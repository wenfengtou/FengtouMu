//! 环境自检：启动时清点运行所需的各项依赖，缺什么、怎么补，一次性告诉用户。
//!
//! 检查项与判据（每一项都给出「可执行的下一步」）：
//!   1. QEMU 动态库 libqemu-xtensa.dll（存在、体积合理、关键依赖 DLL 齐全）
//!   2. QEMU 固件目录（含 esp32-v3-rom.bin / esp32-v3-rom-app.bin）
//!   3. 仿真子进程 esp32-sim.exe
//!   4. arduino-cli（可执行 + 能打印版本）
//!   5. ESP32 开发板核心 esp32:esp32（arduino-cli core list）
//!   6. 固件镜像（当前选中的 merged.bin）
//!   7. 应用数据目录可写（工程文件与最近列表要写这里）

use crate::sim::buildchain::find_arduino_cli;
use crate::sim::engine::discover_dll;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub id: String,
    pub name: String,
    /// ok | warn | missing
    pub status: String,
    pub detail: String,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport {
    /// 没有任何 missing 项即为就绪
    pub ok: bool,
    pub missing: usize,
    pub items: Vec<CheckItem>,
}

fn item(id: &str, name: &str, status: &str, detail: impl Into<String>, hint: impl Into<String>) -> CheckItem {
    CheckItem {
        id: id.to_string(),
        name: name.to_string(),
        status: status.to_string(),
        detail: detail.into(),
        hint: hint.into(),
    }
}

/// 定位 fw 目录：显式传入 > 环境变量 > DLL 同级 fw > 程序目录回溯 lib/qemu/fw
pub fn discover_fw_dir(explicit: Option<&str>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = explicit {
        if !p.is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }
    if let Ok(p) = std::env::var("ESP32_IDE_FW_DIR") {
        candidates.push(PathBuf::from(p));
    }
    if let Some(dll) = discover_dll() {
        if let Some(dir) = dll.parent() {
            candidates.push(dir.join("fw"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent();
        for _ in 0..4 {
            if let Some(d) = dir {
                candidates.push(d.join("lib").join("qemu").join("fw"));
                dir = d.parent();
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("lib").join("qemu").join("fw"));
    }
    candidates.into_iter().find(|c| c.is_dir())
}

/// 定位仿真子进程 esp32-sim.exe（与 worker_host 的查找顺序保持一致）。
pub fn discover_worker() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ESP32_IDE_SIM_WORKER") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for cand in [
        dir.join("esp32-sim.exe"),
        dir.join("resources").join("esp32-sim.exe"),
        dir.join("../esp32-sim.exe"),
    ] {
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn human_size(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    format!("{:.1} MB", bytes as f64 / MB)
}

/// 检查指定路径上的 QEMU 动态库及其依赖（纯函数：只看给定路径，便于测试）
pub fn check_dll_at(path: &Path) -> Vec<CheckItem> {
    let mut items = Vec::new();
    if !path.is_file() {
        items.push(item(
            "dll",
            "QEMU 动态库",
            "missing",
            format!("{} 不存在", path.display()),
            "按 docs/build-qemu-dll-windows.md 自行编译，或把已有的 libqemu-xtensa.dll 及其依赖 DLL 放到项目的 lib/qemu/ 目录",
        ));
        return items;
    }
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    // QEMU 动态库本身约 68 MB；明显偏小说明文件不完整
    let status = if size > 10 * 1024 * 1024 { "ok" } else { "warn" };
    items.push(item(
        "dll",
        "QEMU 动态库",
        status,
        format!("{}（{}）", path.display(), human_size(size)),
        if status == "warn" {
            "文件明显偏小，可能下载/复制不完整，建议重新编译或重新拷贝"
        } else {
            ""
        },
    ));
    // 同目录下的依赖 DLL：缺了会表现为「DLL 能加载但 QEMU 起不来」
    let missing_deps: Vec<String> = ["libglib-2.0-0.dll", "libgcc_s_seh-1.dll", "libpixman-1-0.dll"]
        .iter()
        .filter(|d| {
            path.parent()
                .map(|dir| !dir.join(d).is_file())
                .unwrap_or(true)
        })
        .map(|d| d.to_string())
        .collect();
    if missing_deps.is_empty() {
        items.push(item("dll-deps", "QEMU 依赖 DLL", "ok", "glib / gcc / pixman 均已就位", ""));
    } else {
        items.push(item(
            "dll-deps",
            "QEMU 依赖 DLL",
            "missing",
            format!("缺少 {}", missing_deps.join("、")),
            "把 lib/qemu 目录下的依赖 DLL 一并复制过来（它们与 libqemu-xtensa.dll 同目录）",
        ));
    }
    items
}

fn check_dll() -> Vec<CheckItem> {
    match discover_dll() {
        Some(p) => check_dll_at(&p),
        None => check_dll_at(Path::new("<未找到 libqemu-xtensa.dll>")),
    }
}

/// 检查指定 fw 目录（纯函数：只看给定目录）
pub fn check_fw_at(dir: &Path) -> CheckItem {
    if !dir.is_dir() {
        return item(
            "fw",
            "QEMU 固件目录",
            "missing",
            format!("{} 不是目录或不存在", dir.display()),
            "编译 libqemu-xtensa.dll 时会一并产出 fw 目录；也可用顶部「fw 目录…」按钮手动指定",
        );
    }
    let rom = dir.join("esp32-v3-rom.bin");
    let rom_app = dir.join("esp32-v3-rom-app.bin");
    let keymaps = dir.join("keymaps");
    if rom.is_file() && rom_app.is_file() {
        let km = if keymaps.is_dir() { "keymaps 已就位" } else { "缺少 keymaps 子目录" };
        let status = if keymaps.is_dir() { "ok" } else { "warn" };
        item("fw", "QEMU 固件目录", status, format!("{}（{km}）", dir.display()), "")
    } else {
        item(
            "fw",
            "QEMU 固件目录",
            "missing",
            format!("{} 中缺少 esp32-v3-rom.bin / esp32-v3-rom-app.bin", dir.display()),
            "从已编译好的 lib/qemu/fw 拷贝 ROM 与 keymaps，或用 fw 目录…按钮指向正确目录",
        )
    }
}

fn check_fw(explicit: Option<&str>) -> CheckItem {
    match discover_fw_dir(explicit) {
        Some(dir) => check_fw_at(&dir),
        None => check_fw_at(Path::new("<未找到 fw 目录>")),
    }
}

fn check_worker() -> CheckItem {
    match discover_worker() {
        Some(p) => item("worker", "仿真子进程", "ok", p.display().to_string(), ""),
        None => item(
            "worker",
            "仿真子进程",
            "missing",
            "未找到 esp32-sim.exe",
            "运行 npm run build:release（或 cargo build --release --bins）生成后，它会与主程序同目录或位于 resources 子目录",
        ),
    }
}

fn check_arduino_cli() -> CheckItem {
    match find_arduino_cli() {
        Some(p) => {
            let out = Command::new(&p).arg("version").output();
            match out {
                Ok(o) if o.status.success() => {
                    let text = String::from_utf8_lossy(&o.stdout);
                    let version = text
                        .lines()
                        .find(|l| l.contains("Version"))
                        .unwrap_or(text.lines().next().unwrap_or(""))
                        .trim()
                        .to_string();
                    item("arduino-cli", "arduino-cli", "ok", format!("{}（{version}）", p.display()), "")
                }
                _ => item(
                    "arduino-cli",
                    "arduino-cli",
                    "warn",
                    format!("{} 无法执行 version", p.display()),
                    "确认 arduino-cli.exe 可正常运行；必要时重新下载后设置环境变量 ARDUINO_CLI",
                ),
            }
        }
        None => item(
            "arduino-cli",
            "arduino-cli",
            "missing",
            "未找到 arduino-cli",
            "下载 arduino-cli 后把路径写入环境变量 ARDUINO_CLI（应用也会检查 D:\\work\\Esp32Qume\\tools\\arduino-cli 与 %LOCALAPPDATA%）",
        ),
    }
}

fn check_esp32_core() -> CheckItem {
    let Some(cli) = find_arduino_cli() else {
        return item(
            "esp32-core",
            "ESP32 开发板核心",
            "missing",
            "arduino-cli 缺失，无法检查核心",
            "先补齐 arduino-cli，再执行 arduino-cli core install esp32:esp32",
        );
    };
    match Command::new(&cli).arg("core").arg("list").output() {
        Ok(o) if o.status.success() => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            match text.lines().find(|l| l.contains("esp32:esp32")) {
                Some(line) => item("esp32-core", "ESP32 开发板核心", "ok", line.trim().to_string(), ""),
                None => item(
                    "esp32-core",
                    "ESP32 开发板核心",
                    "missing",
                    "未安装 esp32:esp32 核心",
                    "执行 arduino-cli core install esp32:esp32（首次约 200 MB，需要联网）",
                ),
            }
        }
        _ => item(
            "esp32-core",
            "ESP32 开发板核心",
            "warn",
            "无法执行 arduino-cli core list",
            "在命令行手动执行 arduino-cli core list 查看具体报错",
        ),
    }
}

/// 检查固件镜像（纯函数：只看给定路径）
pub fn check_flash_at(p: &str) -> CheckItem {
    if p.is_empty() {
        return item(
            "flash",
            "固件镜像",
            "warn",
            "尚未选择固件镜像",
            "点顶部「编译」用 arduino-cli 生成 merged.bin，或用「固件…」选择已有镜像",
        );
    }
    if Path::new(p).is_file() {
        let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        item("flash", "固件镜像", "ok", format!("{p}（{}）", human_size(size)), "")
    } else {
        item(
            "flash",
            "固件镜像",
            "warn",
            format!("{p} 不存在"),
            "点顶部「编译」用 arduino-cli 生成 merged.bin，或用「固件…」选择已有镜像",
        )
    }
}

fn check_flash(explicit: Option<&str>) -> CheckItem {
    check_flash_at(explicit.unwrap_or(""))
}

fn check_config_dir(app: &AppHandle) -> CheckItem {
    let dir = match app.path().app_config_dir() {
        Ok(d) => d,
        Err(e) => {
            return item("config-dir", "应用数据目录", "warn", format!("无法定位: {e}"), "检查系统用户目录权限");
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return item(
            "config-dir",
            "应用数据目录",
            "missing",
            format!("{} 创建失败: {e}", dir.display()),
            "检查该目录的写入权限（受控文件夹访问/杀毒软件可能拦截）",
        );
    }
    let probe = dir.join(".write-probe");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            item("config-dir", "应用数据目录", "ok", dir.display().to_string(), "")
        }
        Err(e) => item(
            "config-dir",
            "应用数据目录",
            "missing",
            format!("{} 不可写: {e}", dir.display()),
            "检查该目录写入权限；工程文件与最近工程列表都保存在这里",
        ),
    }
}

#[tauri::command]
pub fn cmd_env_check(
    app: AppHandle,
    fw_dir: Option<String>,
    flash_path: Option<String>,
) -> EnvReport {
    let mut items = check_dll();
    items.push(check_fw(fw_dir.as_deref()));
    items.push(check_worker());
    items.push(check_arduino_cli());
    items.push(check_esp32_core());
    items.push(check_flash(flash_path.as_deref()));
    items.push(check_config_dir(&app));

    let missing = items.iter().filter(|i| i.status == "missing").count();
    EnvReport {
        ok: missing == 0,
        missing,
        items,
    }
}
