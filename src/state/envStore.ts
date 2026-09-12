/** 环境自检域：启动时清点依赖，缺什么就在面板里列出并给出下一步 */

import { envCheck, type EnvCheckItem, type EnvReport } from "../lib/api";
import { editorStore } from "./editorStore";
import { createStore } from "./store";
import { setMsg } from "./uiStore";

export interface EnvState {
  report: EnvReport | null;
  checking: boolean;
  /** 面板是否打开 */
  open: boolean;
  /** 上次检查时间 */
  checkedAt: number | null;
  error: string | null;
}

export const envStore = createStore<EnvState>({
  report: null,
  checking: false,
  open: false,
  checkedAt: null,
  error: null,
});

export function setEnvPanelOpen(open: boolean): void {
  envStore.set({ open });
}

/** 执行一次环境自检（按当前选中的 fw 目录与固件镜像判断） */
export async function runEnvCheck(options: { silent?: boolean } = {}): Promise<EnvReport | null> {
  if (envStore.get().checking) return envStore.get().report;
  envStore.set({ checking: true, error: null });
  try {
    const { fwDir, flashPath } = editorStore.get();
    const report = await envCheck(fwDir, flashPath);
    envStore.set({ report, checking: false, checkedAt: Date.now() });
    if (!options.silent) {
      setMsg(
        report.ok
          ? `环境自检通过（${report.items.length} 项）`
          : `环境自检发现 ${report.missing} 项缺失，已打开自检面板`,
      );
    }
    return report;
  } catch (e) {
    envStore.set({ checking: false, error: String(e) });
    if (!options.silent) setMsg(`环境自检失败: ${e}`);
    return null;
  }
}

/** 启动时的静默自检：有缺失项就自动打开面板 */
export async function initEnvCheck(): Promise<void> {
  const report = await runEnvCheck({ silent: true });
  if (!report) return;
  if (!report.ok) {
    envStore.set({ open: true });
    setMsg(`环境自检发现 ${report.missing} 项缺失，已打开自检面板`);
  }
}

export function itemsOf(report: EnvReport | null): EnvCheckItem[] {
  return report?.items ?? [];
}
