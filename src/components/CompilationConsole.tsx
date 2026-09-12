/** 编译输出控制台（CircuitMuse Output Console 风格，内联样式逐项对齐） */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useStore } from "../state/store";
import { clearCompileLogs, setConsoleOpen, uiStore } from "../state/uiStore";

const logColor = (type: string): string => {
  switch (type) {
    case "error":
      return "#ef5350";
    case "warning":
      return "#ffa726";
    case "success":
      return "#66bb6a";
    default:
      return "#cccccc";
  }
};

export default function CompilationConsole() {
  const logs = useStore(uiStore, (s) => s.compileLogs);
  const outputRef = useRef<HTMLDivElement>(null);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState<"all" | "errors" | "warnings">("all");

  useEffect(() => {
    if (autoscroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [logs, autoscroll]);

  const filtered = logs.filter((l) => {
    if (filter === "errors") return l.type === "error";
    if (filter === "warnings") return l.type === "warning" || l.type === "error";
    return true;
  });
  const errorCount = logs.filter((l) => l.type === "error").length;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.title}>Output Console</span>
          {errorCount > 0 && (
            <span style={styles.errorBadge} title={`${errorCount} errors`}>
              ✕ {errorCount}
            </span>
          )}
        </div>
        <div style={styles.headerRight}>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            style={styles.filterSelect}
          >
            <option value="all">All Logs</option>
            <option value="errors">Errors</option>
            <option value="warnings">Warnings</option>
          </select>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
              style={styles.checkbox}
            />
            Autoscroll
          </label>
          <button onClick={() => clearCompileLogs()} style={styles.iconBtn} title="Clear Console">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>
          <button onClick={() => setConsoleOpen(false)} style={styles.iconBtn} title="Close Console">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div ref={outputRef} style={styles.output}>
        {filtered.length === 0 ? (
          <div style={styles.emptyState}>Console is empty</div>
        ) : (
          filtered.map((log, i) => (
            <div key={i} style={styles.logLine}>
              <span style={styles.timestamp}>
                {new Date(log.ts).toLocaleTimeString("en-US", { hour12: false })}
              </span>
              <span style={{ ...styles.logMessage, color: logColor(log.type) }}>{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    background: "#1e1e1e",
    borderTop: "1px solid #333",
    fontSize: 12,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
    overflow: "hidden",
    height: "100%",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 10px",
    background: "#252526",
    borderBottom: "1px solid #333",
    flexShrink: 0,
    minHeight: 30,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 8 },
  headerRight: { display: "flex", alignItems: "center", gap: 6 },
  title: {
    color: "#cccccc",
    fontWeight: 600,
    fontSize: 12,
    fontFamily: "var(--font-sans)",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  errorBadge: {
    color: "#ef5350",
    background: "rgba(239, 83, 80, 0.15)",
    padding: "1px 6px",
    borderRadius: 3,
    fontSize: 11,
    fontFamily: "var(--font-sans)",
  },
  filterSelect: {
    background: "#333",
    color: "#ccc",
    border: "1px solid #555",
    borderRadius: 3,
    fontSize: 11,
    padding: "2px 4px",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    color: "#999",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
  },
  checkbox: { accentColor: "#0e639c" },
  iconBtn: {
    background: "none",
    border: "none",
    color: "#999",
    cursor: "pointer",
    padding: "3px 4px",
    borderRadius: 3,
    display: "flex",
    alignItems: "center",
  },
  output: {
    flex: 1,
    overflow: "auto",
    padding: "4px 10px",
    lineHeight: 1.6,
  },
  emptyState: { color: "#666", fontStyle: "italic", padding: "12px 0", fontFamily: "var(--font-sans)" },
  logLine: { display: "flex", gap: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" },
  timestamp: { color: "#555", flexShrink: 0, userSelect: "none" },
  logMessage: { flex: 1 },
};
