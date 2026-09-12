//! 集成验证：无 GUI 环境下驱动仿真引擎，验证 LED 闪烁（GPIO 回调链路）。
//! 运行：cargo test --test sim_integration -- --nocapture
//!
//! 自动化诊断输出：
//!   - [UART] 固件串口输出（证明固件在运行）
//!   - [PIN]  任意非初始状态的引脚活动（证明 GPIO 回调到达）

use esp32_ide_lib::sim::engine::{RecordingBus, SimCore, SimEngine, install_sim_core};
use esp32_ide_lib::sim::pins::PIN_LED;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const DLL: &str = r"D:\work\Esp32Qume\FengtouMu\lib\qemu\libqemu-xtensa.dll";
const FW_DIR: &str = r"D:\work\Esp32Qume\FengtouMu\lib\qemu\fw";
const DEFAULT_FLASH: &str = r"D:\work\Esp32Qume\FengtouMu\build_demo\picsimlab_gpio_demo.ino.merged.bin";

/// 固件路径可从环境变量 SIM_FLASH 覆盖，便于对多个镜像做对照实验。
fn flash_path() -> &'static str {
    Box::leak(
        std::env::var("SIM_FLASH")
            .unwrap_or_else(|_| DEFAULT_FLASH.to_string())
            .into_boxed_str(),
    )
}

#[test]
#[ignore = "需要本机 lib/qemu/libqemu-xtensa.dll 与固件镜像（CI 不运行）；本地用 cargo test --test sim_integration -- --ignored --nocapture"]
fn led_blinks_in_simulation() {
    let flash = flash_path();
    let core = SimCore::with_bus(Arc::new(RecordingBus::default()));
    install_sim_core(core).expect("SimCore 应未被其他测试占用");
    let engine = SimEngine::default();

    engine
        .load_dll(Path::new(DLL))
        .expect("加载 DLL 失败");
    assert!(engine.is_loaded(), "DLL 应处于已加载状态");
    println!("[1/4] DLL 加载成功: {DLL}");

    engine
        .start(Path::new(flash), Path::new(FW_DIR))
        .expect("启动仿真失败");
    println!("[2/4] 仿真已启动（qemu_init 返回）, flash={flash}");

    // 观察板级 pin 24（GPIO2 LED）电平翻转，固件周期 500ms。
    let mut last: Option<i32> = None;
    let mut flips = 0u32;
    let mut uart_buf: Vec<u8> = Vec::new();
    let mut activity: Vec<(u32, usize, i16, i32)> = Vec::new(); // (tick, pin, gpio, value)
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut tick = 0u32;
    while std::time::Instant::now() < deadline {
        tick += 1;
        let uart = engine.poll_uart();
        if !uart.is_empty() {
            uart_buf.extend_from_slice(&uart);
        }
        let states = engine.pin_states();
        let led = states.iter().find(|s| s.pin == PIN_LED).map(|s| s.value);
        if let Some(v) = led {
            if last.is_some_and(|p| p != v) {
                flips += 1;
                println!("  LED 翻转 -> {v}（第 {flips} 次）");
            }
            last = Some(v);
        }
        for s in states.iter().filter(|s| s.dir != 0 || s.value != 0) {
            activity.push((tick, s.pin, s.gpio, s.value));
        }
        if flips >= 3 {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }

    println!("[3/4] 观测结果:");
    println!("  LED(pin24) 翻转次数: {flips}");
    println!("  UART 收到 {} 字节: {}", uart_buf.len(), String::from_utf8_lossy(&uart_buf).trim());
    let mut seen = std::collections::BTreeSet::new();
    for (t, pin, gpio, v) in &activity {
        if seen.insert((*pin, *gpio)) {
            println!("  引脚活动: tick={t} pin={pin} gpio={gpio} value={v}");
        }
    }

    engine.stop().expect("停止仿真失败");
    println!("[4/4] 仿真已停止");
    assert!(flips >= 3, "期望 LED 至少翻转 3 次，实际 {flips} 次：GPIO 回调链路未生效");
    println!("集成验证通过：DLL 加载 -> 仿真启动 -> GPIO 回调 -> LED 闪烁 全链路正常");
}
