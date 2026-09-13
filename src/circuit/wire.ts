/**
 * 连线工具：信号类型着色 + A* 迷宫布线（waypoints 生成）+ 圆角正交路径。
 *
 * 着色规范逐字照抄 velxio `wireColors.ts`（Wokwi 色彩约定）：
 *   VCC 红 / GND 黑 / 模拟蓝 / 数字绿 / PWM 紫 / I2C 金 / SPI 橙 / UART 青。
 * 布线：完整移植 velxio `wireAutoRoute.ts` 的 A* 迷宫算法 —— 在压缩的正交网格上
 *   A* 寻路，硬避开元件包围盒，对"并行贴线/垂直交叉/90° 拐弯"施加软代价，
 *   因此能绕开其它元件与既有导线（而非简单 L/Z 型）。
 * 渲染：照抄 velxio `wireUtils.ts` 的 roundedPathFromPoints —— 正交折线 + 圆角。
 */

import { CATALOG, WIRE_COLORS, mergeSignal, type SignalType } from "./catalog";
import type { Connection, Diagram, PinRef } from "./types";

// ==================== 信号着色 ====================

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

// ==================== 正交路径工具（移植 velxio wireUtils.ts） ====================

interface Point {
  x: number;
  y: number;
}

/** 角半径（世界 px），Wokwi 风格圆角 */
export const WIRE_BEND_RADIUS = 7;

/** 在非轴对齐的相邻点间插入 L 形角点，展开为渲染用的正交折线 */
export function expandOrthogonalPoints(points: Point[]): Point[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const out: Point[] = [{ ...points[0] }];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev.x !== curr.x && prev.y !== curr.y) {
      out.push({ x: curr.x, y: prev.y });
    }
    out.push({ ...curr });
  }
  return out;
}

/** 简化正交折线：去重、折叠共线/U 形三点 */
export function simplifyOrthogonalPath(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts.map((p) => ({ ...p }));
  const dedup: Point[] = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) dedup.push({ ...p });
  }
  let result = dedup;
  let changed = true;
  while (changed && result.length > 2) {
    changed = false;
    for (let i = 1; i < result.length - 1; i++) {
      const prev = result[i - 1];
      const curr = result[i];
      const next = result[i + 1];
      if ((prev.x === curr.x && curr.x === next.x) || (prev.y === curr.y && curr.y === next.y)) {
        result = [...result.slice(0, i), ...result.slice(i + 1)];
        changed = true;
        break;
      }
    }
  }
  return result;
}

/** 合并微抖动（拖拽留下的 <2px 偏移），照抄 velxio fuseMicroJogs */
const MICRO_JOG_EPS = 2;
export function fuseMicroJogs(pts: Point[], eps: number = MICRO_JOG_EPS): Point[] {
  const out = pts.map((p) => ({ ...p }));
  if (out.length < 4) return out;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i + 2 < out.length; i++) {
      const a = out[i - 1];
      const p = out[i];
      const q = out[i + 1];
      const b = out[i + 2];
      const beforeAnchored = i - 1 === 0;
      const afterAnchored = i + 2 === out.length - 1;
      if (
        p.y === q.y && p.x !== q.x && Math.abs(p.x - q.x) <= eps &&
        a.x === p.x && a.y !== p.y && b.x === q.x && b.y !== q.y
      ) {
        if (beforeAnchored && afterAnchored) continue;
        const moveAfter = beforeAnchored
          ? true
          : afterAnchored
            ? false
            : Math.abs(b.y - q.y) <= Math.abs(p.y - a.y);
        if (moveAfter) {
          q.x = p.x;
          b.x = p.x;
        } else {
          a.x = q.x;
          p.x = q.x;
        }
        changed = true;
      } else if (
        p.x === q.x && p.y !== q.y && Math.abs(p.y - q.y) <= eps &&
        a.y === p.y && a.x !== p.x && b.y === q.y && b.x !== q.x
      ) {
        if (beforeAnchored && afterAnchored) continue;
        const moveAfter = beforeAnchored
          ? true
          : afterAnchored
            ? false
            : Math.abs(b.x - q.x) <= Math.abs(p.x - a.x);
        if (moveAfter) {
          q.y = p.y;
          b.y = p.y;
        } else {
          a.y = q.y;
          p.y = q.y;
        }
        changed = true;
      }
    }
  }
  return out;
}

/** 正交折线 → 带圆角的 SVG path（照抄 velxio roundedPathFromPoints） */
export function roundedPathFromPoints(pts: Point[], radius: number = WIRE_BEND_RADIUS): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const corner = pts[i];
    const next = pts[i + 1];
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.75 || inLen === 0 || outLen === 0) {
      d += ` L ${corner.x} ${corner.y}`;
      continue;
    }
    const inX = corner.x - ((corner.x - prev.x) / inLen) * r;
    const inY = corner.y - ((corner.y - prev.y) / inLen) * r;
    const outX = corner.x + ((next.x - corner.x) / outLen) * r;
    const outY = corner.y + ((next.y - corner.y) / outLen) * r;
    d += ` L ${inX} ${inY} Q ${corner.x} ${corner.y} ${outX} ${outY}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** 由端点 + 拐点生成渲染路径（展开 → 简化 → 圆角） */
export function generateOrthogonalPath(
  start: Point,
  waypoints: Point[] | undefined,
  end: Point,
): string {
  const points: Point[] = [start, ...(waypoints ?? []), end];
  if (points.length < 2) return "";
  return roundedPathFromPoints(
    simplifyOrthogonalPath(fuseMicroJogs(expandOrthogonalPoints(points))),
  );
}

/** 长轴优先的 L 形拐点（连线预览用），照抄 velxio previewElbow */
export function previewElbow(from: Point, x: number, y: number): Point | null {
  const dx = Math.abs(x - from.x);
  const dy = Math.abs(y - from.y);
  if (dx === 0 || dy === 0) return null;
  return dx >= dy ? { x, y: from.y } : { x: from.x, y };
}

/** 规范化的存储拐点：展开/简化/去抖动后的内部角点 */
export function normalizeWireWaypoints(
  start: Point,
  waypoints: Point[],
  end: Point,
): Point[] {
  const simplified = simplifyOrthogonalPath(
    fuseMicroJogs(expandOrthogonalPoints([start, ...waypoints, end])),
  );
  return simplified.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
}

// ==================== A* 迷宫布线（移植 velxio wireAutoRoute.ts） ====================

export interface ObstacleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一根已有导线的轴对齐段 */
export interface WireSegment {
  a: Point;
  b: Point;
}

/** 路由与元件包围盒的间距 */
const ROUTE_MARGIN = 8;
/** 每个 90° 拐弯的额外代价 */
const BEND_PENALTY = 40;
/** 与既有导线的并行间距（小于此视为"贴线"） */
const WIRE_SEPARATION = 8;
/** 每 px 并行贴线代价 */
const OVERLAP_PENALTY_PER_PX = 2;
/** 垂直交叉固定代价 */
const CROSS_PENALTY = 12;
/** 只考虑此范围内的导线（压缩网格保持小巧） */
const WIRE_WINDOW_MARGIN = 120;
/** 网格坐标数上限，超过则退化为直接拐角 */
const MAX_COORDS_PER_AXIS = 256;

function inflate(r: ObstacleRect, m: number): ObstacleRect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

function rectContains(r: ObstacleRect, p: Point): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

type EscapeDir = "left" | "right" | "up" | "down";

/** 端点被多个矩形覆盖时，所有矩形往同一方向开逃生走廊 */
function unionEscapeDir(rects: ObstacleRect[], p: Point): EscapeDir {
  const containing = rects.filter((r) => rectContains(r, p));
  if (containing.length === 0) return "down";
  const dLeft = Math.max(...containing.map((r) => p.x - r.x));
  const dRight = Math.max(...containing.map((r) => r.x + r.w - p.x));
  const dTop = Math.max(...containing.map((r) => p.y - r.y));
  const dBottom = Math.max(...containing.map((r) => r.y + r.h - p.y));
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dBottom) return "down";
  if (min === dTop) return "up";
  if (min === dRight) return "right";
  return "left";
}

/** 端点所在矩形不能整体阻塞，改为开一条逃生走廊，返回剩余阻塞子矩形 */
function carveEscape(r: ObstacleRect, p: Point, dir?: EscapeDir): ObstacleRect[] {
  if (!rectContains(r, p)) return [r];
  const dLeft = p.x - r.x;
  const dRight = r.x + r.w - p.x;
  const dTop = p.y - r.y;
  const dBottom = r.y + r.h - p.y;
  let d: EscapeDir;
  if (dir) {
    d = dir;
  } else {
    const min = Math.min(dLeft, dRight, dTop, dBottom);
    d = min === dBottom ? "down" : min === dTop ? "up" : min === dRight ? "right" : "left";
  }
  const C = ROUTE_MARGIN;
  const out: ObstacleRect[] = [];
  const push = (x: number, y: number, w: number, h: number) => {
    if (w > 1 && h > 1) out.push({ x, y, w, h });
  };
  if (d === "down" || d === "up") {
    const corridorY = (d === "down" ? p.y : r.y) - (d === "down" ? 1 : 0);
    const corridorEnd = d === "down" ? r.y + r.h : p.y + 1;
    if (d === "down") push(r.x, r.y, r.w, dTop);
    else push(r.x, p.y, r.w, dBottom);
    push(r.x, corridorY, p.x - C - r.x, corridorEnd - corridorY);
    push(p.x + C, corridorY, r.x + r.w - (p.x + C), corridorEnd - corridorY);
  } else {
    const corridorX = (d === "right" ? p.x : r.x) - (d === "right" ? 1 : 0);
    const corridorEnd = d === "right" ? r.x + r.w : p.x + 1;
    if (d === "right") push(r.x, r.y, dLeft, r.h);
    else push(p.x, r.y, dRight, r.h);
    push(corridorX, r.y, corridorEnd - corridorX, p.y - C - r.y);
    push(corridorX, p.y + C, corridorEnd - corridorX, r.y + r.h - (p.y + C));
  }
  return out;
}

/** 轴对齐线段与矩形相交（恰好贴边不算） */
function segmentHitsRect(a: Point, b: Point, r: ObstacleRect): boolean {
  if (a.y === b.y) {
    if (!(a.y > r.y && a.y < r.y + r.h)) return false;
    return Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w;
  }
  if (a.x === b.x) {
    if (!(a.x > r.x && a.x < r.x + r.w)) return false;
    return Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h;
  }
  return false;
}

function pathClear(pts: Point[], rects: ObstacleRect[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    for (const r of rects) {
      if (segmentHitsRect(pts[i - 1], pts[i], r)) return false;
    }
  }
  return true;
}

function overlap1d(a1: number, a2: number, b1: number, b2: number): number {
  const lo = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const hi = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return Math.max(0, hi - lo);
}

/** 一条候选边相对既有导线的软代价（并行贴线按长度计费，交叉固定小额） */
function wireCostOfEdge(a: Point, b: Point, segs: WireSegment[]): number {
  let cost = 0;
  const horizontal = a.y === b.y;
  for (const s of segs) {
    const sHorizontal = s.a.y === s.b.y;
    if (horizontal === sHorizontal) {
      const gap = horizontal ? Math.abs(a.y - s.a.y) : Math.abs(a.x - s.a.x);
      if (gap < WIRE_SEPARATION) {
        const len = horizontal
          ? overlap1d(a.x, b.x, s.a.x, s.b.x)
          : overlap1d(a.y, b.y, s.a.y, s.b.y);
        cost += OVERLAP_PENALTY_PER_PX * len;
      }
    } else {
      const h = horizontal ? { a, b } : { a: s.a, b: s.b };
      const v = horizontal ? { a: s.a, b: s.b } : { a, b };
      const crosses =
        v.a.x > Math.min(h.a.x, h.b.x) &&
        v.a.x < Math.max(h.a.x, h.b.x) &&
        h.a.y > Math.min(v.a.y, v.b.y) &&
        h.a.y < Math.max(v.a.y, v.b.y);
      if (crosses) cost += CROSS_PENALTY;
    }
  }
  return cost;
}

function pathWireCost(pts: Point[], segs: WireSegment[]): number {
  let cost = 0;
  for (let i = 1; i < pts.length; i++) cost += wireCostOfEdge(pts[i - 1], pts[i], segs);
  return cost;
}

/** 最小二叉堆（按 f 排序） */
class Heap {
  private a: { f: number; s: number }[] = [];
  get size() {
    return this.a.length;
  }
  push(f: number, s: number) {
    const a = this.a;
    a.push({ f, s });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { f: number; s: number } {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* 迷宫布线：在压缩的正交网格上从 start 绕到 end，
 * 硬避开元件包围盒，软避开既有导线（可并行贴线/垂直交叉）。
 * 返回内部拐点数组；找不到或直接路径干净时返回 null。
 */
export function routeAroundObstacles(
  start: Point,
  end: Point,
  rawRects: ObstacleRect[],
  wireSegments: WireSegment[] = [],
): Point[] | null {
  const inflated = rawRects.map((r) => inflate(r, ROUTE_MARGIN));
  const startDir = unionEscapeDir(inflated, start);
  const endDir = unionEscapeDir(inflated, end);
  const rects = inflated
    .flatMap((r) => carveEscape(r, start, startDir))
    .flatMap((r) => carveEscape(r, end, endDir));

  const winX0 = Math.min(start.x, end.x) - WIRE_WINDOW_MARGIN;
  const winX1 = Math.max(start.x, end.x) + WIRE_WINDOW_MARGIN;
  const winY0 = Math.min(start.y, end.y) - WIRE_WINDOW_MARGIN;
  const winY1 = Math.max(start.y, end.y) + WIRE_WINDOW_MARGIN;
  const near = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1;
  const segs = wireSegments.filter((s) => {
    if (near(s.a, start) || near(s.b, start) || near(s.a, end) || near(s.b, end)) return false;
    const sx0 = Math.min(s.a.x, s.b.x);
    const sx1 = Math.max(s.a.x, s.b.x);
    const sy0 = Math.min(s.a.y, s.b.y);
    const sy1 = Math.max(s.a.y, s.b.y);
    return sx1 >= winX0 && sx0 <= winX1 && sy1 >= winY0 && sy0 <= winY1;
  });

  if (rects.length === 0 && segs.length === 0) return null;

  const elbow = previewElbow(start, end.x, end.y);
  const direct = elbow ? [start, elbow, end] : [start, end];
  if (pathClear(direct, rects) && pathWireCost(direct, segs) === 0) return null;
  if (elbow) {
    const alt = elbow.x === end.x ? { x: start.x, y: end.y } : { x: end.x, y: start.y };
    const altPath = [start, alt, end];
    if (pathClear(altPath, rects) && pathWireCost(altPath, segs) === 0) return [alt];
  }

  const xsSet = new Set<number>([start.x, end.x]);
  const ysSet = new Set<number>([start.y, end.y]);
  for (const r of rects) {
    xsSet.add(r.x);
    xsSet.add(r.x + r.w);
    ysSet.add(r.y);
    ysSet.add(r.y + r.h);
  }
  for (const s of segs) {
    if (s.a.y === s.b.y) {
      ysSet.add(s.a.y - WIRE_SEPARATION);
      ysSet.add(s.a.y + WIRE_SEPARATION);
    } else {
      xsSet.add(s.a.x - WIRE_SEPARATION);
      xsSet.add(s.a.x + WIRE_SEPARATION);
    }
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  if (xs.length > MAX_COORDS_PER_AXIS || ys.length > MAX_COORDS_PER_AXIS) return null;

  const cols = xs.length;
  const rows = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const nodeId = (cx: number, cy: number, dir: number) => (cy * cols + cx) * 3 + dir;
  const startCx = xi.get(start.x)!;
  const startCy = yi.get(start.y)!;
  const endCx = xi.get(end.x)!;
  const endCy = yi.get(end.y)!;

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const h = (cx: number, cy: number) => Math.abs(xs[cx] - end.x) + Math.abs(ys[cy] - end.y);

  const heap = new Heap();
  const s0 = nodeId(startCx, startCy, 0);
  dist.set(s0, 0);
  heap.push(h(startCx, startCy), s0);

  const stepClear = (a: Point, b: Point) => rects.every((r) => !segmentHitsRect(a, b, r));

  let goal = -1;
  while (heap.size) {
    const { s } = heap.pop();
    const dir = s % 3;
    const node = (s - dir) / 3;
    const cx = node % cols;
    const cy = (node - cx) / cols;
    const d = dist.get(s)!;
    if (cx === endCx && cy === endCy) {
      goal = s;
      break;
    }
    const neighbors: Array<[number, number, number]> = [
      [cx - 1, cy, 1],
      [cx + 1, cy, 1],
      [cx, cy - 1, 2],
      [cx, cy + 1, 2],
    ];
    for (const [nx, ny, ndir] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const a = { x: xs[cx], y: ys[cy] };
      const b = { x: xs[nx], y: ys[ny] };
      if (!stepClear(a, b)) continue;
      const bend = dir !== 0 && dir !== ndir ? BEND_PENALTY : 0;
      const nd = d + Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + bend + wireCostOfEdge(a, b, segs);
      const ns = nodeId(nx, ny, ndir);
      if (nd < (dist.get(ns) ?? Infinity)) {
        dist.set(ns, nd);
        prev.set(ns, s);
        heap.push(nd + h(nx, ny), ns);
      }
    }
  }
  if (goal < 0) return null;

  const pts: Point[] = [];
  for (let s: number | undefined = goal; s !== undefined; s = prev.get(s)) {
    const dir = s % 3;
    const node = (s - dir) / 3;
    const cx = node % cols;
    pts.push({ x: xs[cx], y: ys[(node - cx) / cols] });
  }
  pts.reverse();
  const simplified = simplifyOrthogonalPath(pts);
  return simplified.slice(1, -1);
}

// ==================== 高层封装（面向我们的 Diagram） ====================

/** 收集当前图纸里的元件包围盒（排除连线两端所在元件） */
export function collectObstacles(
  diagram: Diagram,
  excludePartIds: string[],
): ObstacleRect[] {
  const skip = new Set(excludePartIds);
  return diagram.parts
    .filter((p) => !skip.has(p.id))
    .map((p) => {
      const def = CATALOG[p.type];
      return { x: p.x, y: p.y, w: def.w, h: def.h };
    });
}

/** 把当前图纸的全部连线展开为轴对齐线段（可排除一条） */
export function collectWireSegments(
  diagram: Diagram,
  excludeIndex?: number,
): WireSegment[] {
  const segs: WireSegment[] = [];
  diagram.connections.forEach((c, i) => {
    if (excludeIndex !== undefined && i === excludeIndex) return;
    const p1 = diagram.parts.find((p) => p.id === c.from.part);
    const p2 = diagram.parts.find((p) => p.id === c.to.part);
    if (!p1 || !p2) return;
    const a = CATALOG[p1.type].pins.find((p) => p.id === c.from.pin);
    const b = CATALOG[p2.type].pins.find((p) => p.id === c.to.pin);
    if (!a || !b) return;
    const start = { x: p1.x + a.x, y: p1.y + a.y };
    const end = { x: p2.x + b.x, y: p2.y + b.y };
    const pts = simplifyOrthogonalPath(
      expandOrthogonalPoints([start, ...(c.waypoints ?? []), end]),
    );
    for (let k = 1; k < pts.length; k++) {
      const s1 = pts[k - 1];
      const s2 = pts[k];
      if (s1.x === s2.x || s1.y === s2.y) segs.push({ a: s1, b: s2 });
    }
  });
  return segs;
}

/**
 * 新建连线时自动生成 A* 布线路径。
 * 返回规范化的存储拐点；直接路径干净时返回空数组（不存拐点）。
 */
export function autoRoute(
  diagram: Diagram,
  from: PinRef,
  to: PinRef,
  excludeIndex?: number,
): Array<{ x: number; y: number }> {
  const p1 = diagram.parts.find((p) => p.id === from.part);
  const p2 = diagram.parts.find((p) => p.id === to.part);
  if (!p1 || !p2) return [];
  const d1 = CATALOG[p1.type]?.pins.find((p) => p.id === from.pin);
  const d2 = CATALOG[p2.type]?.pins.find((p) => p.id === to.pin);
  if (!d1 || !d2) return [];
  const start = { x: p1.x + d1.x, y: p1.y + d1.y };
  const end = { x: p2.x + d2.x, y: p2.y + d2.y };
  const obstacles = collectObstacles(diagram, [from.part, to.part]);
  const wireSegs = collectWireSegments(diagram, excludeIndex);
  const route = routeAroundObstacles(start, end, obstacles, wireSegs);
  if (!route) return [];
  return normalizeWireWaypoints(start, route, end);
}

/** 旧接口兼容：直接点坐标的 L/Z 型（保留给单元测试） */
export function simpleElbowRoute(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const gap = 16;
  const wp: Array<{ x: number; y: number }> = [];
  if (dx !== 0 && dy !== 0) {
    wp.push({ x: from.x + Math.sign(dx) * Math.max(Math.abs(dx) / 2, gap), y: from.y });
  }
  return wp;
}

/** 由连线生成渲染路径（圆角正交） */
export function waypointPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  waypoints: Array<{ x: number; y: number }>,
): string {
  return generateOrthogonalPath(from, waypoints, to);
}

/** 线段是否与某点接近（命中检测） */
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
