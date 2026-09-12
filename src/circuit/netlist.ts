/**
 * 网表构建：把 diagram 的 connections 合并成电气网络。
 *
 * 无源两端元件（电阻）在网表中透传，即两端引脚属于同一网络，
 * 这样"GPIO → 电阻 → LED → GND"这类常见接法可以直接判定。
 */

import { CATALOG, pinDef } from "./catalog";
import { pinKey, type Diagram, type Part, type PinRef } from "./types";

export interface Net {
  id: number;
  nodes: string[];
  /** 网络涉及的板级引脚号（1..38） */
  boardPins: number[];
  /** 网络涉及的 GPIO 号 */
  gpios: number[];
  hasGnd: boolean;
  hasVcc: boolean;
  /** 通过电阻（而非直接导线）接到 VCC，属于弱上拉 */
  pullUp: boolean;
  /** 通过电阻（而非直接导线）接到 GND，属于弱下拉 */
  pullDown: boolean;
}

export interface Netlist {
  nets: Net[];
  netOf: Map<string, number>;
  pinByKey: Map<string, PinRef>;
}

class UnionFind {
  private parent = new Map<string, string>();

  find(a: string): string {
    const p = this.parent.get(a);
    if (p === undefined) {
      this.parent.set(a, a);
      return a;
    }
    if (p === a) return a;
    const root = this.find(p);
    this.parent.set(a, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/** 该元件当前是否电气透传（两端导通）：电阻恒透传，拨动开关仅在闭合时透传 */
function isPassThrough(part: Part): boolean {
  const def = CATALOG[part.type];
  if (def.passThrough && def.pins.length === 2) return true;
  if (part.type === "switch" && def.pins.length === 2 && Number(part.attrs?.closed) === 1) {
    return true;
  }
  return false;
}

/** 收集一个"线段组"（仅按导线合并）的电源/地属性 */
function groupPower(
  uf: UnionFind,
  pinByKey: Map<string, PinRef>,
  partById: Map<string, Part>,
): Map<string, { hasVcc: boolean; hasGnd: boolean }> {
  const groups = new Map<string, { hasVcc: boolean; hasGnd: boolean }>();
  for (const key of pinByKey.keys()) {
    const root = uf.find(key);
    let g = groups.get(root);
    if (!g) {
      g = { hasVcc: false, hasGnd: false };
      groups.set(root, g);
    }
    const ref = pinByKey.get(key);
    if (!ref) continue;
    const part = partById.get(ref.part);
    if (!part) continue;
    const def = pinDef(part.type, ref.pin);
    if (!def) continue;
    if (def.kind === "vcc") g.hasVcc = true;
    if (def.kind === "gnd") g.hasGnd = true;
  }
  return groups;
}

export function buildNetlist(diagram: Diagram): Netlist {
  const uf = new UnionFind();
  const pinByKey = new Map<string, PinRef>();
  const partById = new Map(diagram.parts.map((p) => [p.id, p]));

  // 1) 登记所有元件的引脚
  for (const part of diagram.parts) {
    for (const pin of CATALOG[part.type].pins) {
      const key = pinKey({ part: part.id, pin: pin.id });
      pinByKey.set(key, { part: part.id, pin: pin.id });
      uf.find(key);
    }
  }

  // 2) 导线合并（暂不含透传元件，先得到"线段组"）
  for (const conn of diagram.connections) {
    const a = pinKey(conn.from);
    const b = pinKey(conn.to);
    if (pinByKey.has(a) && pinByKey.has(b)) uf.union(a, b);
  }

  // 3) 透传元件（电阻、闭合开关）：
  //    先记录"一端接 VCC/GND、另一端接电路"的上/下拉语义，再合并两端网络
  const groups = groupPower(uf, pinByKey, partById);
  const pullUpRoots = new Set<string>();
  const pullDownRoots = new Set<string>();
  for (const part of diagram.parts) {
    if (!isPassThrough(part)) continue;
    const def = CATALOG[part.type];
    const a = pinKey({ part: part.id, pin: def.pins[0].id });
    const b = pinKey({ part: part.id, pin: def.pins[1].id });
    if (!pinByKey.has(a) || !pinByKey.has(b)) continue;
    const ra = uf.find(a);
    const rb = uf.find(b);
    if (ra !== rb) {
      const ga = groups.get(ra);
      const gb = groups.get(rb);
      if (ga && gb) {
        if (ga.hasVcc && !gb.hasVcc) pullUpRoots.add(rb);
        if (gb.hasVcc && !ga.hasVcc) pullUpRoots.add(ra);
        if (ga.hasGnd && !gb.hasGnd) pullDownRoots.add(rb);
        if (gb.hasGnd && !ga.hasGnd) pullDownRoots.add(ra);
      }
      uf.union(a, b);
      // 合并后把被并入组的语义带到新根上
      const newRoot = uf.find(a);
      const oldRoot = newRoot === ra ? rb : ra;
      if (pullUpRoots.has(oldRoot)) pullUpRoots.add(newRoot);
      if (pullDownRoots.has(oldRoot)) pullDownRoots.add(newRoot);
    }
  }

  // 4) 归并成网络
  const finalGroups = new Map<string, string[]>();
  for (const key of pinByKey.keys()) {
    const root = uf.find(key);
    const list = finalGroups.get(root);
    if (list) list.push(key);
    else finalGroups.set(root, [key]);
  }

  const nets: Net[] = [];
  const netOf = new Map<string, number>();
  let id = 0;
  for (const nodes of finalGroups.values()) {
    const root = uf.find(nodes[0]);
    const net: Net = {
      id,
      nodes,
      boardPins: [],
      gpios: [],
      hasGnd: false,
      hasVcc: false,
      pullUp: pullUpRoots.has(root),
      pullDown: pullDownRoots.has(root),
    };
    for (const key of nodes) {
      const ref = pinByKey.get(key);
      if (!ref) continue;
      netOf.set(key, id);
      const part = partById.get(ref.part);
      if (!part) continue;
      const def = pinDef(part.type, ref.pin);
      if (!def) continue;
      if (def.boardPin !== undefined) net.boardPins.push(def.boardPin);
      if (def.gpio !== undefined) net.gpios.push(def.gpio);
      if (def.kind === "gnd") net.hasGnd = true;
      if (def.kind === "vcc") net.hasVcc = true;
    }
    nets.push(net);
    id += 1;
  }

  return { nets, netOf, pinByKey };
}

export function netOfPin(netlist: Netlist, ref: PinRef): Net | null {
  const id = netlist.netOf.get(pinKey(ref));
  if (id === undefined) return null;
  return netlist.nets[id] ?? null;
}

export function netGpios(netlist: Netlist, ref: PinRef): number[] {
  return netOfPin(netlist, ref)?.gpios ?? [];
}

export function netBoardPins(netlist: Netlist, ref: PinRef): number[] {
  return netOfPin(netlist, ref)?.boardPins ?? [];
}

export function netHasGnd(netlist: Netlist, ref: PinRef): boolean {
  return netOfPin(netlist, ref)?.hasGnd ?? false;
}

/** 网络引脚数量，用于判断某点是否真的接上了东西 */
export function netSize(netlist: Netlist, ref: PinRef): number {
  return netOfPin(netlist, ref)?.nodes.length ?? 0;
}

/** 列出某个网络上的全部元件引脚 */
export function netNodes(netlist: Netlist, ref: PinRef): PinRef[] {
  const net = netOfPin(netlist, ref);
  if (!net) return [];
  return net.nodes
    .map((k) => netlist.pinByKey.get(k))
    .filter((r): r is PinRef => r !== undefined);
}

/**
 * 网络的电阻上/下拉语义：
 *   - "pullup"   ：通过电阻接到 VCC（弱上拉，GPIO 空闲读高）
 *   - "pulldown" ：通过电阻接到 GND（弱下拉，GPIO 空闲读低）
 *   - "divider"  ：同时接上拉与下拉电阻（电阻分压节点）
 *   - null       ：无电阻偏置
 */
export function netPullLevel(
  netlist: Netlist,
  ref: PinRef,
): "pullup" | "pulldown" | "divider" | null {
  const net = netOfPin(netlist, ref);
  if (!net) return null;
  if (net.pullUp && net.pullDown) return "divider";
  if (net.pullUp) return "pullup";
  if (net.pullDown) return "pulldown";
  return null;
}
