/** 界面状态：消息条、忙碌标记、视图模式、面板开关、编译日志 */

import { createStore } from "./store";

export type RightView = "board" | "circuit";
export type ViewMode = "code" | "both" | "circuit";

export interface CompileLog {
  type: "info" | "success" | "warning" | "error";
  message: string;
  ts: number;
}

export interface UiState {
  msg: string;
  busy: boolean;
  view: RightView;
  /** Code / Both / Circuit 三态布局 */
  viewMode: ViewMode;
  explorerOpen: boolean;
  /** 编译输出控制台（默认打开，位于代码编辑器下方） */
  consoleOpen: boolean;
  serialOpen: boolean;
  /** 元件选择器（Add 按钮弹出的模态框） */
  pickerOpen: boolean;
  /** 当前打开的标签页：sketch.ino 或 diagram.json */
  activeFileId: string;
  compileLogs: CompileLog[];
}

export const uiStore = createStore<UiState>({
  msg: "",
  busy: false,
  view: "board",
  viewMode: "both",
  explorerOpen: true,
  consoleOpen: true,
  serialOpen: true,
  pickerOpen: false,
  activeFileId: "sketch",
  compileLogs: [],
});

export const setMsg = (msg: string): void => uiStore.set({ msg });
export const setBusy = (busy: boolean): void => uiStore.set({ busy });
export const setView = (view: RightView): void => uiStore.set({ view });
export const setViewMode = (viewMode: ViewMode): void => uiStore.set({ viewMode });
export const toggleExplorer = (): void =>
  uiStore.set((s) => ({ explorerOpen: !s.explorerOpen }));
export const setConsoleOpen = (consoleOpen: boolean): void => uiStore.set({ consoleOpen });
export const setSerialOpen = (serialOpen: boolean): void => uiStore.set({ serialOpen });
export const setPickerOpen = (pickerOpen: boolean): void => uiStore.set({ pickerOpen });
export const setActiveFile = (activeFileId: string): void => uiStore.set({ activeFileId });

export function appendCompileLog(log: Omit<CompileLog, "ts">): void {
  uiStore.set((s) => ({
    compileLogs: [...s.compileLogs, { ...log, ts: Date.now() }],
  }));
}

export function clearCompileLogs(): void {
  uiStore.set({ compileLogs: [] });
}

export async function withBusy<T>(task: () => Promise<T>): Promise<T> {
  uiStore.set({ busy: true });
  try {
    return await task();
  } finally {
    uiStore.set({ busy: false });
  }
}
