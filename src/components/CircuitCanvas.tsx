/**
 * 电路画布：SVG 实现。
 *
 * 交互：滚轮缩放、空白处拖拽平移、拖动元件移动、点击引脚连线、点击导线选中、
 * Delete 删除选中的元件或导线、Esc 取消连线。
 * 按键按下会向固件注入电平，电位器拖动会注入 ADC 读数。
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CATALOG, pinAbsPos } from "../circuit/catalog";
import { pinKey, type Connection, type Part, type PartType } from "../circuit/types";
import { changePot, pressPart, togglePart } from "../state/bridge";
import { connectionColor, waypointPath } from "../circuit/wire";
import WokwiPart from "./WokwiPart";
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
  updateConnectionWaypoints,
} from "../state/circuitStore";
import { simStore } from "../state/simStore";
import { useStore } from "../state/store";
import { PIN_LED } from "../lib/api";

const SNAP = 10;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.2;

const snap = (v: number): number => Math.round(v / SNAP) * SNAP;

/** 双击点投影到最近线段上，插入一个正交拐点（对齐到线段所在轴） */
function insertWaypointAt(
  waypoints: Array<{ x: number; y: number }>,
  a: { x: number; y: number },
  b: { x: number; y: number },
  px: number,
  py: number,
): Array<{ x: number; y: number }> {
  const pts = [a, ...waypoints, b];
  let bestIdx = -1;
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    let t = ((px - p1.x) * dx + (py - p1.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const projX = p1.x + t * dx;
    const projY = p1.y + t * dy;
    const dist = Math.hypot(px - projX, py - projY);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
      best = { x: Math.round(projX), y: Math.round(projY) };
    }
  }
  if (!best || bestIdx < 0) return waypoints;
  // 对齐到线段所在轴，保持正交折线连续
  const p1 = pts[bestIdx];
  const p2 = pts[bestIdx + 1];
  if (Math.abs(p1.y - p2.y) < 1e-6) best = { ...best, y: p1.y }; // 水平段
  else best = { ...best, x: p1.x }; // 垂直段
  const before = waypoints.slice(0, bestIdx);
  const after = waypoints.slice(bestIdx);
  return [...before, best, ...after];
}

export default function CircuitCanvas() {
  const diagram = useStore(circuitStore, (s) => s.diagram);
  const visuals = useStore(circuitStore, (s) => s.visuals);
  const selected = useStore(circuitStore, (s) => s.selected);
  const selectedWire = useStore(circuitStore, (s) => s.selectedWire);
  const wiringFrom = useStore(circuitStore, (s) => s.wiringFrom);
  const pins = useStore(simStore, (s) => s.pins);
  const zoomCmd = useStore(circuitStore, (s) => s.zoomCmd);

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

  // 画布头部 +/−/复位按钮发来的缩放指令
  useEffect(() => {
    if (!zoomCmd) return;
    setView((v) => {
      const scale =
        zoomCmd.op === "in"
          ? v.scale * 1.25
          : zoomCmd.op === "out"
            ? v.scale / 1.25
            : 1;
      return { ...v, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) };
    });
  }, [zoomCmd]);

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
      case "board-devkitc": {
        // 板载 LED = GPIO2（与 BoardView 一致）
        const ledState = pins.get(PIN_LED);
        const ledOn = ledState?.value === 1 && ledState?.dir === 1;
        return (
          <g key={part.id} {...common} onMouseDown={selectOnDown}>
            <WokwiPart type="board-devkitc" state={{ kind: "board-devkitc", ledOn }} />
            {isSelected && (
              <rect
                x={-3}
                y={-3}
                width={def.w + 6}
                height={def.h + 6}
                rx={12}
                fill="none"
                stroke="#ffd54f"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                pointerEvents="none"
              />
            )}
            {def.pins.map((p) => pinNode(part, def.w, p.id, p.label, p.kind, p.boardPin))}
          </g>
        );
      }

      case "led": {
        const visual = visuals.get(part.id);
        const color = String(part.attrs?.color ?? "red");
        const lit = visual?.kind === "led" ? visual.lit : false;
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
            <WokwiPart type="led" state={{ kind: "led", lit, color }} />
            {pinNode(part, def.w, "A", "", "other")}
            {pinNode(part, def.w, "C", "", "other")}
          </g>
        );
      }

      case "resistor": {
        const visual = visuals.get(part.id);
        const value = visual?.kind === "resistor" ? visual.value : String(part.attrs?.value ?? "");
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
            <WokwiPart type="resistor" state={{ kind: "resistor", value }} />
            {pinNode(part, def.w, "a", "", "other")}
            {pinNode(part, def.w, "b", "", "other")}
          </g>
        );
      }

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
            <WokwiPart type="pushbutton" state={{ kind: "pushbutton", pressed }} />
            {pinNode(part, def.w, "A", "", "other")}
            {pinNode(part, def.w, "B", "", "other")}
          </g>
        );
      }

      case "potentiometer": {
        const visual = visuals.get(part.id);
        const value = visual?.kind === "potentiometer" ? visual.value : 0.5;
        return (
          <g
            key={part.id}
            {...common}
            data-pot={value.toFixed(3)}
            onMouseDown={(e) => {
              e.stopPropagation();
              selectPart(part.id);
              const p = toCanvas(e.clientX, e.clientY);
              void changePot(part.id, (p.y - part.y - 12) / (def.h - 24));
              setPotDrag(part.id);
            }}
          >
            <WokwiPart type="potentiometer" state={{ kind: "potentiometer", value }} />
            {/* 透明的拖动热区：覆盖 wokwi 原图，点击旋钮任意位置即可拖动 */}
            <rect x={0} y={0} width={def.w} height={def.h} fill="transparent" />
            <text x={def.w / 2} y={def.h - 4} textAnchor="middle" fontSize={8} fill="#cfdce8">
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
            <WokwiPart type="switch" state={{ kind: "switch", closed }} />
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
            <WokwiPart type="buzzer" state={{ kind: "buzzer", on }} />
            {pinNode(part, def.w, "1", "", "other")}
            {pinNode(part, def.w, "2", "", "other")}
          </g>
        );
      }

      default:
        return null;
    }
  };

  const wirePath = (c: Connection): string | null => {
    const p1 = diagram.parts.find((p) => p.id === c.from.part);
    const p2 = diagram.parts.find((p) => p.id === c.to.part);
    if (!p1 || !p2) return null;
    const a = pinAbsPos(p1.type, p1.x, p1.y, c.from.pin);
    const b = pinAbsPos(p2.type, p2.x, p2.y, c.to.pin);
    if (!a || !b) return null;
    return waypointPath(a, b, c.waypoints ?? []);
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
          const d = wirePath(c);
          if (!d) return null;
          const isSel = selectedWire === i;
          const stroke = isSel ? "#ffd54f" : connectionColor(diagram, c);
          return (
            <path
              key={`w${i}`}
              data-wire={i}
              d={d}
              fill="none"
              stroke={stroke}
              strokeWidth={isSel ? 3 : 2}
              style={{ cursor: "pointer" }}
              onMouseDown={(e) => {
                e.stopPropagation();
                selectWire(i);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                // 双击线段插入拐点（照抄 velxio：投影到线段上，保持正交）
                const p = toCanvas(e.clientX, e.clientY);
                const part1 = diagram.parts.find((q) => q.id === c.from.part);
                const part2 = diagram.parts.find((q) => q.id === c.to.part);
                if (!part1 || !part2) return;
                const a = pinAbsPos(part1.type, part1.x, part1.y, c.from.pin);
                const b = pinAbsPos(part2.type, part2.x, part2.y, c.to.pin);
                if (!a || !b) return;
                const wps = insertWaypointAt(c.waypoints ?? [], a, b, p.x, p.y);
                updateConnectionWaypoints(i, wps);
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
