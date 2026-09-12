//! 协议级测试矩阵（A 层：JSON Lines 线协议 + 宿主状态机，**不需要 QEMU DLL**，CI 可跑）。
//!
//! 用 `fm-fake-worker`（`src/bin/fake_worker.rs`）替代真实仿真子进程，把主进程宿主
//! （SimHost）的完整协议链路 —— 启动健康判据、自动重试、命令往返、事件转发、停止 ——
//! 变成稳定用例。矩阵与用例编号见 `docs/仿真协议.md`。
//!
//! 运行：cargo test --test worker_protocol

use esp32_ide_lib::sim::engine::{EventBus, SimStatus};
use esp32_ide_lib::sim::worker_host::SimHost;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 这些用例要读写环境变量（ESP32_IDE_SIM_WORKER 等），串行执行避免互相污染。
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// 记录宿主发出的所有事件（用于断言转发链路）。
#[derive(Default)]
struct VecBus {
    events: Mutex<Vec<(String, Value)>>,
}

impl EventBus for VecBus {
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.to_string(), payload));
    }
}

fn fake_worker() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fm-fake-worker"))
}

static DIR_SEQ: AtomicUsize = AtomicUsize::new(0);

fn tmp_dir(tag: &str) -> PathBuf {
    let n = DIR_SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("fengtoumu-proto-{tag}-{}-{}", std::process::id(), n));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

/// 构造"固件启动后持续活动"的事件脚本：n 帧 gpio-update。
fn healthy_events(n: usize) -> String {
    let frames: Vec<Value> = (0..n)
        .map(|i| {
            serde_json::json!({
                "event": "gpio-update",
                "payload": { "pin": 24, "gpio": 2, "value": i % 2, "dir": 1 }
            })
        })
        .collect();
    serde_json::to_string(&Value::Array(frames)).unwrap()
}

/// 统一的环境设置：返回的 guard 在 drop 时清掉这些变量。
fn set_envs(entries: &[(&str, String)]) -> EnvGuard {
    for (k, v) in entries {
        std::env::set_var(k, v);
    }
    EnvGuard
}

struct EnvGuard;

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for k in [
            "ESP32_IDE_SIM_WORKER",
            "ESP32_IDE_QEMU_DLL",
            "FAKE_EVENTS",
            "FAKE_EVENT_GAP_MS",
            "FAKE_MARKER_FILE",
            "FAKE_SIM_ERROR",
            "FAKE_EXIT_AFTER_MS",
            "FAKE_EXIT_CODE",
            "FAKE_DIE_AT_SPAWN",
            "FAKE_IGNORE_CMDS",
            "SIM_HEALTH_SEC",
            "SIM_START_ATTEMPTS",
        ] {
            std::env::remove_var(k);
        }
    }
}

/// 起一个"健康"的宿主（假 worker 会持续发 GPIO 活动），返回 (host, bus, marker)。
fn start_healthy_host() -> (SimHost, Arc<VecBus>, PathBuf) {
    let dir = tmp_dir("healthy");
    let flash = dir.join("fw.bin");
    std::fs::write(&flash, b"flash").unwrap();
    let marker = dir.join("marker.txt");
    let _env = set_envs(&[
        ("ESP32_IDE_SIM_WORKER", fake_worker().to_string_lossy().to_string()),
        ("ESP32_IDE_QEMU_DLL", dir.join("libqemu-xtensa.dll").to_string_lossy().to_string()),
        ("FAKE_EVENTS", healthy_events(6)),
        ("FAKE_EVENT_GAP_MS", "700".into()),
        ("FAKE_MARKER_FILE", marker.to_string_lossy().to_string()),
        ("SIM_HEALTH_SEC", "8".into()),
        ("SIM_START_ATTEMPTS", "2".into()),
    ]);
    let bus = Arc::new(VecBus::default());
    let host = SimHost::with_bus(bus.clone());
    host.start(&flash.to_string_lossy(), &dir.to_string_lossy())
        .expect("宿主应判定启动成功");
    (host, bus, marker)
}

// ---------------- 启动与健康判据 ----------------

#[test]
fn h01_healthy_start_reports_running() {
    let _l = ENV_LOCK.lock().unwrap();
    let (host, bus, marker) = start_healthy_host();
    assert_eq!(host.status(), SimStatus::Running);
    assert!(host.is_running(), "子进程应在运行");
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap().lines().count(),
        1,
        "健康启动只应拉起一个子进程"
    );
    // 事件转发：gpio-update 至少 4 条（健康判据要求），且有启动日志
    let evs = bus.events.lock().unwrap();
    let gpio = evs.iter().filter(|(n, _)| n == "gpio-update").count();
    assert!(gpio >= 4, "应转发到至少 4 条 gpio-update，实际 {gpio}");
    assert!(evs.iter().any(|(n, _)| n == "sim-log"), "应有 sim-log（含 仿真已启动）");
    let logs: Vec<String> = evs
        .iter()
        .filter(|(n, _)| n == "sim-log")
        .map(|(_, p)| p.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string())
        .collect();
    assert!(logs.iter().any(|m| m.contains("仿真已启动")));
    drop(evs);
    host.stop();
}

#[test]
fn h02_health_sustained_activity_passes() {
    let _guard = ENV_LOCK.lock().unwrap(); // 无环境变量，仅保证矩阵顺序可读
    // 累计≥4、跨度≥3s、最近 2s 内仍有活动 → 通过
    assert!(SimHost::health_pass(4, 3.0, true, 0));
    assert!(SimHost::health_pass(6, 5.0, true, 0));
    // 串口达到 1500 字节也能判通过（进入应用日志阶段）
    assert!(SimHost::health_pass(0, 0.0, false, 1500));
}

#[test]
fn h03_health_rom_stall_fails() {
    let _guard = ENV_LOCK.lock().unwrap();
    // ROM 阶段"抖几下后卡死"：活动不够 / 跨度不够 / 最近活动已过期 → 都判失败
    assert!(!SimHost::health_pass(2, 1.0, false, 0), "累计不足 4 次");
    assert!(!SimHost::health_pass(3, 3.0, true, 0), "累计差一次");
    assert!(!SimHost::health_pass(4, 1.0, true, 0), "跨度不足 3 秒");
    assert!(!SimHost::health_pass(4, 3.0, false, 0), "最近 2 秒内无活动");
    assert!(!SimHost::health_pass(0, 0.0, false, 1499), "串口差 1 字节");
}

// ---------------- 自动重试与致命错误 ----------------

#[test]
fn h04_retry_after_first_worker_dies() {
    let _l = ENV_LOCK.lock().unwrap();
    let dir = tmp_dir("retry");
    let flash = dir.join("fw.bin");
    std::fs::write(&flash, b"flash").unwrap();
    let marker = dir.join("marker.txt");
    let _env = set_envs(&[
        ("ESP32_IDE_SIM_WORKER", fake_worker().to_string_lossy().to_string()),
        ("ESP32_IDE_QEMU_DLL", dir.join("libqemu-xtensa.dll").to_string_lossy().to_string()),
        ("FAKE_DIE_AT_SPAWN", "1".into()), // 第一次被拉起立刻退出
        ("FAKE_EVENTS", healthy_events(6)),
        ("FAKE_EVENT_GAP_MS", "700".into()),
        ("FAKE_MARKER_FILE", marker.to_string_lossy().to_string()),
        ("SIM_HEALTH_SEC", "6".into()),
        ("SIM_START_ATTEMPTS", "2".into()),
    ]);
    let bus = Arc::new(VecBus::default());
    let host = SimHost::with_bus(bus.clone());
    host.start(&flash.to_string_lossy(), &dir.to_string_lossy())
        .expect("第一次失败后应自动重试并成功");
    assert_eq!(host.status(), SimStatus::Running);
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap().lines().count(),
        2,
        "应先后拉起两个子进程"
    );
    let logs: Vec<String> = bus
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| n == "sim-log")
        .map(|(_, p)| p.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string())
        .collect();
    assert!(logs.iter().any(|m| m.contains("正在重试")), "应发出重试日志：{logs:?}");
    host.stop();
}

#[test]
fn h05_retry_exhausted_returns_error() {
    let _l = ENV_LOCK.lock().unwrap();
    let dir = tmp_dir("exhausted");
    let flash = dir.join("fw.bin");
    std::fs::write(&flash, b"flash").unwrap();
    let _env = set_envs(&[
        ("ESP32_IDE_SIM_WORKER", fake_worker().to_string_lossy().to_string()),
        ("ESP32_IDE_QEMU_DLL", dir.join("libqemu-xtensa.dll").to_string_lossy().to_string()),
        ("FAKE_EXIT_AFTER_MS", "1200".into()), // 两次都"自己死掉"，且不发任何活动
        ("SIM_HEALTH_SEC", "3".into()),
        ("SIM_START_ATTEMPTS", "2".into()),
    ]);
    let host = SimHost::with_bus(Arc::new(VecBus::default()));
    let err = host.start(&flash.to_string_lossy(), &dir.to_string_lossy()).unwrap_err();
    assert!(err.contains("均未成功"), "应提示重试耗尽：{err}");
    assert_eq!(host.status(), SimStatus::Stopped);
}

#[test]
fn h06_sim_error_aborts_start() {
    let _l = ENV_LOCK.lock().unwrap();
    let dir = tmp_dir("fatal");
    let flash = dir.join("fw.bin");
    std::fs::write(&flash, b"flash").unwrap();
    let _env = set_envs(&[
        ("ESP32_IDE_SIM_WORKER", fake_worker().to_string_lossy().to_string()),
        ("ESP32_IDE_QEMU_DLL", dir.join("libqemu-xtensa.dll").to_string_lossy().to_string()),
        ("FAKE_SIM_ERROR", "固件镜像大小不对".into()),
        ("SIM_HEALTH_SEC", "4".into()),
        ("SIM_START_ATTEMPTS", "1".into()),
    ]);
    let host = SimHost::with_bus(Arc::new(VecBus::default()));
    let err = host.start(&flash.to_string_lossy(), &dir.to_string_lossy()).unwrap_err();
    assert!(err.contains("固件镜像大小不对"), "应透传致命错误：{err}");
    assert_eq!(host.status(), SimStatus::Stopped);
}

// ---------------- 命令往返 ----------------

#[test]
fn h07_commands_roundtrip_pins_write_uart_apin_pause_resume() {
    let _l = ENV_LOCK.lock().unwrap();
    let (host, _, _) = start_healthy_host();

    let states = host.pin_states();
    assert_eq!(states.len(), 3, "假 worker 的 pins 应答应有 3 条");
    let led = states.iter().find(|s| s.pin == 24).expect("应有 pin24");
    assert_eq!(led.value, 1);
    assert_eq!(led.dir, 1, "pin24 应为输出");

    let st = host.write_pin(24, 0).expect("pin_write 应成功");
    assert_eq!(st.pin, 24);
    assert_eq!(st.value, 0);

    host.uart_send(0, &[72, 105]).expect("uart_send 应成功");
    host.set_apin(6, 2048).expect("set_apin 应成功");
    host.pause().expect("pause 应成功");
    host.resume().expect("resume 应成功");

    host.stop();
}

#[test]
fn h08_stop_terminates_worker() {
    let _l = ENV_LOCK.lock().unwrap();
    let (host, _, _) = start_healthy_host();
    host.stop();
    assert!(!host.is_running(), "停止后子进程应被回收");
    assert_eq!(host.status(), SimStatus::Stopped);
}

#[test]
fn h09_unresponsive_worker_times_out() {
    let _l = ENV_LOCK.lock().unwrap();
    let dir = tmp_dir("noreply");
    let flash = dir.join("fw.bin");
    std::fs::write(&flash, b"flash").unwrap();
    let _env = set_envs(&[
        ("ESP32_IDE_SIM_WORKER", fake_worker().to_string_lossy().to_string()),
        ("ESP32_IDE_QEMU_DLL", dir.join("libqemu-xtensa.dll").to_string_lossy().to_string()),
        ("FAKE_IGNORE_CMDS", "1".into()),
        ("FAKE_EVENTS", healthy_events(6)),
        ("FAKE_EVENT_GAP_MS", "700".into()),
        ("SIM_HEALTH_SEC", "8".into()),
        ("SIM_START_ATTEMPTS", "1".into()),
    ]);
    let host = SimHost::with_bus(Arc::new(VecBus::default()));
    host.start(&flash.to_string_lossy(), &dir.to_string_lossy()).expect("活动足够仍应启动");
    let err = host.write_pin(24, 1).expect_err("无响应的子进程应超时");
    assert!(err.contains("无响应") || err.contains("超时"), "实际：{err}");
    host.stop(); // stop 会先超时再强杀，不应卡死
    assert!(!host.is_running());
}
