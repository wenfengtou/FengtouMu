import { describe, expect, it } from "vitest";
import { CATALOG, boardPinByBoardPin, boardPinByGpio, DEVKITC_PINMAP, partDef } from "../catalog";
import type { PartType } from "../types";

const TYPES: PartType[] = [
  "board-devkitc",
  "led",
  "resistor",
  "pushbutton",
  "switch",
  "buzzer",
  "potentiometer",
];

describe("元件目录", () => {
  it("板级引脚与 PICSimLab 的 DevKitC 定义一致", () => {
    expect(boardPinByBoardPin(24)?.gpio).toBe(2);
    expect(boardPinByBoardPin(25)?.gpio).toBe(0);
    expect(boardPinByBoardPin(14)?.kind).toBe("gnd");
    expect(boardPinByGpio(2)?.boardPin).toBe(24);
  });

  it("底板暴露 32 个 GPIO 引脚与 6 个非 GPIO 引脚", () => {
    const gpioPins = CATALOG["board-devkitc"].pins.filter((p) => p.kind === "gpio");
    expect(gpioPins).toHaveLength(32);
    expect(CATALOG["board-devkitc"].pins).toHaveLength(38);
    expect(DEVKITC_PINMAP.filter((v) => v >= 0)).toHaveLength(32);
  });

  it("每种元件的引脚 id 唯一，且坐标落在元件范围内", () => {
    for (const type of TYPES) {
      const def = partDef(type);
      const ids = def.pins.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of def.pins) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(def.w);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(def.h);
      }
    }
  });

  it("电阻被标记为电气透传，底板被标记为固定件", () => {
    expect(partDef("resistor").passThrough).toBe(true);
    expect(partDef("board-devkitc").fixed).toBe(true);
    expect(partDef("led").passThrough).toBeUndefined();
  });

  it("拨动开关默认断开，蜂鸣器为两端元件", () => {
    const sw = partDef("switch");
    expect(sw.pins.map((p) => p.id)).toEqual(["1", "2"]);
    expect(sw.attrs).toEqual({ closed: 0 });
    const bz = partDef("buzzer");
    expect(bz.pins.map((p) => p.id)).toEqual(["1", "2"]);
    expect(bz.passThrough).toBeUndefined();
  });
});
