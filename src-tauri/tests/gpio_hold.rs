//! 复现：注入一次低电平到 GPIO0（INPUT_PULLUP）后，电平是否能在模型内稳定保持。
//! 用 GPIO4 作"固件确实读到低电平"的接地真值：读到一次低就永久拉高 GPIO4，
//! 不依赖串口（避免 UART 取数路径的干扰）。
//! 需要本机 lib/qemu 与 arduino-cli；`cargo test --test gpio_hold -- --include-ignored --nocapture`

use esp32_ide_lib::sim::buildchain::compile;
use esp32_ide_lib::sim::engine::{install_sim_core, RecordingBus, SimCore, SimEngine};
use esp32_ide_lib::sim::pins::{PIN_BOOT, PIN_LED};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const DLL: &str = r"D:\work\Esp32Qume\FengtouMu\lib\qemu\libqemu-xtensa.dll";
const FW_DIR: &str = r"D:\work\Esp32Qume\FengtouMu\lib\qemu\fw";
const FQBN: &str = "esp32:esp32:esp32:FlashMode=dio,FlashFreq=40,FlashSize=4M,PartitionScheme=default,PSRAM=disabled";

/// GPIO4 的板级引脚号（DEVKITC_PINMAP 下标 26 = GPIO4）。
const PIN_GPIO4: usize = 26;

/// 固件：GPIO0 上拉输入轮询，并把读到的电平实时镜像到 GPIO4（每 20ms 一次）。
/// 若注入的低电平能在模型内稳定保持，注入后 GPIO4 应持续为高；
/// 若电平丢失，GPIO4 会立刻翻回低 —— 这是不依赖串口的接地真值。
/// GPIO2 闪烁用于确认固件在运行。
const HOLD_CODE: &str = r#"#define LED_PIN 2
#define SEEN_PIN 4
void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(SEEN_PIN, OUTPUT);
  pinMode(0, INPUT_PULLUP);
}
void loop() {
  digitalWrite(SEEN_PIN, digitalRead(0) == LOW ? HIGH : LOW);
  digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  delay(20);
}
"#;

fn compile_hold_firmware() -> PathBuf {
    let root = std::env::temp_dir().join("fengtoumu-gpiohold");
    let _ = std::fs::remove_dir_all(&root);
    let sketch = root.join("gpiohold");
    std::fs::create_dir_all(&sketch).unwrap();
    std::fs::write(sketch.join("gpiohold.ino"), HOLD_CODE).unwrap();
    let out = root.join("out");
    let r = compile(&sketch, FQBN, &out, Some(HOLD_CODE)).expect("编译固件失败");
    PathBuf::from(r.merged_bin.expect("应产出合并镜像"))
}

#[test]
#[ignore = "需要本机 lib/qemu 与 arduino-cli；本地用 cargo test --test gpio_hold -- --include-ignored --nocapture"]
fn injected_low_level_should_hold_on_gpio0() {
    let flash = compile_hold_firmware();
    let core = SimCore::with_bus(Arc::new(RecordingBus::default()));
    install_sim_core(core).expect("SimCore 应未被占用");
    let engine = Arc::new(SimEngine::default());
    engine.load_dll(Path::new(DLL)).expect("加载 DLL 失败");
    engine
        .start(&flash, Path::new(FW_DIR))
        .expect("启动仿真失败");

    // 等待固件运行：LED（pin 24）翻转 ≥3 次
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut ready = false;
    let mut last_led: Option<i32> = None;
    let mut led_flips = 0u32;
    while Instant::now() < deadline {
        if let Some(st) = engine.pin_states().iter().find(|s| s.pin == PIN_LED) {
            if last_led.is_some_and(|p| p != st.value) {
                led_flips += 1;
            }
            last_led = Some(st.value);
            if led_flips >= 3 {
                ready = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(ready, "固件未在窗口内运行起来（LED 翻转 {led_flips} 次）");
    println!("启动就绪（LED 翻转 {led_flips} 次）");

    // 注入前：GPIO4 应为低
    let before = engine
        .pin_states()
        .iter()
        .find(|s| s.pin == PIN_GPIO4)
        .map(|s| s.value);
    assert_eq!(before, Some(0), "注入前 GPIO4 应为低，实际 {before:?}");

    // 注入一次低电平到 GPIO0（板级 pin 25）
    engine.write_pin(PIN_BOOT, 0).expect("注入应成功");
    println!("已注入 GPIO0 = 0（板级 pin 25），等待固件响应后观测…");
    std::thread::sleep(Duration::from_millis(500));

    // 观测：GPIO4 实时镜像 GPIO0。若低电平保持，GPIO4 应持续为高。
    let t0 = Instant::now();
    let mut lows = 0usize;
    let mut highs = 0usize;
    let mut transitions: Vec<String> = Vec::new();
    let mut last: Option<i32> = None;
    let mut last_ms = 0u64;
    while Instant::now() - t0 < Duration::from_secs(8) {
        if let Some(st) = engine.pin_states().iter().find(|s| s.pin == PIN_GPIO4) {
            let ms = t0.elapsed().as_millis() as u64;
            if st.value == 1 {
                highs += 1;
            } else {
                lows += 1;
            }
            if let Some(l) = last {
                if l != st.value {
                    transitions.push(format!("{ms}ms: {l}→{}", st.value));
                }
            }
            last = Some(st.value);
            last_ms = ms;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    println!(
        "观测 8 秒：GPIO4 高={highs} 低={lows}；电平变化点={}",
        if transitions.is_empty() { "(无)".to_string() } else { transitions.join(" | ") }
    );

    engine.stop().expect("停止失败");

    // 判定：注入一次后 GPIO0 应持续读到低电平（GPIO4 持续为高）。
    // 若 GPIO4 出现低采样或高低抖动 → 电平未保持 → 复现。
    assert!(highs > 0, "固件从未读到低电平（GPIO4 从未为高）");
    assert!(
        lows == 0 && transitions.is_empty(),
        "GPIO0 低电平未稳定保持：GPIO4 出现低采样 {lows} 次，变化 {transitions:?}"
    );
    println!("结果：注入一次后 GPIO0 电平稳定保持（8 秒内 GPIO4 持续为高）");
}
