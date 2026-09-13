/**
 * 工程文件（`.vlx`）格式与纯函数工具。
 *
 * `.vlx` 是自包含快照：源码文件（files[]）与电路图（diagram 文本）全部内嵌，
 * 不依赖任何外部目录路径 —— 文件拷到任何电脑/位置都能完整还原。
 * 兼容读取：旧 `.fmp`（无 format 字段的单文件 code 结构）与 velxio/circuit-muse
 * 的 `.vlx`（format: velxio-project / circuit-muse-project，fileGroups 结构）。
 *
 * 与 Rust 侧 `project.rs` 的 `Project` 结构一一对应（camelCase）。
 * 这里只做「组装 / 解析 / 校验」，不触碰任何界面或仿真状态，便于单元测试。
 */

export const PROJECT_VERSION = 1;
/** 工程文件扩展名：`.vlx`（自包含） */
export const PROJECT_EXT = "vlx";
/** 本应用 `.vlx` 的格式标识 */
export const VLX_FORMAT = "fengtoumu-project";
/** 兼容读取的外部格式标识 */
export const VLX_FORMATS = new Set(["velxio-project", "circuit-muse-project"]);

/** `.vlx` 里的源码文件条目 */
export interface ProjectFileEntry {
  name: string;
  content: string;
}

/** 工程文件内容 */
export interface ProjectFile {
  /** 格式标识；本应用 `.vlx` 为 `fengtoumu-project`；旧 .fmp 无此字段 */
  format?: string;
  version: number;
  name: string;
  updatedAt: string;
  /** 创建时间（项目库条目用；外部文件可能缺失） */
  createdAt?: string;
  /** 源码文件列表（`.vlx` 自包含：名称 + 内容全部内嵌） */
  files: ProjectFileEntry[];
  /** 当前主源码（编辑器内容；兼容旧 .fmp 的单文件字段） */
  code: string;
  /** diagram.json 文本（Wokwi 兼容） */
  diagram: string;
  /** 以下为可选的本机路径信息：仅同机继续编辑时作为加速，不参与内容比较 */
  sketchDir: string;
  fwDir: string;
  flashPath: string;
  fqbn: string;
}

/** 项目库条目元数据（不含内容，ProjectsModal 列表用） */
export interface LibraryEntry {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
}

export interface RecentEntry {
  path: string;
  name: string;
  openedAt: string;
}

export interface Prefs {
  recent: RecentEntry[];
  lastProject: string | null;
}

export interface AppPaths {
  configDir: string;
  prefsPath: string;
  autosavePath: string;
}

export interface WokwiImport {
  diagram: string | null;
  sketch: string | null;
  sketchDir: string | null;
  extractedDir: string;
  notes: string[];
}

export const DEFAULT_PROJECT_NAME = "未命名工程";

export const DEFAULT_FQBN =
  "esp32:esp32:esp32:FlashMode=dio,FlashFreq=40,FlashSize=4M,PartitionScheme=default,PSRAM=disabled";

export interface BuildProjectInput {
  name: string;
  code: string;
  diagram: string;
  sketchDir: string;
  fwDir: string;
  flashPath: string;
  fqbn?: string;
  updatedAt?: string;
  createdAt?: string;
  /** 附加源码文件（`.vlx` 自包含用）；主源码自动并入 files 首位 */
  extraFiles?: Array<{ name: string; content: string }>;
}

/** 组装一份 `.vlx` 工程文件（时间戳默认取当前时间；源码与电路图全部内嵌） */
export function buildProjectFile(input: BuildProjectInput): ProjectFile {
  const now = new Date().toISOString();
  return {
    format: VLX_FORMAT,
    version: PROJECT_VERSION,
    name: input.name || DEFAULT_PROJECT_NAME,
    updatedAt: input.updatedAt ?? now,
    createdAt: input.createdAt ?? now,
    files: [
      { name: "sketch.ino", content: input.code },
      ...(input.extraFiles ?? []),
    ],
    code: input.code,
    diagram: input.diagram,
    sketchDir: input.sketchDir,
    fwDir: input.fwDir,
    flashPath: input.flashPath,
    fqbn: input.fqbn || DEFAULT_FQBN,
  };
}

/** 从文件路径推断工程名：`D:\x\闪烁灯.vlx` → `闪烁灯` */
export function projectNameFromPath(path: string): string {
  if (!path) return DEFAULT_PROJECT_NAME;
  const base = path.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.(vlx|fmp|json|zip)$/i, "");
  return stem || DEFAULT_PROJECT_NAME;
}

/** 由工程名生成文件名（去掉路径非法字符，补扩展名） */
export function projectFileName(name: string): string {
  const cleaned = (name || DEFAULT_PROJECT_NAME)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return `${cleaned || DEFAULT_PROJECT_NAME}.${PROJECT_EXT}`;
}

/**
 * 解析工程文件文本（`.vlx`，兼容旧 `.fmp` 与 velxio/circuit-muse 的 `.vlx`）。
 * 返回 `project: null` 表示这不是一份可用的工程文件，具体原因在 `errors` 中。
 */
export function parseProjectFile(text: string): { project: ProjectFile | null; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { project: null, errors: [`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { project: null, errors: ["工程文件根节点应为对象"] };
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  const arr = (k: string): unknown[] => (Array.isArray(o[k]) ? (o[k] as unknown[]) : []);
  const obj = (k: string): Record<string, unknown> =>
    typeof o[k] === "object" && o[k] !== null && !Array.isArray(o[k])
      ? (o[k] as Record<string, unknown>)
      : {};

  const version = typeof o.version === "number" ? o.version : 0;
  if (version > PROJECT_VERSION) {
    errors.push(`工程文件版本 ${version} 高于当前支持的 ${PROJECT_VERSION}，请升级应用`);
  }
  if (version === 0) {
    errors.push(`缺少 version 字段（当前支持 ${PROJECT_VERSION}）`);
  }

  // 识别 velxio / circuit-muse 的 .vlx：源码在 fileGroups 里，按组平铺
  const format = str("format");
  let files: Array<{ name: string; content: string }> = [];
  let code = str("code");
  let diagram = str("diagram");
  let sketchDir = str("sketchDir");
  let fwDir = str("fwDir");
  let flashPath = str("flashPath");

  if (VLX_FORMATS.has(format)) {
    const fileGroups = obj("fileGroups");
    for (const gid of Object.keys(fileGroups)) {
      const group = fileGroups[gid];
      if (!Array.isArray(group)) continue;
      for (const f of group) {
        const fo = f as Record<string, unknown>;
        const name = typeof fo.name === "string" ? fo.name : "";
        const content = typeof fo.content === "string" ? fo.content : "";
        if (name) files.push({ name, content });
      }
    }
    if (!code) {
      const ino = files.find((f) => f.name.toLowerCase().endsWith(".ino"));
      code = ino ? ino.content : (files[0]?.content ?? "");
    }
    // 外部工程没有 FengtouMu 路径信息；若电路图缺失则给空（后续由 UI 提示仅代码可还原）
    diagram = str("diagram");
    if (files.length > 0) {
      sketchDir = "";
      fwDir = "";
      flashPath = "";
    }
  } else {
    // 本应用 .vlx（format=fengtoumu-project）或旧 .fmp（无 format）：files 数组为权威
    if (o.files !== undefined) {
      for (const f of arr("files")) {
        const fo = f as Record<string, unknown>;
        const name = typeof fo.name === "string" ? fo.name : "";
        const content = typeof fo.content === "string" ? fo.content : "";
        if (name) files.push({ name, content });
      }
      if (!code) {
        const ino = files.find((f) => f.name.toLowerCase().endsWith(".ino"));
        code = ino ? ino.content : (files[0]?.content ?? "");
      }
    }
    sketchDir = str("sketchDir");
    fwDir = str("fwDir");
    flashPath = str("flashPath");
  }

  const looksLikeProject = Boolean(code || diagram || files.length > 0);
  if (!looksLikeProject) {
    errors.push("既没有源码也没有电路图，可能不是工程文件");
  }

  const project: ProjectFile = {
    format: format || VLX_FORMAT,
    version: version || PROJECT_VERSION,
    name: str("name") || DEFAULT_PROJECT_NAME,
    updatedAt: str("updatedAt"),
    createdAt: str("createdAt") || undefined,
    files,
    code,
    diagram,
    sketchDir,
    fwDir,
    flashPath,
    fqbn: str("fqbn") || DEFAULT_FQBN,
  };

  // 版本过新、或根本不像工程文件时，不再交给上层使用
  if (version > PROJECT_VERSION || !looksLikeProject) return { project: null, errors };
  return { project, errors };
}

/** 最近工程列表：去重（同路径只保留最新）、按时间倒序、限制长度 */
export function touchRecent(list: RecentEntry[], entry: RecentEntry, max = 8): RecentEntry[] {
  const rest = list.filter((e) => e.path !== entry.path);
  return [entry, ...rest].slice(0, max);
}

/** 两份工程内容是否等价（用于判断"有没有改动"） */
export function sameProjectContent(a: ProjectFile, b: ProjectFile): boolean {
  // files 按 (name,content) 排序后比较，等价于比较全部源码文件集合
  const key = (f: Array<{ name: string; content: string }>) =>
    [...f]
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((f2) => `${f2.name}\u0000${f2.content}`)
      .join("\u0001");
  return (
    key(a.files) === key(b.files) &&
    a.code === b.code &&
    a.diagram === b.diagram &&
    a.fqbn === b.fqbn
  );
}
