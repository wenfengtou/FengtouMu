//! 引脚状态表的行为矩阵（B 层：PinTable 状态机，**不需要 QEMU DLL**，CI 可跑）。
//!
//! 覆盖：默认态、输出回调、输入驱动（按键/传感器）、方向变化、复位清空、外部驱动与
//! MCU 驱动的区分（forced_inputs）、引脚边界。矩阵编号见 `docs/仿真协议.md`。

use esp32_ide_lib::sim::pins::{PinTable, DIR_IN, DIR_OUT, PIN_BOOT, PIN_COUNT, PIN_LED};

#[test]
fn p01_default_state_all_input_zero() {
    let t = PinTable::default();
    assert_eq!(t.snapshot().len(), PIN_COUNT);
    let led = t.state_of(PIN_LED);
    assert_eq!(led.value, 0);
    assert_eq!(led.dir, DIR_IN);
    assert_eq!(led.gpio, 2, "板级 pin24 = GPIO2");
    assert_eq!(t.state_of(PIN_BOOT).gpio, 0, "板级 pin25 = GPIO0");
    assert!(t.forced_inputs().is_empty(), "默认没有任何外部驱动");
}

#[test]
fn p02_output_callback_records_direction_and_value() {
    let mut t = PinTable::default();
    let ev = t.on_output(PIN_LED as i32, 1).expect("首次变化应有事件");
    assert_eq!(ev.pin, PIN_LED);
    assert_eq!(ev.value, 1);
    assert_eq!(ev.dir, DIR_OUT);

    // 相同电平不再触发事件（去抖）
    assert!(t.on_output(PIN_LED as i32, 1).is_none(), "无变化不应触发事件");
    // 翻转触发
    assert!(t.on_output(PIN_LED as i32, 0).is_some());
}

#[test]
fn p03_external_input_drives_and_is_forced() {
    let mut t = PinTable::default();
    // 按键按下（BOOT 拉低）
    let ev = t.set_input(PIN_BOOT, 0).expect("应记录输入");
    assert_eq!(ev.pin, PIN_BOOT);
    assert_eq!(ev.value, 0);
    assert_eq!(ev.dir, DIR_IN);
    assert_eq!(t.forced_inputs(), vec![(PIN_BOOT, 0)], "外部驱动的引脚应进入重推列表");

    // 固件把它当输出接管后，不再作为外部输入推送
    t.on_output(PIN_BOOT as i32, 1);
    assert!(t.forced_inputs().is_empty(), "MCU 接管后应停止外部重推");
}

#[test]
fn p04_dir_callback_flips_direction() {
    let mut t = PinTable::default();
    t.on_dir(PIN_LED as i32, true);
    assert_eq!(t.state_of(PIN_LED).dir, DIR_OUT);
    t.on_dir(PIN_LED as i32, false);
    assert_eq!(t.state_of(PIN_LED).dir, DIR_IN);
}

#[test]
fn p05_reset_clears_everything() {
    let mut t = PinTable::default();
    t.on_output(PIN_LED as i32, 1);
    t.set_input(PIN_BOOT, 0);
    assert!(!t.forced_inputs().is_empty());
    t.reset();
    let s = t.snapshot();
    assert!(s.iter().all(|p| p.value == 0 && p.dir == DIR_IN), "复位后应全输入全低");
    assert!(t.forced_inputs().is_empty(), "复位应清空外部驱动");
}

#[test]
fn p06_pin_bounds_are_guarded() {
    let mut t = PinTable::default();
    assert!(t.on_output(0, 1).is_none(), "pin 0 越界");
    assert!(t.on_output((PIN_COUNT + 1) as i32, 1).is_none(), "pin 越界");
    assert!(t.set_input(0, 1).is_none());
    assert!(t.set_input(PIN_COUNT + 1, 1).is_none());
    t.on_dir(0, true); // 不应 panic
    t.on_dir(999, false);
}
