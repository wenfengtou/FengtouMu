/**
 * 元件选择器（复刻 CircuitMuse ComponentPickerModal）：
 * Add 按钮弹出 → 搜索 + 分类标签 + wokwi 缩略图卡片网格 → 点击卡片即添加到画布
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CATALOG } from "../circuit/catalog";
import type { PartType } from "../circuit/types";
import { applyWokwiState, wokwiElement } from "../circuit/wokwi";
import { addPart, circuitStore, nextSlot } from "../state/circuitStore";
import { useStore } from "../state/store";
import { setMsg, setPickerOpen, setView, uiStore } from "../state/uiStore";

const ORDER: PartType[] = ["led", "resistor", "pushbutton", "switch", "buzzer", "potentiometer"];

const NAME: Record<PartType, string> = {
  "board-devkitc": "ESP32 DevKitC V1",
  led: "LED",
  resistor: "Resistor",
  pushbutton: "Pushbutton",
  switch: "Switch",
  buzzer: "Buzzer",
  potentiometer: "Potentiometer",
};

const DESC: Record<PartType, string> = {
  "board-devkitc": "Espressif ESP32 dev board",
  led: "Light-emitting diode, 20 mA typical",
  resistor: "Passive resistor with color bands",
  pushbutton: "Momentary push button (pressed = closed)",
  switch: "Latching slide switch (stays closed)",
  buzzer: "Passive buzzer, 2 pins, 3-5 V",
  potentiometer: "Rotary potentiometer, 0-100%",
};

const CATEGORY: Record<PartType, string> = {
  "board-devkitc": "board",
  led: "io",
  resistor: "passive",
  pushbutton: "switch",
  switch: "switch",
  buzzer: "audio",
  potentiometer: "passive",
};

/** 卡片缩略图：实例化 wokwi 元素并给预览状态（与 CircuitMuse 相同思路） */
function PickerThumb({ type }: { type: PartType }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const el = wokwiElement(type);
    el.style.transform = "scale(0.55)";
    el.style.transformOrigin = "center center";
    // 预览状态：LED 亮红、按键红帽、开关闭合、蜂鸣器有声、电位器 50%
    const preview: Record<string, unknown> = {
      led: { value: true, color: "red" },
      pushbutton: { color: "red" },
      switch: { value: true },
      buzzer: { hasSignal: true },
      potentiometer: { value: 512 },
    };
    const st = preview[type];
    if (st) applyWokwiState(type, el, st);
    ref.current.innerHTML = "";
    ref.current.appendChild(el);
    return () => {
      if (ref.current) ref.current.innerHTML = "";
    };
  }, [type]);

  return <div ref={ref} className="component-preview" />;
}

function ComponentCard({ type, onSelect }: { type: PartType; onSelect: () => void }) {
  return (
    <button type="button" className="component-card" data-part-type={type} onClick={onSelect}>
      <div className="card-thumbnail">
        <PickerThumb type={type} />
      </div>
      <div className="card-content">
        <div className="card-name">{NAME[type]}</div>
        <div className="card-description">{DESC[type]}</div>
        <div className="card-meta">
          <span className="card-category">{CATEGORY[type]}</span>
          <span className="card-pins">{CATALOG[type].pins.length} pins</span>
        </div>
      </div>
    </button>
  );
}

export default function ComponentPicker() {
  const isOpen = useStore(uiStore, (s) => s.pickerOpen);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | "passive" | "switch" | "io" | "audio">("all");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    if (isOpen) {
      window.addEventListener("keydown", onKey);
      setSearch("");
      setCategory("all");
    }
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const filtered = useMemo(() => {
    return ORDER.filter((t) => {
      const okName = NAME[t].toLowerCase().includes(search.trim().toLowerCase());
      const okCat = category === "all" || CATEGORY[t] === category;
      return okName && okCat;
    });
  }, [search, category]);

  if (!isOpen) return null;

  const addToCanvas = (type: PartType) => {
    const slot = nextSlot(circuitStore.get().diagram);
    const id = addPart(type, slot.x, slot.y);
    setMsg(`已添加 ${NAME[type]}（${id}），可拖动调整位置`);
    setView("circuit");
    setPickerOpen(false);
  };

  return (
    <div className="component-picker-overlay" onClick={() => setPickerOpen(false)}>
      <div className="component-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Component</h2>
          <button className="close-btn" aria-label="Close" onClick={() => setPickerOpen(false)}>
            X
          </button>
        </div>

        <div className="search-section">
          <div className="search-input-wrapper">
            <input
              type="text"
              className="search-input"
              placeholder="Search components…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            {search && (
              <button className="clear-search-btn" aria-label="Clear search" onClick={() => setSearch("")}>
                X
              </button>
            )}
          </div>
        </div>

        <div className="category-tabs">
          <button className="category-tab active" onClick={() => setCategory("all")}>
            All Components
          </button>
          {(["passive", "switch", "io", "audio"] as const).map((c) => (
            <button
              key={c}
              className={`category-tab${category === c ? " active" : ""}`}
              onClick={() => setCategory(c)}
            >
              {c[0].toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>

        <div className="components-scroll">
          <div className="components-grid components-grid--inline">
            {filtered.length === 0 ? (
              <div className="no-results">
                <p>No components match "{search}"</p>
              </div>
            ) : (
              filtered.map((t) => (
                <ComponentCard key={t} type={t} onSelect={() => addToCanvas(t)} />
              ))
            )}
          </div>
        </div>

        <div className="modal-footer">
          <span className="component-count">
            {filtered.length} component{filtered.length !== 1 ? "s" : ""} available
          </span>
        </div>
      </div>
    </div>
  );
}
