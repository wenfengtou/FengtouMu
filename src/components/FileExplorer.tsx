/** 文件资源管理器（CircuitMuse 风格）：板卡分组 + 工程文件列表 */

import { newProject, projectStore, saveProject } from "../state/projectStore";
import { simStore } from "../state/simStore";
import { useStore } from "../state/store";
import { setActiveFile, uiStore } from "../state/uiStore";

const FILES = [
  { id: "sketch", name: "sketch.ino", icon: "{ }" },
  { id: "diagram", name: "diagram.json", icon: "▦" },
];

export default function FileExplorer() {
  const name = useStore(projectStore, (s) => s.name);
  const activeFileId = useStore(uiStore, (s) => s.activeFileId);
  const running = useStore(simStore, (s) => s.status === "running" || s.status === "loading");

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <span>EXPLORER</span>
        <div className="file-explorer-header-actions">
          <button
            className="file-explorer-new-btn"
            data-action="new"
            title="New project"
            onClick={() => newProject()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M12 18v-6M9 15h6" />
            </svg>
          </button>
          <button
            className="file-explorer-save-btn"
            title="Save project"
            onClick={() => void saveProject()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <path d="M17 21v-8H7v8M7 3v5h8" />
            </svg>
          </button>
        </div>
      </div>

      <div className="file-explorer-list">
        <div className="fe-board-section">
          <div className="fe-board-header fe-board-header-active" title="Active board">
            <span className="fe-collapse-btn">▾</span>
            <span className="fe-board-icon">⬡</span>
            <span className="fe-board-label">ESP32 DevKitC V1</span>
            <span
              className="fe-status-dot"
              style={{ background: running ? "#4caf50" : "#555" }}
            />
          </div>
          <div className="fe-board-files">
            {FILES.map((f) => (
              <div
                key={f.id}
                className={`file-explorer-item fe-file-item${f.id === activeFileId ? " file-explorer-item-active" : ""}`}
                onClick={() => setActiveFile(f.id)}
                title={f.name}
              >
                <span className="file-explorer-icon">{f.icon}</span>
                <span className="file-explorer-name">{f.name}</span>
              </div>
            ))}
            <div className="file-explorer-item fe-file-item" title="FengtouMu project file">
              <span className="file-explorer-icon">◫</span>
              <span className="file-explorer-name">{name || "untitled"}.fmp</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
