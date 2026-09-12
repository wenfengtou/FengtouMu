//! 工程文件与 Wokwi zip 互导的往返验证（不需要 QEMU DLL，可在 CI 中运行）。
//!
//! 运行：cargo test --test project_io -- --nocapture

use esp32_ide_lib::project::{
    cmd_export_wokwi_zip, cmd_import_wokwi_zip, cmd_project_load, cmd_project_save, Project,
    PROJECT_VERSION,
};
use std::path::PathBuf;

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fengtoumu-test-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

fn sample_project() -> Project {
    Project {
        version: PROJECT_VERSION,
        name: "闪烁灯".into(),
        updated_at: "2026-09-12T00:00:00.000Z".into(),
        code: "void setup(){}\nvoid loop(){}\n".into(),
        diagram: r#"{"parts":[{"type":"board-esp32-devkitc","id":"esp","top":0,"left":0}],"connections":[]}"#.into(),
        sketch_dir: r"D:\work\sk".into(),
        fw_dir: r"D:\work\fw".into(),
        flash_path: r"D:\work\sk\demo.ino.merged.bin".into(),
        fqbn: "esp32:esp32:esp32:FlashMode=dio,FlashFreq=40,FlashSize=4M".into(),
    }
}

#[test]
fn project_file_round_trip() {
    let dir = tmp_dir("project");
    let path = dir.join("灯.fmp");
    let path_s = path.to_string_lossy().to_string();

    let original = sample_project();
    cmd_project_save(path_s.clone(), original.clone()).expect("保存工程");
    assert!(path.is_file(), "工程文件应已落盘");

    let loaded = cmd_project_load(path_s).expect("读取工程");
    assert_eq!(loaded.version, original.version);
    assert_eq!(loaded.name, original.name);
    assert_eq!(loaded.code, original.code);
    assert_eq!(loaded.diagram, original.diagram);
    assert_eq!(loaded.sketch_dir, original.sketch_dir);
    assert_eq!(loaded.flash_path, original.flash_path);
    assert_eq!(loaded.fqbn, original.fqbn);
    println!("[1/3] 工程文件往返一致：{}", path.display());
}

#[test]
fn wokwi_zip_round_trip() {
    let dir = tmp_dir("zip");
    let zip_path = dir.join("out.zip");
    let diagram = r#"{"parts":[{"type":"wokwi-led","id":"led1","top":0,"left":0,"attrs":{}}],"connections":[]}"#;
    let sketch = "void setup(){}\nvoid loop(){}\n";

    cmd_export_wokwi_zip(
        zip_path.to_string_lossy().to_string(),
        diagram.to_string(),
        sketch.to_string(),
        Some("闪烁灯".into()),
    )
    .expect("导出 zip");
    assert!(zip_path.is_file(), "zip 应已生成");

    let dest = dir.join("unpacked");
    let imported = cmd_import_wokwi_zip(
        zip_path.to_string_lossy().to_string(),
        dest.to_string_lossy().to_string(),
    )
    .expect("导入 zip");

    assert_eq!(imported.diagram.as_deref(), Some(diagram), "diagram.json 内容应一致");
    assert_eq!(imported.sketch.as_deref(), Some(sketch), "sketch.ino 内容应一致");
    // Wokwi zip 的 .ino 通常在根目录，导入时会被复制进与 .ino 同名的目录并给出提示
    assert!(
        imported.notes.iter().any(|n| n.contains("同名")),
        "应说明已按 arduino-cli 的命名要求整理目录：{:?}",
        imported.notes
    );

    // arduino-cli 要求目录名与 .ino 同名，导出名称为「闪烁灯」→ 解压后应有 闪烁灯/闪烁灯.ino
    let sketch_dir = imported.sketch_dir.expect("应给出可编译的 sketch 目录");
    let dir_name = PathBuf::from(&sketch_dir)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    assert_eq!(dir_name, "闪烁灯", "sketch 目录名应与 .ino 同名");
    assert!(
        PathBuf::from(&sketch_dir).join("闪烁灯.ino").is_file(),
        "sketch 目录内应有同名 .ino"
    );
    println!("[2/3] Wokwi zip 往返一致，sketch 目录：{sketch_dir}");
}

#[test]
fn wokwi_zip_missing_pieces_are_reported() {
    let dir = tmp_dir("zip-partial");
    let zip_path = dir.join("partial.zip");

    // 手工构造一个只有 diagram.json 的 zip，模拟「从 Wokwi 只导出电路图」的情形
    {
        use std::io::Write;
        let f = std::fs::File::create(&zip_path).expect("创建 zip");
        let mut zw = zip::ZipWriter::new(f);
        zw.start_file("diagram.json", zip::write::SimpleFileOptions::default())
            .expect("写入条目");
        zw.write_all(br#"{"parts":[],"connections":[]}"#).expect("写入内容");
        zw.finish().expect("完成 zip");
    }

    let dest = dir.join("unpacked");
    let imported = cmd_import_wokwi_zip(
        zip_path.to_string_lossy().to_string(),
        dest.to_string_lossy().to_string(),
    )
    .expect("导入 zip");
    // 只有 diagram.json，没有 .ino —— 应给出提示而不是报错
    assert!(imported.diagram.is_some());
    assert!(imported.sketch.is_none());
    assert!(imported.sketch_dir.is_none());
    assert!(
        imported.notes.iter().any(|n| n.contains(".ino")),
        "应提示缺少 .ino：{:?}",
        imported.notes
    );
    println!("[3/3] 缺件 zip 的提示：{:?}", imported.notes);
}
