# 对比分析：circuit-muse 对 FengtouMu 的可借鉴之处

> 对比对象：`D:\work\Esp32Qume\circuit-muse`（上游 <https://github.com/meshackbahati/circuit-muse>，MIT，基于 Velxio 演进）
> 对比基准：本仓库 FengtouMu（ESP32 离线仿真 IDE，M1 已完成）
> 日期：2026-09-12

## 一、结论

circuit-muse 是一个成熟度明显更高的同类桌面产品：它把"代码编辑 → 编译 → 真实 CPU 仿真 → 电路搭建 → 模拟电路求解 → AI 辅助"串成了完整闭环，覆盖 8 类板卡与 150 多个元件。

对我们最有价值的三件事：**引脚/总线抽象层**（M2 电路图的底座）、**工程持久化与 Wokwi 兼容的导入导出**、**依赖自检与进度反馈的体验设计**。它的 Python 引擎服务与"首次使用在线下载 QEMU"两项与其"完全离线、开箱即用"的主张并不一致，与我们的目标冲突，不建议照搬实现方式，只借鉴其交互与命令面设计。

## 二、项目画像对比

| 维度 | circuit-muse | FengtouMu |
| --- | --- | --- |
| 定位 | 电路设计 + 代码 + 仿真 + AI 助手 | 代码 + 仿真（电路图待 M2） |
| 板卡范围 | 8 类：AVR、RP2040、ESP32 全系、STM32、树莓派 | 仅 ESP32 DevKitC |
| 仿真引擎 | JS 引擎（avr8js、rp2040js）+ QEMU 可执行文件（按架构下载）+ ngspice-WASM | QEMU 动态库（子进程加载，复用 PICSimLab 回调语义） |
| 电气仿真 | 支持：SPICE 模拟电路 + 数字混合求解、44+ 器件模型、示波器/电压表/信号源 | 暂无（仅数字 GPIO 与 UART） |
| 元件体系 | 150+ 元件，按无源/有源/输入/输出/传感器/显示/逻辑/通信分类 | 板卡视图预置 LED、BOOT 按键 |
| 前端 | React + Zustand 分域 store + i18n | React + 单 `App.tsx` 集中状态 + 中文硬编码 |
| 工程格式 | `.vlx` 原生、`.zip`（Wokwi 兼容）、`.fzz`（Fritzing）、`.json`；可导出 `.html` 分享报告；IndexedDB 自动保存 | 无工程文件，资源路径写死 |
| 编译链 | arduino-cli + ESP-IDF（sdkconfig 生成），由 Python 引擎调度 | arduino-cli（固定 `dio/40MHz/4MB`） |
| AI 能力 | 内置 Agent（Ollama/OpenAI/Anthropic/Gemini/OpenRouter）+ MCP Server | 无（仅有仓库内的 CDP 自动化脚本） |
| 测试 | `app/src/__tests__` 下 130+ 用例（协议级、求解器确定性、示例冒烟） | 1 个集成测试 + 1 个 UI 自动化脚本 |
| CI/CD | `ci.yml`（前端/引擎/Rust 三路）+ `release.yml`（多平台安装包） | 无 |

## 三、可借鉴项

### 3.1 近期优先（成本低、直接服务 M2）

**引脚与总线抽象层**

对方把 MCU 与外部世界的连接抽成独立一层：`app/src/simulation/PinManager.ts` 用监听器模型统一管理数字电平、PWM 占空比、模拟电压三类信号，并用 `outputPins` 集合区分"MCU 主动驱动"与"外部元件驱动"——这一点很关键，否则按键、电位器这类外部输入会被 MCU 的空闲电平钳死；同时提供 `hardResetPinStates()` 处理冷启动语义（复位时把曾经为高的引脚回调为低，让显示类元件重绘）。围绕它还有 `PinResolver`、`SignalRouter`、`Interconnect`、`I2CBusManager`、`SpiBus`、`busKernel`、`LogicFamilies`、`HD44780Decoder` 等模块。

我们目前只有一张板级引脚电平表（`src-tauri/src/sim/pins.rs`），没有"谁在驱动这根线"的概念，也没有总线抽象。M2 的"网表 → GPIO → 元件"管线正好需要这一层，建议先照此拆分。

**工程持久化与 Wokwi 兼容的导入导出**

对方 `app/src/services/projectService.ts` 与 `localProjectStore.ts` 定义了工程存取：自动保存到 IndexedDB，导入支持 Wokwi `.zip`（`diagram.json` + 代码）、Fritzing `.fzz`，导出支持 `.zip` 与可分享的 `.html` 报告。

我们的设计方案已经决定"格式对齐 Wokwi `diagram.json`"，可以直接沿用它的文件组织方式与导入导出交互，省去格式设计成本；导出 HTML 报告在教学场景还有额外价值（学生交作业、老师评阅）。

**依赖自检与进度反馈**

对方在 `src-tauri/src/commands/qemu.rs` 中为每种架构提供 `*_qemu_status` 与 `*_qemu_install` 命令，下载过程通过事件推送 `phase/progress/bytes_downloaded`，解压按 `tar` → 系统 `tar.exe` → `7z` 三级回退；构建期依赖由 `scripts/download-deps.sh` 统一获取；前端另有 `dependencyChecker` 做启动自检。

我们目前的短板是"必须手工准备 `lib/qemu`"，新用户容易卡住。可以借它的状态检查与进度事件设计，做一块"环境自检"面板：检查 DLL、fw、编译链是否就绪，缺失时给出明确指引（离线场景下指向本地拷贝或本文档的编译指南）。

**CI 流水线**

对方 `.github/workflows/ci.yml` 分三路验证：前端 `vite build`、Python 引擎启动并请求 `/health`、Rust 侧 `cargo check`（含 `target` 与 cargo 缓存）。我们仓库还没有任何 CI。先加一条 Windows 构建加测试的流水线即可，成本很低。

**协议级测试矩阵**

对方的测试按协议与场景切分：`i2c-esp32-real-firmware.test.ts`、`dual-esp32-uart.test.ts`、`spi-*`、`solver-determinism.test.ts`、`examples-*-smoke.test.ts` 等。这种"按交互协议建用例"的组织方式比按模块切分更能覆盖真实故障。

我们先建立 10 到 20 个关键用例（GPIO 闪烁、BOOT 按键、UART 收发、多引脚并发、示例固件冒烟），等 M2 元件模型落地后再按协议扩展。

**其余低成本项**

前端状态分层：对方按域拆成 `useSimulatorStore`、`useElectricalStore`、`useProjectStore`、`useOscilloscopeStore` 等；我们现在全部堆在 `App.tsx`，建议在 M2 动工前重构。

国际化：对方有 `app/src/i18n` 目录；我们中文硬编码，未来面向多语言教学环境时需要一层 `t()`。

串口批量节流：对方的 `store/serialBatcher.ts` 与我们引擎里的 UART flush 逻辑同源，可以互相对照，检查我们的批处理阈值与 UI 刷新节奏。

### 3.2 中期规划（价值高、工程量大）

ngspice-WASM 混合仿真与仪器。对方用 `ngspice-wasm` 做真实 SPICE 模拟，并与数字 MCU 混合求解，配套示波器、电压表、电流表、信号发生器。这是"LED 串联电阻""电位器调光""整流电路"这类课程的前提。对我们的难点在于引入 WASM 求解器与混合调度，属于独立工程，建议放在元件模型与数字仿真稳定之后，且先做数字化近似（分压近似）再考虑真 SPICE。

多板卡与多引擎。对方用统一桥接接口包住不同引擎（`Esp32Bridge`、`Stm32Bridge`、`RaspberryPi3Bridge`、`AVRSimulator`、`RP2040Simulator`）。我们短期仍应聚焦 ESP32，但可以先把"引擎接口"抽象出来，避免后续扩展时大改。

AI 助手与 MCP 工具化。对方把"编译、增删元件、连线、跑仿真"包装成 MCP 工具（`engine/app/mcp/server.py`、`engine/mcp_server.py`），并支持本地 Ollama 以保持离线。我们已有一支能驱动真实界面的 CDP 自动化脚本，把它升级成受控的工具层是自然的下一步，但要先有稳定的工程数据模型。

ESP-IDF 编译。对方除 arduino-cli 外还支持 ESP-IDF（`compile_chip.py`、`compile_rom.py`，含 sdkconfig 渲染与互斥项处理）。若教学涉及 ESP-IDF 或需要自定义分区表，可后续补齐。

### 3.3 不建议照搬

Python 引擎服务。对方要求用户具备 Python 3.12+，与我们"完全离线、零外部依赖"的目标不一致。其命令面（compile / flash / libraries / simulation / agent）与进度事件的设计值得借，但实现应留在 Rust 侧。

首次使用在线下载 QEMU。对方为节省安装体积，改为按需下载；我们的定位是离线可用，保留随包分发，只借其状态检查与进度反馈。

测试规模照搬。130 多个用例是长期积累的结果，直接照抄不现实，按协议维度逐步补齐更合理。

## 四、我们相对领先的部分

仿真进程模型。我们把 QEMU 放进独立子进程（`src-tauri/src/sim/worker_host.rs` + `src/bin/sim_worker.rs`），规避了 QEMU 动态库不可重复初始化、不可安全卸载导致的闪退，并实现了冷启动卡死自动重试。对方使用 QEMU 可执行文件进程，从代码中未见等价的重试与隔离机制。

回调语义对齐上游。我们直接复用 PICSimLab 的 GPIO/UART 回调定义，省去了对方那套自研引脚桥接的适配成本。

中文教学面向。对方以 i18n 覆盖多语言，我们的界面与文档是原生中文，面向课堂场景更直接。

## 五、一处交叉验证

对方 ESP-IDF 编译器的默认 `flashMode` 也是 `dio`（`engine/tests/test_espidf_options.py` 断言 `opts['flashMode'] == 'dio'`，同时支持显式切换 `qio`）。这与我们为 QEMU 兼容性确定的 `dio/40MHz` 参数一致，说明该选择并非特例。

## 六、借鉴顺序

第一阶段（M2 地基）：引脚与总线抽象层、前端状态分层。
第二阶段（工程化）：工程文件与 Wokwi 兼容导入导出、CI、协议级测试。
第三阶段（体验与进阶）：环境自检面板 → 更多元件与仪器 → AI/MCP 工具层 → 真 SPICE 混合仿真。

具体排期、验收标准与风险应对见 `docs/开发计划.md`。
