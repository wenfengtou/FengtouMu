import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SimStatus = "idle" | "loading" | "running" | "stopping" | "stopped";

export interface PinState {
  pin: number;
  gpio: number;
  value: number;
  dir: number; // 0=输入 1=输出
}

export interface UartChunk {
  flushed: number;
  data: number[];
}

export interface SimLog {
  message: string;
}

export const PIN_LED = 24; // GPIO2
export const PIN_BOOT = 25; // GPIO0

// ---- 命令 ----
export const loadDll = (path: string) => invoke<void>("cmd_load_dll", { path });
export const simStart = (flash: string, fwDir: string) =>
  invoke<void>("cmd_sim_start", { flash, fwDir });
export const simStop = () => invoke<void>("cmd_sim_stop");
export const simPause = () => invoke<void>("cmd_sim_pause");
export const simResume = () => invoke<void>("cmd_sim_resume");
export const pinWrite = (pin: number, value: number) =>
  invoke<PinState>("cmd_pin_write", { pin, value });
export const uartSend = (id: number, data: number[]) =>
  invoke<void>("cmd_uart_send", { id, data });
export const pinStates = () => invoke<PinState[]>("cmd_pin_states");
export const uartPoll = () => invoke<number[]>("cmd_uart_poll");
export const simStatus = () => invoke<SimStatus>("cmd_sim_status");
export const dllLoaded = () => invoke<boolean>("cmd_dll_loaded");
export const autoLoadDll = () => invoke<string>("cmd_auto_load_dll");
export const compileSketch = (sketchDir: string, outputDir: string, fqbn?: string) =>
  invoke<{ ok: boolean; merged_bin: string | null; message: string }>("cmd_compile", {
    sketchDir,
    outputDir,
    fqbn,
  });

// ---- 事件 ----
export const onGpioUpdate = (cb: (s: PinState) => void): Promise<UnlistenFn> =>
  listen<PinState>("gpio-update", (e) => cb(e.payload));
export const onUartData = (cb: (c: UartChunk) => void): Promise<UnlistenFn> =>
  listen<UartChunk>("uart-data", (e) => cb(e.payload));
export const onSimStatus = (cb: (s: SimStatus) => void): Promise<UnlistenFn> =>
  listen<SimStatus>("sim-status", (e) => cb(e.payload));
export const onSimLog = (cb: (c: SimLog) => void): Promise<UnlistenFn> =>
  listen<SimLog>("sim-log", (e) => cb(e.payload));

export function bytesToText(bytes: number[]): string {
  const buf = new Uint8Array(bytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}
