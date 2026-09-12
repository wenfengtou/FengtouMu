/** 电路图面板：工具条 + 元件面板 + 画布 */

import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "../lib/api";
import {
  circuitStore,
  exportDiagramText,
  importDiagramText,
  removeConnectionAt,
  removePart,
  resetCircuit,
} from "../state/circuitStore";
import { useStore } from "../state/store";
import { setMsg } from "../state/uiStore";
import CircuitCanvas from "./CircuitCanvas";
import PartPalette from "./PartPalette";

export default function CircuitPanel() {
  const selected = useStore(circuitStore, (s) => s.selected);
  const selectedWire = useStore(circuitStore, (s) => s.selectedWire);
  const connectionCount = useStore(circuitStore, (s) => s.diagram.connections.length);
  const partCount = useStore(circuitStore, (s) => s.diagram.parts.length);

  const onImport = async () => {
    const file = await open({
      title: "导入 diagram.json（兼容 Wokwi）",
      filters: [{ name: "电路图", extensions: ["json"] }],
    });
    if (typeof file !== "string") return;
    try {
      const text = await readTextFile(file);
      const errors = importDiagramText(text);
      if (errors.length > 0) {
        setMsg(`已导入，但有 ${errors.length} 处问题：${errors.slice(0, 3).join("；")}`);
      } else {
        setMsg(`已导入 ${file}`);
      }
    } catch (e) {
      setMsg(`导入失败: ${e}`);
    }
  };

  const onExport = async () => {
    const path = await save({
      title: "导出 diagram.json",
      defaultPath: "diagram.json",
      filters: [{ name: "电路图", extensions: ["json"] }],
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
    <div className="circuit-panel">
      <div className="circuit-toolbar">
        <button type="button" onClick={onImport}>
          导入
        </button>
        <button type="button" onClick={onExport}>
          导出
        </button>
        <button
          type="button"
          disabled={selectedWire === null}
          onClick={() => {
            if (selectedWire !== null) removeConnectionAt(selectedWire);
          }}
        >
          删除导线
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            if (selected) removePart(selected);
          }}
        >
          删除元件
        </button>
        <button
          type="button"
          onClick={() => {
            resetCircuit();
            setMsg("已清空电路图");
          }}
        >
          清空
        </button>
        <span className="circuit-stat">
          {partCount - 1} 个元件 · {connectionCount} 条导线
        </span>
      </div>
      <PartPalette />
      <div className="circuit-canvas-wrap">
        <CircuitCanvas />
      </div>
      <div className="circuit-hint">
        点击引脚再点另一个引脚即可连线；选中元件或导线后按 Delete 删除；滚轮缩放，空白处拖动平移
      </div>
    </div>
  );
}
