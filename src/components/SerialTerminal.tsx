/** 串口终端：内容由外部传入（受控），便于状态集中管理 */

import { useEffect, useRef, useState } from "react";

interface Props {
  text: string;
  onInput?: (text: string) => void;
  onClear?: () => void;
}

export default function SerialTerminal({ text, onInput, onClear }: Props) {
  const [input, setInput] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const lines = text.length > 0 ? text.split("\n") : [];

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        onClear?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClear]);

  const send = () => {
    if (!input) return;
    onInput?.(input + "\n");
    setInput("");
  };

  return (
    <div className="terminal">
      <div className="terminal-title">
        串口终端 UART0
        <button className="terminal-clear" onClick={() => onClear?.()} title="清空（Ctrl+L）">
          清空
        </button>
      </div>
      <div className="terminal-body" ref={boxRef}>
        <div className="terminal-line">ESP32 离线仿真 IDE — 串口终端（UART0）</div>
        <div className="terminal-line">----------------------------------------</div>
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
}
