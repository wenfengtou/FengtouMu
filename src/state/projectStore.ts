/**
 * 工程域：当前工程文件、最近工程列表、自动保存与恢复。
 *
 * 职责边界：
 *   - 工程文件只存"内容"（源码 + diagram.json + 路径配置），不存运行状态；
 *   - 与编辑器/电路两个域通过 applyProject / snapshot 双向同步；
 *   - 自动保存写到应用数据目录下的 autosave.fmp，重启后可在工程菜单里恢复。
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import {
  appPaths,
  exportWokwiZip,
  importWokwiZip,
  prefsLoad,
  prefsSave,
  projectSave,
  readTextFile,
  writeTextFile,
} from "../lib/api";
import {
  DEFAULT_FQBN,
  DEFAULT_PROJECT_NAME,
  PROJECT_EXT,
  buildProjectFile,
  parseProjectFile,
  projectFileName,
  projectNameFromPath,
  touchRecent,
  type AppPaths,
  type BuildProjectInput,
  type ProjectFile,
  type RecentEntry,
} from "../project/format";
import { circuitStore, exportDiagramText, importDiagramText, resetCircuit } from "./circuitStore";
import { editorStore, setCode, type EditorState } from "./editorStore";
import { createStore } from "./store";
import { setMsg } from "./uiStore";

/** 自动保存间隔（毫秒） */
const AUTOSAVE_INTERVAL_MS = 30_000;

export interface ProjectState {
  /** 当前工程文件路径；null 表示尚未保存过 */
  path: string | null;
  name: string;
  /** 是否有未保存改动 */
  dirty: boolean;
  fqbn: string;
  recent: RecentEntry[];
  lastSavedAt: number | null;
  /** 上次自动保存的时间 */
  autosavedAt: number | null;
  /** 上次退出时残留的自动保存内容（若有） */
  session: ProjectFile | null;
  paths: AppPaths | null;
  ready: boolean;
}

export const projectStore = createStore<ProjectState>({
  path: null,
  name: DEFAULT_PROJECT_NAME,
  dirty: false,
  fqbn: DEFAULT_FQBN,
  recent: [],
  lastSavedAt: null,
  autosavedAt: null,
  session: null,
  paths: null,
  ready: false,
});

/** 当前编辑器 + 电路图快照（工程名/时间戳由调用方决定） */
function snapshotInput(): BuildProjectInput {
  const st = projectStore.get();
  const ed = editorStore.get();
  return {
    name: st.name,
    code: ed.code,
    diagram: exportDiagramText(),
    sketchDir: ed.sketchDir,
    fwDir: ed.fwDir,
    flashPath: ed.flashPath,
    fqbn: st.fqbn,
  };
}

/** 当前完整工程内容 */
export function snapshot(): ProjectFile {
  return buildProjectFile(snapshotInput());
}

/** 把工程内容灌进编辑器与电路图，返回电路图解析问题 */
export function applyProject(project: ProjectFile): string[] {
  const errors: string[] = [];
  if (project.code) setCode(project.code);
  const patch: Partial<EditorState> = {};
  if (project.sketchDir) patch.sketchDir = project.sketchDir;
  if (project.fwDir) patch.fwDir = project.fwDir;
  if (project.flashPath) patch.flashPath = project.flashPath;
  if (Object.keys(patch).length > 0) editorStore.set(patch);
  if (project.diagram) {
    try {
      errors.push(...importDiagramText(project.diagram));
    } catch (e) {
      errors.push(`电路图解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    resetCircuit();
  }
  projectStore.set({ fqbn: project.fqbn || DEFAULT_FQBN });
  return errors;
}

async function persistPrefs(): Promise<void> {
  const { recent, path } = projectStore.get();
  try {
    await prefsSave({ recent, lastProject: path });
  } catch {
    /* 偏好写入失败不影响主流程 */
  }
}

/** 在"应用工程内容"期间抑制 dirty 标记，避免自己触发的变更被当成用户改动 */
let suppressDirty = 0;
function withDirtySuppressed<T>(fn: () => T): T {
  suppressDirty += 1;
  try {
    return fn();
  } finally {
    suppressDirty -= 1;
  }
}

function markDirty(): void {
  if (suppressDirty > 0) return;
  if (!projectStore.get().dirty) projectStore.set({ dirty: true });
}

/** 自动保存当前内容到应用数据目录（只在有改动时写） */
export async function autosave(): Promise<void> {
  const st = projectStore.get();
  if (!st.paths || !st.dirty) return;
  try {
    await projectSave(st.paths.autosavePath, snapshot());
    projectStore.set({ autosavedAt: Date.now() });
  } catch (e) {
    setMsg(`自动保存失败: ${e}`);
  }
}

let inited = false;

/** 启动时初始化：读取应用路径、偏好、上次自动保存（幂等） */
export function initProject(): Promise<void> {
  if (inited) return Promise.resolve();
  inited = true;
  return (async () => {
    let paths: AppPaths | null = null;
    try {
      paths = await appPaths();
    } catch {
      paths = null;
    }
    let recent: RecentEntry[] = [];
    try {
      recent = (await prefsLoad()).recent ?? [];
    } catch {
      /* 忽略：首次运行没有偏好文件 */
    }

    let session: ProjectFile | null = null;
    if (paths) {
      try {
        const { project } = parseProjectFile(await readTextFile(paths.autosavePath));
        if (project) session = project;
      } catch {
        /* 没有自动保存文件 */
      }
    }

    projectStore.set({ paths, recent, session, ready: true });

    // 内容变化即标记为"有改动"（保存/打开/新建后会被清掉）
    editorStore.subscribe(markDirty);
    circuitStore.subscribe(markDirty);

    setInterval(() => {
      void autosave();
    }, AUTOSAVE_INTERVAL_MS);

    if (session) {
      setMsg("检测到上次未保存的编辑，可在「工程 → 恢复上次」中找回");
    }
  })();
}

/** 新建工程：清空源码与电路图，但保留本机路径配置（fw 目录、固件镜像） */
export function newProject(): void {
  withDirtySuppressed(() => {
    resetCircuit();
  });
  projectStore.set({ path: null, name: DEFAULT_PROJECT_NAME, dirty: false, session: null });
  setMsg("已新建工程（源码与电路图已重置，fw 目录与固件路径保留）");
}

/** 打开指定路径的工程文件 */
export async function openProjectPath(path: string): Promise<void> {
  try {
    const { project, errors } = parseProjectFile(await readTextFile(path));
    if (!project) {
      setMsg(`打开失败：${errors.join("；")}`);
      return;
    }
    let diagramErrors: string[] = [];
    withDirtySuppressed(() => {
      diagramErrors = applyProject(project);
    });
    const name = project.name || projectNameFromPath(path);
    const recent = touchRecent(projectStore.get().recent, {
      path,
      name,
      openedAt: new Date().toISOString(),
    });
    projectStore.set({ path, name, dirty: false, recent, lastSavedAt: Date.now(), session: null });
    await persistPrefs();
    const problems = [...errors, ...diagramErrors];
    setMsg(
      problems.length > 0
        ? `已打开 ${name}，但有问题：${problems.slice(0, 3).join("；")}`
        : `已打开工程：${name}`,
    );
  } catch (e) {
    setMsg(`打开工程失败: ${e}`);
  }
}

/** 弹出文件选择框打开工程 */
export async function openProject(): Promise<void> {
  const file = await open({
    title: "打开工程",
    filters: [{ name: "FengtouMu 工程", extensions: [PROJECT_EXT, "json"] }],
  });
  if (typeof file !== "string") return;
  await openProjectPath(file);
}

/** 保存到当前路径；没有路径则转为"另存为" */
export async function saveProject(): Promise<void> {
  const { path } = projectStore.get();
  if (!path) {
    await saveProjectAs();
    return;
  }
  try {
    await projectSave(path, snapshot());
    projectStore.set({ dirty: false, lastSavedAt: Date.now(), session: null });
    await persistPrefs();
    setMsg(`已保存 ${path}`);
  } catch (e) {
    setMsg(`保存失败: ${e}`);
  }
}

/** 另存为 */
export async function saveProjectAs(): Promise<void> {
  const st = projectStore.get();
  const path = await save({
    title: "工程另存为",
    defaultPath: projectFileName(st.name),
    filters: [{ name: "FengtouMu 工程", extensions: [PROJECT_EXT] }],
  });
  if (typeof path !== "string") return;
  const name = projectNameFromPath(path);
  try {
    await projectSave(path, buildProjectFile({ ...snapshotInput(), name }));
    const recent = touchRecent(st.recent, {
      path,
      name,
      openedAt: new Date().toISOString(),
    });
    projectStore.set({ path, name, dirty: false, recent, lastSavedAt: Date.now(), session: null });
    await persistPrefs();
    setMsg(`已保存 ${path}`);
  } catch (e) {
    setMsg(`保存失败: ${e}`);
  }
}

/** 恢复上次退出时残留的自动保存内容 */
export async function restoreSession(): Promise<void> {
  const session = projectStore.get().session;
  if (!session) {
    setMsg("没有可恢复的自动保存内容");
    return;
  }
  const errors = withDirtySuppressed(() => applyProject(session));
  projectStore.set({
    path: null,
    name: session.name || DEFAULT_PROJECT_NAME,
    dirty: true,
    session: null,
    lastSavedAt: null,
  });
  setMsg(
    errors.length > 0
      ? `已恢复上次编辑，但电路图有问题：${errors.slice(0, 3).join("；")}`
      : "已恢复上次未保存的编辑（建议立即「另存为」）",
  );
}

/** 丢弃自动保存内容（同时清空文件，避免下次启动又被提示） */
export async function discardSession(): Promise<void> {
  const paths = projectStore.get().paths;
  projectStore.set({ session: null });
  if (paths) {
    try {
      await writeTextFile(paths.autosavePath, "");
    } catch {
      /* 文件清空失败不影响本次会话 */
    }
  }
  setMsg("已忽略上次的自动保存内容");
}

/** 导入 Wokwi 兼容 zip：解压到应用数据目录，并套用其中的电路图与源码 */
export async function importWokwiProject(): Promise<void> {
  const st = projectStore.get();
  if (!st.paths) {
    setMsg("应用数据目录未就绪，无法导入");
    return;
  }
  const file = await open({
    title: "导入 Wokwi 工程 zip",
    filters: [{ name: "Wokwi 工程", extensions: ["zip"] }],
  });
  if (typeof file !== "string") return;
  const stem = (file.split(/[\\/]/).pop() ?? "wokwi").replace(/\.zip$/i, "");
  const dest = `${st.paths.configDir}\\imports\\${stem}`;
  try {
    const r = await importWokwiZip(file, dest);
    const brandNew = withDirtySuppressed(() => {
      const errors: string[] = [];
      if (r.sketch) setCode(r.sketch);
      if (r.diagram) errors.push(...importDiagramText(r.diagram));
      const patch: Partial<EditorState> = {};
      if (r.sketchDir) patch.sketchDir = r.sketchDir;
      if (Object.keys(patch).length > 0) editorStore.set(patch);
      return errors;
    });
    const name = stem || DEFAULT_PROJECT_NAME;
    projectStore.set({ path: null, name, dirty: true });
    const problems = [...r.notes, ...brandNew];
    setMsg(
      problems.length > 0
        ? `已导入 ${name}（${problems.slice(0, 3).join("；")}）；建议「另存为」保存为本地工程`
        : `已导入 ${name}；建议「另存为」保存为本地工程`,
    );
  } catch (e) {
    setMsg(`导入失败: ${e}`);
  }
}

/** 导出为 Wokwi 兼容 zip（diagram.json + sketch.ino） */
export async function exportWokwiProject(): Promise<void> {
  const st = projectStore.get();
  const path = await save({
    title: "导出为 Wokwi 工程 zip",
    defaultPath: `${st.name || DEFAULT_PROJECT_NAME}.zip`,
    filters: [{ name: "Wokwi 工程", extensions: ["zip"] }],
  });
  if (typeof path !== "string") return;
  try {
    await exportWokwiZip(path, exportDiagramText(), editorStore.get().code, st.name);
    setMsg(`已导出 Wokwi 工程：${path}（含 diagram.json 与 sketch.ino）`);
  } catch (e) {
    setMsg(`导出失败: ${e}`);
  }
}
