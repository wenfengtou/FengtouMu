# FengtouMu

**ESP32 离线仿真 IDE** —— Windows 桌面应用：写 Arduino 代码 → 一键编译 → 本地仿真运行，板卡 LED / 按键 / 串口实时可视化。全部离线，无需联网。

> 技术栈：Tauri 2（Rust 后端）+ React + TypeScript + Monaco Editor，仿真内核复用 PICSimLab 的 `libqemu-xtensa.dll`（QEMU 9.2.2，`esp32-picsimlab` 机型）。

## 特性

- **代码编辑**：Monaco 编辑器，Arduino 语法高亮，内置 LED 闪烁示例
- **一键编译**：封装 arduino-cli，编译前自动把编辑器内容同步到草图目录的 `.ino`（首次覆盖自动备份为 `.bak`），产出 QEMU 可用的 4MB 合并镜像（DIO / 40MHz）
- **本地仿真**：ESP32 DevKitC 板卡视图（38 引脚状态、板载 LED=GPIO2、BOOT 按键=GPIO0）、串口终端（UART0 收发）
- **电路图编辑**：SVG 画布放置元件、拖拽、连线，元件含 LED、电阻、按键、电位器；图纸以 Wokwi 兼容的 `diagram.json` 导入导出
- **工程文件**：`.fmp` 工程（源码 + 电路图 + 路径配置）可新建 / 打开 / 另存为，带最近工程列表与 30 秒自动保存（异常退出后可恢复）；支持导入导出 Wokwi 兼容 zip
- **环境自检**：一键清点 QEMU 动态库及依赖、固件目录、仿真子进程、arduino-cli、ESP32 核心、固件镜像、应用数据目录，缺什么就给出可执行的下一步
- **持续集成**：GitHub Actions 在 Windows 上跑前端构建 + 前端单元测试 + Rust 无 GUI 测试
- **独立子进程仿真**：每次运行为全新 `esp32-sim` 进程 —— 可反复运行；冷启动卡死自动重试；仿真异常不影响界面
- **自动化验证**：前端单元测试（Vitest）、无 GUI 集成测试、基于 WebView2 CDP 的 UI 自动化脚本

## 快速开始

前置：Node.js、Rust 工具链、MSYS2（仅编译 QEMU 时需要）、arduino-cli + ESP32 核心（编译固件时需要）。

```powershell
# 开发模式
npm install
npm run tauri dev

# 构建（exe + MSI/NSIS 安装包）
npm run build:release

# 验证
npm run test:unit        # 前端单元测试（网表/行为/图纸/工程文件）
npm run test:rust        # Rust 测试（自动跳过需本机 QEMU DLL 的用例，CI 同款）
npm run test:rust:local  # Rust 全量测试（含 DLL 用例，需先准备好 lib/qemu 与固件）
npm run test:ui          # UI 自动化（真实点击；8 条链路：板卡 LED / 电路图 LED / 按键 / 电位器 / 工程新建 / 环境自检 / 自动保存恢复 / 一键编译）
```

> `lib/qemu/`（`libqemu-xtensa.dll` 与 glib 等依赖、ROM/fw）体积大且可再生成，**未纳入版本库**。
> 首次运行前请按 [`docs/build-qemu-dll-windows.md`](docs/build-qemu-dll-windows.md) 编译，或从已有构建拷贝到该目录。
> 应用启动时会自动定位并加载该 DLL（也可用环境变量 `ESP32_IDE_QEMU_DLL` 指定）。
> 另外 `src-tauri/resources/esp32-sim.exe` 也是构建产物（`npm run build:release` 生成），
> `tauri.conf.json` 的 `bundle.resources` 在编译期就会校验它，因此在全新克隆里请先跑一次 `npm run build:release` 再执行 `cargo` 相关命令。

## 目录结构

```
FengtouMu/
├── .github/workflows/ci.yml # CI：前端构建/单测 + Rust 无 GUI 测试
├── src/                     # 前端（React + TS）
│   ├── components/          # 代码编辑器 / 板卡视图 / 串口终端 / 电路画布 / 工程工具条 / 环境自检面板
│   ├── circuit/             # 电路数据模型、元件目录、网表、行为计算、diagram.json 读写
│   ├── project/             # 工程文件格式与纯函数（可单测）
│   ├── state/               # 分域状态：界面 / 仿真 / 编辑 / 电路 / 工程 / 环境自检
│   ├── lib/api.ts           # Tauri 命令与事件封装
│   └── App.tsx
├── src-tauri/
│   ├── src/sim/             # 仿真：qemu_dll（FFI）/ engine（引擎）/ worker_host（子进程宿主）/ buildchain（编译链）
│   ├── src/project.rs       # 工程文件、偏好设置、Wokwi zip 互导
│   ├── src/envcheck.rs      # 环境自检检查项
│   ├── src/fsio.rs          # 文本文件读写命令
│   ├── src/bin/sim_worker.rs# 仿真子进程 esp32-sim
│   └── tests/               # 集成测试（project_io / envcheck 可在 CI 跑；sim_* 需本机 DLL）
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
- 电路图中的 LED 与电阻已实测可由固件驱动；按键按下时界面与注入链路正常，但固件以 `INPUT_PULLUP` 读取时低电平无法稳定保持（QEMU 模型侧限制），运行期"按键改变固件行为"待继续定位；电位器经 `cmd_set_apin` 注入 ADC 读数的链路已实测可用（现有 demo 固件未使用 ADC，故仅验证注入无报错）。
- 工程文件保存的是内容与路径配置；电路图里元件的绝对位置会一并存下，但元件之间暂无自动布局（新增元件按固定步进叠加）。
- 串口输出按波特率模拟、明显滞后：固件 setup 里的 `Serial.println` 可能要等 20–40 秒才出现在终端，属 QEMU 模型行为；仿真运行约 20 秒后固件可能偶发崩溃重启（模型侧问题，待定位）。
- CI 只跑不需要 QEMU 的用例：`sim_integration`、`button_injection`、`user_sketch_blink`、`buildchain::compiles_demo_sketch_locally` 需要本机 `lib/qemu`、固件镜像或 arduino-cli，已标记 `#[ignore]`，请用 `npm run test:rust:local` 在本地执行。

## 第三方组件与许可

- QEMU（`libqemu-xtensa.dll`）：GPL-2.0，来自 [lcgamboa/qemu](https://github.com/lcgamboa/qemu) 的 `picsimlab-esp32` 分支
- Monaco Editor、React、Tauri、`zip`（Rust crate，用于 Wokwi 工程 zip 互导）等按各自许可
- 电路图编辑器计划复用 [wokwi-elements](https://github.com/wokwi/wokwi-elements)（MIT）
