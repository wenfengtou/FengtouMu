import { describe, expect, it } from "vitest";
import { buildNetlist, netGpios, netHasGnd, netSize } from "../netlist";
import type { Diagram } from "../types";

const board = { id: "esp", type: "board-devkitc" as const, x: 0, y: 0 };
const led = { id: "led1", type: "led" as const, x: 0, y: 0 };
const resistor = { id: "r1", type: "resistor" as const, x: 0, y: 0 };

function diagram(connections: Diagram["connections"]): Diagram {
  return { version: 1, parts: [board, led, resistor], connections };
}

describe("网表构建", () => {
  it("直接相连的引脚属于同一网络，并能识别 GPIO", () => {
    const d = diagram([{ from: { part: "esp", pin: "GPIO2" }, to: { part: "led1", pin: "A" } }]);
    const nl = buildNetlist(d);
    expect(netGpios(nl, { part: "led1", pin: "A" })).toContain(2);
    expect(netSize(nl, { part: "led1", pin: "A" })).toBe(2);
  });

  it("电阻在网表中透传，串联后仍能识别 GPIO", () => {
    const d = diagram([
      { from: { part: "esp", pin: "GPIO2" }, to: { part: "r1", pin: "a" } },
      { from: { part: "r1", pin: "b" }, to: { part: "led1", pin: "A" } },
    ]);
    const nl = buildNetlist(d);
    expect(netGpios(nl, { part: "led1", pin: "A" })).toContain(2);
    expect(netGpios(nl, { part: "r1", pin: "a" })).toEqual(netGpios(nl, { part: "led1", pin: "A" }));
  });

  it("接地引脚所在网络会被标记为 GND", () => {
    const d = diagram([{ from: { part: "led1", pin: "C" }, to: { part: "esp", pin: "GND.1" } }]);
    const nl = buildNetlist(d);
    expect(netHasGnd(nl, { part: "led1", pin: "C" })).toBe(true);
  });

  it("未接线的引脚自成一个网络", () => {
    const nl = buildNetlist(diagram([]));
    expect(netSize(nl, { part: "led1", pin: "A" })).toBe(1);
    expect(netGpios(nl, { part: "led1", pin: "A" })).toEqual([]);
  });
});
