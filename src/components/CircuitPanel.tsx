/** 电路图面板（CircuitMuse 风格）：左侧元件面板（可折叠）+ SVG 画布 */

import { circuitStore } from "../state/circuitStore";
import { useStore } from "../state/store";
import { uiStore } from "../state/uiStore";
import CircuitCanvas from "./CircuitCanvas";
import PartPalette from "./PartPalette";

export default function CircuitPanel() {
  const paletteOpen = useStore(uiStore, (s) => s.paletteOpen);
  const partCount = useStore(circuitStore, (s) => s.diagram.parts.length);

  return (
    <div className="simulator-canvas-container">
      {paletteOpen && <PartPalette />}
      <div className="simulator-canvas">
        <div className="canvas-content" style={{ position: "relative", flex: 1 }}>
          <CircuitCanvas />
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 11,
            color: "#666",
            fontFamily: "var(--font-sans)",
            background: "rgba(0,0,0,0.35)",
            padding: "3px 10px",
            borderRadius: 12,
            pointerEvents: "none",
          }}
        >
          {partCount - 1} components on canvas
        </div>
      </div>
    </div>
  );
}
