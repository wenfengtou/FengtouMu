/**
 * 电路画布：SVG 实现。
 *
 * 交互：滚轮缩放、空白处拖拽平移、拖动元件移动、点击引脚连线、点击导线选中、
 * Delete 删除选中的元件或导线、Esc 取消连线。
 * 按键按下会向固件注入电平，电位器拖动会注入 ADC 读数。
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CATALOG, pinAbsPos } from "../circuit/catalog";
import { pinKey, type Part, type PartType, type PinRef } from "../circuit/types";
import { changePot, pressPart, togglePart } from "../state/bridge";
import {
  addPart,
  cancelWiring,
  circuitStore,
  clickPin,
  movePart,
  removeConnectionAt,
  removePart,
  selectPart,
  selectWire,
} from "../state/circuitStore";
import { simStore } from "../state/simStore";
import { useStore } from "../state/store";

const SNAP = 10;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.2;

const LED_COLORS: Record<string, { on: string; off: string }> = {
  red: { on: "#ff5252", off: "#4a2a2a" },
  green: { on: "#69f0ae", off: "#274a35" },
  blue: { on: "#40c4ff", off: "#1f3a4a" },
  yellow: { on: "#ffd740", off: "#4a4326" },
};

const snap = (v: number): number => Math.round(v / SNAP) * SNAP;

export default function CircuitCanvas() {
  const diagram = useStore(circuitStore, (s) => s.diagram);
  const visuals = useStore(circuitStore, (s) => s.visuals);
  const selected = useStore(circuitStore, (s) => s.selected);
  const selectedWire = useStore(circuitStore, (s) => s.selectedWire);
  const wiringFrom = useStore(circuitStore, (s) => s.wiringFrom);
  const pins = useStore(simStore, (s) => s.pins);

  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ scale: 1, tx: 16, ty: 16 });
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [pan, setPan] = useState<{ cx: number; cy: number; tx: number; ty: number } | null>(null);
  const [potDrag, setPotDrag] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - view.tx) / view.scale,
        y: (clientY - rect.top - view.ty) / view.scale,
      };
    },
    [view],
  );

  useEffect(() => {
    if (!drag && !pan && !potDrag) return;
    const onMove = (e: MouseEvent) => {
      const p = toCanvas(e.clientX, e.clientY);
      if (drag) {
        movePart(drag.id, snap(p.x - drag.dx), snap(p.y - drag.dy));
      } else if (pan) {
        setView((v) => ({ ...v, tx: pan.tx + (e.clientX - pan.cx), ty: pan.ty + (e.clientY - pan.cy) }));
      } else if (potDrag) {
        const part = circuitStore.get().diagram.parts.find((x) => x.id === potDrag);
        if (part) {
          const def = CATALOG[part.type];
          const value = (p.y - part.y - 12) / (def.h - 24);
          void changePot(potDrag, value);
        }
      }
    };
    const onUp = () => {
      setDrag(null);
      setPan(null);
      setPotDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, pan, potDrag, toCanvas]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelWiring();
      if (e.key === "Delete" || e.key === "Backspace") {
        const st = circuitStore.get();
        if (st.selectedWire !== null) {
          removeConnectionAt(st.selectedWire);
          e.preventDefault();
        } else if (st.selected) {
          removePart(st.selected);
          e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setView((v) => ({
        ...v,
        scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor)),
      }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const gpioPinFill = (boardPin?: number, kind?: string): string => {
    if (boardPin === undefined) return "#3a5a7a";
    if (kind === "gnd") return "#8d8d8d";
    if (kind === "vcc") return "#c96a6a";
    const st = pins.get(boardPin);
    if (!st) return "#2c4a68";
    if (st.dir === 0) return st.value === 1 ? "#4fc3f7" : "#2c3e50";
    return st.value === 1 ? "#ffd54f" : "#6d4c41";
  };

  const pinNode = (part: Part, defW: number, pinId: string, label: string, kind: string, boardPin?: number) => {
    const def = CATALOG[part.type].pins.find((p) => p.id === pinId);
    if (!def) return null;
    const key = pinKey({ part: part.id, pin: pinId });
    const active = wiringFrom
      ? pinKey(wiringFrom) === key
        ? "#ffd54f"
        : "#6d8fb0"
      : undefined;
    return (
      <g
        key={pinId}
        data-pin={key}
        style={{ cursor: "crosshair" }}
        onMouseDown={(e) => {
          e.stopPropagation();
          clickPin({ part: part.id, pin: pinId });
        }}
      >
        <circle
          cx={def.x}
          cy={def.y}
          r={5}
          fill={active ?? gpioPinFill(boardPin, kind)}
          stroke="#0d1f33"
        />
        {label ? (
          <text
            x={def.x < defW / 2 ? def.x + 8 : def.x - 8}
            y={def.y + 3}
            fontSize={8}
            textAnchor={def.x < defW / 2 ? "start" : "end"}
            fill={kind === "gpio" ? "#cfdce8" : "#8fb0cc"}
          >
            {label}
          </text>
        ) : null}
      </g>
    );
  };

  const renderPart = (part: Part) => {
    const def = CATALOG[part.type];
    const isSelected = selected === part.id;
    const common = {
      "data-part": part.id,
      "data-part-type": part.type,
      transform: `translate(${part.x},${part.y})`,
    };
    const selectOnDown = (e: ReactMouseEvent) => {
      e.stopPropagation();
      selectPart(part.id);
    };

    switch (part.type) {
      case "board-devkitc":
        return (
          <g key={part.id} {...common} onMouseDown={selectOnDown}>
            <rect
              width={def.w}
              height={def.h}
              rx={10}
              fill="#1b3a5e"
              stroke={isSelected ? "#ffd54f" : "#3a6ea5"}
            />
            <text x={def.w / 2} y={20} textAnchor="middle" fontSize={11} fill="#9fd0ff">
              ESP32 DevKitC
            </text>
            {def.pins.map((p) => pinNode(part, def.w, p.id, p.label, p.kind, p.boardPin))}
          </g>
        );

      case "led": {
        const visual = visuals.get(part.id);
        const color = String(part.attrs?.color ?? "red");
        const lit = visual?.kind === "led" ? visual.lit : false;
        const palette = LED_COLORS[color] ?? LED_COLORS.red;
        return (
          <g
            key={part.id}
            {...common}
            data-lit={lit ? "1" : "0"}
            onMouseDown={(e) => {
              selectOnDown(e);
              const p = toCanvas(e.clientX, e.clientY);
              setDrag({ id: part.id, dx: p.x - part.x, dy: p.y - part.y });
            }}
          >
            <line x1={20} y1={6} x2={20} y2={22} stroke="#c0c0c0" strokeWidth={2} />
            <line x1={20} y1={46} x2={20} y2={62} stroke="#c0c0c0" strokeWidth={2} />
            {lit ? <circle cx={20} cy={34} r={19} fill={palette.on} opacity={0.25} /> : null}
            <circle
              cx={20}
              cy={34}
              r={13}
              fill={lit ? palette.on : palette.off}
              stroke={isSelected ? "#ffd54f" : "#666"}
              strokeWidth={isSelected ? 2 : 1.2}
            />
            {pinNode(part, def.w, "A", "", "other")}
            {pinNode(part, def.w, "C", "", "other")}
          </g>
        );
      }

      case "resistor":
        return (
          <g
            key={part.id}
            {...common}
            onMouseDown={(e) => {
              selectOnDown(e);
              const p = toCanvas(e.clientX, e.clientY);
              setDrag({ id: part.id, dx: p.x - part.x, dy: p.y - part.y });
            }}
          >
            <line x1={6} y1={10} x2={16} y2={10} stroke="#c0c0c0" strokeWidth={2} />
            <line x1={60} y1={10} x2={70} y2={10} stroke="#c0c0c0" strokeWidth={2} />
            <rect
              x={16}
              y={3}
              width={44}
              height={14}
              rx={3}
              fill="#d7c9a5"
              stroke={isSelected ? "#ffd54f" : "#8a7a55"}
            />
            <rect x={26} y={3} width={4} height={14} fill="#6d4c41" />
            <rect x={34} y={3} width={4} height={14} fill="#000" />
            <rect x={42} y={3} width={4} height={14} fill="#c62828" />
            <rect x={50} y={3} width={4} height={14} fill="#c9a227" />
            <text x={38} y={-2} fontSize={8} textAnchor="middle" fill="#cfdce8">
              {String(part.attrs?.value ?? "")}Ω
            </text>
            {pinNode(part, def.w, "a", "", "other")}
            {pinNode(part, def.w, "b", "", "other")}
          </g>
        );

      case "pushbutton": {
        const visual = visuals.get(part.id);
        const pressed = visual?.kind === "pushbutton" ? visual.pressed : false;
        // 整块元件都可按下（鼠标落在标签、外壳、引脚之间的任意位置都能触发；
        // 引脚自身的 mousedown 会 stopPropagation，因此接线不会误触发按下）
        return (
          <g
            key={part.id}
            {...common}
            data-pressed={pressed ? "1" : "0"}
            style={{ cursor: "pointer" }}
            onMouseDown={(e) => {
              e.stopPropagation();
              selectPart(part.id);
              void pressPart(part.id, true);
            }}
            onMouseUp={() => void pressPart(part.id, false)}
            onMouseLeave={() => void pressPart(part.id, false)}
          >
            <rect
              width={def.w}
              height={def.h}
              rx={6}
              fill="#2b3d52"
              stroke={isSelected ? "#ffd54f" : "#5a7d9e"}
            />
            <rect x={18} y={pressed ? 10 : 6} width={32} height={22} rx={4} fill={pressed ? "#7cb342" : "#3d5470"} />
            <text x={def.w / 2} y={44} textAnchor="middle" fontSize={8} fill="#cfdce8">
              {pressed ? "按下" : "按键"}
            </text>
            {pinNode(part, def.w, "A", "", "other")}
            {pinNode(part, def.w, "B", "", "other")}
          </g>
        );
      }

      case "potentiometer": {
        const visual = visuals.get(part.id);
        const value = visual?.kind === "potentiometer" ? visual.value : 0.5;
        const angle = -135 + value * 270;
        return (
          <g key={part.id} {...common} data-pot={value.toFixed(3)}>
            <rect
              width={def.w}
              height={def.h}
              rx={8}
              fill="#2b3d52"
              stroke={isSelected ? "#ffd54f" : "#5a7d9e"}
              onMouseDown={(e) => {
                e.stopPropagation();
                selectPart(part.id);
                const p = toCanvas(e.clientX, e.clientY);
                void changePot(part.id, (p.y - part.y - 12) / (def.h - 24));
                setPotDrag(part.id);
              }}
            />
            <circle cx={30} cy={42} r={16} fill="#3d5470" stroke="#8fb0cc" />
            <line
              x1={30}
              y1={42}
              x2={30 + 13 * Math.sin((angle * Math.PI) / 180)}
              y2={42 - 13 * Math.cos((angle * Math.PI) / 180)}
              stroke="#ffd54f"
              strokeWidth={2}
            />
            <text x={30} y={70} textAnchor="middle" fontSize={8} fill="#cfdce8">
              {Math.round(value * 100)}%
            </text>
            {pinNode(part, def.w, "VCC", "", "other")}
            {pinNode(part, def.w, "SIG", "", "other")}
            {pinNode(part, def.w, "GND", "", "other")}
          </g>
        );
      }

      case "switch": {
        const visual = visuals.get(part.id);
        const closed = visual?.kind === "switch" ? visual.closed : Number(part.attrs?.closed) === 1;
        // 自锁开关：整块可点击切换开合（引脚 mousedown 会 stopPropagation，接线不受影响）
        return (
          <g
            key={part.id}
            {...common}
            data-closed={closed ? "1" : "0"}
            style={{ cursor: "pointer" }}
            onMouseDown={(e) => {
              e.stopPropagation();
              selectPart(part.id);
              void togglePart(part.id, !closed);
            }}
          >
            <rect
              width={def.w}
              height={def.h}
              rx={6}
              fill="#2b3d52"
              stroke={isSelected ? "#ffd54f" : "#5a7d9e"}
            />
            <line x1={14} y1={18} x2={50} y2={18} stroke="#8fb0cc" strokeWidth={2} />
            <rect
              x={closed ? 32 : 14}
              y={10}
              width={18}
              height={16}
              rx={3}
              fill={closed ? "#7cb342" : "#3d5470"}
              stroke="#8fb0cc"
            />
            <text x={def.w / 2} y={33} textAnchor="middle" fontSize={8} fill="#cfdce8">
              {closed ? "ON" : "OFF"}
            </text>
            {pinNode(part, def.w, "1", "", "other")}
            {pinNode(part, def.w, "2", "", "other")}
          </g>
        );
      }

      case "buzzer": {
        const visual = visuals.get(part.id);
        const on = visual?.kind === "buzzer" ? visual.on : false;
        return (
          <g
            key={part.id}
            {...common}
            data-on={on ? "1" : "0"}
            onMouseDown={(e) => {
              selectOnDown(e);
              const p = toCanvas(e.clientX, e.clientY);
              setDrag({ id: part.id, dx: p.x - part.x, dy: p.y - part.y });
            }}
          >
            <circle
              cx={24}
              cy={24}
              r={16}
              fill={on ? "#ffd740" : "#3d5470"}
              stroke={isSelected ? "#ffd54f" : "#8fb0cc"}
              strokeWidth={isSelected ? 2 : 1.2}
            />
            <text x={24} y={20} textAnchor="middle" fontSize={8} fill={on ? "#5a4300" : "#8fb0cc"}>
              蜂鸣
            </text>
            {on ? <circle cx={24} cy={31} r={4} fill="#5a4300" /> : null}
            <rect x={12} y={8} width={24} height={3} rx={1.5} fill="#8fb0cc" />
            <rect x={12} y={37} width={24} height={3} rx={1.5} fill="#8fb0cc" />
            {pinNode(part, def.w, "1", "", "other")}
            {pinNode(part, def.w, "2", "", "other")}
          </g>
        );
      }

      default:
        return null;
    }
  };

  const wirePath = (from: PinRef, to: PinRef): string | null => {
    const p1 = diagram.parts.find((p) => p.id === from.part);
    const p2 = diagram.parts.find((p) => p.id === to.part);
    if (!p1 || !p2) return null;
    const a = pinAbsPos(p1.type, p1.x, p1.y, from.pin);
    const b = pinAbsPos(p2.type, p2.x, p2.y, to.pin);
    if (!a || !b) return null;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} Q ${mx} ${my - 24} ${b.x} ${b.y}`;
  };

  const wiringPreview = (() => {
    if (!wiringFrom || !cursor) return null;
    const part = diagram.parts.find((p) => p.id === wiringFrom.part);
    if (!part) return null;
    const a = pinAbsPos(part.type, part.x, part.y, wiringFrom.pin);
    if (!a) return null;
    return `M ${a.x} ${a.y} L ${cursor.x} ${cursor.y}`;
  })();

  return (
    <svg
      ref={svgRef}
      className="circuit-svg"
      data-testid="circuit-svg"
      onMouseDown={(e) => {
        selectPart(null);
        selectWire(null);
        cancelWiring();
        setPan({ cx: e.clientX, cy: e.clientY, tx: view.tx, ty: view.ty });
      }}
      onMouseMove={(e) => {
        if (wiringFrom) setCursor(toCanvas(e.clientX, e.clientY));
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData("application/x-fm-part") as PartType;
        if (!type || !(type in CATALOG)) return;
        const p = toCanvas(e.clientX, e.clientY);
        addPart(type, snap(p.x), snap(p.y));
      }}
    >
      <defs>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#22303f" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect x={0} y={0} width="100%" height="100%" fill="url(#grid)" />
      <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
        {diagram.connections.map((c, i) => {
          const d = wirePath(c.from, c.to);
          if (!d) return null;
          const isSel = selectedWire === i;
          return (
            <path
              key={`w${i}`}
              data-wire={i}
              d={d}
              fill="none"
              stroke={isSel ? "#ffd54f" : c.color ?? "#69f0ae"}
              strokeWidth={isSel ? 3 : 2}
              style={{ cursor: "pointer" }}
              onMouseDown={(e) => {
                e.stopPropagation();
                selectWire(i);
              }}
            />
          );
        })}
        {wiringPreview ? (
          <path d={wiringPreview} fill="none" stroke="#ffd54f" strokeDasharray="4 3" strokeWidth={1.5} />
        ) : null}
        {diagram.parts.map(renderPart)}
      </g>
    </svg>
  );
}
