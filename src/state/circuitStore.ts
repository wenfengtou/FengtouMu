/** 电路域：图纸数据、网表、元件外观、选中与连线状态 */

import { CATALOG } from "../circuit/catalog";
import { computeVisuals, type BehaviorInput, type PartVisual } from "../circuit/behavior";
import { parseDiagram, serializeDiagram } from "../circuit/diagram";
import { buildNetlist, type Netlist } from "../circuit/netlist";
import {
  emptyDiagram,
  pinKey,
  type Diagram,
  type PartType,
  type PinRef,
} from "../circuit/types";
import { simStore } from "./simStore";
import { createStore } from "./store";
import { setMsg } from "./uiStore";

export interface CircuitState {
  diagram: Diagram;
  netlist: Netlist;
  visuals: Map<string, PartVisual>;
  selected: string | null;
  /** 选中的导线下标（用于删除） */
  selectedWire: number | null;
  /** 正在连线的起点引脚；null 表示未处于连线状态 */
  wiringFrom: PinRef | null;
  /** 当前按下的按键元件 id */
  pressed: string | null;
  /** 电位器元件 id → 0..1 位置 */
  potValues: Record<string, number>;
  /** 画布缩放指令（画布头部 +/−/复位按钮发来的命令） */
  zoomCmd: { op: "in" | "out" | "reset"; seq: number } | null;
}

const initialDiagram = emptyDiagram();

export const circuitStore = createStore<CircuitState>({
  diagram: initialDiagram,
  netlist: buildNetlist(initialDiagram),
  visuals: new Map(),
  selected: null,
  selectedWire: null,
  wiringFrom: null,
  pressed: null,
  potValues: {},
  zoomCmd: null,
});

/** 请求画布缩放（seq 递增以触发每次指令） */
export function setZoomCmd(op: "in" | "out" | "reset", seq: number): void {
  circuitStore.set({ zoomCmd: { op, seq } });
}

/** 组装行为计算的输入 */
export function behaviorInput(state: CircuitState = circuitStore.get()): BehaviorInput {
  return {
    diagram: state.diagram,
    netlist: state.netlist,
    pins: simStore.get().pins,
    pressed: state.pressed,
    potValues: state.potValues,
  };
}

/** 重新构建网表并计算元件外观 */
export function recompute(): void {
  const state = circuitStore.get();
  const netlist = buildNetlist(state.diagram);
  const visuals = computeVisuals({
    diagram: state.diagram,
    netlist,
    pins: simStore.get().pins,
    pressed: state.pressed,
    potValues: state.potValues,
  });
  circuitStore.set({ netlist, visuals });
}

function nextId(diagram: Diagram, type: PartType): string {
  const prefix =
    type === "led"
      ? "led"
      : type === "resistor"
        ? "r"
        : type === "pushbutton"
          ? "sw"
          : type === "switch"
            ? "tgl"
            : type === "buzzer"
              ? "bz"
              : "pot";
  let n = 1;
  const ids = new Set(diagram.parts.map((p) => p.id));
  while (ids.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/**
 * 元件自动布局：在底板右侧按列扫描空位，返回第一个不与现有元件重叠的坐标。
 * 替代原先"固定步进叠加"的放法，连续添加多个元件也不会互相压盖。
 */
const SLOT_COLS = [340, 500, 660, 820, 980];
const SLOT_ROW_START = 80;
const SLOT_ROW_STEP = 130;
const SLOT_MARGIN = 24;

export function nextSlot(diagram: Diagram): { x: number; y: number } {
  const occupied = diagram.parts.map((p) => {
    const def = CATALOG[p.type];
    return {
      x0: p.x - SLOT_MARGIN,
      y0: p.y - SLOT_MARGIN,
      x1: p.x + def.w + SLOT_MARGIN,
      y1: p.y + def.h + SLOT_MARGIN,
    };
  });
  const overlaps = (x: number, y: number, w: number, h: number): boolean =>
    occupied.some((o) => x < o.x1 && x + w > o.x0 && y < o.y1 && y + h > o.y0);
  for (const col of SLOT_COLS) {
    for (let row = 0; row < 24; row += 1) {
      const x = col;
      const y = SLOT_ROW_START + row * SLOT_ROW_STEP;
      if (!overlaps(x, y, 40, 40)) return { x, y };
    }
  }
  // 兜底：回到首列继续往下偏移
  let y = SLOT_ROW_START;
  while (overlaps(SLOT_COLS[0], y, 40, 40)) y += SLOT_ROW_STEP;
  return { x: SLOT_COLS[0], y };
}

export function addPart(type: PartType, x: number, y: number): string {
  const id = nextId(circuitStore.get().diagram, type);
  const part = {
    id,
    type,
    x: Math.round(x),
    y: Math.round(y),
    ...(type === "switch" ? { attrs: { closed: 0 } as Record<string, string | number> } : {}),
  };
  circuitStore.set((prev) => ({
    diagram: { ...prev.diagram, parts: [...prev.diagram.parts, part] },
    selected: id,
    potValues:
      type === "potentiometer" ? { ...prev.potValues, [id]: 0.5 } : prev.potValues,
  }));
  recompute();
  return id;
}

/** 切换拨动开关开合：写入 attrs 并重新建网（闭合时两端导通），再向引擎注入电平 */
export function togglePart(partId: string, closed: boolean): void {
  circuitStore.set((prev) => ({
    diagram: {
      ...prev.diagram,
      parts: prev.diagram.parts.map((p) =>
        p.id === partId
          ? { ...p, attrs: { ...(p.attrs ?? {}), closed: closed ? 1 : 0 } }
          : p,
      ),
    },
  }));
  recompute();
}

export function movePart(id: string, x: number, y: number): void {
  circuitStore.set((prev) => ({
    diagram: {
      ...prev.diagram,
      parts: prev.diagram.parts.map((p) =>
        p.id === id ? { ...p, x: Math.round(x), y: Math.round(y) } : p,
      ),
    },
  }));
}

export function removePart(id: string): void {
  const state = circuitStore.get();
  const part = state.diagram.parts.find((p) => p.id === id);
  if (!part) return;
  if (part.type === "board-devkitc") {
    setMsg("底板不可删除");
    return;
  }
  circuitStore.set((prev) => ({
    diagram: {
      ...prev.diagram,
      parts: prev.diagram.parts.filter((p) => p.id !== id),
      connections: prev.diagram.connections.filter(
        (c) => c.from.part !== id && c.to.part !== id,
      ),
    },
    selected: prev.selected === id ? null : prev.selected,
    selectedWire: null,
    wiringFrom: prev.wiringFrom?.part === id ? null : prev.wiringFrom,
    pressed: prev.pressed === id ? null : prev.pressed,
  }));
  recompute();
}

export function selectPart(id: string | null): void {
  circuitStore.set({ selected: id, selectedWire: null });
}

/** 选中某条导线（用于删除） */
export function selectWire(index: number | null): void {
  circuitStore.set({ selectedWire: index, selected: null });
}

/** 点击引脚：第一次记录起点，第二次完成连线 */
export function clickPin(ref: PinRef): void {
  const state = circuitStore.get();
  if (!state.wiringFrom) {
    circuitStore.set({ wiringFrom: ref });
    setMsg(`已选择 ${pinKey(ref)}，再点击目标引脚完成连线`);
    return;
  }
  const from = state.wiringFrom;
  if (from.part === ref.part && from.pin === ref.pin) {
    circuitStore.set({ wiringFrom: null });
    return;
  }
  if (from.part === ref.part) {
    setMsg("同一元件的两个引脚不需要连线");
    return;
  }
  const exists = state.diagram.connections.some(
    (c) =>
      (pinKey(c.from) === pinKey(from) && pinKey(c.to) === pinKey(ref)) ||
      (pinKey(c.from) === pinKey(ref) && pinKey(c.to) === pinKey(from)),
  );
  if (exists) {
    setMsg("这两个引脚已经连接");
    circuitStore.set({ wiringFrom: null });
    return;
  }
  circuitStore.set((prev) => ({
    diagram: {
      ...prev.diagram,
      connections: [...prev.diagram.connections, { from, to: ref, color: "green" }],
    },
    wiringFrom: null,
  }));
  recompute();
  setMsg(`已连接 ${pinKey(from)} → ${pinKey(ref)}`);
}

export function cancelWiring(): void {
  circuitStore.set({ wiringFrom: null });
}

export function removeConnectionAt(index: number): void {
  circuitStore.set((prev) => ({
    diagram: {
      ...prev.diagram,
      connections: prev.diagram.connections.filter((_, i) => i !== index),
    },
    selectedWire: null,
  }));
  recompute();
}

export function resetCircuit(): void {
  const diagram = emptyDiagram();
  circuitStore.set({
    diagram,
    netlist: buildNetlist(diagram),
    visuals: new Map(),
    selected: null,
    selectedWire: null,
    wiringFrom: null,
    pressed: null,
    potValues: {},
  });
  recompute();
}

/** 导入 diagram.json 文本，返回解析出的问题列表 */
export function importDiagramText(text: string): string[] {
  const { diagram, errors } = parseDiagram(text);
  circuitStore.set({
    diagram,
    selected: null,
    selectedWire: null,
    wiringFrom: null,
    pressed: null,
    potValues: {},
  });
  recompute();
  return errors;
}

export function exportDiagramText(): string {
  return serializeDiagram(circuitStore.get().diagram);
}
