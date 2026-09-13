/**
 * 连线工具：信号类型着色 + 正交路径（waypoints）生成。
 *
 * 着色规范逐字照抄 velxio `wireColors.ts`（Wokwi 色彩约定）：
 *   VCC 红 / GND 黑 / 模拟蓝 / 数字绿 / PWM 紫 / I2C 金 / SPI 橙 / UART 青。
 * 路径生成：创建连线时按端点信号自动生成正交折线（L 型或 Z 型），
 * 为连线/元件留出绕行空间 —— 参考 velxio 自动布线思想，保持轻量。
 */

import { CATALOG, WIRE_COLORS, mergeSignal, type SignalType } from "./catalog";
import type { Connection, Diagram, PinRef } from "./types";

/** 由引脚定义取信号类型（非底板引脚默认 digital） */
function signalOf(diagram: Diagram, ref: PinRef): SignalType {
  const part = diagram.parts.find((p) => p.id === ref.part);
  if (!part) return "digital";
  const def = CATALOG[part.type]?.pins.find((p) => p.id === ref.pin);
  return def?.signal ?? "digital";
}

/** 一条连线的信号类型 = 两端中优先级更高的信号（照抄 velxio 的合并规则） */
export function connectionSignal(diagram: Diagram, c: Connection): SignalType {
  return mergeSignal(signalOf(diagram, c.from), signalOf(diagram, c.to));
}

/** 连线默认颜色（未显式指定时按信号类型着色） */
export function connectionColor(diagram: Diagram, c: Connection): string {
  if (c.color && c.color !== "green" && c.color !== "") return c.color;
  return WIRE_COLORS[connectionSignal(diagram, c)];
}

/** 创建连线时自动生成的初始路径（L/Z 型正交折线），返回拐点数组 */
export function autoRoute(
  from: { x: number; y: number },
  to: { x: number; y: number },
  obstacles: Array<{ x: number; y: number; w: number; h: number }> = [],
): Array<{ x: number; y: number }> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const gap = 16; // 拐点距端点最小水平/垂直间距，避免贴死引脚

  // 尝试三种 L 型 / Z 型，选第一条不与障碍相交的
  const candidates: Array<Array<{ x: number; y: number }>> = [
    // L1：先水平后垂直（向右或向左）
    [{ x: from.x + Math.sign(dx) * Math.max(Math.abs(dx) / 2, gap), y: from.y }],
    // L2：先垂直后水平
    [{ x: from.x, y: from.y + Math.sign(dy) * Math.max(Math.abs(dy) / 2, gap) }],
    // Z1：水平-垂直-水平（中间偏 from）
    [
      { x: from.x + Math.sign(dx) * Math.max(Math.abs(dx) / 2, gap), y: from.y },
      { x: from.x + Math.sign(dx) * Math.max(Math.abs(dx) / 2, gap), y: to.y },
    ],
  ];

  for (const wp of candidates) {
    if (!crossesObstacle(from, to, wp, obstacles)) return wp;
  }
  // 兜底：简单 L 型
  return candidates[0];
}

function segmentHit(
  ax: number, ay: number, bx: number, by: number,
  o: { x: number; y: number; w: number; h: number },
): boolean {
  const pad = 4;
  const minX = Math.min(ax, bx) - pad, maxX = Math.max(ax, bx) + pad;
  const minY = Math.min(ay, by) - pad, maxY = Math.max(ay, by) + pad;
  const ox = o.x, oy = o.y, ow = o.w, oh = o.h;
  // 线段与矩形相交（AABB 分离轴粗略判定）
  const segIsH = Math.abs(ay - by) < 1e-6;
  const segIsV = Math.abs(ax - bx) < 1e-6;
  if (segIsH) {
    return ay >= oy && ay <= oy + oh && maxX >= ox && minX <= ox + ow;
  }
  if (segIsV) {
    return ax >= ox && ax <= ox + ow && maxY >= oy && minY <= oy + oh;
  }
  return false;
}

function crossesObstacle(
  from: { x: number; y: number },
  to: { x: number; y: number },
  waypoints: Array<{ x: number; y: number }>,
  obstacles: Array<{ x: number; y: number; w: number; h: number }>,
): boolean {
  const pts = [from, ...waypoints, to];
  for (let i = 0; i + 1 < pts.length; i++) {
    for (const o of obstacles) {
      if (segmentHit(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, o)) return true;
    }
  }
  return false;
}

/** 由拐点数组生成 SVG path（M 起点 L 各拐点 L 终点） */
export function waypointPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  waypoints: Array<{ x: number; y: number }>,
): string {
  if (!waypoints || waypoints.length === 0) {
    // 无拐点：简单 L 型正交（先水平再垂直）
    const mx = (from.x + to.x) / 2;
    return `M ${from.x} ${from.y} L ${mx} ${from.y} L ${mx} ${to.y} L ${to.x} ${to.y}`;
  }
  const d = [`M ${from.x} ${from.y}`];
  for (const wp of waypoints) d.push(`L ${wp.x} ${wp.y}`);
  d.push(`L ${to.x} ${to.y}`);
  return d.join(" ");
}

/** 线段是否与某点接近（命中检测，用于拖动拐点/选中线段） */
export function pointNearSegment(
  ax: number, ay: number, bx: number, by: number,
  x: number, y: number, threshold: number,
): boolean {
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  if (len2 === 0) return Math.hypot(x - ax, y - ay) <= threshold;
  let t = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * (bx - ax);
  const py = ay + t * (by - ay);
  return Math.hypot(x - px, y - py) <= threshold;
}
