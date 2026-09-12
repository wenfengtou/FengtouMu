//! 仿真子进程（esp32-sim）：每次由主进程 spawn 一个全新实例运行一次仿真。
//! 本进程独占加载 libqemu-xtensa.dll，通过 stdin/stdout 的 JSON Lines 协议
//! 与主进程通信（事件下发 + 命令响应），从而彻底规避：
//!   - QEMU 不支持同进程二次 qemu_init（会导致进程退出）
//!   - QEMU DLL 不可安全卸载（残留线程访问已释放代码 → 0xC0000005）
//!
//! 命令行：esp32-sim --flash <4MB镜像> --fw <fw目录> [--dll <libqemu-xtensa.dll>]

use esp32_ide_lib::sim::engine::{install_sim_core, EventBus, SimCore, SimEngine};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

/// 输出总线：把引擎事件写成一行 JSON 到 stdout（互斥保证不交错）。
struct StdioBus {
    out: Arc<Mutex<std::io::Stdout>>,
}

impl EventBus for StdioBus {
    fn emit(&self, event: &str, payload: Value) {
        write_line(
            &self.out,
            &json!({ "event": event, "payload": payload }).to_string(),
        );
    }
}

fn write_line(out: &Arc<Mutex<std::io::Stdout>>, line: &str) {
    let mut o = out.lock().unwrap();
    let _ = writeln!(o, "{line}");
    let _ = o.flush();
}

fn fail(out: &Arc<Mutex<std::io::Stdout>>, msg: &str) -> ! {
    write_line(out, &json!({ "event": "sim-error", "message": msg }).to_string());
    std::process::exit(2);
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = Arc::new(Mutex::new(std::io::stdout()));

    let Some(flash) = arg_value(&args, "--flash") else {
        fail(&out, "缺少 --flash 参数");
    };
    let Some(fw) = arg_value(&args, "--fw") else {
        fail(&out, "缺少 --fw 参数");
    };

    // 1) 注入仿真核心（stdio 事件总线）
    let _ = install_sim_core(SimCore::with_bus(Arc::new(StdioBus { out: out.clone() })));
    let engine = SimEngine::default();

    // 2) 加载 DLL（显式路径优先，否则自动查找）
    match arg_value(&args, "--dll") {
        Some(p) => {
            if let Err(e) = engine.load_dll(std::path::Path::new(&p)) {
                fail(&out, &format!("加载 DLL 失败: {e}"));
            }
        }
        None => {
            if let Err(e) = engine.auto_load() {
                fail(&out, &format!("自动查找 DLL 失败: {e}"));
            }
        }
    }
    write_line(&out, &json!({ "log": "DLL loaded" }).to_string());

    // 3) 启动仿真（qemu_init + main_loop 在引擎内部线程）
    if let Err(e) = engine.start(std::path::Path::new(&flash), std::path::Path::new(&fw)) {
        fail(&out, &format!("启动仿真失败: {e}"));
    }
    write_line(&out, &json!({ "log": "qemu started" }).to_string());

    // 4) 命令循环（stdin JSON Lines）。stdout 由互斥保护，事件可并发写入。
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = v.get("id").and_then(|x| x.as_u64());
        let cmd = v.get("cmd").and_then(|x| x.as_str()).unwrap_or_default();

        let reply = |ok: bool, data: Option<Value>, err: Option<String>| {
            let mut m = json!({ "reply": id, "ok": ok });
            if let Some(d) = data {
                m["data"] = d;
            }
            if let Some(e) = err {
                m["error"] = Value::String(e);
            }
            write_line(&out, &m.to_string());
        };

        match cmd {
            "stop" => {
                let r = engine.stop();
                match r {
                    Ok(()) => reply(true, None, None),
                    Err(e) => reply(false, None, Some(e.to_string())),
                }
                break;
            }
            "pause" => match engine.pause() {
                Ok(()) => reply(true, None, None),
                Err(e) => reply(false, None, Some(e.to_string())),
            },
            "resume" => match engine.resume() {
                Ok(()) => reply(true, None, None),
                Err(e) => reply(false, None, Some(e.to_string())),
            },
            "pin_write" => {
                let pin = v.get("pin").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                let value = v.get("value").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
                match engine.write_pin(pin, value) {
                    Ok(st) => reply(true, serde_json::to_value(st).ok(), None),
                    Err(e) => reply(false, None, Some(e.to_string())),
                }
            }
            "uart_send" => {
                let uart_id = v.get("uart").and_then(|x| x.as_u64()).unwrap_or(0) as u8;
                let data: Vec<u8> = v
                    .get("data")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|b| b.as_u64().map(|n| n as u8)).collect())
                    .unwrap_or_default();
                match engine.uart_send(uart_id, &data) {
                    Ok(()) => reply(true, None, None),
                    Err(e) => reply(false, None, Some(e.to_string())),
                }
            }
            "set_apin" => {
                let chn = v.get("chn").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
                let value = v.get("value").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
                match engine.set_apin(chn, value) {
                    Ok(()) => reply(true, None, None),
                    Err(e) => reply(false, None, Some(e.to_string())),
                }
            }
            "pins" => {
                let st = engine.pin_states();
                reply(true, serde_json::to_value(st).ok(), None);
            }
            "status" => {
                reply(true, serde_json::to_value(engine.status()).ok(), None);
            }
            "uart_poll" => {
                let b = engine.poll_uart();
                reply(true, serde_json::to_value(b).ok(), None);
            }
            _ => reply(false, None, Some(format!("未知命令: {cmd}"))),
        }
    }

    // stdin 关闭（主进程退出）或收到 stop：确保停止并结束进程
    let _ = engine.stop();
    std::process::exit(0);
}
