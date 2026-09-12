//! 仿真宿主：把 QEMU 仿真放在**独立子进程**（esp32-sim.exe）中运行。
//!
//! 为什么这么做：PICSimLab 的 QEMU DLL 既不支持同进程二次 qemu_init（会直接
//! 退出进程），也无法安全卸载（残留线程访问已释放代码 → 0xC0000005 闪退）。
//! 把仿真放进子进程后：
//!   - 每点一次"运行" = 全新进程 = 干净的 QEMU 静态区，可无限次重复运行；
//!   - 冷启动卡死时直接杀掉子进程再起一个，自动重试；
//!   - 子进程崩溃也不会影响主界面（表现为"启动失败"，绝不闪退）。
//!
//! 通信：stdin/stdout 上的 JSON Lines 协议。
//!   子进程 → 主进程：{"event":<名>,"payload":<值>} / {"reply":<id>,"ok":..,"data":..} / {"log":".."}
//!   主进程 → 子进程：{"id":<n>,"cmd":"stop|pause|resume|pin_write|uart_send|pins|status|uart_poll",...}

use crate::sim::engine::{discover_dll, EventBus, SimStatus};
use crate::sim::pins::PinState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// 事件总线：转发到 Tauri 前端（事件名与旧引擎保持一致）。
struct WryBus {
    app: AppHandle,
}

impl EventBus for WryBus {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }
}

/// 宿主与读取线程共享的状态。
struct Shared {
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    /// 引脚活动计数：每收到一次 gpio-update 递增（= 固件确实在驱动 GPIO）
    activity: Mutex<u64>,
    /// 最近一次引脚活动时间（用于判断"是否仍在持续运行"）
    last_activity: Mutex<Option<Instant>>,
    /// 串口累计字节数（ROM 卡死时约几百字节即停止；进入应用后持续增长）
    uart_bytes: Mutex<u64>,
    cv: Condvar,
    /// 子进程启动阶段的致命错误（如镜像大小不对）
    start_error: Mutex<Option<String>>,
    /// 子进程是否已退出
    exited: Mutex<bool>,
    status: Mutex<SimStatus>,
    /// 最后一次引脚快照（子进程退出后仍可展示）
    pins: Mutex<Vec<PinState>>,
}

impl Shared {
    fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            activity: Mutex::new(0),
            last_activity: Mutex::new(None),
            uart_bytes: Mutex::new(0),
            cv: Condvar::new(),
            start_error: Mutex::new(None),
            exited: Mutex::new(false),
            status: Mutex::new(SimStatus::Idle),
            pins: Mutex::new(Vec::new()),
        }
    }
}

struct ChildProc {
    child: Child,
    stdin: ChildStdin,
}

pub struct SimHost {
    shared: Arc<Shared>,
    bus: Arc<dyn EventBus>,
    child: Mutex<Option<ChildProc>>,
    dll_path: Mutex<Option<PathBuf>>,
    next_id: AtomicU64,
}

impl SimHost {
    pub fn new(app: AppHandle) -> Self {
        Self {
            shared: Arc::new(Shared::new()),
            bus: Arc::new(WryBus { app }),
            child: Mutex::new(None),
            dll_path: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    fn log(&self, msg: impl Into<String>) {
        self.bus.emit("sim-log", json!({ "message": msg.into() }));
    }

    fn set_status(&self, s: SimStatus) {
        *self.shared.status.lock().unwrap() = s;
    }

    /// 定位 esp32-sim.exe：
    ///   1) 环境变量 ESP32_IDE_SIM_WORKER
    ///   2) 主程序同级目录（target/release 或安装目录）
    ///   3) 安装目录的 resources 子目录（Tauri resources 打包位置）
    ///   4) 主程序上一级目录（开发布局）
    fn worker_path(&self) -> Result<PathBuf, String> {
        if let Ok(p) = std::env::var("ESP32_IDE_SIM_WORKER") {
            let pb = PathBuf::from(p);
            if pb.is_file() {
                return Ok(pb);
            }
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = exe.parent().ok_or("无法获取程序目录")?;
        for cand in [
            dir.join("esp32-sim.exe"),
            dir.join("resources").join("esp32-sim.exe"),
            dir.join("../esp32-sim.exe"),
        ] {
            if cand.is_file() {
                return Ok(cand);
            }
        }
        Err("未找到仿真子进程 esp32-sim.exe（应与主程序同目录或在 resources 目录）".into())
    }

    fn resolved_dll(&self) -> Option<PathBuf> {
        self.dll_path
            .lock()
            .unwrap()
            .clone()
            .or_else(discover_dll)
    }

    /// 启动子进程并挂上 stdout 读取线程。
    fn spawn_child(&self, flash: &str, fw: &str) -> Result<ChildProc, String> {
        let worker = self.worker_path()?;
        let mut cmd = Command::new(&worker);
        cmd.arg("--flash")
            .arg(flash)
            .arg("--fw")
            .arg(fw)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(dll) = self.resolved_dll() {
            cmd.arg("--dll").arg(dll);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动仿真子进程失败: {e}"))?;
        let stdin = child.stdin.take().ok_or("无法获取子进程 stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取子进程 stdout")?;

        let shared = self.shared.clone();
        let bus = self.bus.clone();
        std::thread::Builder::new()
            .name("sim-worker-reader".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let Ok(v) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    // 命令响应
                    if let Some(id) = v.get("reply").and_then(|x| x.as_u64()) {
                        if let Some(tx) = shared.pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(v);
                        }
                        continue;
                    }
                    // 日志
                    if let Some(l) = v.get("log").and_then(|x| x.as_str()) {
                        bus.emit("sim-log", json!({ "message": l }));
                        continue;
                    }
                    // 事件
                    if let Some(name) = v.get("event").and_then(|x| x.as_str()) {
                        let payload = v.get("payload").cloned().unwrap_or(Value::Null);
                        match name {
                            "gpio-update" => {
                                if let Ok(st) = serde_json::from_value::<PinState>(payload.clone()) {
                                    let mut pins = shared.pins.lock().unwrap();
                                    if let Some(slot) = pins.iter_mut().find(|p| p.pin == st.pin) {
                                        *slot = st;
                                    } else {
                                        pins.push(st);
                                    }
                                }
                                *shared.activity.lock().unwrap() += 1;
                                *shared.last_activity.lock().unwrap() = Some(Instant::now());
                                shared.cv.notify_all();
                            }
                            "sim-status" => {
                                if let Ok(s) = serde_json::from_value::<SimStatus>(payload.clone()) {
                                    *shared.status.lock().unwrap() = s;
                                }
                            }
                            "uart-data" => {
                                let n = payload
                                    .get("data")
                                    .and_then(|d| d.as_array())
                                    .map(|a| a.len() as u64)
                                    .unwrap_or(0);
                                if n > 0 {
                                    *shared.uart_bytes.lock().unwrap() += n;
                                    shared.cv.notify_all();
                                }
                            }
                            "sim-error" => {
                                let msg = v
                                    .get("message")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("子进程启动失败")
                                    .to_string();
                                *shared.start_error.lock().unwrap() = Some(msg);
                                shared.cv.notify_all();
                            }
                            _ => {}
                        }
                        bus.emit(name, payload);
                    }
                }
                *shared.exited.lock().unwrap() = true;
                shared.cv.notify_all();
            })
            .map_err(|e| format!("创建读取线程失败: {e}"))?;

        Ok(ChildProc { child, stdin })
    }

    fn kill_child(&self) {
        let mut guard = self.child.lock().unwrap();
        if let Some(mut cp) = guard.take() {
            let _ = cp.child.kill();
            let _ = cp.child.wait();
        }
    }

    /// 向子进程发命令并等待响应。
    fn send_cmd(&self, mut v: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        v["id"] = json!(id);
        let (tx, rx) = channel();
        self.shared.pending.lock().unwrap().insert(id, tx);
        {
            let mut guard = self.child.lock().unwrap();
            let cp = guard.as_mut().ok_or("仿真未在运行")?;
            writeln!(cp.stdin, "{v}").map_err(|e| format!("写入子进程失败: {e}"))?;
            let _ = cp.stdin.flush();
        }
        match rx.recv_timeout(timeout) {
            Ok(reply) => {
                if reply.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                    Ok(reply.get("data").cloned().unwrap_or(Value::Null))
                } else {
                    Err(reply
                        .get("error")
                        .and_then(|x| x.as_str())
                        .unwrap_or("子进程返回错误")
                        .to_string())
                }
            }
            Err(_) => {
                self.shared.pending.lock().unwrap().remove(&id);
                Err("仿真子进程无响应".into())
            }
        }
    }

    /// 启动仿真（自动重试：每次都是全新子进程）。
    pub fn start(&self, flash: &str, fw_dir: &str) -> Result<(), String> {
        self.stop();
        if !Path::new(flash).is_file() {
            return Err(format!("固件镜像不存在: {flash}"));
        }
        let health_secs: u64 = std::env::var("SIM_HEALTH_SEC")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);
        let attempts: u32 = std::env::var("SIM_START_ATTEMPTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3);

        for attempt in 1..=attempts {
            {
                *self.shared.activity.lock().unwrap() = 0;
                *self.shared.last_activity.lock().unwrap() = None;
                *self.shared.uart_bytes.lock().unwrap() = 0;
                *self.shared.start_error.lock().unwrap() = None;
                *self.shared.exited.lock().unwrap() = false;
            }
            self.log(format!("正在启动仿真（第 {attempt}/{attempts} 次）…"));
            let cp = self.spawn_child(flash, fw_dir)?;
            *self.child.lock().unwrap() = Some(cp);
            self.set_status(SimStatus::Loading);

            // 健康判据（避免把 ROM 卡死误判为成功）：
            //   - 引脚仍在**持续**变化：累计 ≥2 次 且 最近一次活动在 2 秒内
            //     （LED 闪烁等周期性驱动必然满足；卡死时活动会停止、时间戳变旧），或
            //   - 串口输出 ≥1500 字节（已进入应用日志阶段；ROM 卡死通常远小于此）
            let deadline = Instant::now() + Duration::from_secs(health_secs);
            let mut ok = false;
            let mut fatal: Option<String> = None;
            while Instant::now() < deadline {
                let act = *self.shared.activity.lock().unwrap();
                let recent = self
                    .shared
                    .last_activity
                    .lock()
                    .unwrap()
                    .map(|t| t.elapsed() < Duration::from_secs(2))
                    .unwrap_or(false);
                let uart = *self.shared.uart_bytes.lock().unwrap();
                if (act >= 2 && recent) || uart >= 1500 {
                    ok = true;
                    break;
                }
                if let Some(e) = self.shared.start_error.lock().unwrap().clone() {
                    fatal = Some(e);
                    break;
                }
                if *self.shared.exited.lock().unwrap() {
                    break;
                }
                let guard = self.shared.activity.lock().unwrap();
                let _ = self
                    .shared
                    .cv
                    .wait_timeout(guard, Duration::from_millis(200))
                    .unwrap();
            }

            if ok {
                self.set_status(SimStatus::Running);
                self.log("仿真已启动");
                return Ok(());
            }
            if let Some(e) = fatal {
                self.kill_child();
                self.set_status(SimStatus::Stopped);
                self.bus.emit("sim-status", json!("stopped"));
                return Err(e);
            }
            // 冷启动卡死或子进程异常退出：杀掉并换一个全新进程重试
            self.kill_child();
            self.set_status(SimStatus::Stopped);
            self.bus.emit("sim-status", json!("stopped"));
            if attempt < attempts {
                self.log(format!(
                    "第 {attempt} 次启动未成功（QEMU 冷启动卡死），正在重试…"
                ));
            }
        }
        Err(format!(
            "{attempts} 次启动均未成功（QEMU 冷启动卡死）。可关闭占用 CPU 的程序（如远程桌面/录屏）后重试"
        ))
    }

    /// 停止仿真（优雅退出，超时则强杀）。
    pub fn stop(&self) {
        let has_child = self.child.lock().unwrap().is_some();
        if has_child {
            let _ = self.send_cmd(json!({ "cmd": "stop" }), Duration::from_secs(5));
            // 等待子进程自行退出
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                {
                    let mut guard = self.child.lock().unwrap();
                    if let Some(cp) = guard.as_mut() {
                        if let Ok(Some(_)) = cp.child.try_wait() {
                            *guard = None;
                            break;
                        }
                    } else {
                        break;
                    }
                }
                if Instant::now() > deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            self.kill_child();
        }
        self.set_status(SimStatus::Stopped);
        self.bus.emit("sim-status", json!("stopped"));
    }

    pub fn pause(&self) -> Result<(), String> {
        self.send_cmd(json!({ "cmd": "pause" }), Duration::from_secs(3))
            .map(|_| ())
    }

    pub fn resume(&self) -> Result<(), String> {
        self.send_cmd(json!({ "cmd": "resume" }), Duration::from_secs(3))
            .map(|_| ())
    }

    pub fn write_pin(&self, pin: usize, value: i32) -> Result<PinState, String> {
        let data = self.send_cmd(
            json!({ "cmd": "pin_write", "pin": pin, "value": value }),
            Duration::from_secs(3),
        )?;
        serde_json::from_value(data).map_err(|e| format!("解析引脚状态失败: {e}"))
    }

    pub fn uart_send(&self, id: u8, data: &[u8]) -> Result<(), String> {
        self.send_cmd(
            json!({ "cmd": "uart_send", "uart": id, "data": data }),
            Duration::from_secs(3),
        )
        .map(|_| ())
    }

    pub fn pin_states(&self) -> Vec<PinState> {
        if self.child.lock().unwrap().is_some() {
            if let Ok(v) = self.send_cmd(json!({ "cmd": "pins" }), Duration::from_secs(2)) {
                if let Ok(list) = serde_json::from_value::<Vec<PinState>>(v) {
                    *self.shared.pins.lock().unwrap() = list.clone();
                    return list;
                }
            }
        }
        self.shared.pins.lock().unwrap().clone()
    }

    pub fn poll_uart(&self) -> Vec<u8> {
        if self.child.lock().unwrap().is_some() {
            if let Ok(v) = self.send_cmd(json!({ "cmd": "uart_poll" }), Duration::from_secs(2)) {
                if let Ok(b) = serde_json::from_value::<Vec<u8>>(v) {
                    return b;
                }
            }
        }
        Vec::new()
    }

    pub fn status(&self) -> SimStatus {
        *self.shared.status.lock().unwrap()
    }

    /// 子进程是否在运行。
    pub fn is_running(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    pub fn dll_ready(&self) -> bool {
        self.resolved_dll().is_some()
    }

    pub fn set_dll(&self, path: &Path) -> Result<(), String> {
        if !path.is_file() {
            return Err(format!("DLL 不存在: {}", path.display()));
        }
        *self.dll_path.lock().unwrap() = Some(path.to_path_buf());
        Ok(())
    }

    /// 自动定位 DLL（不加载），返回路径。
    pub fn auto_dll(&self) -> Result<String, String> {
        if let Some(p) = self.resolved_dll() {
            *self.dll_path.lock().unwrap() = Some(p.clone());
            return Ok(p.to_string_lossy().into_owned());
        }
        Err("未找到 libqemu-xtensa.dll（已检查环境变量、程序目录与项目 lib/qemu）".into())
    }
}

// ---------------- Tauri 命令层 ----------------

pub struct AppState {
    pub host: SimHost,
}

impl AppState {
    pub fn new(app: AppHandle) -> Self {
        Self {
            host: SimHost::new(app),
        }
    }
}

#[tauri::command]
pub fn cmd_load_dll(state: State<'_, AppState>, path: String) -> Result<(), String> {
    // 只记录路径；实际加载发生在仿真子进程中（每次运行全新加载）
    state.host.set_dll(Path::new(&path))
}

#[tauri::command]
pub fn cmd_auto_load_dll(state: State<'_, AppState>) -> Result<String, String> {
    state.host.auto_dll()
}

#[tauri::command]
pub fn cmd_dll_loaded(state: State<'_, AppState>) -> bool {
    state.host.dll_ready()
}

#[tauri::command]
pub fn cmd_sim_start(
    state: State<'_, AppState>,
    flash: String,
    fw_dir: String,
) -> Result<(), String> {
    state.host.start(&flash, &fw_dir)
}

#[tauri::command]
pub fn cmd_sim_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.host.stop();
    Ok(())
}

#[tauri::command]
pub fn cmd_sim_pause(state: State<'_, AppState>) -> Result<(), String> {
    state.host.pause()
}

#[tauri::command]
pub fn cmd_sim_resume(state: State<'_, AppState>) -> Result<(), String> {
    state.host.resume()
}

#[tauri::command]
pub fn cmd_pin_write(
    state: State<'_, AppState>,
    pin: usize,
    value: i32,
) -> Result<PinState, String> {
    state.host.write_pin(pin, value)
}

#[tauri::command]
pub fn cmd_uart_send(state: State<'_, AppState>, id: u8, data: Vec<u8>) -> Result<(), String> {
    state.host.uart_send(id, &data)
}

#[tauri::command]
pub fn cmd_pin_states(state: State<'_, AppState>) -> Vec<PinState> {
    state.host.pin_states()
}

#[tauri::command]
pub fn cmd_uart_poll(state: State<'_, AppState>) -> Vec<u8> {
    state.host.poll_uart()
}

#[tauri::command]
pub fn cmd_sim_status(state: State<'_, AppState>) -> SimStatus {
    state.host.status()
}
