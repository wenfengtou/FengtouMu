//! 仿真引擎：管理 libqemu-xtensa.dll 的生命周期、QEMU 线程、GPIO/UART 回调。
//! 启动流程复用 PICSimLab bsim_qemu.cc 中已验证的参数构造与线程模型。

use crate::sim::pins::{PinState, PinTable, DEVKITC_PINMAP};
use crate::sim::qemu_dll::{Callbacks, QemuDll, SetPinFn, SimError};
use serde::{Deserialize, Serialize};
use std::ffi::{CString, c_void};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter};

/// 回调线程（QEMU 内部线程）访问的共享核心。
static SIM_CORE: OnceLock<Arc<SimCore>> = OnceLock::new();

/// QEMU 的 set_pin 函数指针。QEMU 每次读取 GPIO 输入寄存器都会请求一次同步
/// （picsimlab_dir_pin(-1, ...)），此时必须把外部驱动的电平重新推回模型，
/// 否则界面上的按键/传感器电平会被模型内部状态覆盖。
static SET_PIN_FN: OnceLock<SetPinFn> = OnceLock::new();

/// 事件总线抽象：将引擎与 GUI 框架（Tauri）解耦，便于无 GUI 自动化测试。
pub trait EventBus: Send + Sync {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// 生产环境实现：转发到 Tauri 前端事件。
struct WryBus {
    app: AppHandle,
}

impl EventBus for WryBus {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }
}

/// 测试/自动化用：记录最近一次事件（不连接任何前端）。
#[derive(Default)]
pub struct RecordingBus {
    pub last: Mutex<Option<(String, serde_json::Value)>>,
}

impl EventBus for RecordingBus {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        *self.last.lock().unwrap() = Some((event.to_string(), payload));
    }
}

const EFUSE_SIZE: usize = 124;
const FLASH_SIZE: u64 = 4 * 1024 * 1024; // 4MB，与 PICSimLab DBGGetROMSize 一致
const UART_FLUSH_MS: u128 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SimStatus {
    Idle,
    Loading,
    Running,
    Stopping,
    Stopped,
}

pub struct SimCore {
    pub bus: Arc<dyn EventBus>,
    pub pins: Mutex<PinTable>,
    pub uart: Mutex<Vec<u8>>,
    pub uart_flushed: Mutex<usize>,
    pub last_uart_flush: Mutex<std::time::Instant>,
    pub status: Mutex<SimStatus>,
}

impl SimCore {
    /// 生产用（子进程内）：事件总线转发到指定 Tauri AppHandle。
    pub fn new(app: AppHandle) -> Arc<Self> {
        Self::with_bus(Arc::new(WryBus { app }))
    }

    pub fn with_bus(bus: Arc<dyn EventBus>) -> Arc<Self> {
        Arc::new(Self {
            bus,
            pins: Mutex::new(PinTable::default()),
            uart: Mutex::new(Vec::new()),
            uart_flushed: Mutex::new(0),
            last_uart_flush: Mutex::new(std::time::Instant::now()),
            status: Mutex::new(SimStatus::Idle),
        })
    }

    fn flush_uart_if_due(&self) {
        let due = self.last_uart_flush.lock().unwrap().elapsed().as_millis() >= UART_FLUSH_MS;
        if !due {
            return;
        }
        *self.last_uart_flush.lock().unwrap() = std::time::Instant::now();
        let (new_bytes, flushed) = {
            let u = self.uart.lock().unwrap();
            let mut f = self.uart_flushed.lock().unwrap();
            if u.len() > *f {
                let chunk = u[*f..].to_vec();
                *f = u.len();
                (chunk, *f)
            } else {
                (Vec::new(), *f)
            }
        };
        if !new_bytes.is_empty() {
            self.bus.emit("uart-data", serde_json::to_value(UartChunk { flushed, data: new_bytes }).unwrap_or(serde_json::Value::Null));
        }
    }
}

#[derive(Clone, Serialize)]
struct UartChunk {
    flushed: usize,
    data: Vec<u8>,
}

extern "C" fn cb_write_pin(pin: c_int, value: c_int) {
    let Some(core) = SIM_CORE.get() else { return };
    let ev = {
        let mut t = core.pins.lock().unwrap();
        t.on_output(pin, value)
    };
    if let Some(s) = ev {
        core.bus.emit("gpio-update", serde_json::to_value(s).unwrap_or(serde_json::Value::Null));
    }
}

extern "C" fn cb_dir_pin(pin: c_int, dir: c_int) {
    let Some(core) = SIM_CORE.get() else { return };
    if pin < 0 {
        // QEMU 每次读取 GPIO 输入寄存器都会请求同步（dir = -1，或 in_sel/out_sel 变更）。
        // 这里把外部驱动的引脚值重新推回模型，与 PICSimLab 的行为一致。
        let forced = core.pins.lock().unwrap().forced_inputs();
        if let Some(set_pin) = SET_PIN_FN.get() {
            for (p, v) in forced {
                unsafe { set_pin(p as c_int, v) };
            }
        }
        return;
    }
    // QEMU 侧 dir 语义：0=输出 1=输入（与 PICSimLab 内部 !dir 相反）
    let mut t = core.pins.lock().unwrap();
    t.on_dir(pin, dir == 0);
}

extern "C" fn cb_uart_tx(_id: u8, byte: u8) {
    let Some(core) = SIM_CORE.get() else { return };
    {
        let mut u = core.uart.lock().unwrap();
        u.push(byte);
    }
    core.flush_uart_if_due();
}

pub struct SimEngine {
    pub dll: Mutex<Option<Arc<QemuDll>>>,
    pub thread: Mutex<Option<JoinHandle<()>>>,
    /// 本 QEMU 构建不支持同进程二次 qemu_init（会耗尽静态区直接退出进程），
    /// 因此整个进程生命周期只允许启动一次仿真。
    started_once: std::sync::atomic::AtomicBool,
}

impl Default for SimEngine {
    fn default() -> Self {
        Self {
            dll: Mutex::new(None),
            thread: Mutex::new(None),
            started_once: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

impl SimEngine {
    pub fn load_dll(&self, path: &Path) -> Result<(), SimError> {
        {
            let dll = self.dll.lock().unwrap();
            if dll.is_some() {
                return Err(SimError::AlreadyLoaded);
            }
        }
        let dll = QemuDll::load(path)?;
        *self.dll.lock().unwrap() = Some(Arc::new(dll));
        Ok(())
    }

    pub fn is_loaded(&self) -> bool {
        self.dll.lock().unwrap().is_some()
    }

    fn require_dll(&self) -> Result<Arc<QemuDll>, SimError> {
        self.dll
            .lock()
            .unwrap()
            .clone()
            .ok_or(SimError::NotLoaded)
    }

    /// 自动查找并加载 DLL（已加载则返回 Ok(None)）。供启动重试与 UI 自动加载共用。
    pub fn auto_load(&self) -> Result<Option<PathBuf>, SimError> {
        if self.is_loaded() {
            return Ok(None);
        }
        for c in dll_candidates() {
            if !c.is_file() {
                continue;
            }
            match self.load_dll(&c) {
                Ok(()) => return Ok(Some(c)),
                Err(SimError::AlreadyLoaded) => return Ok(Some(c)),
                Err(_) => continue,
            }
        }
        Err(SimError::Load(
            "未找到 libqemu-xtensa.dll（已检查环境变量 ESP32_IDE_QEMU_DLL、exe 目录与项目 lib/qemu）"
                .into(),
        ))
    }

    /// 启动仿真。flash_path 为 4MB 对齐的固件镜像，fw_dir 为 ROM/keymaps 目录。
    pub fn start(&self, flash_path: &Path, fw_dir: &Path) -> Result<(), SimError> {
        // 进程级一次性防护：QEMU 不支持同进程二次初始化，直接报错而不是崩溃。
        if self
            .started_once
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(SimError::Init(
                "QEMU 仅支持每进程启动一次仿真；再次运行请重启应用（本限制源于 PICSimLab QEMU DLL）"
                    .into(),
            ));
        }
        if self.thread.lock().unwrap().is_some() {
            return Err(SimError::AlreadyRunning);
        }
        let dll = self.require_dll()?;

        if !flash_path.is_file() {
            return Err(SimError::Io(format!("固件镜像不存在: {}", flash_path.display())));
        }
        let flash_len = std::fs::metadata(flash_path)
            .map_err(|e| SimError::Io(e.to_string()))?
            .len();
        if flash_len != FLASH_SIZE {
            return Err(SimError::Io(format!(
                "固件镜像大小应为 4MB（当前 {} 字节），请用编译链封装对齐后再试",
                flash_len
            )));
        }

        let rom_a = fw_dir.join("esp32-v3-rom.bin");
        let rom_b = fw_dir.join("esp32-v3-rom-app.bin");
        if !rom_a.is_file() || !rom_b.is_file() {
            return Err(SimError::Io(format!(
                "fw 目录缺少 ROM 文件（需要 {} 和 {}）",
                rom_a.display(),
                rom_b.display()
            )));
        }
        let keymap = fw_dir.join("keymaps").join("en-us");
        if !keymap.is_file() {
            return Err(SimError::Io(format!(
                "fw 目录缺少 keymaps/en-us（QEMU 初始化必需）: {}",
                keymap.display()
            )));
        }

        let efuse_path = ensure_efuse(flash_path)?;

        let fw_dir_s = fw_dir.to_string_lossy().to_string();
        let flash_s = flash_path.to_string_lossy().to_string();
        let efuse_s = efuse_path.to_string_lossy().to_string();

        let core = SIM_CORE
            .get()
            .expect("SimCore must be initialized before start");

        // 复位仿真状态（重启场景：清除上次运行的引脚/串口残留）
        core.pins.lock().unwrap().reset();
        core.uart.lock().unwrap().clear();
        *core.uart_flushed.lock().unwrap() = 0;

        {
            let mut st = core.status.lock().unwrap();
            *st = SimStatus::Loading;
        }
        core.bus.emit("sim-status", serde_json::to_value(SimStatus::Loading).unwrap_or(serde_json::Value::Null));

        let (started, cv) = started_flag();
        *started.lock().unwrap() = false;

        let handle = std::thread::Builder::new()
            .name("qemu-sim".to_string())
            .spawn(move || {
                run_qemu(dll, fw_dir_s, flash_s, efuse_s, core.clone());
            })
            .map_err(|e| SimError::Init(e.to_string()))?;

        // 等待 qemu_init 完成（PICSimLab 同样以互斥等待 qemu_started）
        let mut ok = started.lock().unwrap();
        let timeout = std::time::Duration::from_secs(15);
        let deadline = std::time::Instant::now() + timeout;
        while !*ok {
            let (guard, result) = cv.wait_timeout(ok, timeout).unwrap();
            ok = guard;
            if result.timed_out() || std::time::Instant::now() >= deadline {
                // qemu_init 可能仍在输出，不强杀；标记停止等待
                break;
            }
        }
        if !*ok {
            *self.thread.lock().unwrap() = Some(handle);
            return Err(SimError::Init("qemu_init 超时（15s），请检查 fw 目录与 DLL 依赖".to_string()));
        }
        drop(ok);
        *self.thread.lock().unwrap() = Some(handle);
        Ok(())
    }

    /// 启动 + 健康检测：QEMU 冷启动偶发卡在 ROM 引导阶段（表现为固件永不驱动
    /// GPIO）。观察窗口内是否出现引脚电平变化：正常固件启动后会驱动引脚，但
    /// GUI 场景下要与其他进程（WebView2）抢 CPU，启动可能明显变慢，故窗口放宽
    /// 到默认 20 秒（可用环境变量 SIM_HEALTH_SEC 调整）。超时判定卡死，自动停止
    /// （DLL 保持驻留）并返回错误。
    /// attempts 恒为 1：本 QEMU 不支持同进程二次 qemu_init，无法自动重试。
    pub fn start_with_auto_retry(
        &self,
        flash_path: &Path,
        fw_dir: &Path,
        attempts: u32,
    ) -> Result<u32, SimError> {
        let health_secs: u64 = std::env::var("SIM_HEALTH_SEC")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(20);
        for attempt in 1..=attempts {
            self.auto_load()?;
            self.start(flash_path, fw_dir)?;
            let mut prev: Vec<PinState> = self.pin_states();
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_secs(health_secs);
            let mut alive = false;
            while std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let cur = self.pin_states();
                if cur.iter().zip(&prev).any(|(a, b)| a.value != b.value) {
                    alive = true;
                    break;
                }
                prev = cur;
            }
            if alive {
                return Ok(attempt);
            }
            // 疑似 ROM 冷启动卡死：停止本次运行并报告（DLL 不卸载，防崩溃）
            let _ = self.stop();
        }
        Err(SimError::Init(format!(
            "QEMU 冷启动卡死（{health_secs} 秒内无任何引脚活动），本次运行已停止；再次运行需重启应用"
        )))
    }

    pub fn stop(&self) -> Result<(), SimError> {
        let dll = self.require_dll()?;
        let core = SIM_CORE.get().expect("SimCore must be initialized");
        {
            let mut st = core.status.lock().unwrap();
            if *st != SimStatus::Running {
                return Err(SimError::NotRunning);
            }
            *st = SimStatus::Stopping;
        }
        core.bus.emit("sim-status", serde_json::to_value(SimStatus::Stopping).unwrap_or(serde_json::Value::Null));

        // 与 PICSimLab MEnd 一致：持 BQL 调 qmp_quit
        unsafe {
            (dll.bql_lock)(b"esp32-ide\0".as_ptr() as *const c_char, line!() as c_int);
            (dll.qmp_quit)(std::ptr::null_mut());
            (dll.bql_unlock)();
        }

        let handle = self.thread.lock().unwrap().take();
        if let Some(h) = handle {
            let _ = h.join();
        }
        // 注意：不能在这里卸载 DLL。本 QEMU 在 qemu_cleanup 后仍可能有残留线程
        // （如 VNC/AIO），FreeLibrary 会让它们访问已释放的代码导致进程崩溃（0xC0000005）。
        // DLL 保持驻留到进程退出即可。
        Ok(())
    }

    pub fn pause(&self) -> Result<(), SimError> {
        let dll = self.require_dll()?;
        unsafe {
            (dll.bql_lock)(b"esp32-ide\0".as_ptr() as *const c_char, line!() as c_int);
            (dll.qmp_stop)(std::ptr::null_mut());
            (dll.bql_unlock)();
        }
        Ok(())
    }

    pub fn resume(&self) -> Result<(), SimError> {
        let dll = self.require_dll()?;
        unsafe {
            (dll.bql_lock)(b"esp32-ide\0".as_ptr() as *const c_char, line!() as c_int);
            (dll.qmp_cont)(std::ptr::null_mut());
            (dll.bql_unlock)();
        }
        Ok(())
    }

    /// 注入模拟引脚电压（ADC）。`chn` 为 ESP32 SAR ADC 通道号，`value` 为 12 位读数。
    pub fn set_apin(&self, chn: i32, value: i32) -> Result<(), SimError> {
        let dll = self.require_dll()?;
        // 与 set_pin 同理：跨线程写入需要在 BQL 保护下进行
        unsafe {
            (dll.bql_lock)(b"esp32-ide\0".as_ptr() as *const c_char, line!() as c_int);
            (dll.set_apin)(chn as c_int, value as c_int);
            (dll.bql_unlock)();
        }
        Ok(())
    }

    /// 前端设置输入引脚（按键等）。
    pub fn write_pin(&self, pin: usize, value: i32) -> Result<PinState, SimError> {
        if !(1..=38).contains(&pin) {
            return Err(SimError::Init(format!("引脚号 {pin} 超出范围（1-38）")));
        }
        let dll = self.require_dll()?;
        let core = SIM_CORE.get().expect("SimCore must be initialized");
        // 引脚下拉由 QEMU 线程执行，跨线程调用必须持 BQL，否则电平变化不会被 vCPU 观察到
        unsafe {
            (dll.bql_lock)(b"esp32-ide\0".as_ptr() as *const c_char, line!() as c_int);
            (dll.set_pin)(pin as c_int, value);
            (dll.bql_unlock)();
        }
        let st = {
            let mut t = core.pins.lock().unwrap();
            t.set_input(pin, value).expect("validated pin")
        };
        core.bus.emit("gpio-update", serde_json::to_value(st).unwrap_or(serde_json::Value::Null));
        Ok(st)
    }

    /// 向串口发送数据（前端终端输入）。
    pub fn uart_send(&self, id: u8, data: &[u8]) -> Result<(), SimError> {
        let dll = self.require_dll()?;
        unsafe {
            (dll.uart_receive)(id as c_int, data.as_ptr(), data.len() as c_int);
        }
        Ok(())
    }

    pub fn pin_states(&self) -> Vec<PinState> {
        let core = SIM_CORE.get().expect("SimCore must be initialized");
        core.pins.lock().unwrap().snapshot()
    }

    /// 增量读取串口输出（前端轮询兜底，与事件并行不冲突）。
    pub fn poll_uart(&self) -> Vec<u8> {
        let core = SIM_CORE.get().expect("SimCore must be initialized");
        core.flush_uart_if_due();
        let (buf, flushed) = {
            let u = core.uart.lock().unwrap();
            let mut f = core.uart_flushed.lock().unwrap();
            if u.len() > *f {
                let b = u[*f..].to_vec();
                *f = u.len();
                (b, *f)
            } else {
                (Vec::new(), *f)
            }
        };
        let _ = flushed;
        buf
    }

    pub fn status(&self) -> SimStatus {
        let core = SIM_CORE.get().expect("SimCore must be initialized");
        *core.status.lock().unwrap()
    }
}

/// 在 QEMU 线程内执行初始化与主循环（与 PICSimLab EvThreadRun 流程一致）。
fn run_qemu(dll: Arc<QemuDll>, fw_dir: String, flash: String, efuse: String, core: Arc<SimCore>) {
    let callbacks = Callbacks {
        write_pin: Some(cb_write_pin),
        dir_pin: Some(cb_dir_pin),
        i2c_event: None,
        spi_event: None,
        uart_tx_event: Some(cb_uart_tx),
        pinmap: DEVKITC_PINMAP.as_ptr(),
        rmt_event: None,
    };

    // ---- argv 构造（与 PICSimLab bsim_qemu.cc 的 ESP32 分支一致） ----
    let args: Vec<String> = vec![
        "qemu-system-xtensa".into(),
        "-M".into(),
        "esp32-picsimlab".into(),
        "-L".into(),
        fw_dir,
        "-drive".into(),
        format!("file={flash},if=mtd,format=raw"),
        "-drive".into(),
        format!("file={efuse},if=none,format=raw,id=efuse"),
        "-global".into(),
        "driver=nvram.esp32.efuse,property=drive,value=efuse".into(),
        "-serial".into(),
        "none".into(),
    ];

    let cstrings: Vec<CString> = match args.iter().map(|a| CString::new(a.as_str())).collect() {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut argv: Vec<*mut c_char> = cstrings.iter().map(|cs| cs.as_ptr() as *mut c_char).collect();

    unsafe {
        // 供输入同步回调使用：把外部引脚电平重新推回模型
        let _ = SET_PIN_FN.set(dll.set_pin);
        (dll.register_callbacks)(&callbacks as *const Callbacks as *mut c_void);
        (dll.qemu_init)(argv.len() as c_int, argv.as_mut_ptr(), std::ptr::null());
    }

    {
        let mut st = core.status.lock().unwrap();
        *st = SimStatus::Running;
    }
    core.bus.emit("sim-status", serde_json::to_value(SimStatus::Running).unwrap_or(serde_json::Value::Null));

    // 通知 start() 等待方
    {
        let (started, cv) = started_flag();
        let mut st = started.lock().unwrap();
        *st = true;
        cv.notify_all();
    }

    core.flush_uart_if_due();

    unsafe {
        (dll.qemu_main_loop)();
        (dll.qemu_cleanup)();
    }

    {
        let mut st = core.status.lock().unwrap();
        *st = SimStatus::Stopped;
    }
    core.bus.emit("sim-status", serde_json::to_value(SimStatus::Stopped).unwrap_or(serde_json::Value::Null));
}

// run_qemu 内部使用的启动信号（与 SimEngine 的 started 共享，避免跨结构借用）
static SIM_ENGINE_STARTED: OnceLock<Mutex<bool>> = OnceLock::new();
static SIM_ENGINE_CV: OnceLock<Condvar> = OnceLock::new();

fn started_flag() -> (&'static Mutex<bool>, &'static Condvar) {
    let m = SIM_ENGINE_STARTED.get_or_init(|| Mutex::new(false));
    let c = SIM_ENGINE_CV.get_or_init(Condvar::new);
    (m, c)
}

/// 确保 efuse 文件存在（124 字节，固定测试 MAC）。
fn ensure_efuse(flash_path: &Path) -> Result<PathBuf, SimError> {
    let efuse = flash_path.with_extension("efuse");
    if efuse.is_file() {
        return Ok(efuse);
    }
    let mut mac: [u8; 6] = [0x02, 0x00, 0x00, 0x12, 0x34, 0x56];
    mac[0] &= 0xFE; // 本地管理地址
    let mut crc: u8 = 0;
    for b in &mac {
        crc ^= b;
        for _ in 0..8 {
            crc = if crc & 0x01 != 0 { (crc >> 1) ^ 0x8C } else { crc >> 1 };
        }
    }
    let mut efuse_data = [0u8; EFUSE_SIZE];
    efuse_data[13] = 0x80; // chip revision bits
    efuse_data[22] = 0x10;
    efuse_data[4] = mac[5];
    efuse_data[5] = mac[4];
    efuse_data[6] = mac[3];
    efuse_data[7] = mac[2];
    efuse_data[8] = mac[1];
    efuse_data[9] = mac[0];
    efuse_data[10] = crc;
    std::fs::write(&efuse, efuse_data).map_err(|e| SimError::Io(format!("创建 efuse 失败: {e}")))?;
    Ok(efuse)
}

// ---- 供子进程（esp32-sim）使用 ----

/// 测试/自动化用：注入自定义 SimCore（无 Tauri 前端时使用）。
pub fn install_sim_core(core: Arc<SimCore>) -> Result<(), &'static str> {
    SIM_CORE.set(core).map_err(|_| "SimCore 已初始化")
}

/// 常见 DLL 查找位置：环境变量 → exe 同级 → 逐级回溯项目根 lib/qemu → cwd。
pub fn dll_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("ESP32_IDE_QEMU_DLL") {
        candidates.push(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("libqemu-xtensa.dll"));
        }
        // 回溯上层目录，找项目根下的 lib/qemu（开发目录：src-tauri/target/debug/...）
        let mut dir = exe.parent();
        for _ in 0..4 {
            if let Some(d) = dir {
                candidates.push(d.join("lib").join("qemu").join("libqemu-xtensa.dll"));
                dir = d.parent();
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("lib").join("qemu").join("libqemu-xtensa.dll"));
    }
    candidates
}

/// 自动查找 libqemu-xtensa.dll 的路径（不加载，仅定位）。
pub fn discover_dll() -> Option<PathBuf> {
    dll_candidates().into_iter().find(|c| c.is_file())
}
