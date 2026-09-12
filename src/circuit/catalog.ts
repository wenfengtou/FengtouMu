/**
 * 元件目录：定义每种元件的外观尺寸、引脚位置与元数据。
 *
 * 底板引脚表与 Rust 侧 `src-tauri/src/sim/pins.rs` 的 DEVKITC_PINMAP 保持一致
 * （板级引脚 1..38，其中 -1 表示非 GPIO 的电源/使能脚）。
 */

import type { PartType } from "./types";

export interface PartPinDef {
  /** 引脚 id（在元件内唯一，也是 diagram.json connections 中使用的名字） */
  id: string;
  label: string;
  /** 相对元件左上角的坐标 */
  x: number;
  y: number;
  kind: "gpio" | "gnd" | "vcc" | "other";
  /** 板级引脚号（1..38），仅底板引脚有 */
  boardPin?: number;
  /** GPIO 号，仅 GPIO 引脚有 */
  gpio?: number;
}

export interface PartDef {
  type: PartType;
  name: string;
  w: number;
  h: number;
  pins: PartPinDef[];
  attrs?: Record<string, string | number>;
  /** 两端无源元件：网表构建时视为导线（电气上透传） */
  passThrough?: boolean;
  /** 底板固定存在，不可拖拽删除 */
  fixed?: boolean;
}

/** 板级引脚 1..38 对应的 GPIO 号，-1 表示非 GPIO */
export const DEVKITC_PINMAP: number[] = [
  -1, -1, 36, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, -1, 13, 9, 10, 11, -1, 6,
  7, 8, 15, 2, 0, 4, 16, 17, 5, 18, 19, -1, 21, 3, 1, 22, 23, -1,
];

/** 非 GPIO 板级引脚的名称与类别 */
const BOARD_SPECIAL: Record<number, { id: string; label: string; kind: PartPinDef["kind"] }> = {
  1: { id: "3V3", label: "3V3", kind: "vcc" },
  2: { id: "EN", label: "EN", kind: "other" },
  14: { id: "GND.1", label: "GND", kind: "gnd" },
  19: { id: "VIN", label: "VIN", kind: "vcc" },
  32: { id: "GND.2", label: "GND", kind: "gnd" },
  38: { id: "GND.3", label: "GND", kind: "gnd" },
};

const BOARD_W = 210;
const BOARD_H = 624;
const PIN_PITCH = 30;
const PIN_TOP = 30;

/** 板级引脚号 → 相对底板左上角的坐标（左列 1..19，右列 20..38 自下而上） */
export function boardPinPos(boardPin: number): { x: number; y: number } {
  if (boardPin <= 19) {
    return { x: 10, y: PIN_TOP + (boardPin - 1) * PIN_PITCH };
  }
  const row = 19 - (boardPin - 20) - 1;
  return { x: BOARD_W - 10, y: PIN_TOP + row * PIN_PITCH };
}

function buildBoardPins(): PartPinDef[] {
  const pins: PartPinDef[] = [];
  for (let n = 1; n <= DEVKITC_PINMAP.length; n++) {
    const gpio = DEVKITC_PINMAP[n - 1];
    const pos = boardPinPos(n);
    const special = BOARD_SPECIAL[n];
    if (gpio >= 0) {
      pins.push({
        id: `GPIO${gpio}`,
        label: `GPIO${gpio}`,
        x: pos.x,
        y: pos.y,
        kind: "gpio",
        boardPin: n,
        gpio,
      });
    } else if (special) {
      pins.push({
        id: special.id,
        label: special.label,
        x: pos.x,
        y: pos.y,
        kind: special.kind,
        boardPin: n,
      });
    }
  }
  return pins;
}

export const CATALOG: Record<PartType, PartDef> = {
  "board-devkitc": {
    type: "board-devkitc",
    name: "ESP32 DevKitC",
    w: BOARD_W,
    h: BOARD_H,
    pins: buildBoardPins(),
    fixed: true,
  },
  led: {
    type: "led",
    name: "LED",
    // 尺寸与引脚坐标对齐 wokwi-led 原图（自然尺寸 40×50，引脚 A/C 在底部）
    w: 40,
    h: 50,
    attrs: { color: "red" },
    pins: [
      { id: "A", label: "正极", x: 25, y: 42, kind: "other" },
      { id: "C", label: "负极", x: 15, y: 42, kind: "other" },
    ],
  },
  resistor: {
    type: "resistor",
    name: "电阻",
    // 对齐 wokwi-resistor（59×11，引脚在水平中线）
    w: 59,
    h: 11,
    attrs: { value: "220" },
    passThrough: true,
    pins: [
      { id: "a", label: "a", x: 0, y: 6, kind: "other" },
      { id: "b", label: "b", x: 59, y: 6, kind: "other" },
    ],
  },
  pushbutton: {
    type: "pushbutton",
    name: "按键",
    // 对齐 wokwi-pushbutton（67×45）；A/B 取上排 1.l/1.r（按下导通）
    w: 67,
    h: 45,
    pins: [
      { id: "A", label: "1", x: 0, y: 13, kind: "other" },
      { id: "B", label: "2", x: 67, y: 13, kind: "other" },
    ],
  },
  switch: {
    type: "switch",
    name: "拨动开关",
    // 对齐 wokwi-slide-switch（32×35）；用 1/2 两个脚（第三个脚 3 仅作原图展示）
    w: 32,
    h: 35,
    attrs: { closed: 0 },
    pins: [
      { id: "1", label: "1", x: 6.5, y: 34, kind: "other" },
      { id: "2", label: "2", x: 16, y: 34, kind: "other" },
    ],
  },
  buzzer: {
    type: "buzzer",
    name: "蜂鸣器",
    // 对齐 wokwi-buzzer（64×76，引脚在底部引线末端）
    w: 64,
    h: 76,
    pins: [
      { id: "1", label: "+", x: 27, y: 74, kind: "other" },
      { id: "2", label: "-", x: 37, y: 74, kind: "other" },
    ],
  },
  potentiometer: {
    type: "potentiometer",
    name: "电位器",
    // 对齐 wokwi-potentiometer（76×76，三脚在底部：GND/SIG/VCC）
    w: 76,
    h: 76,
    attrs: { value: 50 },
    pins: [
      { id: "VCC", label: "VCC", x: 49, y: 68.5, kind: "other" },
      { id: "SIG", label: "SIG", x: 39, y: 68.5, kind: "other" },
      { id: "GND", label: "GND", x: 29, y: 68.5, kind: "other" },
    ],
  },
};

export function partDef(type: PartType): PartDef {
  return CATALOG[type];
}

export function pinDef(type: PartType, pinId: string): PartPinDef | undefined {
  return CATALOG[type].pins.find((p) => p.id === pinId);
}

/** 元件引脚相对画布的绝对坐标 */
export function pinAbsPos(
  type: PartType,
  partX: number,
  partY: number,
  pinId: string,
): { x: number; y: number } | null {
  const def = pinDef(type, pinId);
  if (!def) return null;
  return { x: partX + def.x, y: partY + def.y };
}

/** 按板级引脚号反查底板引脚定义（用于把 gpio-update 的板级号映射到画布引脚） */
export function boardPinByBoardPin(n: number): PartPinDef | undefined {
  return CATALOG["board-devkitc"].pins.find((p) => p.boardPin === n);
}

/** 按 GPIO 号反查底板引脚定义 */
export function boardPinByGpio(gpio: number): PartPinDef | undefined {
  return CATALOG["board-devkitc"].pins.find((p) => p.gpio === gpio);
}
