/**
 * 元件行为：由板级引脚状态推导元件外观，以及把用户操作（按键、电位器）
 * 转换成对仿真引擎的输入注入。
 *
 * 这里只做纯计算，不接触任何副作用，便于单元测试。
 */

import { boardPinByGpio } from "./catalog";
import { netGpios, netHasGnd, netOfPin, type Netlist } from "./netlist";
import type { BoardPinState, Diagram, PinRef } from "./types";

/**
 * ESP32 SAR ADC 通道表：GPIO → 引擎 `set_apin(chn, value)` 的下标。
 * ADC1 通道 0..7 映射 GPIO36/37/38/39/32/33/34/35；
 * ADC2 通道 0..9 映射 GPIO4/0/2/15/13/12/14/27/25/26，下标从 8 起。
 */
export const ADC_CHANNEL_BY_GPIO: Record<number, number> = {
  36: 0,
  37: 1,
  38: 2,
  39: 3,
  32: 4,
  33: 5,
  34: 6,
  35: 7,
  4: 8,
  0: 9,
  2: 10,
  15: 11,
  13: 12,
  12: 13,
  14: 14,
  27: 15,
  25: 16,
  26: 17,
};

/** 12 位 ADC 满量程 */
export const ADC_MAX = 4095;

export function adcChannelOfGpio(gpio: number): number | null {
  const chn = ADC_CHANNEL_BY_GPIO[gpio];
  return chn === undefined ? null : chn;
}

/** 把 0..1 的电位器位置换算成 12 位 ADC 读数 */
export function adcRaw(fraction: number): number {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return Math.round(f * ADC_MAX);
}

export type PartVisual =
  | { kind: "led"; lit: boolean; color: string }
  | { kind: "pushbutton"; pressed: boolean }
  | { kind: "switch"; closed: boolean }
  | { kind: "buzzer"; on: boolean }
  | { kind: "potentiometer"; value: number }
  | { kind: "resistor"; value: string };

export interface BehaviorInput {
  diagram: Diagram;
  netlist: Netlist;
  /** 板级引脚状态，key 为板级引脚号 */
  pins: Map<number, BoardPinState>;
  /** 当前被按下的按键元件 id */
  pressed: string | null;
  /** 电位器元件 id → 0..1 位置 */
  potValues: Record<string, number>;
}

function boardStateOf(
  netlist: Netlist,
  ref: PinRef,
  pins: Map<number, BoardPinState>,
  want: (s: BoardPinState) => boolean,
): boolean {
  for (const gpio of netGpios(netlist, ref)) {
    const def = boardPinByGpio(gpio);
    if (def?.boardPin === undefined) continue;
    const st = pins.get(def.boardPin);
    if (st && want(st)) return true;
  }
  return false;
}

/** 该引脚所在网络是否被某个 GPIO 输出高电平 */
export function drivenHigh(
  netlist: Netlist,
  ref: PinRef,
  pins: Map<number, BoardPinState>,
): boolean {
  return boardStateOf(netlist, ref, pins, (s) => s.value === 1);
}

/** 该引脚所在网络是否接地，或被某个 GPIO 拉低 */
export function sunkLow(
  netlist: Netlist,
  ref: PinRef,
  pins: Map<number, BoardPinState>,
): boolean {
  return netHasGnd(netlist, ref) || boardStateOf(netlist, ref, pins, (s) => s.value === 0);
}

/** 两端元件是否被供电：一端被拉高、另一端被拉低（允许反接） */
function twoPinPowered(
  netlist: Netlist,
  a: PinRef,
  b: PinRef,
  pins: Map<number, BoardPinState>,
): boolean {
  return (
    (drivenHigh(netlist, a, pins) && sunkLow(netlist, b, pins)) ||
    (drivenHigh(netlist, b, pins) && sunkLow(netlist, a, pins))
  );
}

function ledLit(input: BehaviorInput, ledId: string): boolean {
  const { netlist, pins } = input;
  const anode: PinRef = { part: ledId, pin: "A" };
  const cathode: PinRef = { part: ledId, pin: "C" };
  return twoPinPowered(netlist, anode, cathode, pins);
}

function buzzerOn(input: BehaviorInput, buzzerId: string): boolean {
  const { netlist, pins } = input;
  return twoPinPowered(
    netlist,
    { part: buzzerId, pin: "1" },
    { part: buzzerId, pin: "2" },
    pins,
  );
}

export function computeVisuals(input: BehaviorInput): Map<string, PartVisual> {
  const out = new Map<string, PartVisual>();
  for (const part of input.diagram.parts) {
    switch (part.type) {
      case "led":
        out.set(part.id, {
          kind: "led",
          lit: ledLit(input, part.id),
          color: String(part.attrs?.color ?? "red"),
        });
        break;
      case "pushbutton":
        out.set(part.id, { kind: "pushbutton", pressed: input.pressed === part.id });
        break;
      case "switch":
        out.set(part.id, { kind: "switch", closed: Number(part.attrs?.closed) === 1 });
        break;
      case "buzzer":
        out.set(part.id, { kind: "buzzer", on: buzzerOn(input, part.id) });
        break;
      case "potentiometer": {
        const raw = input.potValues[part.id];
        const fallback = Number(part.attrs?.value ?? 50) / 100;
        out.set(part.id, {
          kind: "potentiometer",
          value: raw === undefined ? fallback : raw,
        });
        break;
      }
      case "resistor":
        out.set(part.id, { kind: "resistor", value: String(part.attrs?.value ?? "") });
        break;
      case "board-devkitc":
        break;
      default:
        break;
    }
  }
  return out;
}

/** 对某个引脚对应的板级 GPIO 注入数字电平 */
export interface PinInjection {
  boardPin: number;
  gpio: number;
  value: 0 | 1;
}

/**
 * 按键按下/松开时应当注入的引脚电平。
 * 松开时注入高电平，与固件 `INPUT_PULLUP` 的语义一致。
 */
export function buttonInjection(
  input: BehaviorInput,
  partId: string,
  pressed: boolean,
): PinInjection | null {
  const { netlist } = input;
  for (const pinId of ["A", "B"]) {
    const ref: PinRef = { part: partId, pin: pinId };
    for (const gpio of netGpios(netlist, ref)) {
      const def = boardPinByGpio(gpio);
      if (def?.boardPin === undefined) continue;
      return { boardPin: def.boardPin, gpio, value: pressed ? 0 : 1 };
    }
  }
  return null;
}

/**
 * 拨动开关闭合/断开时应当注入的引脚电平。
 * 参考电气语义：开关接到 VCC 侧时闭合与断开都读高；接到 GND 侧时闭合拉低、
 * 断开回高（与按键的上拉语义一致）；无电源/地参考时默认闭合高、断开低。
 */
export function switchInjection(
  input: BehaviorInput,
  partId: string,
  closed: boolean,
): PinInjection | null {
  const { netlist } = input;
  const refs: PinRef[] = [
    { part: partId, pin: "1" },
    { part: partId, pin: "2" },
  ];
  const refHas = (
    want: (net: { hasVcc: boolean; hasGnd: boolean; pullUp: boolean; pullDown: boolean }) => boolean,
  ): boolean =>
    refs.some((r) => {
      const net = netOfPin(netlist, r);
      return !!net && want(net);
    });
  const hasVcc = refHas((n) => n.hasVcc || n.pullUp);
  const hasGnd = refHas((n) => n.hasGnd || n.pullDown);
  let value: 0 | 1;
  if (hasVcc) value = 1;
  else if (hasGnd) value = closed ? 0 : 1;
  else value = closed ? 1 : 0;

  for (const ref of refs) {
    for (const gpio of netGpios(netlist, ref)) {
      const def = boardPinByGpio(gpio);
      if (def?.boardPin === undefined) continue;
      return { boardPin: def.boardPin, gpio, value };
    }
  }
  return null;
}

/** 电位器注入到 ADC 的请求 */
export interface AdcInjection {
  channel: number;
  raw: number;
  gpio: number;
}

/**
 * 电位器滑动时应当注入的模拟量。
 * SIG 引脚所在的网络上若存在 ADC 能力的 GPIO，则按其 SAR 通道注入。
 */
export function potInjection(
  input: BehaviorInput,
  partId: string,
  value01: number,
): AdcInjection | null {
  const ref: PinRef = { part: partId, pin: "SIG" };
  for (const gpio of netGpios(input.netlist, ref)) {
    const chn = adcChannelOfGpio(gpio);
    if (chn === null) continue;
    return { channel: chn, raw: adcRaw(value01), gpio };
  }
  return null;
}
