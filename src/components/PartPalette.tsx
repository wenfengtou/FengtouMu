/** 元件面板（CircuitMuse Component Palette 风格）：停靠在画布左侧，点击添加 */

import { CATALOG } from "../circuit/catalog";
import type { PartType } from "../circuit/types";
import {
  addPart,
  circuitStore,
  nextSlot,
  removeConnectionAt,
  removePart,
  resetCircuit,
} from "../state/circuitStore";
import { setMsg } from "../state/uiStore";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "../lib/api";
import { exportDiagramText, importDiagramText } from "../state/circuitStore";
import { useStore } from "../state/store";

const ORDER: PartType[] = ["led", "resistor", "pushbutton", "switch", "buzzer", "potentiometer"];

const EN_NAME: Record<PartType, string> = {
  "board-devkitc": "DevKitC",
  led: "LED",
  resistor: "Resistor",
  pushbutton: "Pushbutton",
  switch: "Switch",
  buzzer: "Buzzer",
  potentiometer: "Potentiometer",
};

const ICON: Record<PartType, string> = {
  "board-devkitc": "⬡",
  led: "🔴",
  resistor: "〽️",
  pushbutton: "🔘",
  switch: "⇄",
  buzzer: "🔊",
  potentiometer: "🎚️",
};

export default function PartPalette() {
  const selected = useStore(circuitStore, (s) => s.selected);
  const selectedWire = useStore(circuitStore, (s) => s.selectedWire);

  const onImport = async () => {
    const file = await open({
      title: "Import diagram.json",
      filters: [{ name: "Circuit diagram", extensions: ["json"] }],
    });
    if (typeof file !== "string") return;
    try {
      const text = await readTextFile(file);
      const errors = importDiagramText(text);
      setMsg(errors.length > 0 ? `已导入，但有 ${errors.length} 处问题：${errors.slice(0, 3).join("；")}` : `已导入 ${file}`);
    } catch (e) {
      setMsg(`导入失败: ${e}`);
    }
  };

  const onExport = async () => {
    const path = await save({
      title: "Export diagram.json",
      defaultPath: "diagram.json",
      filters: [{ name: "Circuit diagram", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      await writeTextFile(path, exportDiagramText());
      setMsg(`已导出 ${path}`);
    } catch (e) {
      setMsg(`导出失败: ${e}`);
    }
  };

  return (
    <div className="component-palette">
      <div className="palette-header">
        <h3>Components</h3>
        <p className="palette-hint">Click to add · drag to canvas</p>
      </div>
      <div className="palette-items">
        {ORDER.map((type) => (
          <button
            key={type}
            type="button"
            className="palette-item"
            data-part-type={type}
            draggable
            title="Click to add, or drag onto the canvas"
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-fm-part", type);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => {
              const slot = nextSlot(circuitStore.get().diagram);
              const id = addPart(type, slot.x, slot.y);
              setMsg(`已添加 ${CATALOG[type].name}（${id}），可拖动调整位置`);
            }}
          >
            <span className="palette-icon">{ICON[type]}</span>
            <span className="palette-label">{EN_NAME[type]}</span>
          </button>
        ))}
      </div>
      <div className="palette-help">
        <p>Delete: 选中元件/导线后按 Delete；滚轮缩放；点击引脚连线。</p>
      </div>
      <div className="palette-actions">
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            if (selected) removePart(selected);
          }}
        >
          Delete part
        </button>
        <button
          type="button"
          disabled={selectedWire === null}
          onClick={() => {
            if (selectedWire !== null) removeConnectionAt(selectedWire);
          }}
        >
          Delete wire
        </button>
        <button
          type="button"
          onClick={() => {
            resetCircuit();
            setMsg("已清空电路图");
          }}
        >
          Clear
        </button>
        <button type="button" onClick={() => void onImport()}>
          Import JSON
        </button>
        <button type="button" onClick={() => void onExport()}>
          Export JSON
        </button>
      </div>
    </div>
  );
}
