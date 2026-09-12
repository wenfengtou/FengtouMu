/** 应用级默认路径与文案 */

import type { SimStatus } from "./lib/api";

export const DEFAULT_FW = "D:\\work\\Esp32Qume\\FengtouMu\\lib\\qemu\\fw";
export const DEFAULT_SKETCH_DIR = "D:\\work\\Esp32Qume\\picsimlab_gpio_demo";
export const DEFAULT_OUT = "D:\\work\\Esp32Qume\\FengtouMu\\build_demo";
export const DEFAULT_FLASH = DEFAULT_OUT + "\\picsimlab_gpio_demo.ino.merged.bin";

export const STATUS_TEXT: Record<SimStatus, string> = {
  idle: "空闲",
  loading: "加载中…",
  running: "运行中",
  stopping: "停止中…",
  stopped: "已停止",
};

/** 串口终端保留的最大行数 */
export const UART_MAX_LINES = 500;
