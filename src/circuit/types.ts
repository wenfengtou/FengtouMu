/**
 * 电路数据模型
 *
 * 内部结构对齐 Wokwi 的 diagram.json（parts + connections），
 * 读写文件时由 `diagram.ts` 负责在数组形式与对象形式之间转换。
 */

/** 目前支持的元件类型（board 为固定底板，其余为可拖拽元件） */
export type PartType =
  | "board-devkitc"
  | "led"
  | "resistor"
  | "pushbutton"
  | "switch"
  | "buzzer"
  | "potentiometer";

export interface Part {
  id: string;
  type: PartType;
  /** 画布坐标，指向元件外框左上角 */
  x: number;
  y: number;
  attrs?: Record<string, string | number>;
}

export interface PinRef {
  part: string;
  pin: string;
}

export interface Connection {
  from: PinRef;
  to: PinRef;
  color?: string;
  /** 中间拐点（照抄 velxio waypoints：双击线段插入、拖动调整、自动布线生成） */
  waypoints?: Array<{ x: number; y: number }>;
}

export interface Diagram {
  version: 1;
  parts: Part[];
  connections: Connection[];
}

/** 板级引脚状态（与 Rust 侧 PinState 对应） */
export interface BoardPinState {
  pin: number;
  gpio: number;
  value: number;
  dir: number;
}

export const pinKey = (r: PinRef): string => `${r.part}:${r.pin}`;

export function parsePinKey(key: string): PinRef | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  return { part: key.slice(0, i), pin: key.slice(i + 1) };
}

export function emptyDiagram(): Diagram {
  return {
    version: 1,
    parts: [{ id: "esp", type: "board-devkitc", x: 40, y: 40 }],
    connections: [],
  };
}
