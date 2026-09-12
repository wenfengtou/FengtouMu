//! 编译链封装：调用 arduino-cli 编译 Arduino 工程并产出 QEMU 可用的 4MB 合并镜像。

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct CompileResult {
    pub ok: bool,
    pub merged_bin: Option<String>,
    pub message: String,
    /// 编译前是否把编辑器内容写进了草图目录的主 .ino
    pub synced: bool,
    /// 首次覆盖时留下的备份文件（`<sketch>.ino.bak`）
    pub backup: Option<String>,
}

/// 在用户配置中查找 arduino-cli（环境变量 ARDUINO_CLI > 常见安装位置）。
pub fn find_arduino_cli() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ARDUINO_CLI") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    for cand in [
        r"D:\work\Esp32Qume\tools\arduino-cli\arduino-cli.exe",
        r"C:\Users\lwf\AppData\Local\Arduino15\arduino-cli.exe",
    ] {
        let pb = PathBuf::from(cand);
        if pb.is_file() {
            return Some(pb);
        }
    }
    // PATH 兜底
    if let Ok(output) = std::process::Command::new("arduino-cli").arg("version").output() {
        if output.status.success() {
            return Some(PathBuf::from("arduino-cli"));
        }
    }
    None
}

/// sketch 名（不含扩展名）：优先取目录内与目录同名的 `.ino`，否则退而取目录里任意 `.ino`。
///
/// arduino-cli 要求 sketch 目录名与 `.ino` 同名，但用户手上拿到的目录未必规范，
/// 这里两种都尽量兼容，并把结果用作产物文件名。
pub fn sketch_name(sketch_dir: &Path) -> Option<String> {
    let dir_name = sketch_dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let entries = std::fs::read_dir(sketch_dir).ok()?;
    let mut fallback: Option<String> = None;
    for e in entries.flatten() {
        let p = e.path();
        let is_ino = p
            .extension()
            .map(|x| x.eq_ignore_ascii_case("ino"))
            .unwrap_or(false);
        if !is_ino {
            continue;
        }
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if stem == dir_name {
            return Some(stem);
        }
        if fallback.is_none() {
            fallback = Some(stem);
        }
    }
    fallback
}

/// 在 output_dir 里定位合并镜像。
///
/// arduino-cli 的命名是 `<sketch>.ino.merged.bin`，但写法在不同版本/参数下略有差异，
/// 因此按「精确名 → 目录名 + .merged.bin → 最新的 *.merged.bin」依次尝试。
pub fn find_merged_bin(output_dir: &Path, sketch_dir: &Path) -> Option<PathBuf> {
    let name = sketch_name(sketch_dir);
    let dir_name = sketch_dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(n) = &name {
        candidates.push(output_dir.join(format!("{n}.ino.merged.bin")));
        candidates.push(output_dir.join(format!("{n}.merged.bin")));
    }
    if !dir_name.is_empty() {
        candidates.push(output_dir.join(format!("{dir_name}.ino.merged.bin")));
        candidates.push(output_dir.join(format!("{dir_name}.merged.bin")));
    }
    if let Some(hit) = candidates.into_iter().find(|c| c.is_file()) {
        return Some(hit);
    }

    // 兜底：取输出目录里最新的 *.merged.bin
    let entries = std::fs::read_dir(output_dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for e in entries.flatten() {
        let p = e.path();
        let is_merged = p
            .file_name()
            .map(|f| f.to_string_lossy().ends_with(".merged.bin"))
            .unwrap_or(false);
        if !p.is_file() || !is_merged {
            continue;
        }
        let modified = p
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            best = Some((modified, p));
        }
    }
    best.map(|(_, p)| p)
}

/// 列出输出目录里的产物，用于编译失败时给出可读提示
fn list_outputs(output_dir: &Path) -> String {
    let Ok(entries) = std::fs::read_dir(output_dir) else {
        return "（无法读取输出目录）".into();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    if names.is_empty() {
        "（输出目录为空）".into()
    } else {
        names.join("、")
    }
}

/// 把源码写入草图目录的主 `.ino`（编译前同步编辑器内容）。
///
/// 编辑器里的代码只存在内存/工程文件里，而 arduino-cli 编译的是磁盘上的草图目录，
/// 两边不同步就会出现「改了代码但编译出来还是旧固件」。这里在编译前落盘，
/// 并在内容确实不同时留一份 `<sketch>.ino.bak`（只备份一次，不覆盖已有备份）。
pub fn sync_sketch_source(sketch_dir: &Path, code: &str) -> Result<(PathBuf, Option<PathBuf>), String> {
    let name = sketch_name(sketch_dir)
        .ok_or_else(|| format!("草图目录里没有 .ino 文件：{}", sketch_dir.display()))?;
    let ino = sketch_dir.join(format!("{name}.ino"));
    let existing = std::fs::read_to_string(&ino).ok();
    if existing.as_deref() == Some(code) {
        return Ok((ino, None));
    }
    let mut backup = None;
    if let Some(old) = existing {
        let bak = sketch_dir.join(format!("{name}.ino.bak"));
        if !bak.exists() {
            std::fs::write(&bak, old).map_err(|e| format!("备份 {name}.ino 失败: {e}"))?;
            backup = Some(bak);
        }
    }
    std::fs::write(&ino, code).map_err(|e| format!("写入 {} 失败: {e}", ino.display()))?;
    Ok((ino, backup))
}

/// 编译 sketch 目录，输出到 output_dir，返回 merged.bin 路径。
/// `code` 非空时会先把它写入草图目录的主 `.ino`（即"编译前保存编辑器内容"）。
/// fqbn 默认使用与验证过的 GPIO demo 一致的配置。
/// 注意：必须显式指定 FlashMode=dio/FlashFreq=40，PICSimLab 的 QEMU
/// 无法运行 80MHz 或 QIO 模式固件（flash 初始化会失败）。
pub fn compile(
    sketch_dir: &Path,
    fqbn: &str,
    output_dir: &Path,
    code: Option<&str>,
) -> Result<CompileResult, String> {
    // 先检查草图本身，这样即使机器上没装 arduino-cli 也能给出更贴切的提示
    if !sketch_dir.is_dir() {
        return Err(format!("草图目录不存在：{}", sketch_dir.display()));
    }
    let Some(ino_name) = sketch_name(sketch_dir) else {
        return Err(format!("草图目录里没有 .ino 文件：{}", sketch_dir.display()));
    };
    let dir_name = sketch_dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if ino_name != dir_name {
        // arduino-cli 要求目录名与 .ino 同名，这里先给一句更直白的提示
        return Err(format!(
            "arduino-cli 要求目录名与 .ino 同名：目录 {} 里是 {ino_name}.ino，请把目录改名或另存一份",
            sketch_dir.display()
        ));
    }

    let cli = find_arduino_cli().ok_or("未找到 arduino-cli，请设置环境变量 ARDUINO_CLI")?;

    // 编译前把编辑器内容落到草图目录，避免"改了代码但编出来还是旧固件"
    let mut synced = false;
    let mut backup: Option<String> = None;
    let mut sync_note = String::new();
    if let Some(source) = code {
        if !source.trim().is_empty() {
            let (ino, bak) = sync_sketch_source(sketch_dir, source)?;
            synced = true;
            sync_note = format!("\n已把编辑器内容写入 {}", ino.display());
            if let Some(b) = bak {
                backup = Some(b.to_string_lossy().to_string());
                sync_note.push_str(&format!("（原文件已备份为 {}）", b.display()));
            }
        }
    }

    std::fs::create_dir_all(output_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

    let output = std::process::Command::new(&cli)
        .arg("compile")
        .arg("--fqbn")
        .arg(fqbn)
        .arg("--output-dir")
        .arg(output_dir)
        .arg(sketch_dir)
        .output()
        .map_err(|e| format!("调用 arduino-cli 失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "编译失败（arduino-cli exit {:?}）:\n{stdout}\n{stderr}",
            output.status.code()
        ));
    }

    // 退出码为 0 说明编译本身成功；下一步只关心有没有产出可仿真的合并镜像
    match find_merged_bin(output_dir, sketch_dir) {
        Some(merged_bin) => Ok(CompileResult {
            ok: true,
            merged_bin: Some(merged_bin.to_string_lossy().to_string()),
            message: format!("编译成功：{stdout}\n{stderr}{sync_note}"),
            synced,
            backup,
        }),
        None => Err(format!(
            "编译已完成，但输出目录里没有合并镜像（*.merged.bin）。\n输出目录：{}\n已有产物：{}\n\
             请在编译参数里保留 FlashMode=dio,FlashFreq=40,FlashSize=4M（当前 fqbn：{fqbn}），\
             或手动把 bootloader/partitions/app 合并为 4MB 镜像后放到该目录。{sync_note}",
            output_dir.display(),
            list_outputs(output_dir),
        )),
    }
}

#[tauri::command]
pub fn cmd_compile(
    sketch_dir: String,
    output_dir: String,
    fqbn: Option<String>,
    code: Option<String>,
) -> Result<CompileResult, String> {
    let fqbn = fqbn.unwrap_or_else(|| {
        // 与验证过的 GPIO demo 一致：DIO/40MHz/4MB。默认(80MHz)在 QEMU 下无法启动。
        "esp32:esp32:esp32:FlashMode=dio,FlashFreq=40,FlashSize=4M,PartitionScheme=default,PSRAM=disabled"
            .to_string()
    });
    compile(
        Path::new(&sketch_dir),
        &fqbn,
        Path::new(&output_dir),
        code.as_deref(),
    )
}
