//! libqemu-xtensa.dll 封装：加载、符号解析。
//! FFI 签名严格对齐 PICSimLab qemu.h / bsim_qemu.cc。

use libloading::Library;
use std::ffi::c_void;
use std::os::raw::{c_char, c_int, c_longlong, c_uint};

pub type QemuInitFn = unsafe extern "C" fn(c_int, *mut *mut c_char, *const *const c_char);
pub type QemuMainLoopFn = unsafe extern "C" fn();
pub type QemuCleanupFn = unsafe extern "C" fn();
pub type QmpFn = unsafe extern "C" fn(*mut *mut c_char);
pub type BqlLockFn = unsafe extern "C" fn(*const c_char, c_int);
pub type BqlUnlockFn = unsafe extern "C" fn();
pub type RegisterCallbacksFn = unsafe extern "C" fn(*mut c_void);
pub type SetPinFn = unsafe extern "C" fn(c_int, c_int);
pub type SetAPinFn = unsafe extern "C" fn(c_int, c_int);
pub type FlashDumpFn = unsafe extern "C" fn(c_longlong, *mut c_void, c_int) -> c_int;
pub type UartReceiveFn = unsafe extern "C" fn(c_int, *const u8, c_int);
pub type ClockGetNsFn = unsafe extern "C" fn(c_int) -> c_longlong;
pub type GetInternalsFn = unsafe extern "C" fn(c_int) -> *mut c_uint;
pub type GetTiocmFn = unsafe extern "C" fn() -> c_uint;

/// PICSimLab callbacks_t 结构体（qemu.h）——字段顺序与 C 侧严格一致。
#[repr(C)]
pub struct Callbacks {
    pub write_pin: Option<unsafe extern "C" fn(c_int, c_int)>,
    pub dir_pin: Option<unsafe extern "C" fn(c_int, c_int)>,
    pub i2c_event: Option<unsafe extern "C" fn(u8, u8, u16) -> c_int>,
    pub spi_event: Option<unsafe extern "C" fn(u8, u16) -> u8>,
    pub uart_tx_event: Option<unsafe extern "C" fn(u8, u8)>,
    pub pinmap: *const i16,
    pub rmt_event: Option<unsafe extern "C" fn(u8, u32, u32)>,
}

pub const QEMU_INTERNAL_STRAP: c_int = 0;
pub const QEMU_INTERNAL_UART0_BAUD: c_int = 7;

#[derive(Debug)]
pub enum SimError {
    Load(String),
    Symbol(String),
    AlreadyLoaded,
    NotLoaded,
    AlreadyRunning,
    NotRunning,
    Io(String),
    Init(String),
}

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SimError::Load(m) => write!(f, "DLL 加载失败: {m}"),
            SimError::Symbol(m) => write!(f, "DLL 缺少导出符号: {m}"),
            SimError::AlreadyLoaded => write!(f, "DLL 已加载"),
            SimError::NotLoaded => write!(f, "DLL 未加载，请先调用 load_dll"),
            SimError::AlreadyRunning => write!(f, "仿真已在运行"),
            SimError::NotRunning => write!(f, "仿真未在运行"),
            SimError::Io(m) => write!(f, "文件错误: {m}"),
            SimError::Init(m) => write!(f, "初始化错误: {m}"),
        }
    }
}

impl std::error::Error for SimError {}

impl From<libloading::Error> for SimError {
    fn from(e: libloading::Error) -> Self {
        SimError::Load(e.to_string())
    }
}

pub struct QemuDll {
    #[allow(dead_code)]
    lib: Library,
    pub qemu_init: QemuInitFn,
    pub qemu_main_loop: QemuMainLoopFn,
    pub qemu_cleanup: QemuCleanupFn,
    pub qmp_quit: QmpFn,
    pub qmp_stop: QmpFn,
    pub qmp_cont: QmpFn,
    pub qmp_system_reset: QmpFn,
    pub bql_lock: BqlLockFn,
    pub bql_unlock: BqlUnlockFn,
    pub register_callbacks: RegisterCallbacksFn,
    pub set_pin: SetPinFn,
    pub set_apin: SetAPinFn,
    pub flash_dump: FlashDumpFn,
    pub uart_receive: UartReceiveFn,
    pub clock_get_ns: ClockGetNsFn,
    pub get_internals: GetInternalsFn,
    pub get_tiocm: GetTiocmFn,
}

unsafe fn get_fn<T: Copy>(lib: &Library, name: &str) -> Result<T, SimError> {
    let mut key = name.as_bytes().to_vec();
    key.push(0); // libloading 要求 nul 结尾
    let sym = lib
        .get::<T>(&key)
        .map_err(|_| SimError::Symbol(name.to_string()))?;
    Ok(*sym)
}

impl QemuDll {
    pub fn load(path: &std::path::Path) -> Result<Self, SimError> {
        // libqemu-xtensa.dll 依赖 glib 等 DLL（与其同目录）。Windows 的 LoadLibrary
        // 默认不搜索"被加载模块所在目录"，这里先 SetDllDirectory 到 DLL 目录再加载，
        // 使 release/打包后的 exe 也能从 lib/qemu 目录解析依赖（加载后恢复 null）。
        let dll_dir: Vec<u16> = path
            .parent()
            .map(|p| {
                p.to_string_lossy()
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect()
            })
            .unwrap_or_default();
        unsafe { SetDllDirectoryW(dll_dir.as_ptr()) };

        let loaded = (|| {
            let lib = unsafe { Library::new(path) }.map_err(|e| {
                SimError::Load(format!("{} ({e})", path.display()))
            })?;
            unsafe {
                let qemu_init = get_fn(&lib, "qemu_init")?;
                let qemu_main_loop = get_fn(&lib, "qemu_main_loop")?;
                let qemu_cleanup = get_fn(&lib, "qemu_cleanup")?;
                let qmp_quit = get_fn(&lib, "qmp_quit")?;
                let qmp_stop = get_fn(&lib, "qmp_stop")?;
                let qmp_cont = get_fn(&lib, "qmp_cont")?;
                let qmp_system_reset = get_fn(&lib, "qmp_system_reset")?;
                let bql_lock = get_fn(&lib, "bql_lock_impl")?;
                let bql_unlock = get_fn(&lib, "bql_unlock")?;
                let register_callbacks = get_fn(&lib, "qemu_picsimlab_register_callbacks")?;
                let set_pin = get_fn(&lib, "qemu_picsimlab_set_pin")?;
                let set_apin = get_fn(&lib, "qemu_picsimlab_set_apin")?;
                let flash_dump = get_fn(&lib, "qemu_picsimlab_flash_dump")?;
                let uart_receive = get_fn(&lib, "qemu_picsimlab_uart_receive")?;
                let clock_get_ns = get_fn(&lib, "qemu_clock_get_ns")?;
                let get_internals = get_fn(&lib, "qemu_picsimlab_get_internals")?;
                let get_tiocm = get_fn(&lib, "qemu_picsimlab_get_TIOCM")?;

                Ok(Self {
                    lib,
                    qemu_init,
                    qemu_main_loop,
                    qemu_cleanup,
                    qmp_quit,
                    qmp_stop,
                    qmp_cont,
                    qmp_system_reset,
                    bql_lock,
                    bql_unlock,
                    register_callbacks,
                    set_pin,
                    set_apin,
                    flash_dump,
                    uart_receive,
                    clock_get_ns,
                    get_internals,
                    get_tiocm,
                })
            }
        })();

        // 恢复原始 DLL 搜索目录（传 null 即清除）
        unsafe { SetDllDirectoryW(std::ptr::null()) };
        loaded
    }
}

#[link(name = "kernel32")]
extern "system" {
    fn SetDllDirectoryW(lp_path_name: *const u16) -> i32;
}
