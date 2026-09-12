/** 编辑域：代码、工程目录、固件镜像，以及编译动作 */

import { open } from "@tauri-apps/plugin-dialog";
import { DEFAULT_FLASH, DEFAULT_FW, DEFAULT_OUT, DEFAULT_SKETCH_DIR } from "../config";
import { compileSketch } from "../lib/api";
import { DEFAULT_SKETCH } from "../project/defaults";
import { createStore } from "./store";
import { setBusy, setMsg } from "./uiStore";

export interface EditorState {
  code: string;
  sketchDir: string;
  fwDir: string;
  flashPath: string;
}

export const editorStore = createStore<EditorState>({
  code: DEFAULT_SKETCH,
  sketchDir: DEFAULT_SKETCH_DIR,
  fwDir: DEFAULT_FW,
  flashPath: DEFAULT_FLASH,
});

export const setCode = (code: string): void => editorStore.set({ code });

export async function pickSketchDir(): Promise<void> {
  const dir = await open({ directory: true, title: "选择 Arduino 工程目录（含 .ino）" });
  if (typeof dir === "string") editorStore.set({ sketchDir: dir });
}

export async function pickFwDir(): Promise<void> {
  const dir = await open({ directory: true, title: "选择 fw 目录（含 ROM 与 keymaps）" });
  if (typeof dir === "string") editorStore.set({ fwDir: dir });
}

export async function pickFlashFile(): Promise<void> {
  const file = await open({
    title: "选择固件镜像（4MB 合并 bin）",
    filters: [{ name: "固件镜像", extensions: ["bin"] }],
  });
  if (typeof file === "string") editorStore.set({ flashPath: file });
}

/** 一键编译：把编辑器内容与（可选）工程 fqbn 交给编译链 */
export async function compileCurrent(fqbn?: string): Promise<void> {
  const { sketchDir, code } = editorStore.get();
  setBusy(true);
  setMsg("正在编译…（首次约 1-3 分钟）");
  try {
    // 把编辑器里的代码一并交给编译链：编译前会写入草图目录的主 .ino，
    // 避免"改了代码但编出来还是旧固件"。
    const r = await compileSketch(sketchDir, DEFAULT_OUT, fqbn?.trim() || undefined, code);
    if (r.ok && r.merged_bin) {
      editorStore.set({ flashPath: r.merged_bin });
      const syncNote = r.synced ? "（编辑器内容已同步到草图目录" : "";
      const backupNote = r.backup ? `，原文件备份为 ${r.backup}` : "";
      setMsg(
        `编译成功：${r.merged_bin}${syncNote}${backupNote}${r.synced ? "）" : ""}`,
      );
    } else {
      setMsg(`编译未产出镜像：${r.message}`);
    }
  } catch (e) {
    setMsg(`编译失败: ${e}`);
  } finally {
    setBusy(false);
  }
}
