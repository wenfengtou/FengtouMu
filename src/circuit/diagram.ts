/**
 * diagram.json 读写
 *
 * 文件结构对齐 Wokwi：parts 为对象数组（type/id/left/top/attrs），
 * connections 为 `["元件:引脚", "元件:引脚", 颜色, []]` 数组。
 * 导入时会做兼容映射（元件类型别名、引脚别名），并给出可读的错误说明。
 */

import { CATALOG } from "./catalog";
import {
  emptyDiagram,
  pinKey,
  type Connection,
  type Diagram,
  type Part,
  type PartType,
  type PinRef,
} from "./types";

const TYPE_TO_FILE: Record<PartType, string> = {
  "board-devkitc": "board-esp32-devkitc",
  led: "wokwi-led",
  resistor: "wokwi-resistor",
  pushbutton: "wokwi-pushbutton",
  switch: "wokwi-slide-switch",
  buzzer: "wokwi-buzzer",
  potentiometer: "wokwi-potentiometer",
};

const TYPE_ALIASES: Record<string, PartType> = {
  "board-esp32-devkitc": "board-devkitc",
  "esp32-devkitc": "board-devkitc",
  "wokwi-esp32-devkitc": "board-devkitc",
  "wokwi-led": "led",
  led: "led",
  "wokwi-resistor": "resistor",
  resistor: "resistor",
  "wokwi-pushbutton": "pushbutton",
  "wokwi-pushbutton-6mm": "pushbutton",
  pushbutton: "pushbutton",
  "wokwi-slide-switch": "switch",
  "wokwi-dip-switch-4": "switch",
  switch: "switch",
  "wokwi-buzzer": "buzzer",
  buzzer: "buzzer",
  "wokwi-potentiometer": "potentiometer",
  potentiometer: "potentiometer",
};

/** 引脚别名（导入 Wokwi 文件时使用） */
const PIN_ALIASES: Record<PartType, Record<string, string>> = {
  "board-devkitc": {},
  led: {},
  resistor: { "1": "a", "2": "b" },
  pushbutton: { "1": "A", "2": "B", "1.l": "A", "1.r": "B", "2.l": "A", "2.r": "B" },
  switch: {},
  buzzer: {},
  potentiometer: { "1": "VCC", "2": "SIG", "3": "GND" },
};

/** Wokwi 拨动开关的开关位置（嵌套 attrs.switch.position）与内部 closed 互转 */
function switchClosedFromRaw(attrsRaw: Record<string, unknown>): 0 | 1 {
  const nested = attrsRaw.switch;
  if (typeof nested === "object" && nested !== null) {
    const pos = (nested as Record<string, unknown>).position;
    if (pos === 1) return 1;
  }
  return attrsRaw.closed === 1 ? 1 : 0;
}

function switchAttrsToRaw(attrs: Record<string, string | number> | undefined) {
  return { switch: { position: Number(attrs?.closed) === 1 ? 1 : 0 } };
}

export function serializeDiagram(diagram: Diagram): string {
  const parts = diagram.parts.map((p) => ({
    type: TYPE_TO_FILE[p.type],
    id: p.id,
    top: Math.round(p.y),
    left: Math.round(p.x),
    ...(p.type === "switch"
      ? { attrs: switchAttrsToRaw(p.attrs) }
      : p.attrs && Object.keys(p.attrs).length > 0
        ? { attrs: p.attrs }
        : {}),
  }));
  const connections = diagram.connections.map((c) => [
    pinKey(c.from),
    pinKey(c.to),
    c.color ?? "green",
    [],
  ]);
  return JSON.stringify({ version: 1, parts, connections, dependencies: {} }, null, 2);
}

export interface ParseResult {
  diagram: Diagram;
  errors: string[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function normalizePinAlias(type: PartType, pin: string): string {
  return PIN_ALIASES[type][pin] ?? pin;
}

function hasPin(type: PartType, pin: string): boolean {
  return CATALOG[type].pins.some((p) => p.id === pin);
}

/** 解析 diagram.json 文本；无法修复的问题会写入 errors，并尽量返回可用的图 */
export function parseDiagram(text: string): ParseResult {
  const errors: string[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { diagram: emptyDiagram(), errors: ["文件不是合法的 JSON"] };
  }

  const obj = asRecord(root);
  if (!obj) return { diagram: emptyDiagram(), errors: ["文件内容不是一个对象"] };

  const parts: Part[] = [];
  const seenIds = new Set<string>();
  const rawParts = Array.isArray(obj.parts) ? obj.parts : [];
  if (rawParts.length === 0) errors.push("parts 为空或缺失");

  rawParts.forEach((raw, index) => {
    const p = asRecord(raw);
    if (!p) {
      errors.push(`parts[${index}] 不是对象`);
      return;
    }
    const rawType = String(p.type ?? "");
    const type = TYPE_ALIASES[rawType];
    if (!type) {
      errors.push(`parts[${index}] 的元件类型无法识别：${rawType || "(空)"}`);
      return;
    }
    const id = String(p.id ?? "");
    if (!id) {
      errors.push(`parts[${index}] 缺少 id`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`元件 id 重复：${id}`);
      return;
    }
    seenIds.add(id);

    const attrsRaw = asRecord(p.attrs) ?? {};
    const attrs: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(attrsRaw)) {
      if (typeof v === "string" || typeof v === "number") attrs[k] = v;
    }
    if (type === "switch") {
      // Wokwi 拨动开关用嵌套 attrs.switch.position 表示位置，内部统一为 closed
      attrs.closed = switchClosedFromRaw(attrsRaw);
    }
    parts.push({
      id,
      type,
      x: Number(p.left ?? 0),
      y: Number(p.top ?? 0),
      attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
    });
  });

  if (!parts.some((p) => p.type === "board-devkitc")) {
    const board: Part = { id: "esp", type: "board-devkitc", x: 40, y: 40 };
    parts.unshift(board);
    seenIds.add(board.id);
  }

  const partById = new Map(parts.map((p) => [p.id, p]));
  const connections: Connection[] = [];
  const rawConns = Array.isArray(obj.connections) ? obj.connections : [];

  const resolve = (token: unknown): PinRef | null => {
    const s = String(token ?? "");
    const i = s.indexOf(":");
    if (i <= 0) return null;
    const partId = s.slice(0, i);
    const rawPin = s.slice(i + 1);
    const part = partById.get(partId);
    if (!part) return null;
    const pin = normalizePinAlias(part.type, rawPin);
    if (!hasPin(part.type, pin)) return null;
    return { part: partId, pin };
  };

  rawConns.forEach((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 2) {
      errors.push(`connections[${index}] 格式应为 [起点, 终点, 颜色, []]`);
      return;
    }
    const from = resolve(raw[0]);
    const to = resolve(raw[1]);
    if (!from || !to) {
      errors.push(`connections[${index}] 的端点不存在或引脚名无效：${String(raw[0])} → ${String(raw[1])}`);
      return;
    }
    const color = typeof raw[2] === "string" && raw[2].length > 0 ? raw[2] : "green";
    connections.push({ from, to, color });
  });

  return { diagram: { version: 1, parts, connections }, errors };
}

/** 校验当前图，返回问题列表（用于导出前的自检） */
export function validateDiagram(diagram: Diagram): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const part of diagram.parts) {
    if (ids.has(part.id)) issues.push(`元件 id 重复：${part.id}`);
    ids.add(part.id);
  }
  if (!diagram.parts.some((p) => p.type === "board-devkitc")) {
    issues.push("缺少 ESP32 DevKitC 底板");
  }
  diagram.connections.forEach((c, i) => {
    const from = diagram.parts.find((p) => p.id === c.from.part);
    const to = diagram.parts.find((p) => p.id === c.to.part);
    if (!from) issues.push(`连线 ${i} 的起点元件不存在：${c.from.part}`);
    if (!to) issues.push(`连线 ${i} 的终点元件不存在：${c.to.part}`);
    if (from && !hasPin(from.type, c.from.pin)) issues.push(`连线 ${i} 的引脚无效：${c.from.part}:${c.from.pin}`);
    if (to && !hasPin(to.type, c.to.pin)) issues.push(`连线 ${i} 的引脚无效：${c.to.part}:${c.to.pin}`);
  });
  return issues;
}
