import { describe, expect, it } from "vitest";
import { buildNetlist, netGpios, netHasGnd, netPullLevel, netSize } from "../netlist";
import type { Diagram } from "../types";

const board = { id: "esp", type: "board-devkitc" as const, x: 0, y: 0 };
const led = { id: "led1", type: "led" as const, x: 0, y: 0 };
const resistor = { id: "r1", type: "resistor" as const, x: 0, y: 0 };
const switchOpen = { id: "tgl1", type: "switch" as const, x: 0, y: 0, attrs: { closed: 0 } };
const switchClosed = { id: "tgl1", type: "switch" as const, x: 0, y: 0, attrs: { closed: 1 } };

function diagram(connections: Diagram["connections"], parts: Diagram["parts"]): Diagram {
  return { version: 1, parts, connections };
}

describe("网表构建", () => {
  it("直接相连的引脚属于同一网络，并能识别 GPIO", () => {
    const d = diagram(
      [{ from: { part: "esp", pin: "D2" }, to: { part: "led1", pin: "A" } }],
      [board, led],
    );
    const nl = buildNetlist(d);
    expect(netGpios(nl, { part: "led1", pin: "A" })).toContain(2);
    expect(netSize(nl, { part: "led1", pin: "A" })).toBe(2);
  });

  it("电阻在网表中透传，串联后仍能识别 GPIO", () => {
    const d = diagram(
      [
        { from: { part: "esp", pin: "D2" }, to: { part: "r1", pin: "a" } },
        { from: { part: "r1", pin: "b" }, to: { part: "led1", pin: "A" } },
      ],
      [board, led, resistor],
    );
    const nl = buildNetlist(d);
    expect(netGpios(nl, { part: "led1", pin: "A" })).toContain(2);
    expect(netGpios(nl, { part: "r1", pin: "a" })).toEqual(netGpios(nl, { part: "led1", pin: "A" }));
  });

  it("接地引脚所在网络会被标记为 GND", () => {
    const d = diagram(
      [{ from: { part: "led1", pin: "C" }, to: { part: "esp", pin: "GND.1" } }],
      [board, led],
    );
    const nl = buildNetlist(d);
    expect(netHasGnd(nl, { part: "led1", pin: "C" })).toBe(true);
  });

  it("未接线的引脚自成一个网络", () => {
    const nl = buildNetlist(diagram([], [board, led]));
    expect(netSize(nl, { part: "led1", pin: "A" })).toBe(1);
    expect(netGpios(nl, { part: "led1", pin: "A" })).toEqual([]);
  });
});

describe("拨动开关透传", () => {
  const conns: Diagram["connections"] = [
    { from: { part: "esp", pin: "D2" }, to: { part: "tgl1", pin: "1" } },
    { from: { part: "tgl1", pin: "2" }, to: { part: "led1", pin: "A" } },
  ];

  it("断开时两端各自成网，GPIO 不传导", () => {
    const nl = buildNetlist(diagram(conns, [board, led, switchOpen]));
    expect(netGpios(nl, { part: "led1", pin: "A" })).toEqual([]);
    expect(netGpios(nl, { part: "tgl1", pin: "1" })).toContain(2);
    expect(netSize(nl, { part: "led1", pin: "A" })).toBe(2); // 只与开关脚相连
  });

  it("闭合时两端导通，GPIO 传导到对侧", () => {
    const nl = buildNetlist(diagram(conns, [board, led, switchClosed]));
    expect(netGpios(nl, { part: "led1", pin: "A" })).toContain(2);
  });
});

describe("电阻上拉/下拉语义", () => {
  it("GPIO 经电阻接 3V3 时识别为上拉", () => {
    const d = diagram(
      [
        { from: { part: "esp", pin: "D2" }, to: { part: "r1", pin: "a" } },
        { from: { part: "r1", pin: "b" }, to: { part: "esp", pin: "3V3" } },
      ],
      [board, resistor],
    );
    const nl = buildNetlist(d);
    expect(netPullLevel(nl, { part: "esp", pin: "D2" })).toBe("pullup");
  });

  it("GPIO 经电阻接 GND 时识别为下拉", () => {
    const d = diagram(
      [
        { from: { part: "esp", pin: "D2" }, to: { part: "r1", pin: "a" } },
        { from: { part: "r1", pin: "b" }, to: { part: "esp", pin: "GND.1" } },
      ],
      [board, resistor],
    );
    const nl = buildNetlist(d);
    expect(netPullLevel(nl, { part: "esp", pin: "D2" })).toBe("pulldown");
  });

  it("电阻分压节点（上拉+下拉）识别为 divider", () => {
    const d = diagram(
      [
        { from: { part: "esp", pin: "3V3" }, to: { part: "r1", pin: "a" } },
        { from: { part: "r1", pin: "b" }, to: { part: "esp", pin: "D34" } },
        { from: { part: "r2", pin: "a" }, to: { part: "esp", pin: "D34" } },
        { from: { part: "r2", pin: "b" }, to: { part: "esp", pin: "GND.2" } },
      ],
      [board, { ...resistor, id: "r1" }, { ...resistor, id: "r2" }],
    );
    const nl = buildNetlist(d);
    expect(netPullLevel(nl, { part: "esp", pin: "D34" })).toBe("divider");
  });

  it("直接接 3V3（无电阻）不算上拉语义", () => {
    const d = diagram(
      [{ from: { part: "esp", pin: "D2" }, to: { part: "esp", pin: "3V3" } }],
      [board],
    );
    const nl = buildNetlist(d);
    expect(netPullLevel(nl, { part: "esp", pin: "D2" })).toBeNull();
  });
});
