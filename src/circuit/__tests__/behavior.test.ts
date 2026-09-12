import { describe, expect, it } from "vitest";
import {
  ADC_MAX,
  adcChannelOfGpio,
  adcRaw,
  buttonInjection,
  computeVisuals,
  potInjection,
  type BehaviorInput,
} from "../behavior";
import { buildNetlist } from "../netlist";
import type { BoardPinState, Diagram } from "../types";

const BOARD_PIN_GPIO2 = 24;
const BOARD_PIN_GPIO0 = 25;

function pin(state: Partial<BoardPinState>): BoardPinState {
  return { pin: BOARD_PIN_GPIO2, gpio: 2, value: 0, dir: 1, ...state };
}

function input(
  connections: Diagram["connections"],
  parts: Diagram["parts"],
  pins: Map<number, BoardPinState>,
  extra: Partial<BehaviorInput> = {},
): BehaviorInput {
  const diagram: Diagram = { version: 1, parts, connections };
  return {
    diagram,
    netlist: buildNetlist(diagram),
    pins,
    pressed: null,
    potValues: {},
    ...extra,
  };
}

const board = { id: "esp", type: "board-devkitc" as const, x: 0, y: 0 };

describe("LED 外观", () => {
  it("正极接高电平 GPIO、负极接地时点亮", () => {
    const ctx = input(
      [
        { from: { part: "esp", pin: "GPIO2" }, to: { part: "led1", pin: "A" } },
        { from: { part: "led1", pin: "C" }, to: { part: "esp", pin: "GND.1" } },
      ],
      [board, { id: "led1", type: "led", x: 0, y: 0 }],
      new Map([[BOARD_PIN_GPIO2, pin({ value: 1 })]]),
    );
    const visual = computeVisuals(ctx).get("led1");
    expect(visual).toEqual({ kind: "led", lit: true, color: "red" });
  });

  it("GPIO 为低电平时不亮", () => {
    const ctx = input(
      [
        { from: { part: "esp", pin: "GPIO2" }, to: { part: "led1", pin: "A" } },
        { from: { part: "led1", pin: "C" }, to: { part: "esp", pin: "GND.1" } },
      ],
      [board, { id: "led1", type: "led", x: 0, y: 0 }],
      new Map([[BOARD_PIN_GPIO2, pin({ value: 0 })]]),
    );
    const visual = computeVisuals(ctx).get("led1");
    expect(visual?.kind === "led" && visual.lit).toBe(false);
  });

  it("未接线时不亮", () => {
    const ctx = input([], [board, { id: "led1", type: "led", x: 0, y: 0 }], new Map());
    const visual = computeVisuals(ctx).get("led1");
    expect(visual?.kind === "led" && visual.lit).toBe(false);
  });
});

describe("按键注入", () => {
  const parts = [board, { id: "sw1", type: "pushbutton" as const, x: 0, y: 0 }];
  const conns: Diagram["connections"] = [
    { from: { part: "sw1", pin: "A" }, to: { part: "esp", pin: "GPIO0" } },
    { from: { part: "sw1", pin: "B" }, to: { part: "esp", pin: "GND.1" } },
  ];

  it("按下时把 GPIO0 拉低，松开时恢复高电平", () => {
    const ctx = input(conns, parts, new Map());
    expect(buttonInjection(ctx, "sw1", true)).toEqual({
      boardPin: BOARD_PIN_GPIO0,
      gpio: 0,
      value: 0,
    });
    expect(buttonInjection(ctx, "sw1", false)).toEqual({
      boardPin: BOARD_PIN_GPIO0,
      gpio: 0,
      value: 1,
    });
  });

  it("未连接到 GPIO 时不产生注入", () => {
    const ctx = input(
      [{ from: { part: "sw1", pin: "B" }, to: { part: "esp", pin: "GND.1" } }],
      parts,
      new Map(),
    );
    expect(buttonInjection(ctx, "sw1", true)).toBeNull();
  });
});

describe("电位器注入", () => {
  const parts = [
    board,
    { id: "pot1", type: "potentiometer" as const, x: 0, y: 0, attrs: { value: 50 } },
  ];
  const conns: Diagram["connections"] = [
    { from: { part: "pot1", pin: "SIG" }, to: { part: "esp", pin: "GPIO34" } },
  ];

  it("按 GPIO34 的 SAR 通道注入 12 位读数", () => {
    const ctx = input(conns, parts, new Map());
    const inj = potInjection(ctx, "pot1", 0.5);
    expect(inj).toEqual({ channel: adcChannelOfGpio(34), raw: Math.round(0.5 * ADC_MAX), gpio: 34 });
    expect(inj?.channel).toBe(6);
    expect(inj?.raw).toBe(2048);
  });

  it("SIG 未接到 ADC 引脚时不注入", () => {
    const ctx = input(
      [{ from: { part: "pot1", pin: "SIG" }, to: { part: "esp", pin: "GND.1" } }],
      parts,
      new Map(),
    );
    expect(potInjection(ctx, "pot1", 0.5)).toBeNull();
  });

  it("读数换算在边界处收敛", () => {
    expect(adcRaw(-1)).toBe(0);
    expect(adcRaw(0)).toBe(0);
    expect(adcRaw(1)).toBe(ADC_MAX);
    expect(adcRaw(2)).toBe(ADC_MAX);
    expect(adcRaw(Number.NaN)).toBe(0);
  });
});

describe("电位器外观", () => {
  it("未记录位置时回落到属性值", () => {
    const ctx = input(
      [],
      [board, { id: "pot1", type: "potentiometer", x: 0, y: 0, attrs: { value: 30 } }],
      new Map(),
    );
    const visual = computeVisuals(ctx).get("pot1");
    expect(visual).toEqual({ kind: "potentiometer", value: 0.3 });
  });
});
