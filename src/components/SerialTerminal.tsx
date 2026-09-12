import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface TerminalHandle {
  append(text: string): void;
  clear(): void;
}

interface Props {
  onInput?: (text: string) => void;
}

const SerialTerminal = forwardRef<TerminalHandle, Props>(function SerialTerminal(
  { onInput },
  ref,
) {
  const [lines, setLines] = useState<string[]>([
    "ESP32 离线仿真 IDE — 串口终端（UART0）",
    "----------------------------------------",
  ]);
  const [input, setInput] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    append(text: string) {
      setLines((prev) => {
        const next = prev.length ? prev.slice() : [""];
        const last = next[next.length - 1] ?? "";
        const parts = text.split("\n");
        next[next.length - 1] = last + parts[0];
        for (let i = 1; i < parts.length; i++) next.push(parts[i]);
        if (next.length > 500) next.splice(0, next.length - 500);
        return next;
      });
    },
    clear() {
      setLines([]);
    },
  }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setLines([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  const send = () => {
    if (!input) return;
    const text = input + "\n";
    setLines((p) => [...p, `> ${input}`]);
    setInput("");
    onInput?.(text);
  };

  return (
    <div className="terminal">
      <div className="terminal-title">
        串口终端 UART0
        <button className="terminal-clear" onClick={() => setLines([])} title="清空（Ctrl+L）">
          清空
        </button>
      </div>
      <div className="terminal-body" ref={boxRef}>
        {lines.map((l, i) => (
          <div key={i} className="terminal-line">
            {l}
          </div>
        ))}
      </div>
      <div className="terminal-input-row">
        <input
          className="terminal-input"
          value={input}
          placeholder="输入内容发送到串口，回车发送"
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button className="terminal-send" onClick={send}>
          发送
        </button>
      </div>
    </div>
  );
});

export default SerialTerminal;
