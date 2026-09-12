/** 元件面板：拖到画布，或点击直接添加 */

import { CATALOG } from "../circuit/catalog";
import type { PartType } from "../circuit/types";
import { addPart, circuitStore, nextSlot } from "../state/circuitStore";
import { setMsg } from "../state/uiStore";

const ORDER: PartType[] = [
  "led",
  "resistor",
  "pushbutton",
  "switch",
  "buzzer",
  "potentiometer",
];

export default function PartPalette() {
  return (
    <div className="palette">
      <span className="palette-label">元件</span>
      {ORDER.map((type) => {
        const def = CATALOG[type];
        return (
          <button
            key={type}
            type="button"
            className="palette-item"
            data-part-type={type}
            draggable
            title="拖到画布，或点击直接添加"
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-fm-part", type);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => {
              const slot = nextSlot(circuitStore.get().diagram);
              const id = addPart(type, slot.x, slot.y);
              setMsg(`已添加 ${def.name}（${id}），可拖动调整位置`);
            }}
          >
            {def.name}
          </button>
        );
      })}
    </div>
  );
}
