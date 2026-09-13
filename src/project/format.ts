/**
 * 工程文件（`.fmp`）格式与纯函数工具。
 *
 * 与 Rust 侧 `project.rs` 的 `Project` 结构一一对应（camelCase）。
 * 这里只做「组装 / 解析 / 校验」，不触碰任何界面或仿真状态，便于单元测试。
 */

export const PROJECT_VERSION = 1;
export const PROJECT_EXT = "fmp";

/** 工程文件内容 */
export interface ProjectFile {
  version: number;
  name: string;
  updatedAt: string;
  /** 创建时间（项目库条目用；外部 .fmp 可能缺失） */
  createdAt?: string;
  /** Arduino 源码 */
  code: string;
  /** diagram.json 文本（Wokwi 兼容） */
  diagram: string;
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
}

/** 组装一份工程文件（时间戳默认取当前时间） */
export function buildProjectFile(input: BuildProjectInput): ProjectFile {
  return {
    version: PROJECT_VERSION,
    name: input.name || DEFAULT_PROJECT_NAME,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    code: input.code,
    diagram: input.diagram,
    sketchDir: input.sketchDir,
    fwDir: input.fwDir,
    flashPath: input.flashPath,
    fqbn: input.fqbn || DEFAULT_FQBN,
  };
}

/** 从文件路径推断工程名：`D:\x\闪烁灯.fmp` → `闪烁灯` */
export function projectNameFromPath(path: string): string {
  if (!path) return DEFAULT_PROJECT_NAME;
  const base = path.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.(fmp|json)$/i, "");
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
 * 解析工程文件文本。
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

  const version = typeof o.version === "number" ? o.version : 0;
  if (version > PROJECT_VERSION) {
    errors.push(`工程文件版本 ${version} 高于当前支持的 ${PROJECT_VERSION}，请升级应用`);
  }
  if (version === 0) {
    errors.push(`缺少 version 字段（当前支持 ${PROJECT_VERSION}）`);
  }
  const looksLikeProject = Boolean(str("code") || str("diagram"));
  if (!looksLikeProject) {
    errors.push("既没有 code 也没有 diagram，可能不是 FengtouMu 工程文件");
  }

  const project: ProjectFile = {
    version: version || PROJECT_VERSION,
    name: str("name") || DEFAULT_PROJECT_NAME,
    updatedAt: str("updatedAt"),
    createdAt: str("createdAt") || undefined,
    code: str("code"),
    diagram: str("diagram"),
    sketchDir: str("sketchDir"),
    fwDir: str("fwDir"),
    flashPath: str("flashPath"),
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
  return (
    a.code === b.code &&
    a.diagram === b.diagram &&
    a.sketchDir === b.sketchDir &&
    a.fwDir === b.fwDir &&
    a.flashPath === b.flashPath &&
    a.fqbn === b.fqbn
  );
}
