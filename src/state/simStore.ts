/** 仿真域：DLL 状态、仿真进程状态、板级引脚状态、串口输出 */

import { open } from "@tauri-apps/plugin-dialog";
import { UART_MAX_LINES } from "../config";
import {
  autoLoadDll,
  bytesToText,
  dllLoaded,
  loadDll,
  onGpioUpdate,
  onSimLog,
  onSimStatus,
  onUartData,
  pinStates,
  pinWrite,
  simPause,
  simResume,
  simStart,
  simStatus,
  simStop,
  uartSend,
  type PinState,
  type SimStatus,
} from "../lib/api";
import { editorStore } from "./editorStore";
import { createStore } from "./store";
import { setBusy, setMsg } from "./uiStore";

export interface SimState {
  /** 供界面展示的 DLL 状态文本 */
  dllPath: string;
  status: SimStatus;
  /** key 为板级引脚号（1..38） */
  pins: Map<number, PinState>;
  uartText: string;
  ready: boolean;
}

export const simStore = createStore<SimState>({
  dllPath: "",
  status: "idle",
  pins: new Map(),
  uartText: "",
  ready: false,
});

function toMap(states: PinState[]): Map<number, PinState> {
  const m = new Map<number, PinState>();
  states.forEach((s) => m.set(s.pin, s));
  return m;
}

export function appendUart(text: string): void {
  if (!text) return;
  simStore.set((prev) => {
    const lines = (prev.uartText + text).split("\n");
    if (lines.length > UART_MAX_LINES) lines.splice(0, lines.length - UART_MAX_LINES);
    return { uartText: lines.join("\n") };
  });
}

export function clearUart(): void {
  simStore.set({ uartText: "" });
}

let initPromise: Promise<void> | null = null;

/** 启动时初始化：定位 DLL、拉取引脚快照、订阅引擎事件（幂等） */
export function initSim(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let loaded = false;
    try {
      const p = await autoLoadDll();
      setMsg(`DLL 已自动加载：${p}`);
      loaded = true;
    } catch {
      loaded = await dllLoaded().catch(() => false);
    }
    simStore.set({ dllPath: loaded ? "（已加载）" : "", ready: true });

    const states = await pinStates().catch(() => [] as PinState[]);
    simStore.set({ pins: toMap(states) });

    await Promise.all([
      onGpioUpdate((s) =>
        simStore.set((prev) => {
          const pins = new Map(prev.pins);
          pins.set(s.pin, s);
          return { pins };
        }),
      ),
      onUartData((c) => appendUart(bytesToText(c.data))),
      onSimStatus((s) => simStore.set({ status: s })),
      onSimLog((c) => setMsg(c.message)),
    ]);

    await refreshStatus();
  })();
  return initPromise;
}

export async function refreshStatus(): Promise<void> {
  const s = await simStatus().catch(() => "idle" as SimStatus);
  simStore.set({ status: s });
}

export async function pickDllFile(): Promise<void> {
  const file = await open({
    title: "选择 libqemu-xtensa.dll",
    filters: [{ name: "QEMU DLL", extensions: ["dll"] }],
  });
  if (typeof file !== "string") return;
  try {
    await loadDll(file);
    simStore.set({ dllPath: file });
    setMsg("DLL 路径已登记，运行仿真时由子进程加载");
  } catch (e) {
    setMsg(`DLL 设置失败: ${e}`);
  }
}

export async function startSim(): Promise<void> {
  // 点击即置忙：按钮立即变灰，避免"点了没反应"的卡顿感（照抄 velxio/circuit-muse 的 setCompiling(true) 放第一行）
  setBusy(true);
  try {
    const { flashPath, fwDir } = editorStore.get();
    if (!simStore.get().ready) {
      const ok = await dllLoaded().catch(() => false);
      if (!ok) {
        setMsg("请先准备 libqemu-xtensa.dll");
        return;
      }
    }
    setMsg("正在启动仿真…");
    await simStart(flashPath, fwDir);
    setMsg("仿真已启动");
  } catch (e) {
    setMsg(`启动失败: ${e}`);
  } finally {
    setBusy(false);
  }
}

export async function stopSim(): Promise<void> {
  try {
    await simStop();
    setMsg("仿真已停止");
  } catch (e) {
    setMsg(`停止失败: ${e}`);
  }
}

export async function togglePauseSim(): Promise<void> {
  try {
    if (simStore.get().status === "running") await simPause();
    else await simResume();
    await refreshStatus();
  } catch (e) {
    setMsg(`操作失败: ${e}`);
  }
}

export async function writePin(pin: number, value: number): Promise<void> {
  try {
    await pinWrite(pin, value);
  } catch (e) {
    setMsg(`引脚写入失败: ${e}`);
  }
}

export async function sendUart(text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  try {
    await uartSend(0, Array.from(bytes));
  } catch (e) {
    setMsg(`串口发送失败: ${e}`);
  }
}
