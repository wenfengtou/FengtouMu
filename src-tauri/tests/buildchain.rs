//! 编译链的产物定位与前置校验（不需要 arduino-cli 也能跑，供 CI 使用）。
//!
//! 这条用例是为了防止回归：arduino-cli 产出的合并镜像是 `<sketch>.ino.merged.bin`，
//! 早期实现按 `<目录名>.merged.bin` 去找，导致「编译明明成功（exit 0）却报编译失败」。
//! 真实调用 arduino-cli 的用例标记 `#[ignore]`，本地用 --include-ignored 执行。

use esp32_ide_lib::sim::buildchain::{compile, find_merged_bin, sketch_name};
use std::path::{Path, PathBuf};

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fengtoumu-buildchain-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

/// 造一个 `blink/blink.ino` 结构的草图目录
fn fake_sketch(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.ino")), b"void setup(){}\nvoid loop(){}\n").unwrap();
    dir
}

#[test]
fn sketch_name_prefers_same_named_ino() {
    let root = tmp_dir("name");
    let sketch = fake_sketch(&root, "blink");
    // 额外塞一个不同名的 .ino，仍应优先选中与目录同名的那个
    std::fs::write(sketch.join("helper.ino"), b"// helper\n").unwrap();
    assert_eq!(sketch_name(&sketch).as_deref(), Some("blink"));

    let unnamed = root.join("weird");
    std::fs::create_dir_all(&unnamed).unwrap();
    std::fs::write(unnamed.join("main.ino"), b"// main\n").unwrap();
    assert_eq!(sketch_name(&unnamed).as_deref(), Some("main"));

    let empty = root.join("nothing");
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(sketch_name(&empty), None);
}

#[test]
fn finds_arduino_cli_merged_bin_naming() {
    let root = tmp_dir("merged");
    let sketch = fake_sketch(&root, "blink");
    let out = root.join("out");
    std::fs::create_dir_all(&out).unwrap();

    // arduino-cli 的真实命名
    let expected = out.join("blink.ino.merged.bin");
    std::fs::write(&expected, b"img").unwrap();
    // 干扰项：只有 .bin / .elf
    std::fs::write(out.join("blink.ino.bin"), b"app").unwrap();
    std::fs::write(out.join("blink.ino.elf"), b"elf").unwrap();

    let found = find_merged_bin(&out, &sketch).expect("应找到合并镜像");
    assert_eq!(found, expected, "应命中 <sketch>.ino.merged.bin");
    println!("[1/3] 命中 arduino-cli 命名：{}", found.display());
}

#[test]
fn merged_bin_fallbacks() {
    let root = tmp_dir("merged-fallback");
    let sketch = fake_sketch(&root, "blink");
    let out = root.join("out");
    std::fs::create_dir_all(&out).unwrap();

    // 只有 <目录名>.merged.bin 这种写法时也能找到
    let alt = out.join("blink.merged.bin");
    std::fs::write(&alt, b"img").unwrap();
    assert_eq!(find_merged_bin(&out, &sketch), Some(alt.clone()));

    // 完全对不上名字时，退化为「最新的 *.merged.bin」
    std::fs::remove_file(&alt).unwrap();
    let other = out.join("something-else.merged.bin");
    std::fs::write(&other, b"img").unwrap();
    assert_eq!(find_merged_bin(&out, &sketch), Some(other));

    // 输出目录里没有任何合并镜像
    let empty = root.join("empty-out");
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(find_merged_bin(&empty, &sketch), None);
    std::fs::remove_dir_all(&root).ok();
    println!("[2/3] 兜底命名与空目录判定通过");
}

#[test]
fn compile_validates_sketch_dir_before_calling_cli() {
    let root = tmp_dir("validate");
    let out = root.join("out");

    // 目录不存在
    let err = compile(&root.join("missing"), "esp32:esp32:esp32", &out).unwrap_err();
    assert!(err.contains("草图目录不存在"), "实际提示：{err}");

    // 目录里没有 .ino
    let no_ino = root.join("no-ino");
    std::fs::create_dir_all(&no_ino).unwrap();
    let err = compile(&no_ino, "esp32:esp32:esp32", &out).unwrap_err();
    assert!(err.contains("没有 .ino"), "实际提示：{err}");

    // 目录名与 .ino 不同名
    let mismatch = root.join("folder-name");
    std::fs::create_dir_all(&mismatch).unwrap();
    std::fs::write(mismatch.join("other.ino"), b"// x\n").unwrap();
    let err = compile(&mismatch, "esp32:esp32:esp32", &out).unwrap_err();
    assert!(err.contains("目录名与 .ino 同名"), "实际提示：{err}");

    std::fs::remove_dir_all(&root).ok();
    println!("[3/3] 前置校验提示通过");
}

/// 真实调用 arduino-cli 编译 demo 草图（需要本机 arduino-cli + ESP32 核心）。
#[test]
#[ignore = "需要本机 arduino-cli 与 ESP32 核心（CI 不运行）；本地用 cargo test --test buildchain -- --include-ignored --nocapture"]
fn compiles_demo_sketch_locally() {
    let sketch = PathBuf::from(r"D:\work\Esp32Qume\picsimlab_gpio_demo");
    if !sketch.is_dir() {
        println!("跳过：找不到 {sketch:?}");
        return;
    }
    let out = std::env::temp_dir().join("fengtoumu-buildchain-real");
    let _ = std::fs::remove_dir_all(&out);
    let r = compile(
        &sketch,
        "esp32:esp32:esp32:FlashMode=dio,FlashFreq=40,FlashSize=4M,PartitionScheme=default,PSRAM=disabled",
        &out,
    )
    .expect("编译应成功");
    let merged = r.merged_bin.expect("应给出合并镜像路径");
    let p = Path::new(&merged);
    assert!(p.is_file(), "合并镜像应存在：{merged}");
    let size = std::fs::metadata(p).unwrap().len();
    assert_eq!(size, 4 * 1024 * 1024, "合并镜像应为 4MB");
    println!("真实编译通过：{merged}（{size} 字节）");
}
