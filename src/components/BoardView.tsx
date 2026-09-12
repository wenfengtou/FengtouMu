import { useEffect, useState } from "react";
import { PIN_LED, type PinState } from "../lib/api";

interface Props {
  pins: Map<number, PinState>;
  onBootPress: (pressed: boolean) => void;
}

const BOARD_W = 440;
const BOARD_H = 560;
const PIN_X_LEFT = 18;
const PIN_X_RIGHT = BOARD_W - 32;
const PIN_TOP = 90;
const PIN_SPACING = 24;

function pinRowIndex(pin: number): number {
  // pin 1-19 左排（从上到下），pin 20-38 右排（从下到上，模拟 DevKitC 交错布局）
  if (pin <= 19) return pin - 1;
  return 19 - (pin - 20) - 1; // 20→18, 38→0
}

export default function BoardView({ pins, onBootPress }: Props) {
  const [bootHeld, setBootHeld] = useState(false);

  const led = pins.get(PIN_LED);
  const ledOn = led?.value === 1 && led?.dir === 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 空格键模拟 BOOT 按键
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) {
          setBootHeld(true);
          onBootPress(true);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && bootHeld) {
        setBootHeld(false);
        onBootPress(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [bootHeld, onBootPress]);

  const press = (p: boolean) => {
    setBootHeld(p);
    onBootPress(p);
  };

  const pinColor = (s?: PinState): string => {
    if (!s || s.gpio < 0) return "#555";
    if (s.dir === 0) return s.value === 1 ? "#4fc3f7" : "#2c3e50"; // 输入：蓝
    return s.value === 1 ? "#ffd54f" : "#6d4c41"; // 输出：黄
  };

  const pinLabel = (s?: PinState): string => {
    if (!s || s.gpio < 0) return "—";
    return `GPIO${s.gpio}`;
  };

  return (
    <div className="board-wrap">
      <svg
        width={BOARD_W}
        height={BOARD_H}
        viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
        className="board-svg"
      >
        {/* PCB */}
        <rect x={6} y={10} width={BOARD_W - 12} height={BOARD_H - 20} rx={14} fill="#1b3a5e" />
        <rect x={16} y={20} width={BOARD_W - 32} height={BOARD_H - 40} rx={10} fill="#16304e" />

        {/* USB 口 */}
        <rect x={BOARD_W / 2 - 34} y={30} width={68} height={26} rx={4} fill="#0d1f33" stroke="#3a6ea5" />
        <text x={BOARD_W / 2} y={47} textAnchor="middle" fontSize="9" fill="#7ba3c9">
          USB
        </text>

        {/* ESP32 芯片 */}
        <rect x={BOARD_W / 2 - 52} y={210} width={104} height={104} rx={4} fill="#0b1a2b" stroke="#3a6ea5" />
        <text x={BOARD_W / 2} y={253} textAnchor="middle" fontSize="11" fill="#9fd0ff" fontWeight="bold">
          ESP32
        </text>
        <text x={BOARD_W / 2} y={270} textAnchor="middle" fontSize="8" fill="#5a85ad">
          DevKitC V4
        </text>
        <text x={BOARD_W / 2} y={286} textAnchor="middle" fontSize="8" fill="#5a85ad">
          {ledOn ? "运行中…" : "待机"}
        </text>

        {/* LED（GPIO2，板载蓝灯） */}
        <circle cx={BOARD_W / 2 + 70} cy={170} r={7} fill={ledOn ? "#4fc3f7" : "#1a3350"} stroke={ledOn ? "#a8e4ff" : "#2c4a68"} strokeWidth={1.5}>
          {ledOn && <animate attributeName="opacity" values="1;0.75;1" dur="0.6s" repeatCount="indefinite" />}
        </circle>
        <text x={BOARD_W / 2 + 70} y={188} textAnchor="middle" fontSize="8" fill="#7ba3c9">
          LED
        </text>
        <text x={BOARD_W / 2 + 70} y={198} textAnchor="middle" fontSize="7" fill="#5a85ad">
          GPIO2
        </text>

        {/* BOOT 按键 */}
        <g
          transform={`translate(${BOARD_W / 2 - 52}, 380)`}
          style={{ cursor: "pointer" }}
          onMouseDown={() => press(true)}
          onMouseUp={() => press(false)}
          onMouseLeave={() => press(false)}
          onTouchStart={(e) => {
            e.preventDefault();
            press(true);
          }}
          onTouchEnd={() => press(false)}
        >
          <rect x={-14} y={-14} width={28} height={28} rx={6} fill={bootHeld ? "#7cb342" : "#2e4d6f"} stroke="#5a85ad" />
          <text x={0} y={4} textAnchor="middle" fontSize="9" fill="#d7e9ff">
            {bootHeld ? "按下" : "BOOT"}
          </text>
        </g>
        <text x={BOARD_W / 2} y={418} textAnchor="middle" fontSize="8" fill="#5a85ad">
          GPIO0（点击或按空格）
        </text>

        {/* 引脚：左排 pin 1-19 */}
        {Array.from({ length: 19 }, (_, i) => {
          const pin = i + 1;
          const s = pins.get(pin);
          const y = PIN_TOP + i * PIN_SPACING;
          return (
            <g key={`L${pin}`}>
              <rect x={PIN_X_LEFT - 8} y={y - 9} width={16} height={18} rx={3} fill={pinColor(s)} stroke="#0d1f33" />
              <text x={PIN_X_LEFT + 2} y={y + 3} textAnchor="middle" fontSize="7" fill="#0d1f33" fontWeight="bold">
                {s?.value ?? 0}
              </text>
              <text x={PIN_X_LEFT + 22} y={y + 3} fontSize="8" fill="#9fb8cf">
                {pin}
              </text>
              <text x={PIN_X_LEFT + 60} y={y + 3} fontSize="8" fill={pinLabel(s) === "—" ? "#4a6a86" : "#cfdce8"}>
                {pinLabel(s)}
              </text>
            </g>
          );
        })}

        {/* 引脚：右排 pin 20-38（自下而上） */}
        {Array.from({ length: 19 }, (_, i) => {
          const pin = i + 20;
          const s = pins.get(pin);
          const y = PIN_TOP + pinRowIndex(pin) * PIN_SPACING;
          return (
            <g key={`R${pin}`}>
              <rect x={PIN_X_RIGHT - 8} y={y - 9} width={16} height={18} rx={3} fill={pinColor(s)} stroke="#0d1f33" />
              <text x={PIN_X_RIGHT + 2} y={y + 3} textAnchor="middle" fontSize="7" fill="#0d1f33" fontWeight="bold">
                {s?.value ?? 0}
              </text>
              <text x={PIN_X_RIGHT - 22} y={y + 3} textAnchor="end" fontSize="8" fill="#9fb8cf">
                {pin}
              </text>
              <text x={PIN_X_RIGHT - 60} y={y + 3} textAnchor="end" fontSize="8" fill={pinLabel(s) === "—" ? "#4a6a86" : "#cfdce8"}>
                {pinLabel(s)}
              </text>
            </g>
          );
        })}

        {/* 图例 */}
        <g fontSize="8" fill="#7ba3c9">
          <rect x={24} y={BOARD_H - 44} width={10} height={10} rx={2} fill="#ffd54f" />
          <text x={40} y={BOARD_H - 36}>输出高</text>
          <rect x={100} y={BOARD_H - 44} width={10} height={10} rx={2} fill="#6d4c41" />
          <text x={116} y={BOARD_H - 36}>输出低</text>
          <rect x={182} y={BOARD_H - 44} width={10} height={10} rx={2} fill="#4fc3f7" />
          <text x={198} y={BOARD_H - 36}>输入</text>
          <rect x={252} y={BOARD_H - 44} width={10} height={10} rx={2} fill="#555" />
          <text x={268} y={BOARD_H - 36}>非GPIO</text>
        </g>
      </svg>
    </div>
  );
}
