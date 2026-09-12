# FengtouMu

**ESP32 离线仿真 IDE** —— Windows 桌面应用：写 Arduino 代码 → 一键编译 → 本地仿真运行，板卡 LED / 按键 / 串口实时可视化。全部离线，无需联网。

> 技术栈：Tauri 2（Rust 后端）+ React + TypeScript + Monaco Editor，仿真内核复用 PICSimLab 的 `libqemu-xtensa.dll`（QEMU 9.2.2，`esp32-picsimlab` 机型）。

## 特性

- **代码编辑**：Monaco 编辑器，Arduino 语法高亮，内置 LED 闪烁示例
- **一键编译**：封装 arduino-cli，自动产出 QEMU 可用的 4MB 合并镜像（DIO / 40MHz）
- **本地仿真**：ESP32 DevKitC 板卡视图（38 引脚状态、板载 LED=GPIO2、BOOT 按键=GPIO0）、串口终端（UART0 收发）
- **独立子进程仿真**：每次运行为全新 `esp32-sim` 进程 —— 可反复运行；冷启动卡死自动重试；仿真异常不影响界面
- **自动化验证**：无 GUI 集成测试 + 基于 WebView2 CDP 的 UI 自动化脚本

## 快速开始

前置：Node.js、Rust 工具链、MSYS2（仅编译 QEMU 时需要）、arduino-cli + ESP32 核心（编译固件时需要）。

```powershell
# 开发模式
npm install
npm run tauri dev

# 构建（exe + MSI/NSIS 安装包）
npm run build:release

# 验证
cargo test --manifest-path src-tauri/Cargo.toml --test sim_integration -- --nocapture   # 无 GUI 全链路
npm run test:ui                                                                        # UI 自动化（真实点击）
```

> `lib/qemu/`（`libqemu-xtensa.dll` 与 glib 等依赖、ROM/fw）体积大且可再生成，**未纳入版本库**。
> 首次运行前请按 [`docs/build-qemu-dll-windows.md`](docs/build-qemu-dll-windows.md) 编译，或从已有构建拷贝到该目录。
> 应用启动时会自动定位并加载该 DLL（也可用环境变量 `ESP32_IDE_QEMU_DLL` 指定）。

## 目录结构

```
FengtouMu/
├── src/                     # 前端（React + TS）
│   ├── components/          # 代码编辑器 / 板卡视图 / 串口终端
│   ├── lib/api.ts           # Tauri 命令与事件封装
│   └── App.tsx
├── src-tauri/
│   ├── src/sim/             # 仿真：qemu_dll（FFI）/ engine（引擎）/ worker_host（子进程宿主）/ buildchain（编译链）
│   ├── src/bin/sim_worker.rs# 仿真子进程 esp32-sim
│   └── tests/               # 集成测试
├── scripts/                 # build_release.ps1 / ui_drive.mjs
└── docs/                    # 设计方案 / 开发日志 / DLL 编译指南
```

## 文档

- [设计方案 v1.0](docs/ESP32_离线仿真IDE_设计方案.md)
- [开发计划](docs/开发计划.md)
- [开发日志](docs/开发日志.md)
- [对比分析：circuit-muse 可借鉴之处](docs/对比分析-circuit-muse.md)
- [libqemu-xtensa.dll 编译指南（Windows + MSYS2）](docs/build-qemu-dll-windows.md)

## 已知限制

- 宿主负载高（远程桌面、录屏等占 CPU）时，QEMU 冷启动偶发卡死；应用会自动重试，仍失败可再次点击运行。
- 每次启动仿真为独立进程，停止后需重新运行（不支持仿真中途热重载）。
- 目前仅支持 ESP32（esp32-picsimlab 机型）+ DevKitC 板卡。

## 第三方组件与许可

- QEMU（`libqemu-xtensa.dll`）：GPL-2.0，来自 [lcgamboa/qemu](https://github.com/lcgamboa/qemu) 的 `picsimlab-esp32` 分支
- Monaco Editor、React、Tauri 等按各自许可
- 电路图编辑器计划复用 [wokwi-elements](https://github.com/wokwi/wokwi-elements)（MIT）
