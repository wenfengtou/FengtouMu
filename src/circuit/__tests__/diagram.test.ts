import { describe, expect, it } from "vitest";
import { parseDiagram, serializeDiagram, validateDiagram } from "../diagram";
import type { Diagram } from "../types";

const sample: Diagram = {
  version: 1,
  parts: [
    { id: "esp", type: "board-devkitc", x: 40, y: 40 },
    { id: "led1", type: "led", x: 300, y: 80, attrs: { color: "green" } },
    { id: "r1", type: "resistor", x: 300, y: 160, attrs: { value: "220" } },
  ],
  connections: [
    { from: { part: "esp", pin: "GPIO2" }, to: { part: "r1", pin: "a" }, color: "green" },
    { from: { part: "r1", pin: "b" }, to: { part: "led1", pin: "A" } },
    { from: { part: "led1", pin: "C" }, to: { part: "esp", pin: "GND.1" } },
  ],
};

describe("diagram.json 读写", () => {
  it("序列化后能原样解析回来", () => {
    const { diagram, errors } = parseDiagram(serializeDiagram(sample));
    // 导线颜色在导出时统一写为 green，这里按同样的默认值归一后比较
    const normalize = (d: Diagram): Diagram => ({
      ...d,
      connections: d.connections.map((c) => ({ ...c, color: c.color ?? "green" })),
    });
    expect(errors).toEqual([]);
    expect(normalize(diagram)).toEqual(normalize(sample));
  });

  it("导出的文件是可读 JSON 且包含 Wokwi 风格字段", () => {
    const text = serializeDiagram(sample);
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(raw.version).toBe(1);
    const parts = raw.parts as Array<Record<string, unknown>>;
    expect(parts[1]).toMatchObject({ type: "wokwi-led", id: "led1", left: 300, top: 80 });
    const conns = raw.connections as unknown[][];
    expect(conns[0][0]).toBe("esp:GPIO2");
    expect(conns[0][1]).toBe("r1:a");
  });

  it("缺少底板时自动补上", () => {
    const text = JSON.stringify({
      version: 1,
      parts: [{ type: "wokwi-led", id: "led1", left: 10, top: 10 }],
      connections: [],
    });
    const { diagram } = parseDiagram(text);
    expect(diagram.parts.some((p) => p.type === "board-devkitc")).toBe(true);
  });

  it("无法识别的元件类型会报错并跳过", () => {
    const text = JSON.stringify({
      version: 1,
      parts: [
        { type: "wokwi-servo", id: "servo1", left: 0, top: 0 },
        { type: "wokwi-led", id: "led1", left: 0, top: 0 },
      ],
      connections: [],
    });
    const { diagram, errors } = parseDiagram(text);
    expect(errors.some((e) => e.includes("元件类型无法识别"))).toBe(true);
    expect(diagram.parts.some((p) => p.id === "servo1")).toBe(false);
    expect(diagram.parts.some((p) => p.id === "led1")).toBe(true);
  });

  it("重复 id 会报错", () => {
    const text = JSON.stringify({
      version: 1,
      parts: [
        { type: "wokwi-led", id: "dup", left: 0, top: 0 },
        { type: "wokwi-led", id: "dup", left: 10, top: 10 },
      ],
      connections: [],
    });
    const { errors } = parseDiagram(text);
    expect(errors.some((e) => e.includes("id 重复"))).toBe(true);
  });

  it("非法引脚名会报错并跳过该连线", () => {
    const text = JSON.stringify({
      version: 1,
      parts: [{ type: "wokwi-led", id: "led1", left: 0, top: 0 }],
      connections: [["esp:GPIO2", "led1:XYZ", "green", []]],
    });
    const { diagram, errors } = parseDiagram(text);
    expect(errors.some((e) => e.includes("引脚名无效"))).toBe(true);
    expect(diagram.connections).toEqual([]);
  });

  it("兼容 Wokwi 的引脚别名", () => {
    const text = JSON.stringify({
      version: 1,
      parts: [
        { type: "wokwi-resistor", id: "r1", left: 0, top: 0 },
        { type: "wokwi-pushbutton", id: "sw1", left: 0, top: 0 },
        { type: "wokwi-potentiometer", id: "pot1", left: 0, top: 0 },
      ],
      connections: [
        ["esp:GPIO2", "r1:1", "green", []],
        ["r1:2", "sw1:1.l", "green", []],
        ["pot1:2", "esp:GPIO34", "green", []],
        ["pot1:1", "esp:3V3", "red", []],
        ["pot1:3", "esp:GND.1", "black", []],
      ],
    });
    const { diagram, errors } = parseDiagram(text);
    expect(errors).toEqual([]);
    expect(diagram.connections.map((c) => `${c.from.pin}->${c.to.pin}`)).toEqual([
      "GPIO2->a",
      "b->A",
      "SIG->GPIO34",
      "VCC->3V3",
      "GND->GND.1",
    ]);
  });

  it("非 JSON 内容会给出可读错误", () => {
    const { errors } = parseDiagram("{ 这不是 json }");
    expect(errors[0]).toBe("文件不是合法的 JSON");
  });

  it("validateDiagram 能发现缺失元件与非法引脚", () => {
    const broken: Diagram = {
      version: 1,
      parts: [{ id: "esp", type: "board-devkitc", x: 0, y: 0 }],
      connections: [{ from: { part: "esp", pin: "GPIO2" }, to: { part: "led1", pin: "A" } }],
    };
    const issues = validateDiagram(broken);
    expect(issues.some((i) => i.includes("终点元件不存在"))).toBe(true);
  });

  it("拨动开关与蜂鸣器可以往返序列化", () => {
    const d: Diagram = {
      version: 1,
      parts: [
        { id: "esp", type: "board-devkitc", x: 40, y: 40 },
        { id: "tgl1", type: "switch", x: 300, y: 80, attrs: { closed: 1 } },
        { id: "bz1", type: "buzzer", x: 300, y: 160 },
      ],
      connections: [
        { from: { part: "esp", pin: "GPIO2" }, to: { part: "tgl1", pin: "1" } },
        { from: { part: "tgl1", pin: "2" }, to: { part: "bz1", pin: "1" } },
      ],
    };
    const text = serializeDiagram(d);
    const raw = JSON.parse(text) as {
      parts: Array<Record<string, unknown>>;
    };
    const tgl = raw.parts.find((p) => p.id === "tgl1");
    expect(tgl?.type).toBe("wokwi-slide-switch");
    expect(tgl?.attrs).toEqual({ switch: { position: 1 } });
    expect(raw.parts.find((p) => p.id === "bz1")?.type).toBe("wokwi-buzzer");

    const { diagram, errors } = parseDiagram(text);
    expect(errors).toEqual([]);
    expect(diagram.parts.find((p) => p.id === "tgl1")?.attrs?.closed).toBe(1);
    expect(diagram.connections).toHaveLength(2);
  });

  it("导入 Wokwi 拨动开关时读取嵌套 attrs.switch.position", () => {
    const text = JSON.stringify({
      version: 1,
      parts: [{ type: "wokwi-slide-switch", id: "tgl1", left: 10, top: 10, attrs: { switch: { position: 1 } } }],
      connections: [["tgl1:1", "esp:GPIO2", "green", []]],
    });
    const { diagram, errors } = parseDiagram(text);
    expect(errors).toEqual([]);
    const tgl = diagram.parts.find((p) => p.id === "tgl1");
    expect(tgl?.type).toBe("switch");
    expect(tgl?.attrs?.closed).toBe(1);
    expect(diagram.connections[0].from.pin).toBe("1");
  });

  it("导入 Wokwi DIP 开关与蜂鸣器别名", () => {
    const text = JSON.stringify({
      version: 1,
      parts: [
        { type: "wokwi-dip-switch-4", id: "dip1", left: 0, top: 0 },
        { type: "wokwi-buzzer", id: "bz1", left: 0, top: 0 },
      ],
      connections: [["dip1:1", "bz1:1", "green", []]],
    });
    const { diagram, errors } = parseDiagram(text);
    expect(errors).toEqual([]);
    expect(diagram.parts.find((p) => p.id === "dip1")?.type).toBe("switch");
    expect(diagram.parts.find((p) => p.id === "bz1")?.type).toBe("buzzer");
  });
});
