//! 按键注入链路验证（真实演示固件）。
//!
//! 背景：早期文档记录过"注入的低电平无法在模型内稳定保持"的已知限制。
//! 经排查，该结论是误诊 —— 三重原因叠加：
//!   1) `build_demo` 里的固件镜像被空草图覆盖（LED 从不翻转、也没有按键代码），
//!      观测数据本身不成立；
//!   2) 旧测试在注入后立刻采样，把固件"当前闪烁周期残余的低电平相位"（最长约 1 秒）
//!      误判为"电平丢失"；
//!   3) 引擎 `poll_uart` 与总线 flush 共享游标，会吞掉串口每个突发的首字节，
//!      终端文本残缺（"BOOT pressed" → "OOT pressed"），进一步误导判断。
//! 本用例自带演示固件源码编译：注入一次低电平，等待固件进入按下分支后采样，
//! 断言 LED 全程常亮（即电平稳定保持）。
//!
//! 运行：cargo test --test button_injection -- --ignored --nocapture

use esp32_ide_lib::sim::buildchain::compile;
use esp32_ide_lib::sim::engine::{install_sim_core, RecordingBus, SimCore, SimEngine};
use esp32_ide_lib::sim::pins::PIN_BOOT;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const DLL: &str = r"D:\work\Esp32Qume\FengtouMu\lib\qemu\libqemu-xtensa.dll";
const FW_DIR: &str = r"D:\work\Esp32Qume\FengtouMu\lib\qemu\fw";
const FQBN: &str = "esp32:esp32:esp32:FlashMode=dio,FlashFreq=40,FlashSize=4M,PartitionScheme=default,PSRAM=disabled";

/// 演示固件：LED 闪烁 + BOOT 按键控制（与 build_demo 的原始 demo 一致）。
const DEMO_CODE: &str = r#"#define LED_PIN  2
#define BOOT_PIN 0
void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(BOOT_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  Serial.println("GPIO Demo: LED blink + BOOT button");
}
void loop() {
  if (digitalRead(BOOT_PIN) == LOW) {
    digitalWrite(LED_PIN, HIGH);
    Serial.println("BOOT pressed -> LED ON");
    delay(100);
  } else {
    digitalWrite(LED_PIN, HIGH);
    delay(500);
    digitalWrite(LED_PIN, LOW);
    delay(500);
  }
}
"#;

fn compile_demo_firmware() -> PathBuf {
    let root = std::env::temp_dir().join("fengtoumu-demo");
    let _ = std::fs::remove_dir_all(&root);
    let sketch = root.join("gpio_demo");
    std::fs::create_dir_all(&sketch).unwrap();
    std::fs::write(sketch.join("gpio_demo.ino"), DEMO_CODE).unwrap();
    let out = root.join("out");
    let r = compile(&sketch, FQBN, &out, Some(DEMO_CODE)).expect("编译演示固件失败");
    PathBuf::from(r.merged_bin.expect("应产出合并镜像"))
}

fn led_value(engine: &SimEngine) -> Option<i32> {
    engine
        .pin_states()
        .iter()
        .find(|s| s.pin == 24)
        .map(|s| s.value)
}

#[test]
#[ignore = "需要本机 lib/qemu 与 arduino-cli（CI 不运行）；本地用 cargo test --test button_injection -- --ignored --nocapture"]
fn boot_button_injection_holds_low() {
    let flash = compile_demo_firmware();
    let core = SimCore::with_bus(Arc::new(RecordingBus::default()));
    install_sim_core(core).expect("SimCore 应未被其他测试占用");
    let engine = SimEngine::default();

    engine.load_dll(Path::new(DLL)).expect("加载 DLL 失败");
    engine
        .start(&flash, Path::new(FW_DIR))
        .expect("启动仿真失败（若为偶发卡死可重跑）");
    println!("[1/4] 仿真已启动");

    // 等待固件跑起来：LED 至少翻转 3 次（未按下时 500ms 闪烁）
    let mut flips = 0u32;
    let mut last = led_value(&engine);
    let deadline = Instant::now() + Duration::from_secs(40);
    while Instant::now() < deadline && flips < 3 {
        std::thread::sleep(Duration::from_millis(50));
        let cur = led_value(&engine);
        if last.is_some() && cur != last {
            flips += 1;
        }
        last = cur;
    }
    assert!(flips >= 3, "演示固件未运行起来（LED 翻转 {flips} 次）");
    println!("[2/4] 固件运行确认（LED 翻转 {flips} 次）");

    // 注入 BOOT 按下（板级引脚 25 = GPIO0 拉低），只注入一次
    let st = engine.write_pin(PIN_BOOT, 0).expect("注入引脚失败");
    assert_eq!(st.pin, PIN_BOOT);
    assert_eq!(st.gpio, 0);
    assert_eq!(st.value, 0, "引擎应记录外部驱动电平");
    println!("[3/4] 注入成功：pin={} gpio={} value={}", st.pin, st.gpio, st.value);

    // 等待固件响应：注入时固件可能正处在闪烁周期的低电平相位（最长约 1 秒），
    // 它要等当前周期结束、下一轮 digitalRead 才会进入"按下 → LED 常亮"分支。
    // 直接采样会把这段残余相位误判成"电平丢失"，所以先等 1.5 秒再观测。
    std::thread::sleep(Duration::from_millis(1500));

    // 观测 3 秒：按键按下 → 固件应让 LED 常亮（不再闪烁），即 LED 全程为高。
    // 若电平丢失，固件会退回闪烁分支，LED 出现低采样。
    let mut low_samples = 0u32;
    let mut samples = 0u32;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(3000) {
        std::thread::sleep(Duration::from_millis(50));
        samples += 1;
        if led_value(&engine) == Some(0) {
            low_samples += 1;
        }
    }
    let released = engine.write_pin(PIN_BOOT, 1).expect("恢复引脚失败");
    assert_eq!(released.value, 1);

    engine.stop().expect("停止仿真失败");
    println!("[4/4] 采样 {samples} 次，LED 为低 {low_samples} 次（按键保持期间 LED 应常亮）");

    assert!(
        low_samples == 0,
        "注入一次低电平后 LED 出现低采样 {low_samples} 次 → 电平未能保持"
    );
    println!("结果：注入一次后 GPIO0 低电平稳定保持，固件持续进入按键按下分支（LED 常亮）");
}
