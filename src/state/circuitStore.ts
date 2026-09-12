/** 电路域：图纸数据、网表、元件外观、选中与连线状态 */

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
});

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
    type === "led" ? "led" : type === "resistor" ? "r" : type === "pushbutton" ? "sw" : "pot";
  let n = 1;
  const ids = new Set(diagram.parts.map((p) => p.id));
  while (ids.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function addPart(type: PartType, x: number, y: number): string {
  const id = nextId(circuitStore.get().diagram, type);
  const part = { id, type, x: Math.round(x), y: Math.round(y) };
  circuitStore.set((prev) => ({
    diagram: { ...prev.diagram, parts: [...prev.diagram.parts, part] },
    selected: id,
    potValues:
      type === "potentiometer" ? { ...prev.potValues, [id]: 0.5 } : prev.potValues,
  }));
  recompute();
  return id;
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
