use serde::{Deserialize, Serialize};

/// ESP32 DevKitC 板级引脚表（与 PICSimLab board_DevKitC.cc 的 pinmap 一致）。
/// pinmap[0] = 引脚数量；pinmap[i] = 板级引脚 i 对应的 GPIO 号，-1 表示非 GPIO。
pub const DEVKITC_PINMAP: [i16; 39] = [
    38, -1, -1, 36, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, -1, 13, 9, 10, 11, -1, 6, 7, 8, 15, 2,
    0, 4, 16, 17, 5, 18, 19, -1, 21, 3, 1, 22, 23, -1,
];

pub const PIN_COUNT: usize = 38;
/// 板级 pin 24 = GPIO2（板上 LED）
pub const PIN_LED: usize = 24;
/// 板级 pin 25 = GPIO0（BOOT 按键）
pub const PIN_BOOT: usize = 25;

pub const DIR_IN: i32 = 0;
pub const DIR_OUT: i32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PinState {
    /// 板级引脚号（1-based，与 pinmap 索引一致）
    pub pin: usize,
    /// 对应 GPIO 号，-1 表示非 GPIO
    pub gpio: i16,
    /// 当前电平（0/1）
    pub value: i32,
    /// 方向（0=输入 1=输出）
    pub dir: i32,
}

/// 板级 GPIO 状态表。回调线程（QEMU）写入，UI 线程读取，需外部加锁。
#[derive(Debug)]
pub struct PinTable {
    values: [i32; PIN_COUNT + 1],
    dirs: [i32; PIN_COUNT + 1],
}

impl Default for PinTable {
    fn default() -> Self {
        Self {
            values: [0; PIN_COUNT + 1],
            dirs: [DIR_IN; PIN_COUNT + 1],
        }
    }
}

impl PinTable {
    /// 复位到初始状态（仿真重启时调用）。
    pub fn reset(&mut self) {
        for v in self.values.iter_mut() {
            *v = 0;
        }
        for d in self.dirs.iter_mut() {
            *d = DIR_IN;
        }
    }

    /// 记录 QEMU 输出回调（板级 pin，1-based）。返回 (pin, gpio, value, dir, 是否发生变化)。
    pub fn on_output(&mut self, pin: i32, value: i32) -> Option<PinState> {
        if !(1..=PIN_COUNT as i32).contains(&pin) {
            return None;
        }
        let p = pin as usize;
        let changed = self.values[p] != value || self.dirs[p] != DIR_OUT;
        self.values[p] = value;
        self.dirs[p] = DIR_OUT;
        changed.then(|| self.state_of(p))
    }

    /// 记录方向变化回调。
    pub fn on_dir(&mut self, pin: i32, is_out: bool) {
        if (1..=PIN_COUNT as i32).contains(&pin) {
            self.dirs[pin as usize] = if is_out { DIR_OUT } else { DIR_IN };
        }
    }

    /// 前端输入：设置输入引脚电平（通过 qemu_picsimlab_set_pin 写入 QEMU）。
    pub fn set_input(&mut self, pin: usize, value: i32) -> Option<PinState> {
        if !(1..=PIN_COUNT).contains(&pin) {
            return None;
        }
        self.values[pin] = value;
        self.dirs[pin] = DIR_IN;
        Some(self.state_of(pin))
    }

    pub fn state_of(&self, pin: usize) -> PinState {
        PinState {
            pin,
            gpio: DEVKITC_PINMAP[pin],
            value: self.values[pin],
            dir: self.dirs[pin],
        }
    }

    pub fn snapshot(&self) -> Vec<PinState> {
        (1..=PIN_COUNT).map(|p| self.state_of(p)).collect()
    }
}

/// 板级引脚号 → GPIO 号
pub fn pin_to_gpio(pin: usize) -> i16 {
    DEVKITC_PINMAP.get(pin).copied().unwrap_or(-1)
}
