/**
 * wokwi-elements 接入层：把官方 Wokwi 元件（Lit 自定义元素 + shadow DOM SVG）
 * 渲染到我们的 SVG 画布里。
 *
 * 方案说明：画布保持"纯 SVG"架构（平移/缩放/连线/拖拽都不变），这里只负责
 *  1) 按元件类型实例化 wokwi 元素（脱离文档的缓存实例）；
 *  2) 把我们的视觉状态（LED 亮灭、按键按下、电位器位置…）映射成元素属性；
 *  3) 取回元素 shadow DOM 里的 <svg> 原图，供画布 <g> 内嵌。
 *
 * 与 Wokwi/Velxio 的"HTML 绝对定位层"不同，我们选择内嵌 SVG：交互（引脚连线、
 * 拖拽、按键按下、旋钮拖动）全部沿用既有实现，只替换元件外观与引脚坐标。
 */

import "@wokwi/elements";

import type { PartType } from "./types";

/** 每种元件对应的 wokwi 自定义元素标签 */
export const WOKWI_TAG: Partial<Record<PartType, string>> = {
  "board-devkitc": "wokwi-esp32-devkit-v1",
  led: "wokwi-led",
  resistor: "wokwi-resistor",
  pushbutton: "wokwi-pushbutton",
  switch: "wokwi-slide-switch",
  buzzer: "wokwi-buzzer",
  potentiometer: "wokwi-potentiometer",
};

/** 渲染尺寸（px，与 wokwi 元素自然尺寸一致，也是 catalog 里 w/h 的来源） */
export const WOKWI_SIZE: Partial<Record<PartType, { w: number; h: number }>> = {
  // 底板尺寸与官方 svg 等比（107:201 ≈ 210:395），拉伸为等比缩放不变形
  "board-devkitc": { w: 210, h: 395 },
  led: { w: 40, h: 50 },
  resistor: { w: 59, h: 11 },
  pushbutton: { w: 67, h: 45 },
  switch: { w: 32, h: 35 },
  buzzer: { w: 64, h: 76 },
  potentiometer: { w: 76, h: 76 },
};

/** 元件视觉状态（与 behavior.ts 的 PartVisual 对齐） */
export type WokwiPartState =
  | { kind: "board-devkitc"; ledOn: boolean }
  | { kind: "led"; lit: boolean; color: string }
  | { kind: "resistor"; value: string }
  | { kind: "pushbutton"; pressed: boolean }
  | { kind: "switch"; closed: boolean }
  | { kind: "buzzer"; on: boolean }
  | { kind: "potentiometer"; value: number };

/** 按类型取回（缓存）一个 wokwi 元素实例 */
const elCache = new Map<string, HTMLElement>();

export function wokwiElement(type: PartType): HTMLElement {
  const cached = elCache.get(type);
  if (cached) return cached;
  const tag = WOKWI_TAG[type];
  if (!tag) throw new Error(`wokwi-elements 没有元件类型: ${type}`);
  const el = document.createElement(tag);
  elCache.set(type, el);
  return el;
}

/** 隐藏宿主：让元素以"已连接"语义完成首次渲染（Lit 的 connectedCallback 会触发更新） */
let holder: HTMLDivElement | null = null;
function hiddenHolder(): HTMLDivElement {
  if (!holder) {
    holder = document.createElement("div");
    holder.style.cssText =
      "position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;";
    document.body.appendChild(holder);
  }
  return holder;
}

/** 把我们的视觉状态映射成 wokwi 元素属性 */
export function applyWokwiState(type: PartType, el: HTMLElement, state: unknown): void {
  const w = el as unknown as Record<string, unknown>;
  switch (type) {
    case "board-devkitc": {
      const s = state as Extract<WokwiPartState, { kind: "board-devkitc" }>;
      w.led1 = !!s?.ledOn;
      w.ledPower = true;
      break;
    }
    case "led": {
      const s = state as Extract<WokwiPartState, { kind: "led" }>;
      w.color = s?.color ?? "red";
      w.value = !!s?.lit;
      w.brightness = 1;
      break;
    }
    case "resistor": {
      const s = state as Extract<WokwiPartState, { kind: "resistor" }>;
      w.value = String(s?.value ?? "220");
      break;
    }
    case "pushbutton": {
      const s = state as Extract<WokwiPartState, { kind: "pushbutton" }>;
      w.pressed = !!s?.pressed;
      break;
    }
    case "switch": {
      const s = state as Extract<WokwiPartState, { kind: "switch" }>;
      w.value = s?.closed ? 1 : 0;
      break;
    }
    case "buzzer": {
      const s = state as Extract<WokwiPartState, { kind: "buzzer" }>;
      w.hasSignal = !!s?.on;
      break;
    }
    case "potentiometer": {
      const s = state as Extract<WokwiPartState, { kind: "potentiometer" }>;
      // wokwi 电位器 value 范围 0..1023
      w.value = Math.round((s?.value ?? 0.5) * 1023);
      break;
    }
    default:
      break;
  }
}

/**
 * 让元素完成一次更新并取回 shadow DOM 里的 <svg> 原图。
 * 返回的 svg 已按 WOKWI_SIZE 归一化 width/height（px），可直接内嵌进画布 <g>。
 */
export async function wokwiSvgClone(
  type: PartType,
  el: HTMLElement,
): Promise<SVGSVGElement | null> {
  const host = hiddenHolder();
  host.appendChild(el);
  const lit = el as unknown as { requestUpdate(): void; updateComplete: Promise<unknown> };
  lit.requestUpdate();
  await lit.updateComplete;
  const svg = el.shadowRoot?.querySelector("svg");
  let clone: SVGSVGElement | null = null;
  if (svg) {
    const size = WOKWI_SIZE[type];
    clone = svg.cloneNode(true) as SVGSVGElement;
    if (size) {
      clone.setAttribute("width", String(size.w));
      clone.setAttribute("height", String(size.h));
    }
    // 底板：官方图按我们的 38 引脚矩形拉伸铺满（引脚圆点覆盖在两侧）
    if (type === "board-devkitc") {
      clone.setAttribute("preserveAspectRatio", "none");
    }
  }
  host.removeChild(el);
  return clone;
}
