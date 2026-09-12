/**
 * 网表构建：把 diagram 的 connections 合并成电气网络。
 *
 * 无源两端元件（电阻）在网表中透传，即两端引脚属于同一网络，
 * 这样"GPIO → 电阻 → LED → GND"这类常见接法可以直接判定。
 */

import { CATALOG, pinDef } from "./catalog";
import { pinKey, type Diagram, type PinRef } from "./types";

export interface Net {
  id: number;
  nodes: string[];
  /** 网络涉及的板级引脚号（1..38） */
  boardPins: number[];
  /** 网络涉及的 GPIO 号 */
  gpios: number[];
  hasGnd: boolean;
  hasVcc: boolean;
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

  // 2) 导线合并
  for (const conn of diagram.connections) {
    const a = pinKey(conn.from);
    const b = pinKey(conn.to);
    if (pinByKey.has(a) && pinByKey.has(b)) uf.union(a, b);
  }

  // 3) 无源两端元件透传（电阻等）
  for (const part of diagram.parts) {
    const def = CATALOG[part.type];
    if (def.passThrough && def.pins.length === 2) {
      const a = pinKey({ part: part.id, pin: def.pins[0].id });
      const b = pinKey({ part: part.id, pin: def.pins[1].id });
      if (pinByKey.has(a) && pinByKey.has(b)) uf.union(a, b);
    }
  }

  // 4) 归并成网络
  const groups = new Map<string, string[]>();
  for (const key of pinByKey.keys()) {
    const root = uf.find(key);
    const list = groups.get(root);
    if (list) list.push(key);
    else groups.set(root, [key]);
  }

  const nets: Net[] = [];
  const netOf = new Map<string, number>();
  let id = 0;
  for (const nodes of groups.values()) {
    const net: Net = { id, nodes, boardPins: [], gpios: [], hasGnd: false, hasVcc: false };
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
