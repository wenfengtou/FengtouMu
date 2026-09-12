//! 环境自检的判定逻辑验证（纯函数版本，不需要 QEMU DLL，可在 CI 中运行）。
//!
//! 这里只测「给一个确定的路径，判定结果与给出的下一步指引是否正确」；
//! 真实机器上的查找顺序（环境变量 / 程序目录 / 项目目录）由 discover_* 负责，
//! 其结果随环境变化，不适合做断言。

use esp32_ide_lib::envcheck::{check_dll_at, check_flash_at, check_fw_at};
use std::path::Path;

const HINT_DOC: &str = "build-qemu-dll-windows";

#[test]
fn missing_dll_reports_docs_hint() {
    let items = check_dll_at(Path::new(r"D:\no-such-dir\libqemu-xtensa.dll"));
    assert_eq!(items.len(), 1, "文件不存在时只报一项，不再检查依赖");
    assert_eq!(items[0].id, "dll");
    assert_eq!(items[0].status, "missing");
    assert!(
        items[0].hint.contains(HINT_DOC),
        "缺失时应指向编译文档：{}",
        items[0].hint
    );
    println!("[1/4] 缺 DLL 的提示：{}", items[0].hint);
}

#[test]
fn present_dll_reports_dependencies() {
    let dir = std::env::temp_dir().join("fengtoumu-envcheck-dll");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    let dll = dir.join("libqemu-xtensa.dll");
    // 写一个真实大小够大的文件，避免触发"文件偏小"告警
    std::fs::write(&dll, vec![0u8; 11 * 1024 * 1024]).expect("写入占位 DLL");

    let items = check_dll_at(&dll);
    assert_eq!(items.len(), 2, "应同时给出依赖检查项");
    assert_eq!(items[0].status, "ok", "体积正常应判定 ok");
    assert_eq!(items[1].id, "dll-deps");
    assert_eq!(items[1].status, "missing", "依赖 DLL 缺失应判 missing");
    assert!(items[1].detail.contains("libglib"), "应列出缺哪个：{}", items[1].detail);

    // 补齐依赖后应转为 ok
    for dep in ["libglib-2.0-0.dll", "libgcc_s_seh-1.dll", "libpixman-1-0.dll"] {
        std::fs::write(dir.join(dep), b"x").expect("写入占位依赖");
    }
    let items = check_dll_at(&dll);
    assert_eq!(items[1].status, "ok");
    std::fs::remove_dir_all(&dir).ok();
    println!("[2/4] 依赖齐全判定：{}", items[1].detail);
}

#[test]
fn fw_dir_requires_rom_files() {
    let dir = std::env::temp_dir().join("fengtoumu-envcheck-fw");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("创建临时目录");

    let empty = check_fw_at(&dir);
    assert_eq!(empty.status, "missing");
    assert!(empty.detail.contains("esp32-v3-rom.bin"), "应指出缺哪个 ROM：{}", empty.detail);

    std::fs::write(dir.join("esp32-v3-rom.bin"), b"rom").unwrap();
    std::fs::write(dir.join("esp32-v3-rom-app.bin"), b"rom").unwrap();
    let no_keymaps = check_fw_at(&dir);
    assert_eq!(no_keymaps.status, "warn", "只有 ROM 时给出注意而非缺失");
    assert!(no_keymaps.detail.contains("keymaps"), "应提示缺 keymaps：{}", no_keymaps.detail);

    std::fs::create_dir_all(dir.join("keymaps")).unwrap();
    let ok = check_fw_at(&dir);
    assert_eq!(ok.status, "ok");
    std::fs::remove_dir_all(&dir).ok();
    println!("[3/4] fw 目录判定：{}", ok.detail);
}

#[test]
fn flash_image_states() {
    let none = check_flash_at("");
    assert_eq!(none.status, "warn");
    assert!(none.detail.contains("尚未选择"));

    let bogus = check_flash_at(r"D:\no-such-dir\demo.ino.merged.bin");
    assert_eq!(bogus.status, "warn");
    assert!(bogus.detail.contains("不存在"));
    assert!(bogus.hint.contains("编译"), "应提示可先编译：{}", bogus.hint);

    let dir = std::env::temp_dir().join("fengtoumu-envcheck-flash");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("demo.ino.merged.bin");
    std::fs::write(&bin, b"x").unwrap();
    let ok = check_flash_at(&bin.to_string_lossy());
    assert_eq!(ok.status, "ok");
    std::fs::remove_dir_all(&dir).ok();
    println!("[4/4] 固件镜像判定：{}", ok.detail);
}
