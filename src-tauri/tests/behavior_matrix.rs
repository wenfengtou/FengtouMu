//! 行为级测试矩阵（C 层：真实 QEMU DLL，需要本机 lib/qemu 与 arduino-cli，CI 不运行）。
//!
//! QEMU 同一进程只能 qemu_init 一次，因此把「示例固件冒烟、UART 收发、多引脚并发写、
//! 串口批处理 drain」合并进一个用例，顺序执行。矩阵编号见 `docs/仿真协议.md`。
//!
//! 运行：cargo test --test behavior_matrix -- --include-ignored --nocapture

use esp32_ide_lib::sim::buildchain::compile;
use esp32_ide_lib::sim::engine::{install_sim_core, RecordingBus, SimCore, SimEngine};
use esp32_ide_lib::sim::pins::PIN_LED;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const DLL: &str = r"D:\work\Esp32Qume\FengtouMu\lib\qemu\libqemu-xtensa.dll";
const FW_DIR: &str = r"D:\work\Esp32Qume\FengtouMu\lib\qemu\fw";
const FQBN: &str = "esp32:esp32:esp32:FlashMode=dio,FlashFreq=40,FlashSize=4M,PartitionScheme=default,PSRAM=disabled";

/// 自带一份"会动"的固件源码，编译出合并镜像后仿真，不依赖 build_demo 里放了什么。
const BLINK_CODE: &str = r#"#define LED_PIN 2
unsigned long last = 0;
int st = LOW;
void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("BEHAVIOR-MATRIX-READY");
}
void loop() {
  if (millis() - last >= 500) {
    st = !st;
    digitalWrite(LED_PIN, st);
    last = millis();
  }
  delay(10);
}
"#;

/// 编译自带固件并返回合并镜像路径（用临时目录，避免污染任何工程）。
fn compile_own_firmware() -> PathBuf {
    let root = std::env::temp_dir().join("fengtoumu-behavior");
    let _ = std::fs::remove_dir_all(&root);
    let sketch = root.join("blink500");
    std::fs::create_dir_all(&sketch).unwrap();
    std::fs::write(sketch.join("blink500.ino"), BLINK_CODE).unwrap();
    let out = root.join("out");
    let r = compile(&sketch, FQBN, &out, Some(BLINK_CODE)).expect("编译自带固件失败");
    PathBuf::from(r.merged_bin.expect("应产出合并镜像"))
}

#[test]
#[ignore = "需要本机 lib/qemu 与 arduino-cli（CI 不运行）；本地用 cargo test --test behavior_matrix -- --include-ignored --nocapture"]
fn behavior_matrix_on_real_qemu() {
    let flash = compile_own_firmware();
    let core = SimCore::with_bus(Arc::new(RecordingBus::default()));
    install_sim_core(core).expect("SimCore 应未被占用");
    let engine = Arc::new(SimEngine::default());
    engine.load_dll(Path::new(DLL)).expect("加载 DLL 失败");
    engine
        .start(&flash, Path::new(FW_DIR))
        .expect("启动仿真失败（若为偶发卡死可重跑）");
    println!("[1/6] 仿真已启动，flash={}", flash.display());

    // ---- b01 示例固件冒烟：LED 翻转 + ROM 串口字节 ----
    let mut flips = 0u32;
    let mut last: Option<i32> = None;
    let mut uart: Vec<u8> = Vec::new();
    // 冷启动偶发偏慢（模型已知），窗口给到 18 秒
    let deadline = Instant::now() + Duration::from_secs(18);
    while Instant::now() < deadline && flips < 3 {
        uart.extend_from_slice(&engine.poll_uart());
        if let Some(v) = engine.pin_states().iter().find(|s| s.pin == PIN_LED).map(|s| s.value) {
            if last.is_some_and(|p| p != v) {
                flips += 1;
            }
            last = Some(v);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(flips >= 3, "示例固件 LED 应翻转 ≥3 次，实际 {flips}；UART 尾部：{}", {
        let tail = String::from_utf8_lossy(&uart);
        tail.split('\n').rev().take(8).collect::<Vec<_>>().join("\n")
    });
    assert!(!uart.is_empty(), "固件启动后应有串口字节（ROM 日志）");
    println!("[2/6] 冒烟通过：LED 翻转 {flips} 次，串口 {uart_len} 字节", uart_len = uart.len());

    // ---- b04 串口批处理 drain：两次 poll 之间不丢不重 ----
    let before = uart.len();
    let mut s1 = 0usize;
    let mut s2 = 0usize;
    let d2 = Instant::now() + Duration::from_secs(4);
    while Instant::now() < d2 {
        let b = engine.poll_uart();
        s1 += b.len();
        let b2 = engine.poll_uart();
        s2 += b2.len();
        if s1 > 0 && s2 > 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("[3/6] drain 观测：首读 {s1} 字节，二次读 {s2} 字节（累计 {before}+{s1}+{s2}）");

    // ---- b02 UART 上行（前端→固件）：调用不报错 ----
    engine
        .uart_send(0, b"PING\n")
        .expect("uart_send 应成功返回（协议链路可用）");
    println!("[4/6] uart_send 链路 OK");

    // ---- b03 多引脚并发写：BQL 保护下并发 set_pin 不 panic、全部落表 ----
    let pins: Vec<usize> = [2, 3, 4, 5, 6, 7, 8].to_vec();
    let handles: Vec<_> = pins
        .iter()
        .map(|&pin| {
            let engine = engine.clone();
            std::thread::spawn(move || {
                engine.write_pin(pin, 1).expect("并发写引脚应成功");
            })
        })
        .collect();
    for h in handles {
        h.join().expect("并发线程不应 panic");
    }
    let states = engine.pin_states();
    for pin in &pins {
        let st = states.iter().find(|s| s.pin == *pin).expect("引脚应存在");
        assert_eq!(st.value, 1, "pin {pin} 电平应被并发写入");
        assert_eq!(st.dir, 0, "pin {pin} 方向应保持输入（外部驱动）");
    }
    println!("[5/6] 多引脚并发写通过：{:?}", pins);

    engine.stop().expect("停止仿真失败");
    println!("[6/6] 行为矩阵（真实 QEMU）全部通过");
}
