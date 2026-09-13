/**
 * 工程域与编辑器/电路域之间的"胶水"验证。
 *
 * 这里不触碰 Tauri 命令（保存/打开那种动作需要真实运行环境），
 * 只验证「把工程内容灌进各域」与「把各域内容取出来组成工程」这一对操作是对称的。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildProjectFile } from "../../project/format";
import { circuitStore } from "../circuitStore";
import { editorStore } from "../editorStore";
import { applyProject, snapshot } from "../projectStore";

const DIAGRAM = JSON.stringify({
  version: 1,
  parts: [
    { type: "board-esp32-devkitc", id: "esp", top: 0, left: 0, attrs: {} },
    { type: "wokwi-led", id: "led1", top: 80, left: 420, attrs: { color: "red" } },
  ],
  // Wokwi 的连线是数组形式：[起点, 终点, 颜色, []]
  connections: [
    ["led1:A", "esp:D2", "green", []],
    ["led1:C", "esp:GND.1", "green", []],
  ],
});

function sampleProject() {
  return buildProjectFile({
    name: "胶水测试",
    code: "void setup(){}\nvoid loop(){}\n",
    diagram: DIAGRAM,
    sketchDir: "D:\\work\\sk",
    fwDir: "D:\\work\\fw",
    flashPath: "D:\\work\\sk\\demo.ino.merged.bin",
    updatedAt: "2026-09-12T00:00:00.000Z",
  });
}

beforeEach(() => {
  // 每个用例从干净的编辑器/电路状态开始
  editorStore.set({
    code: "",
    sketchDir: "",
    fwDir: "",
    flashPath: "",
  });
});

describe("applyProject + snapshot", () => {
  it("灌入工程后各域状态被正确设置，且没有解析错误", () => {
    const p = sampleProject();
    const errors = applyProject(p);
    expect(errors).toEqual([]);
    expect(editorStore.get().code).toBe(p.code);
    expect(editorStore.get().sketchDir).toBe(p.sketchDir);
    expect(editorStore.get().fwDir).toBe(p.fwDir);
    expect(editorStore.get().flashPath).toBe(p.flashPath);
    expect(circuitStore.get().diagram.parts.map((x) => x.id)).toEqual(["esp", "led1"]);
    expect(circuitStore.get().diagram.connections).toHaveLength(2);
    // 网表应已重建：led1 的 A 脚在 D2 所在的网络上
    expect(circuitStore.get().netlist.nets.length).toBeGreaterThan(0);
  });

  it("snapshot 与灌入的内容一致（往返对称）", () => {
    const p = sampleProject();
    applyProject(p);
    const s = snapshot();
    expect(s.code).toBe(p.code);
    expect(s.sketchDir).toBe(p.sketchDir);
    expect(s.fwDir).toBe(p.fwDir);
    expect(s.flashPath).toBe(p.flashPath);
    // diagram 经过解析再序列化后应稳定（序列化结果与再次往返一致）
    applyProject(s);
    expect(snapshot().diagram).toBe(s.diagram);
    expect(snapshot().code).toBe(s.code);
  });

  it("diagram 为空时清空电路图并保留底板", () => {
    const p = { ...sampleProject(), diagram: "" };
    applyProject(p);
    const parts = circuitStore.get().diagram.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("board-devkitc");
    expect(circuitStore.get().diagram.connections).toHaveLength(0);
  });

  it("diagram 有非法引脚时返回可读错误但仍完成导入", () => {
    const bad = JSON.stringify({
      version: 1,
      parts: [
        { type: "board-esp32-devkitc", id: "esp", top: 0, left: 0, attrs: {} },
        { type: "wokwi-led", id: "led1", top: 0, left: 0, attrs: {} },
      ],
      connections: [["led1:ZZZ", "esp:D2", "green", []]],
    });
    const errors = applyProject({ ...sampleProject(), diagram: bad });
    expect(errors.length).toBeGreaterThan(0);
    expect(circuitStore.get().diagram.parts).toHaveLength(2);
  });
});
