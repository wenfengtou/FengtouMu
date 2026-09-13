//! 工程文件（`.fmp`）与偏好设置：读写、最近工程列表、Wokwi 兼容 zip 互导。
//!
//! 设计取向：电路图仍然以 `diagram.json` 文本原样存放，Rust 侧不认识元件模型，
//! 只负责「把一段 JSON 存下来 / 读出来」，电路语义全部留在前端。

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 工程文件格式版本，后续做迁移时用它判断。
pub const PROJECT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub updated_at: String,
    /// 创建时间（项目库条目用；外部 .fmp 可能缺失，空串即可）
    #[serde(default)]
    pub created_at: String,
    /// Arduino 源码（当前编辑器内容）
    #[serde(default)]
    pub code: String,
    /// diagram.json 文本（Wokwi 兼容）
    #[serde(default)]
    pub diagram: String,
    #[serde(default)]
    pub sketch_dir: String,
    #[serde(default)]
    pub fw_dir: String,
    #[serde(default)]
    pub flash_path: String,
    #[serde(default)]
    pub fqbn: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    #[serde(default)]
    pub recent: Vec<RecentEntry>,
    #[serde(default)]
    pub last_project: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub config_dir: String,
    pub prefs_path: String,
    pub autosave_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WokwiImport {
    /// 解压出来的 diagram.json 文本
    pub diagram: Option<String>,
    /// 解压出来的 .ino 文本
    pub sketch: Option<String>,
    /// 可直接交给 arduino-cli 的 sketch 目录
    pub sketch_dir: Option<String>,
    /// 解压目录
    pub extracted_dir: String,
    /// 需要让用户知道的情况（例如目录名与 .ino 不同名，已自动复制一份）
    pub notes: Vec<String>,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {e}"))?;
    Ok(dir)
}

fn write_text(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    let mut f = std::fs::File::create(path).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    f.write_all(contents.as_bytes())
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))
}

fn read_text(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))
}

// ---------------- 工程文件 ----------------

#[tauri::command]
pub fn cmd_project_save(path: String, project: Project) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&project).map_err(|e| format!("序列化工程失败: {e}"))?;
    write_text(Path::new(&path), &text)
}

#[tauri::command]
pub fn cmd_project_load(path: String) -> Result<Project, String> {
    let text = read_text(Path::new(&path))?;
    // 兼容手写/第三方文件：缺字段用默认值补齐
    serde_json::from_str::<Project>(&text).map_err(|e| format!("解析工程文件失败: {e}"))
}

// ---------------- 偏好设置（最近工程 / 上次工程） ----------------

#[tauri::command]
pub fn cmd_app_paths(app: AppHandle) -> Result<AppPaths, String> {
    let dir = config_dir(&app)?;
    Ok(AppPaths {
        config_dir: dir.to_string_lossy().to_string(),
        prefs_path: dir.join("prefs.json").to_string_lossy().to_string(),
        autosave_path: dir.join("autosave.fmp").to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn cmd_prefs_load(app: AppHandle) -> Result<Prefs, String> {
    let path = config_dir(&app)?.join("prefs.json");
    if !path.is_file() {
        return Ok(Prefs::default());
    }
    match read_text(&path).and_then(|t| {
        serde_json::from_str::<Prefs>(&t).map_err(|e| format!("解析偏好设置失败: {e}"))
    }) {
        Ok(p) => Ok(p),
        // 偏好损坏不应阻塞启动，按空处理
        Err(_) => Ok(Prefs::default()),
    }
}

#[tauri::command]
pub fn cmd_prefs_save(app: AppHandle, prefs: Prefs) -> Result<(), String> {
    let path = config_dir(&app)?.join("prefs.json");
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| format!("序列化偏好失败: {e}"))?;
    write_text(&path, &text)
}

// ---------------- Wokwi 兼容 zip ----------------

fn find_ino(dir: &Path, depth: usize) -> Option<PathBuf> {
    let mut subdirs: Vec<PathBuf> = Vec::new();
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() {
            if p.extension().map(|x| x.eq_ignore_ascii_case("ino")).unwrap_or(false) {
                return Some(p);
            }
        } else if p.is_dir() && depth > 0 {
            subdirs.push(p);
        }
    }
    for d in subdirs {
        if let Some(found) = find_ino(&d, depth - 1) {
            return Some(found);
        }
    }
    None
}

/// 把 Wokwi 工程 zip 解压到 `dest_dir`，并整理出可直接编译的 sketch 目录。
///
/// 说明：arduino-cli 要求「目录名与 .ino 同名」，而 Wokwi 的 zip 通常是根目录下的
/// `sketch.ino`。遇到这种情况会自动建一个 `<stem>/` 目录并把同一层的源文件复制进去。
#[tauri::command]
pub fn cmd_import_wokwi_zip(path: String, dest_dir: String) -> Result<WokwiImport, String> {
    let file = std::fs::File::open(&path).map_err(|e| format!("打开 zip 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 zip 失败: {e}"))?;
    let dest = PathBuf::from(&dest_dir);
    std::fs::create_dir_all(&dest).map_err(|e| format!("创建解压目录失败: {e}"))?;

    let mut notes: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;
        let Some(name) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        let out = dest.join(&name);
        if entry.is_dir() {
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("解压 {} 失败: {e}", name.display()))?;
        std::fs::write(&out, &buf).map_err(|e| format!("写入 {} 失败: {e}", out.display()))?;
    }

    let diagram_path = dest.join("diagram.json");
    let diagram = if diagram_path.is_file() {
        Some(read_text(&diagram_path)?)
    } else {
        notes.push("zip 中没有 diagram.json，电路图保持当前内容".into());
        None
    };

    let mut sketch_dir: Option<String> = None;
    let mut sketch: Option<String> = None;
    if let Some(ino) = find_ino(&dest, 2) {
        let stem = ino.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let parent = ino.parent().unwrap_or(&dest).to_path_buf();
        let parent_name = parent.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let target = if parent_name == stem {
            parent.clone()
        } else {
            let t = dest.join(&stem);
            std::fs::create_dir_all(&t).map_err(|e| format!("创建 sketch 目录失败: {e}"))?;
            let mut copied = 0;
            if let Ok(entries) = std::fs::read_dir(&parent) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.is_file() {
                        if let Some(fname) = p.file_name() {
                            if fname.to_string_lossy().eq_ignore_ascii_case("diagram.json") {
                                continue;
                            }
                            let _ = std::fs::copy(&p, t.join(fname));
                            copied += 1;
                        }
                    }
                }
            }
            notes.push(format!(
                "已把 {stem}.ino 及同层 {copied} 个文件复制到 {}/（arduino-cli 要求目录名与 .ino 同名）",
                t.display()
            ));
            t
        };
        sketch = read_text(&target.join(format!("{stem}.ino"))).ok();
        sketch_dir = Some(target.to_string_lossy().to_string());
    } else {
        notes.push("zip 中没有找到 .ino 源码".into());
    }

    if sketch.is_none() {
        sketch = None;
    }

    Ok(WokwiImport {
        diagram,
        sketch,
        sketch_dir,
        extracted_dir: dest.to_string_lossy().to_string(),
        notes,
    })
}

/// 导出为 Wokwi 兼容 zip（diagram.json + sketch.ino）。
#[tauri::command]
pub fn cmd_export_wokwi_zip(
    path: String,
    diagram: String,
    sketch: String,
    sketch_name: Option<String>,
) -> Result<(), String> {
    if let Some(dir) = Path::new(&path).parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    let file = std::fs::File::create(&path).map_err(|e| format!("创建 zip 失败: {e}"))?;
    let mut zw = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let ino_name = {
        let raw = sketch_name.unwrap_or_else(|| "sketch".to_string());
        let cleaned: String = raw
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .collect();
        if cleaned.to_ascii_lowercase().ends_with(".ino") {
            cleaned
        } else {
            format!("{cleaned}.ino")
        }
    };

    zw.start_file("diagram.json", opts)
        .map_err(|e| format!("写入 zip 失败: {e}"))?;
    zw.write_all(diagram.as_bytes())
        .map_err(|e| format!("写入 zip 失败: {e}"))?;
    zw.start_file(ino_name, opts)
        .map_err(|e| format!("写入 zip 失败: {e}"))?;
    zw.write_all(sketch.as_bytes())
        .map_err(|e| format!("写入 zip 失败: {e}"))?;
    zw.finish().map_err(|e| format!("完成 zip 失败: {e}"))?;
    Ok(())
}

// ---------------- 本地项目库（CircuitMuse 风格：应用数据目录下管理多个工程） ----------------

/// 项目库条目元数据（不含内容，列表用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub name: String,
    pub updated_at: String,
    pub created_at: String,
}

fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = config_dir(app)?.join("projects");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建项目库目录失败: {e}"))?;
    Ok(dir)
}

/// 列出项目库全部条目（按最近更新时间倒序）。只解析元数据，不加载内容。
#[tauri::command]
pub fn cmd_library_list(app: AppHandle) -> Result<Vec<LibraryEntry>, String> {
    let dir = library_dir(&app)?;
    let mut out: Vec<LibraryEntry> = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| format!("读取项目库失败: {e}"))? {
        let e = e.map_err(|e| format!("读取项目库条目失败: {e}"))?;
        let p = e.path();
        if p.extension().map(|x| x.eq_ignore_ascii_case("fmp")).unwrap_or(false) {
            if let Some(id) = p.file_stem().map(|s| s.to_string_lossy().to_string()) {
                let entry = match serde_json::from_str::<Project>(&read_text(&p)?) {
                    Ok(proj) => LibraryEntry {
                        id: id.clone(),
                        name: proj.name,
                        updated_at: proj.updated_at,
                        created_at: proj.created_at,
                    },
                    Err(_) => LibraryEntry {
                        id: id.clone(),
                        name: id,
                        updated_at: String::new(),
                        created_at: String::new(),
                    },
                };
                out.push(entry);
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// 从项目库删除一个工程（按 id 删除对应的 .fmp 文件）。
#[tauri::command]
pub fn cmd_library_delete(app: AppHandle, id: String) -> Result<(), String> {
    // 防路径穿越：id 只允许字母/数字/中划线/下划线
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() || safe != id {
        return Err("非法的项目 id".into());
    }
    let path = library_dir(&app)?.join(format!("{safe}.fmp"));
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除项目库条目失败: {e}")),
    }
}
