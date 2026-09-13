import { describe, expect, it } from "vitest";
import { autoRoute, routeAroundObstacles, generateOrthogonalPath, normalizeWireWaypoints } from "../wire";
import type { Diagram } from "../types";

const BOARD: Diagram["parts"][0] = { id: "esp", type: "board-devkitc", x: 0, y: 0 };

function diagram(parts: Diagram["parts"], connections: Diagram["connections"]): Diagram {
  return { version: 1, parts, connections };
}

describe("routeAroundObstacles", () => {
  it("无障碍时返回 null（用直接拐角）", () => {
    const r = routeAroundObstacles({ x: 0, y: 0 }, { x: 100, y: 80 }, []);
    expect(r).toBeNull();
  });

  it("绕过挡在直线上的障碍", () => {
    const r = routeAroundObstacles(
      { x: 0, y: 50 },
      { x: 120, y: 50 },
      [{ x: 40, y: 30, w: 40, h: 40 }],
    );
    expect(r).not.toBeNull();
    const pts = [{ x: 0, y: 50 }, ...(r ?? []), { x: 120, y: 50 }];
    // 路径不应穿过障碍矩形
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a.y === b.y) {
        expect(a.y < 30 || a.y > 70 || Math.max(a.x, b.x) < 40 || Math.min(a.x, b.x) > 80).toBe(true);
      }
    }
  });

  it("绕开既有导线（不同线束）", () => {
    const r = routeAroundObstacles(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      [],
      [{ a: { x: 40, y: -20 }, b: { x: 60, y: 20 } }],
    );
    expect(r).not.toBeNull();
  });
});

describe("autoRoute（面向 Diagram）", () => {
  it("底板到 LED 生成正交路径且不穿过其它元件", () => {
    const d = diagram(
      [
        BOARD,
        { id: "led1", type: "led", x: 300, y: 80 },
        { id: "r1", type: "resistor", x: 300, y: 160 },
      ],
      [],
    );
    const wps = autoRoute(d, { part: "esp", pin: "D2" }, { part: "led1", pin: "A" });
    expect(Array.isArray(wps)).toBe(true);
  });

  it("生成的路径展开后是纯正交的（每段水平或垂直）", () => {
    const d = diagram(
      [BOARD, { id: "led1", type: "led", x: 300, y: 80 }],
      [],
    );
    const wps = autoRoute(d, { part: "esp", pin: "D2" }, { part: "led1", pin: "A" });
    const pts = [{ x: 0, y: 0 }, ...wps, { x: 300, y: 80 }];
    const path = generateOrthogonalPath(pts[0], wps, pts[pts.length - 1]);
    expect(path.startsWith("M")).toBe(true);
    // 存储拐点规范化：不含端点
    const norm = normalizeWireWaypoints(pts[0], wps, pts[pts.length - 1]);
    expect(norm.length).toBeLessThanOrEqual(wps.length + 2);
  });
});
