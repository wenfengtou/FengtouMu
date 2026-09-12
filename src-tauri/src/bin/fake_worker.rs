//! 仿真子进程的「协议替身」（仅测试用，不打包）。
//!
//! 行为由环境变量控制，让主进程的 SimHost 在**不加载 QEMU DLL** 的情况下走完整条
//! JSON Lines 协议链路，从而把「GPIO 闪烁、UART、按键、重试、健康判据」等交互协议
//! 变成可在 CI 中稳定运行的用例（见 `tests/worker_protocol.rs` 与 `docs/仿真协议.md`）。
//!
//! 环境变量：
//!   FAKE_EVENTS         启动时要逐条发送的事件帧（JSON 数组，`[{"event":"gpio-update","payload":{...}}, ...]`）
//!   FAKE_EVENT_GAP_MS   事件帧之间的间隔（毫秒），默认 0 —— 用 700~900 可以模拟"持续活动"
//!   FAKE_MARKER_FILE    启动时把一行 "spawned" 追加进去（用于统计子进程被启动了几次）
//!   FAKE_SIM_ERROR      启动后立刻发一个 sim-error 事件并退出 1（模拟致命错误）
//!   FAKE_EXIT_AFTER_MS  启动 N 毫秒后按 FAKE_EXIT_CODE 退出（默认 0，模拟"自己死掉"）
//!   FAKE_DIE_AT_SPAWN   第 N 次被拉起时立刻按 FAKE_EXIT_CODE 退出（配合 FAKE_MARKER_FILE 统计，
//!                       用于"第一次失败、第二次成功"的重试场景）
//!   FAKE_IGNORE_CMDS    置 1 时对所有命令都不应答（模拟无响应子进程，宿主应超时/强杀）

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::Duration;

fn env_i64(key: &str) -> Option<i64> {
    std::env::var(key).ok().and_then(|v| v.trim().parse().ok())
}

fn env_str(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn emit(line: Value) {
    println!("{line}");
}

fn main() {
    let mut spawn_count: i64 = 0;
    if let Some(marker) = env_str("FAKE_MARKER_FILE") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&marker) {
            let _ = writeln!(f, "spawned");
        }
        // 统计"第几次被拉起"：行数 = 当前累计启动次数
        if let Ok(text) = std::fs::read_to_string(&marker) {
            spawn_count = text.lines().count() as i64;
        }
    }

    emit(json!({"log": "fake worker ready"}));

    // 指定"第 N 次拉起即死"，配合重试场景（FAKE_MARKER_FILE 必须已配置）
    if let Some(n) = env_i64("FAKE_DIE_AT_SPAWN") {
        if spawn_count == n {
            std::process::exit(env_i64("FAKE_EXIT_CODE").unwrap_or(0) as i32);
        }
    }

    // 可选：先发一段事件脚本（模拟固件启动后的引脚活动）
    if let Some(events_text) = env_str("FAKE_EVENTS") {
        if let Ok(Value::Array(events)) = serde_json::from_str::<Value>(&events_text) {
            let gap = env_i64("FAKE_EVENT_GAP_MS").unwrap_or(0).max(0) as u64;
            for ev in events {
                emit(ev);
                if gap > 0 {
                    std::thread::sleep(Duration::from_millis(gap));
                }
            }
        }
    }

    // 可选：致命错误路径
    if let Some(msg) = env_str("FAKE_SIM_ERROR") {
        emit(json!({"event": "sim-error", "message": msg}));
        std::process::exit(1);
    }

    // 可选：N 毫秒后自行退出（模拟卡死/异常退出，触发宿主重试）
    if let Some(ms) = env_i64("FAKE_EXIT_AFTER_MS") {
        std::thread::sleep(Duration::from_millis(ms.max(0) as u64));
        std::process::exit(env_i64("FAKE_EXIT_CODE").unwrap_or(0) as i32);
    }

    // 命令应答循环
    if env_str("FAKE_IGNORE_CMDS").is_some() {
        // 模拟无响应：只挂起等待 stdin 关闭（宿主会超时并强杀）
        let stdin = std::io::stdin();
        for _ in stdin.lock().lines() {}
        return;
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = v.get("id").and_then(|x| x.as_u64()) else {
            continue;
        };
        let cmd = v.get("cmd").and_then(|x| x.as_str()).unwrap_or("");
        let reply: Value = match cmd {
            "pins" => json!({
                "reply": id, "ok": true, "data": [
                    {"pin": 1,  "gpio": 36, "value": 0, "dir": 0},
                    {"pin": 24, "gpio": 2,  "value": 1, "dir": 1},
                    {"pin": 25, "gpio": 0,  "value": 1, "dir": 0}
                ]
            }),
            "status" => json!({ "reply": id, "ok": true, "data": "running" }),
            "pin_write" => {
                let pin = v.get("pin").and_then(|x| x.as_u64()).unwrap_or(0);
                let value = v.get("value").and_then(|x| x.as_i64()).unwrap_or(0);
                json!({ "reply": id, "ok": true, "data": { "pin": pin, "gpio": 0, "value": value, "dir": 0 } })
            }
            "uart_poll" => json!({ "reply": id, "ok": true, "data": [] }),
            "stop" => {
                let ok = json!({ "reply": id, "ok": true, "data": null });
                println!("{ok}");
                std::process::exit(0);
            }
            _ => json!({ "reply": id, "ok": true, "data": null }),
        };
        emit(reply);
        let _ = std::io::stdout().flush();
    }
}
