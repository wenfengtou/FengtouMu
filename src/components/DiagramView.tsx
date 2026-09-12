/** diagram.json 只读视图（与 sketch.ino 标签页并列） */

import { circuitStore } from "../state/circuitStore";
import { useStore } from "../state/store";

export default function DiagramView() {
  const diagram = useStore(circuitStore, (s) => s.diagram);
  return (
    <div
      style={{
        height: "100%",
        background: "#1e1e1e",
        color: "#d4d4d4",
        fontSize: 13,
        fontFamily: "'JetBrains Mono', Consolas, monospace",
        padding: 12,
        overflow: "auto",
        whiteSpace: "pre",
      }}
    >
      {JSON.stringify(diagram, null, 2)}
    </div>
  );
}
