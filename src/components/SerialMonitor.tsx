/** 串口监视器（CircuitMuse Serial Monitor 风格）：ESP32 标签 + 输出 + 输入行 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { clearUart, sendUart, simStore } from "../state/simStore";
import { useStore } from "../state/store";

export default function SerialMonitor() {
  const uartText = useStore(simStore, (s) => s.uartText);
  const [input, setInput] = useState("");
  const [lineEnding, setLineEnding] = useState<"none" | "nl" | "cr" | "both">("nl");
  const [autoscroll, setAutoscroll] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);
  const lines = uartText.length > 0 ? uartText.split("\n") : [];

  useEffect(() => {
    if (autoscroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [uartText, autoscroll]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        clearUart();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const send = () => {
    if (!input) return;
    let text = input;
    if (lineEnding === "nl") text += "\n";
    else if (lineEnding === "cr") text += "\r";
    else if (lineEnding === "both") text += "\r\n";
    sendUart(text);
    setInput("");
  };

  return (
    <div style={styles.container}>
      <div style={styles.tabStrip}>
        <button style={styles.tabActive} title="ESP32 DevKitC V1 - UART0">
          <span style={{ fontSize: 9, marginRight: 3, color: "#a5d6a7" }}>⬡</span>
          ESP32
        </button>
        <div style={styles.tabControls}>
          <span style={styles.baudRate}>115200 baud</span>
          <label style={styles.autoscrollLabel}>
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
              style={styles.checkbox}
            />
            Autoscroll
          </label>
          <button onClick={() => clearUart()} style={styles.clearBtn} title="Clear">
            Clear
          </button>
        </div>
      </div>
      <div ref={outputRef} style={styles.output}>
        <div className="terminal-line">ESP32 Offline Simulator — Serial Monitor (UART0)</div>
        {lines.map((l, i) => (
          <div key={i} className="terminal-line">
            {l}
          </div>
        ))}
      </div>
      <div style={styles.inputRow}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="Type message to send to serial, Enter to send"
          style={styles.input}
        />
        <select
          value={lineEnding}
          onChange={(e) => setLineEnding(e.target.value as typeof lineEnding)}
          style={styles.select}
        >
          <option value="none">No line ending</option>
          <option value="nl">Newline</option>
          <option value="cr">Carriage return</option>
          <option value="both">Both NL &amp; CR</option>
        </select>
        <button onClick={send} style={styles.sendBtn}>
          Send
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#1e1e1e",
    borderTop: "1px solid #333",
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: 13,
    minHeight: 0,
  },
  tabStrip: {
    display: "flex",
    alignItems: "center",
    background: "#252526",
    borderBottom: "1px solid #333",
    minHeight: 32,
    flexShrink: 0,
    overflow: "hidden",
  },
  tabActive: {
    background: "rgba(255,255,255,0.04)",
    border: "none",
    borderBottom: "2px solid #a5d6a7",
    color: "#a5d6a7",
    padding: "5px 12px",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    fontFamily: "inherit",
    display: "flex",
    alignItems: "center",
    gap: 2,
    whiteSpace: "nowrap",
  },
  tabControls: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 8,
    paddingRight: 8,
    flexShrink: 0,
  },
  baudRate: {
    color: "#569cd6",
    fontSize: 11,
    fontFamily: "monospace",
    background: "#1e1e1e",
    border: "1px solid #3a3a3a",
    borderRadius: 3,
    padding: "1px 6px",
  },
  autoscrollLabel: {
    color: "#999",
    fontSize: 11,
    display: "flex",
    alignItems: "center",
    gap: 4,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
  },
  checkbox: { margin: 0, cursor: "pointer" },
  clearBtn: {
    background: "transparent",
    border: "1px solid #555",
    color: "#ccc",
    padding: "2px 8px",
    borderRadius: 3,
    cursor: "pointer",
    fontSize: 11,
    fontFamily: "var(--font-sans)",
  },
  output: {
    flex: 1,
    margin: 0,
    padding: 8,
    color: "#00ff41",
    background: "#0a0a0a",
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    minHeight: 0,
    fontSize: 13,
    lineHeight: "1.4",
  },
  inputRow: {
    display: "flex",
    gap: 4,
    padding: 4,
    background: "#252526",
    borderTop: "1px solid #333",
    flexShrink: 0,
  },
  input: {
    flex: 1,
    background: "#1e1e1e",
    border: "1px solid #444",
    color: "#ccc",
    padding: "4px 8px",
    borderRadius: 3,
    fontFamily: "monospace",
    fontSize: 12,
    outline: "none",
  },
  select: {
    background: "#1e1e1e",
    border: "1px solid #444",
    color: "#ccc",
    padding: "4px",
    borderRadius: 3,
    fontSize: 11,
    outline: "none",
    fontFamily: "var(--font-sans)",
  },
  sendBtn: {
    background: "#0e639c",
    border: "none",
    color: "#fff",
    padding: "4px 12px",
    borderRadius: 3,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "var(--font-sans)",
  },
};
