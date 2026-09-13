/** 统一工具条（CircuitMuse 风格）：编译/运行/停止/复位 + 文件标签 + 溢出菜单 + 输出控制台 */

import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { STATUS_TEXT } from "../config";
import {
  circuitStore,
  importDiagramText,
  removeConnectionAt,
  removePart,
  resetCircuit,
  exportDiagramText,
} from "../state/circuitStore";
import { compileCurrent, editorStore, pickFlashFile, pickFwDir, pickSketchDir } from "../state/editorStore";
import { setEnvPanelOpen } from "../state/envStore";
import { readTextFile, writeTextFile } from "../lib/api";
import {
  exportWokwiProject,
  importWokwiProject,
  openProject,
  projectStore,
  restoreSession,
  saveProject,
  saveProjectAs,
} from "../state/projectStore";
import { simStore, startSim, stopSim } from "../state/simStore";
import { useStore } from "../state/store";
import { setConsoleOpen, setMsg, uiStore } from "../state/uiStore";
import FileTabs from "./FileTabs";
import { ProjectsModal } from "./ProjectsModal";

export default function EditorToolbar() {
  const busy = useStore(uiStore, (s) => s.busy);
  const consoleOpen = useStore(uiStore, (s) => s.consoleOpen);
  const status = useStore(simStore, (s) => s.status);
  const dllPath = useStore(simStore, (s) => s.dllPath);
  const flashPath = useStore(editorStore, (s) => s.flashPath);
  const fqbn = useStore(projectStore, (s) => s.fqbn);
  const session = useStore(projectStore, (s) => s.session);
  const selected = useStore(circuitStore, (s) => s.selected);
  const selectedWire = useStore(circuitStore, (s) => s.selectedWire);

  const running = status === "running" || status === "loading" || status === "stopping";
  const [moreOpen, setMoreOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [moreOpen]);

  // Ctrl+S 保存（照抄 CircuitMuse：注册 keydown 快捷键）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void saveProject();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const resetSim = () => {
    void stopSim().then(() => {
      setTimeout(() => void startSim(), 600);
    });
  };

  const onImportDiagram = async () => {
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

  const onExportDiagram = async () => {
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

  const flashName = flashPath.split(/[\\/]/).pop() || "";

  const menu = (label: string, action: () => void, extra?: Record<string, string>, disabled = false) => (
    <button
      key={label}
      className="tb-overflow-item"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        action();
        setMoreOpen(false);
      }}
      {...extra}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      <span className="tb-overflow-label">{label}</span>
    </button>
  );

  return (
    <div className="editor-toolbar-wrapper">
      <div className="editor-toolbar">
        <div className="toolbar-group">
          <span className="tb-board-pill" title="Active board: ESP32 DevKitC V1">
            <span className="tb-board-pill-icon">⬡</span>
            <span className="tb-board-pill-label">ESP32 DevKitC V1</span>
            {running && <span className="tb-board-pill-running" />}
          </span>
          <div className="tb-divider" />
          <button
            className="tb-btn tb-btn-compile"
            data-action="compile"
            title="Compile Code"
            disabled={busy}
            onClick={() => void compileCurrent(fqbn)}
          >
            {busy ? (
              <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
            )}
          </button>
          {!running ? (
            <button
              className="tb-btn tb-btn-run btn-run"
              title="Run Simulation"
              disabled={busy || !dllPath}
              onClick={() => void startSim()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </button>
          ) : (
            <>
              <button className="tb-btn tb-btn-stop btn-stop" title="Stop" onClick={() => void stopSim()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                </svg>
              </button>
              <button className="tb-btn tb-btn-reset" title="Reset" onClick={resetSim}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            </>
          )}
          <span className={`status status-${status}`}>● {STATUS_TEXT[status]}</span>
        </div>

        <div className="toolbar-center-slot">
          <FileTabs />
        </div>

        <div className="toolbar-group toolbar-group-right">
          {flashName && (
            <span className="path" title={flashPath}>
              {flashName}
            </span>
          )}
          <div className="tb-divider" />
          <div className="tb-overflow-wrap" ref={moreRef}>
            <button
              className={`tb-btn tb-btn-overflow${moreOpen ? " tb-btn-overflow-active" : ""}`}
              title="More"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
                <circle cx="5" cy="12" r="1.6" />
              </svg>
            </button>
            {moreOpen && (
              <div className="tb-overflow-menu">
                {menu("Projects…", () => setProjectsOpen(true), { "data-action": "projects" })}
                {session
                  ? menu("Restore last session", () => void restoreSession(), { "data-action": "restore-session" })
                  : null}
                {menu("Open project…", () => void openProject())}
                {menu("Save project as…", () => void saveProjectAs())}
                {menu("Import Wokwi (.zip)", () => void importWokwiProject())}
                {menu("Export Wokwi (.zip)", () => void exportWokwiProject())}
                {menu("Select sketch folder", () => void pickSketchDir())}
                {menu("Select fw folder", () => void pickFwDir())}
                {menu("Load firmware image", () => void pickFlashFile())}
                {menu("Environment check", () => setEnvPanelOpen(true), { "data-action": "env-check" })}
                {menu("Docs", () => setMsg("文档位于项目 docs/ 目录（开发日志、设计文档、QEMU DLL 编译指南）"))}
                {menu("GitHub", () => setMsg("https://github.com/wenfengtou/FengtouMu"))}
                <div className="tb-overflow-sep" />
                {menu(
                  "Delete selected part",
                  () => {
                    if (selected) removePart(selected);
                  },
                  undefined,
                  !selected,
                )}
                {menu(
                  "Delete selected wire",
                  () => {
                    if (selectedWire !== null) removeConnectionAt(selectedWire);
                  },
                  undefined,
                  selectedWire === null,
                )}
                {menu("Clear circuit", () => {
                  resetCircuit();
                  setMsg("已清空电路图");
                })}
                {menu("Import diagram.json…", () => void onImportDiagram())}
                {menu("Export diagram.json…", () => void onExportDiagram())}
              </div>
            )}
          </div>
          <button
            className={`tb-btn tb-btn-output${consoleOpen ? " tb-btn-output-active" : ""}`}
            title="Toggle Output Console"
            onClick={() => setConsoleOpen(!consoleOpen)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
        </div>
      </div>
      {projectsOpen && <ProjectsModal onClose={() => setProjectsOpen(false)} />}
    </div>
  );
}
