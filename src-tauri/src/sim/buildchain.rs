//! 编译链封装：调用 arduino-cli 编译 Arduino 工程并产出 QEMU 可用的 4MB 合并镜像。

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct CompileResult {
    pub ok: bool,
    pub merged_bin: Option<String>,
    pub message: String,
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

/// 编译 sketch 目录，输出到 output_dir，返回 merged.bin 路径。
/// fqbn 默认使用与验证过的 GPIO demo 一致的配置。
/// 注意：必须显式指定 FlashMode=dio/FlashFreq=40，PICSimLab 的 QEMU
/// 无法运行 80MHz 或 QIO 模式固件（flash 初始化会失败）。
pub fn compile(
    sketch_dir: &Path,
    fqbn: &str,
    output_dir: &Path,
) -> Result<CompileResult, String> {
    let cli = find_arduino_cli().ok_or("未找到 arduino-cli，请设置环境变量 ARDUINO_CLI")?;

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
    let merged = format!("{}.merged.bin", sketch_dir.file_stem().unwrap_or_default().to_string_lossy());
    let merged_bin = output_dir.join(merged);

    if output.status.success() && merged_bin.is_file() {
        Ok(CompileResult {
            ok: true,
            merged_bin: Some(merged_bin.to_string_lossy().to_string()),
            message: format!("编译成功：{stdout}\n{stderr}"),
        })
    } else {
        Err(format!(
            "编译失败（arduino-cli exit {:?}）:\n{stdout}\n{stderr}",
            output.status.code()
        ))
    }
}

#[tauri::command]
pub fn cmd_compile(
    sketch_dir: String,
    output_dir: String,
    fqbn: Option<String>,
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
    )
}
