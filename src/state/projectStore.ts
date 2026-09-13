/**
 * 工程域：当前工程文件、最近工程列表、自动保存与恢复。
 *
 * 职责边界：
 *   - 工程文件只存"内容"（源码 + diagram.json + 路径配置），不存运行状态；
 *   - 与编辑器/电路两个域通过 applyProject / snapshot 双向同步；
 *   - 自动保存写到应用数据目录下的 autosave.vlx，重启后可在工程菜单里恢复。
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import {
  appPaths,
  exportWokwiZip,
  importWokwiZip,
  libraryDelete,
  libraryList,
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
  type LibraryEntry,
  type ProjectFile,
  type RecentEntry,
} from "../project/format";
import { circuitStore, exportDiagramText, importDiagramText, resetCircuit } from "./circuitStore";
import { editorStore, setCode, type EditorState } from "./editorStore";
import { simStore, stopSim } from "./simStore";
import { createStore } from "./store";
import { setMsg } from "./uiStore";
import { DEFAULT_SKETCH } from "../project/defaults";

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
  /** 本地项目库（应用数据目录 projects/ 下的工程条目，按更新时间倒序） */
  library: LibraryEntry[];
  /** 当前工程在项目库里的 id；null 表示尚未登记到库 */
  libraryId: string | null;
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
  library: [],
  libraryId: null,
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
  scheduleLibrarySave();
}

// ---------------- 本地项目库（CircuitMuse 风格） ----------------

/** 防抖定时器：编辑停止 2s 后把当前工作区自动写进项目库（照抄 CircuitMuse autoSaveCurrentState） */
let librarySaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleLibrarySave(): void {
  if (librarySaveTimer) clearTimeout(librarySaveTimer);
  librarySaveTimer = setTimeout(() => {
    void saveToLibrary();
  }, 2000);
}

/** 刷新项目库列表（打开 Projects 弹窗 / 保存后调用） */
export async function refreshLibrary(): Promise<void> {
  try {
    const library = await libraryList();
    projectStore.set({ library });
  } catch (e) {
    setMsg(`读取项目库失败: ${e}`);
  }
}

/** 为当前工作区分配一个项目库 id（可排序、仅安全字符） */
function newLibraryId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把当前工作区快照保存到项目库（`<configDir>/projects/<id>.vlx`）。
 * - 当前工作区已有 libraryId → 覆盖该条目；
 * - 没有 → 自动分配新 id 并登记（新建工程 / 导入的文件也进库，与 CircuitMuse 一致）。
 */
export async function saveToLibrary(): Promise<void> {
  const st = projectStore.get();
  if (!st.paths) return;
  const id = st.libraryId ?? newLibraryId();
  const path = `${st.paths.configDir}\\projects\\${id}.vlx`;
  try {
    await projectSave(path, snapshot());
    projectStore.set({ libraryId: id, autosavedAt: Date.now() });
    await refreshLibrary();
  } catch (e) {
    setMsg(`保存到项目库失败: ${e}`);
  }
}

/** 从项目库打开一个工程（读取内容灌入编辑器与电路图） */
export async function openFromLibrary(id: string): Promise<void> {
  const st = projectStore.get();
  if (!st.paths) {
    setMsg("应用数据目录未就绪，无法打开");
    return;
  }
  try {
    const { project, errors } = parseProjectFile(
      await readTextFile(`${st.paths.configDir}\\projects\\${id}.vlx`),
    );
    if (!project) {
      setMsg(`打开失败：${errors.join("；")}`);
      return;
    }
    let diagramErrors: string[] = [];
    withDirtySuppressed(() => {
      diagramErrors = applyProject(project);
    });
    const name = project.name || DEFAULT_PROJECT_NAME;
    projectStore.set({ path: null, name, libraryId: id, dirty: false, lastSavedAt: Date.now() });
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

/** 从项目库删除一个工程（删除文件并刷新列表；删除的是当前工程则重置工作区） */
export async function deleteFromLibrary(id: string): Promise<void> {
  try {
    await libraryDelete(id);
  } catch (e) {
    setMsg(`删除项目库条目失败: ${e}`);
    return;
  }
  const st = projectStore.get();
  const library = st.library.filter((e) => e.id !== id);
  const wasCurrent = st.libraryId === id;
  if (wasCurrent) {
    projectStore.set({
      library,
      libraryId: null,
      path: null,
      name: DEFAULT_PROJECT_NAME,
      dirty: false,
    });
    setMsg("已删除当前工程（工作区已重置）");
  } else {
    projectStore.set({ library });
    setMsg("已删除工程");
  }
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

    // 启动时加载项目库列表
    void refreshLibrary();

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

/** 新建工程（照抄 velxio/circuit-muse 交互：确认 → 停止仿真 → 清空 → 重置默认代码）。
 * 返回是否真正新建（用户在确认框点取消时返回 false）。 */
export async function newProject(): Promise<boolean> {
  const st = projectStore.get();
  const hasWork = st.dirty || editorStore.get().code !== DEFAULT_SKETCH;
  if (hasWork) {
    // Tauri 2 的 window.confirm 返回 Promise（原生对话框，异步），必须 await
    const ok = await window.confirm(
      "Start a new project? This clears every component, wire and file. This cannot be undone.",
    );
    if (!ok) return false;
  }
  // 停止仿真（幂等：未运行则 no-op），与 velxio newProject 一致
  if (simStore.get().status === "running" || simStore.get().status === "loading" || simStore.get().status === "stopping") {
    await stopSim();
  }
  withDirtySuppressed(() => {
    resetCircuit();
  });
  setCode(DEFAULT_SKETCH);
  projectStore.set({
    path: null,
    name: DEFAULT_PROJECT_NAME,
    dirty: false,
    session: null,
    libraryId: newLibraryId(),
  });
  void saveToLibrary();
  setMsg("已新建工程（源码与电路图已重置）");
  return true;
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
    projectStore.set({
      path,
      name,
      dirty: false,
      recent,
      lastSavedAt: Date.now(),
      session: null,
      libraryId: newLibraryId(),
    });
    await persistPrefs();
    void saveToLibrary();
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

/** 弹出文件选择框打开工程（.vlx 为主；.zip 走 Wokwi 导入） */
export async function openProject(): Promise<void> {
  const file = await open({
    title: "打开工程",
    filters: [
      { name: "FengtouMu 工程 (.vlx)", extensions: [PROJECT_EXT] },
      { name: "Wokwi 工程 (.zip)", extensions: ["zip"] },
      { name: "工程 JSON", extensions: ["json"] },
    ],
  });
  if (typeof file !== "string") return;
  if (file.toLowerCase().endsWith(".zip")) {
    await importWokwiProject();
    return;
  }
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

/** 另存为（`.vlx` 自包含快照） */
export async function saveProjectAs(): Promise<void> {
  const st = projectStore.get();
  const path = await save({
    title: "工程另存为",
    defaultPath: projectFileName(st.name),
    filters: [{ name: "FengtouMu 工程 (.vlx)", extensions: [PROJECT_EXT] }],
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
    projectStore.set({
      path,
      name,
      dirty: false,
      recent,
      lastSavedAt: Date.now(),
      session: null,
      libraryId: newLibraryId(),
    });
    await persistPrefs();
    void saveToLibrary();
    setMsg(`已保存 ${path}`);
  } catch (e) {
    setMsg(`保存失败: ${e}`);
  }
}

/** 从最近工程列表移除记录（不删除磁盘文件），并持久化 */
export async function removeRecent(path: string): Promise<void> {
  const st = projectStore.get();
  if (!st.recent.some((e) => e.path === path)) return;
  const recent = st.recent.filter((e) => e.path !== path);
  projectStore.set({ recent });
  await persistPrefs();
  setMsg("已从最近工程列表移除");
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
    libraryId: newLibraryId(),
  });
  void saveToLibrary();
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
    projectStore.set({ path: null, name, dirty: true, libraryId: newLibraryId() });
    void saveToLibrary();
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
