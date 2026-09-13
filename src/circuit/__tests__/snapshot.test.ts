/**
 * 网表快照：固定一个"标准教学电路"，把构建结果做成 golden snapshot。
 *
 * 任何会改变网表语义的改动（元件目录、透传规则、导线合并、板级引脚表）都会让
 * 快照对不上，从而提醒人工复核 —— 这是 M3-4 测试矩阵里"网表快照"一项。
 */

import { describe, expect, it } from "vitest";
import { buildNetlist } from "../netlist";
import type { Diagram } from "../types";

/** 标准教学电路：LED 接 D2/GND；按键接 D0/GND；电阻串在 D2 与 LED 之间 */
const DIAGRAM: Diagram = {
  version: 1,
  parts: [
    { id: "esp", type: "board-devkitc", x: 40, y: 40 },
    { id: "r1", type: "resistor", x: 260, y: 160 },
    { id: "led1", type: "led", x: 380, y: 160, attrs: { color: "red" } },
    { id: "sw1", type: "pushbutton", x: 380, y: 300 },
  ],
  connections: [
    { from: { part: "esp", pin: "D2" }, to: { part: "r1", pin: "a" }, color: "green" },
    { from: { part: "r1", pin: "b" }, to: { part: "led1", pin: "A" }, color: "green" },
    { from: { part: "led1", pin: "C" }, to: { part: "esp", pin: "GND.1" }, color: "green" },
    { from: { part: "esp", pin: "D0" }, to: { part: "sw1", pin: "A" }, color: "green" },
    { from: { part: "sw1", pin: "B" }, to: { part: "esp", pin: "GND.2" }, color: "green" },
  ],
};

function stableSnapshot(diagram: Diagram) {
  const net = buildNetlist(diagram);
  return {
    netCount: net.nets.length,
    nets: net.nets.map((n) => ({
      nodes: [...n.nodes].sort(),
      boardPins: [...n.boardPins].sort((a, b) => a - b),
      gpios: [...n.gpios].sort((a, b) => a - b),
      hasGnd: n.hasGnd,
      hasVcc: n.hasVcc,
    })),
  };
}

describe("网表快照", () => {
  it("标准教学电路的网表结构保持稳定", () => {
    expect(stableSnapshot(DIAGRAM)).toMatchSnapshot("标准教学电路网表");
  });

  it("空图只有底板：38 个引脚各自成网，互不相连", () => {
    const net = buildNetlist({
      version: 1,
      parts: [{ id: "esp", type: "board-devkitc", x: 40, y: 40 }],
      connections: [],
    });
    expect(net.nets.length).toBe(38);
    expect(net.nets.every((n) => n.nodes.length === 1 && n.boardPins.length === 1)).toBe(true);
  });
});
