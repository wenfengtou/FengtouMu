/**
 * FengtouMu 主界面 —— 复刻 CircuitMuse 编辑器壳层（统一顶栏 + 文件树 + Monaco + 仿真画布 + 底部面板）
 *
 * 结构对照 circuit-muse/pages/EditorPage.tsx：
 *   .unified-toolbar       统一工具条（视图切换 + 汉堡菜单 + 编辑工具条 + 画布工具条）
 *   .app-container         主容器（编辑器面板 | 分隔条 | 仿真面板）
 *   .msgbar                底部消息条（保留原自动化契约）
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import BoardView from "./components/BoardView";
import CircuitPanel from "./components/CircuitPanel";
import CodeEditor from "./components/CodeEditor";
import CompilationConsole from "./components/CompilationConsole";
import DiagramView from "./components/DiagramView";
import EditorToolbar from "./components/EditorToolbar";
import EnvPanel from "./components/EnvPanel";
import FileExplorer from "./components/FileExplorer";
import SerialMonitor from "./components/SerialMonitor";
import { PIN_BOOT } from "./lib/api";
import { initCircuitBridge } from "./state/bridge";
import { circuitStore, setZoomCmd } from "./state/circuitStore";
import { editorStore, setCode } from "./state/editorStore";
import { initEnvCheck, setEnvPanelOpen } from "./state/envStore";
import {
  discardSession,
  exportWokwiProject,
  initProject,
  newProject,
  openProject,
  projectStore,
  restoreSession,
  saveProject,
} from "./state/projectStore";
import { initSim, simStore, writePin } from "./state/simStore";
import { useStore } from "./state/store";
import {
  setMsg,
  setPaletteOpen,
  setSerialOpen,
  setView,
  setViewMode,
  toggleExplorer,
  uiStore,
  type ViewMode,
} from "./state/uiStore";
import "./App.css";
import "./cm/tokens.css";
import "./cm/shell.css";
import "./cm/toolbar.css";
import "./cm/tabs.css";
import "./cm/explorer.css";
import "./cm/canvas.css";
import "./cm/palette.css";

const BOTTOM_MIN = 80;
const BOTTOM_MAX = 600;
const BOTTOM_DEFAULT = 200;
const EXPLORER_MIN = 110;
const EXPLORER_MAX = 500;
const EXPLORER_DEFAULT = 165;

const resizeHandleStyle: CSSProperties = {
  height: 5,
  flexShrink: 0,
  cursor: "row-resize",
  background: "#2a2d2e",
  borderTop: "1px solid #3c3c3c",
  borderBottom: "1px solid #3c3c3c",
};

const VIEW_MODES: { key: ViewMode; label: string; path: string }[] = [
  { key: "code", label: "Code", path: "M16 18l6-6-6-6M8 6l-6 6 6 6" },
  { key: "both", label: "Both", path: "M3 3h7v18H3zM14 3h7v18h-7z" },
  { key: "circuit", label: "Circuit", path: "M5 12h14M12 5v14" },
];

function App() {
  const code = useStore(editorStore, (s) => s.code);
  const pins = useStore(simStore, (s) => s.pins);
  const status = useStore(simStore, (s) => s.status);
  const msg = useStore(uiStore, (s) => s.msg);
  const view = useStore(uiStore, (s) => s.view);
  const viewMode = useStore(uiStore, (s) => s.viewMode);
  const explorerOpen = useStore(uiStore, (s) => s.explorerOpen);
  const consoleOpen = useStore(uiStore, (s) => s.consoleOpen);
  const serialOpen = useStore(uiStore, (s) => s.serialOpen);
  const paletteOpen = useStore(uiStore, (s) => s.paletteOpen);
  const activeFileId = useStore(uiStore, (s) => s.activeFileId);
  const partCount = useStore(circuitStore, (s) => s.diagram.parts.length);
  const wireCount = useStore(circuitStore, (s) => s.diagram.connections.length);
  const session = useStore(projectStore, (s) => s.session);

  const [editorWidthPct, setEditorWidthPct] = useState(45);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(BOTTOM_DEFAULT);
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomSeq = useRef(0);
  const running = status === "running" || status === "loading" || status === "stopping";

  useEffect(() => {
    initCircuitBridge();
    void initSim();
    void initProject();
    void initEnvCheck();
  }, []);

  // Ctrl+S 保存工程
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

  // 编辑器/画布 纵向分隔
  const onSplitterDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setEditorWidthPct(Math.max(20, Math.min(80, pct)));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // 文件树宽度
  const onExplorerResizeDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = explorerWidth;
    const onMove = (ev: globalThis.MouseEvent) => {
      setExplorerWidth(Math.max(EXPLORER_MIN, Math.min(EXPLORER_MAX, startWidth + (ev.clientX - startX))));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [explorerWidth]);

  // 底部面板高度
  const onBottomResizeDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = bottomPanelHeight;
    const onMove = (ev: globalThis.MouseEvent) => {
      setBottomPanelHeight(Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, startHeight + (startY - ev.clientY))));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [bottomPanelHeight]);

  const editorWidth = viewMode === "code" ? "100%" : viewMode === "circuit" ? "0%" : `${editorWidthPct}%`;
  const simWidth = viewMode === "circuit" ? "100%" : viewMode === "code" ? "0%" : `${100 - editorWidthPct}%`;

  const hamburgerItem = (label: string, action: () => void, extra?: Record<string, string>) => (
    <button
      key={label}
      onClick={() => {
        action();
        setMenuOpen(false);
      }}
      style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 14px", background: "transparent", border: "none", color: "#d4d4d8", cursor: "pointer", fontSize: 13 }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#2c2c33")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      {...extra}
    >
      {label}
    </button>
  );

  return (
    <div className="app">
      {/* ── 统一顶栏 ── */}
      <div className="unified-toolbar">
        <button
          className="explorer-toggle-btn unified-toolbar-explorer-toggle"
          onClick={toggleExplorer}
          title={explorerOpen ? "Hide file explorer" : "Show file explorer"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>

        <div role="group" aria-label="View mode" className="view-mode-toggle" style={{ display: "flex", gap: 1, background: "#252526", border: "1px solid #3c3c3c", borderRadius: 4, overflow: "hidden", alignSelf: "center", margin: "0 6px" }}>
          {VIEW_MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setViewMode(m.key)}
              aria-pressed={viewMode === m.key}
              style={{
                background: viewMode === m.key ? "#0e639c" : "transparent",
                color: viewMode === m.key ? "white" : "#aaa",
                border: "none",
                height: 28,
                padding: "0 10px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                cursor: "pointer",
                fontSize: 12,
                fontFamily: "inherit",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={m.path} />
              </svg>
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 2, marginLeft: 8, alignItems: "center", position: "relative" }}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            style={{ background: menuOpen ? "#2c2c33" : "transparent", border: "none", color: "#aaa", cursor: "pointer", padding: "6px", borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center" }}
            title="Menu"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          {menuOpen && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#1e1e23", border: "1px solid #2c2c33", borderRadius: 6, padding: "4px 0", minWidth: 190, zIndex: 10000, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
              {hamburgerItem("New project", () => newProject())}
              {hamburgerItem("Open project…", () => void openProject())}
              {hamburgerItem("Save", () => void saveProject())}
              {hamburgerItem("Export Wokwi (.zip)", () => void exportWokwiProject())}
              {hamburgerItem("Environment check", () => setEnvPanelOpen(true), { "data-action": "env-check" })}
              {hamburgerItem("Docs", () => setMsg("文档位于项目 docs/ 目录（开发日志、设计文档、QEMU DLL 编译指南）"))}
              {hamburgerItem("GitHub", () => setMsg("https://github.com/wenfengtou/FengtouMu"))}
            </div>
          )}
        </div>

        <div className="unified-toolbar-editor">
          <EditorToolbar />
        </div>

        <div className="unified-toolbar-canvas">
          <div className="canvas-header canvas-header--portaled">
            <div className="canvas-header-left">
              <span className={`status-dot ${running ? "running" : "stopped"}`} title={running ? "Running" : "Stopped"} />
              <div className="canvas-view-toggle" role="group" aria-label="View">
                <button
                  data-view="board"
                  onClick={() => setView("board")}
                  style={{
                    background: view === "board" ? "#0e639c" : "transparent",
                    color: view === "board" ? "#fff" : "#aaa",
                    border: "none",
                    height: 28,
                    padding: "0 10px",
                    cursor: "pointer",
                    fontSize: 12,
                    fontFamily: "inherit",
                  }}
                >
                  Board
                </button>
                <button
                  data-view="circuit"
                  onClick={() => setView("circuit")}
                  style={{
                    background: view === "circuit" ? "#0e639c" : "transparent",
                    color: view === "circuit" ? "#fff" : "#aaa",
                    border: "none",
                    height: 28,
                    padding: "0 10px",
                    cursor: "pointer",
                    fontSize: 12,
                    fontFamily: "inherit",
                  }}
                >
                  Circuit
                </button>
              </div>
              <select className="board-selector" disabled title="Active board">
                <option>ESP32 DevKitC V1</option>
              </select>
              <button
                className={`canvas-serial-btn${serialOpen ? " canvas-serial-btn-active" : ""}`}
                onClick={() => setSerialOpen(!serialOpen)}
                title="Toggle Serial Monitor"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </svg>
                Serial
              </button>
              <span className="component-count">
                {partCount - 1} parts · {wireCount} wires
              </span>
            </div>
            <div className="canvas-header-right">
              <div className="zoom-controls">
                <button className="zoom-btn" onClick={() => setZoomCmd("out", ++zoomSeq.current)} title="Zoom Out">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button className="zoom-level" onClick={() => setZoomCmd("reset", ++zoomSeq.current)} title="Reset View">
                  100%
                </button>
                <button className="zoom-btn" onClick={() => setZoomCmd("in", ++zoomSeq.current)} title="Zoom In">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </div>
              <button className="add-component-btn" onClick={() => setPaletteOpen(!paletteOpen)} title="Add Component" disabled={view !== "circuit"}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── 会话恢复横幅 ── */}
      {session && (
        <div className="tb-lib-hint">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>检测到上次未保存的编辑，可恢复「{session.name || "未命名工程"}」</span>
          <button className="tb-lib-hint-btn" data-action="restore-session" onClick={() => void restoreSession()}>
            Restore last session
          </button>
          <button className="tb-lib-hint-close" data-action="discard-session" title="Dismiss" onClick={() => void discardSession()}>
            ×
          </button>
        </div>
      )}

      {/* ── 主容器 ── */}
      <div className="app-container" ref={containerRef}>
        <div
          className="editor-panel"
          style={{ width: editorWidth, display: viewMode === "circuit" ? "none" : "flex", flexDirection: "row" }}
        >
          {explorerOpen && (
            <>
              <div style={{ width: explorerWidth, flexShrink: 0, display: "flex", overflow: "hidden" }}>
                <FileExplorer />
              </div>
              <div className="explorer-resize-handle" onMouseDown={onExplorerResizeDown} />
            </>
          )}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
            <div className="editor-wrapper" style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
              {activeFileId === "sketch" ? <CodeEditor code={code} onChange={setCode} /> : <DiagramView />}
            </div>
            {consoleOpen && (
              <>
                <div onMouseDown={onBottomResizeDown} style={resizeHandleStyle} title="Drag to resize" />
                <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                  <CompilationConsole />
                </div>
              </>
            )}
          </div>
        </div>

        {viewMode === "both" && (
          <div className="resize-handle" onMouseDown={onSplitterDown}>
            <div className="resize-handle-grip" />
          </div>
        )}

        <div
          className="simulator-panel"
          style={{ width: simWidth, display: viewMode === "code" ? "none" : "flex", flexDirection: "column" }}
        >
          <div style={{ flex: 1, overflow: "hidden", position: "relative", minHeight: 0 }}>
            {view === "board" ? (
              <BoardView pins={pins} onBootPress={(pressed) => void writePin(PIN_BOOT, pressed ? 0 : 1)} />
            ) : (
              <CircuitPanel />
            )}
          </div>
          {serialOpen && (
            <>
              <div onMouseDown={onBottomResizeDown} style={resizeHandleStyle} title="Drag to resize" />
              <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                <SerialMonitor />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="msgbar" title={msg}>
        {msg || "就绪：加载 DLL → 编译或选择固件 → 运行仿真"}
      </div>

      <EnvPanel />
    </div>
  );
}

export default App;
