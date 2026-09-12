//! `poll_uart` 与事件总线共享 UART 缓冲区的正确性（不需要 QEMU DLL，CI 可跑）。
//!
//! 背景：旧实现里 `flush_uart_if_due`（总线事件）与 `poll_uart`（轮询兜底）共用同一个
//! 消费游标。QEMU 按波特率逐字节回调（cb_uart_tx），一个 "LOW\r\n" 突发会跨多个 flush
//! 窗口 —— 先到的那部分被总线 flush 消费并推进游标，`poll_uart` 只能拿到剩余字节，
//! 表现为"每个串口突发的首字节丢失"（"BOOT pressed" → "OOT pressed"）。
//! 修复后 bus 与 poll 各自维护游标，互不抢占，任何一路都能拿到完整字节流。

use esp32_ide_lib::sim::engine::{install_sim_core, RecordingBus, SimCore, SimEngine};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn poll_uart_keeps_every_byte_across_flush_windows() {
    let core = SimCore::with_bus(Arc::new(RecordingBus::default()));
    install_sim_core(core.clone()).expect("SimCore 应未被占用");
    let engine = SimEngine::default();

    // 场景 1：'L' 先进（触发一次 flush），其余字节稍后到 ——
    // 旧实现里 'L' 会被总线 flush 吃掉，poll 只能拿到 "OW\r\n"。
    core.uart.lock().unwrap().extend_from_slice(b"L");
    std::thread::sleep(Duration::from_millis(12)); // 越过 flush 定时窗口（10ms）
    let first = engine.poll_uart(); // 触发 flush：总线拿到 "L"，poll 应同样拿到 "L"
    assert_eq!(first, b"L", "flush 消费后 poll 不应丢失首字节：{first:?}");

    core.uart.lock().unwrap().extend_from_slice(b"OW\r\n");
    std::thread::sleep(Duration::from_millis(12));
    let rest = engine.poll_uart();
    assert_eq!(rest, b"OW\r\n", "后续字节应完整到达 poll：{rest:?}");

    // 场景 2：多轮突发，全部字节应被 poll 无丢失地取回（不重不漏）
    let mut total = Vec::new();
    for i in 0..6u8 {
        let line = format!("LINE{i}\r\n").into_bytes();
        core.uart.lock().unwrap().extend_from_slice(&line);
        std::thread::sleep(Duration::from_millis(12));
        total.extend_from_slice(&engine.poll_uart());
    }
    assert_eq!(
        String::from_utf8_lossy(&total),
        "LINE0\r\nLINE1\r\nLINE2\r\nLINE3\r\nLINE4\r\nLINE5\r\n",
        "多轮突发字节应完整且有序"
    );

    // 场景 3：一次写入大量字节，poll 应取回与写入完全一致的完整流
    let blob: Vec<u8> = (0..200u16)
        .flat_map(|i| format!("{i:04},").into_bytes())
        .collect();
    core.uart.lock().unwrap().extend_from_slice(&blob);
    let mut got = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    while got.len() < blob.len() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(12));
        got.extend_from_slice(&engine.poll_uart());
    }
    assert_eq!(got, blob, "poll 应取回与写入完全一致的完整字节流（无丢失无重复）");

    // 场景 4：游标推进后已消费前缀应被裁剪，缓冲区不会无限增长
    assert!(
        core.uart.lock().unwrap().len() < 4096,
        "已消费前缀应被裁剪"
    );
}
