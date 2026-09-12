/** 界面状态：消息条、忙碌标记、右侧面板视图 */

import { createStore } from "./store";

export type RightView = "board" | "circuit";

export interface UiState {
  msg: string;
  busy: boolean;
  view: RightView;
}

export const uiStore = createStore<UiState>({
  msg: "",
  busy: false,
  view: "board",
});

export const setMsg = (msg: string): void => uiStore.set({ msg });
export const setBusy = (busy: boolean): void => uiStore.set({ busy });
export const setView = (view: RightView): void => uiStore.set({ view });

export async function withBusy<T>(task: () => Promise<T>): Promise<T> {
  uiStore.set({ busy: true });
  try {
    return await task();
  } finally {
    uiStore.set({ busy: false });
  }
}
