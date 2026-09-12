# ESP32 离线仿真 IDE 设计方案（正式版）

> 版本：v1.0（2026-09-06）
> 状态：设计阶段，待评审
> 前置资产：已验证可用的 `libqemu-xtensa.dll`（QEMU 9.2.2 picsimlab-esp32 分支编译产物，
> 编译与部署见 `docs/build-qemu-dll-windows.md`）
>
> 备注（2026-09-12）：项目目录已由 `esp32-ide` 重命名为 **`FengtouMu`**；
> 原 `myself\qemu\docs\esp32-qemu-notes\` 目录已删除，相关记录见本仓库 `docs/开发日志.md`
> 与 `docs/build-qemu-dll-windows.md`。

## 一、项目概述

### 1.1 目标

开发一款 **Windows 离线桌面 IDE**：

- 编写 Arduino 代码（面向 ESP32）

- 拖拽绘制电路图（Wokwi 风格）

- 一键编译 + 本地仿真运行，LED、按键等组件实时可视化

- **完全离线**：编译器、核心库、仿真器全部随应用打包，无需联网

### 1.2 已确认决策

| 决策项      | 结论                                                                              |
| -------- | ------------------------------------------------------------------------------- |
| 仿真引擎复用方式 | **新 IDE + 复用 DLL**（Rust 封装 `libqemu-xtensa.dll`，参考 PICSimLab `bsim_qemu.cc` 逻辑） |
| 桌面技术栈    | **Tauri（Rust 后端 + Web 前端）**                                                     |
| 目标用户     | **学生教学用**（中文界面、示例库、引导式体验）                                                       |
| 芯片范围     | **仅 ESP32**（esp32-picsimlab 机型 + DevKitC）                                       |
| 电路图编辑器   | **自研画布（SVG）+ 复用 wokwi-elements**（MIT，可离线打包），格式对齐 Wokwi `diagram.json`           |

### 1.3 核心价值

仿真链路已全部验证：固件 → QEMU 执行 → GPIO 回调 → 组件可视化（LED 闪烁、按键控制均实测通过）。
本项目**不需要从零造仿真轮子**，重点在 IDE 体验与电路图编辑器。

## 二、总体架构

```
┌─────────────────────────────────────────────────┐
│              Windows 桌面应用（Tauri）             │
│  ┌─────────────┐  ┌─────────────────────────┐   │
│  │ 代码编辑器    │  │  电路图编辑器（Wokwi式）   │   │
│  │ Monaco      │  │  SVG 拖拽 + 连线         │   │
│  └──────┬──────┘  └───────────┬─────────────┘   │
│  ┌──────┴─────────────────────┴─────────────┐   │
│  │       工程管理 + diagram.json 数据模型     │   │
│  └──────┬──────────────────────────────────┘   │
└─────────┼──────────────────────────────────────┘
          │ IPC（Tauri Command / WebSocket）
┌─────────┴──────────────────────────────────────┐
│            仿真引擎服务（Rust 进程内线程）        │
│  ┌─────────────────────────────────────────┐   │
│  │  电路仿真层：组件模型 + 网表 + 时序推进    │   │
│  └──────────────┬──────────────────────────┘   │
│                 │ GPIO 回调                    │
│  ┌──────────────┴──────────────────────────┐   │
│  │  QEMU 封装层：加载 libqemu-xtensa.dll    │   │
│  └─────────────────────────────────────────┘   │
└──────────────┬─────────────────────────────────┘
               │ flash 镜像
┌──────────────┴─────────────────────────────────┐
│        离线工具链（随应用打包）                   │
│  arduino-cli + xtensa-esp32-elf +              │
│  Arduino-ESP32 core(3.3.10-cn) + ROM/keymaps   │
└─────────────────────────────────────────────────┘
```

## 三、技术选型

| 层      | 选型                           | 说明                                      |
| ------ | ---------------------------- | --------------------------------------- |
| 桌面壳    | **Tauri 2.x**                | 体积小（\~10MB）、Rust 直接 FFI 调 DLL           |
| 前端框架   | React + TypeScript           | 生态成熟，Monaco 集成方便                        |
| 代码编辑器  | Monaco Editor                | VS Code 同款，Arduino 语法高亮                 |
| 电路图编辑器 | 自研画布（SVG）+ 复用 wokwi-elements | 组件复用开源元素（MIT），格式对齐 Wokwi `diagram.json` |
| DLL 封装 | Rust `libloading` + FFI      | `#[repr(C)]` 回调结构体                      |
| 编译链    | arduino-cli（离线打包）            | 复用已有 3.3.10-cn 环境                       |

## 四、项目结构

```
esp32-ide/
├── src/                      # Rust 后端（Tauri）
│   ├── main.rs               # Tauri 入口
│   ├── qemu/
│   │   ├── dll.rs            # DLL 加载 + 符号解析（libloading）
│   │   ├── engine.rs         # qemu_init + qemu_main_loop 线程管理
│   │   └── callbacks.rs      # GPIO/UART 回调注册与转发
│   ├── circuit/
│   │   ├── netlist.rs        # diagram.json → 网表 → GPIO 映射
│   │   ├── components/       # led.rs / button.rs / resistor.rs / pot.rs
│   │   └── sim.rs            # 时序推进（Run_CPU_ns 模式）
│   ├── build/compiler.rs     # arduino-cli 封装 + flash 合并 + 0xFF 填充
│   └── server.rs             # 前端命令（start/stop/pin-state/serial）
├── ui/                       # Web 前端（React + TS）
│   ├── editor/               # Monaco 代码编辑器
│   ├── schematic/            # Canvas 电路图编辑器
│   ├── debug/                # 虚拟终端 / 串口监视器
│   └── components/           # 组件库面板（拖拽源）
├── toolchain/                # 离线打包资源
│   ├── arduino-cli.exe
│   ├── xtensa-esp32-elf/     # 交叉编译器
│   ├── cores/esp32/          # Arduino-ESP32 3.3.10-cn
│   ├── qemu/                 # libqemu-xtensa.dll + ROM + keymaps
│   └── fw/                   # 板载引导镜像
└── examples/                 # 教学示例库
```

## 五、数据模型（diagram.json，对齐 Wokwi）

电路图采用 Wokwi 的 parts + connections 结构，学生可无缝迁移到 Wokwi 在线版：

```json
{
  "version": 1,
  "parts": [
    { "type": "esp32-devkitc", "id": "esp", "top": 0, "left": 0 },
    { "type": "led", "id": "led1", "top": 140, "left": 120, "attrs": { "color": "red" } },
    { "type": "resistor", "id": "r1", "top": 80, "left": 120, "attrs": { "value": "220" } }
  ],
  "connections": [
    ["esp:GPIO2", "r1:a", "green", []],
    ["r1:b", "led1:a", "black", []],
    ["led1:c", "esp:GND", "black", []]
  ]
}
```

**核心转换**：`connections → 网表 → esp:GPIO2 直接映射 QEMU GPIO 号`。
电路仿真层只需监听"GPIO2 变高/变低"，驱动 LED 组件亮灭；按键按下时调用
`qemu_picsimlab_set_pin` 注入电平。

## 六、仿真引擎设计（核心）

### 6.1 DLL 符号表（已实测导出）

以下符号经 `objdump -p` 在部署版 DLL 中逐项确认：

```rust
// Rust FFI 声明（#[repr(C)]）
qemu_init(argc: i32, argv: *mut *mut c_char, envp: *const *const c_char)
qemu_main_loop()
qemu_cleanup()
qemu_picsimlab_register_callbacks(cb: *mut Callbacks)
qemu_picsimlab_set_pin(pin: i32, value: i32)
qemu_picsimlab_set_apin(chn: i32, value: i32)
qemu_picsimlab_uart_receive(id: i32, buf: *const u8, size: i32)
qemu_clock_get_ns(clock_type: i32) -> i64
timer_init_full / timer_mod_ns
qmp_cont() / qmp_stop() / qmp_system_reset() / qmp_quit()
qemu_mutex_lock_iothread_impl / qemu_mutex_unlock_iothread   // 兼容别名（已入库）
```

### 6.2 回调结构（对应 C 的 callbacks\_t）

```rust
#[repr(C)]
struct Callbacks {
    picsimlab_write_pin: Option<extern "C" fn(pin: i32, value: i32)>,
    picsimlab_dir_pin:   Option<extern "C" fn(pin: i32, value: i32)>,
    picsimlab_i2c_event: Option<extern "C" fn(id: u8, addr: u8, event: u16) -> i32>,
    picsimlab_spi_event: Option<extern "C" fn(id: u8, event: u16) -> u8>,
    picsimlab_uart_tx_event: Option<extern "C" fn(id: u8, value: u8)>,  // 串口 → 虚拟终端
    pinmap: *const i16,
    picsimlab_rmt_event: Option<extern "C" fn(channel: u8, config0: u32, value: u32)>,
}
```

### 6.3 线程模型

| 线程 | 职责                             | 关键点                            |
| -- | ------------------------------ | ------------------------------ |
| A  | `qemu_init` + `qemu_main_loop` | 持有 BQL，执行固件                    |
| B  | 仿真主循环（定时器驱动）                   | 注入 `set_pin` 输入、读取 GPIO 更新 LED |
| C  | Tauri 命令 / WebSocket           | 前端 ↔ 引擎通信（启停、引脚状态、串口数据）        |

线程 A 的 `qemu_init` 返回后置 `qemu_started` 标志，线程 B 再开始推进（严格照搬
PICSimLab `bsim_qemu.cc` 的 `while(!qemu_started)` 等待模式，避免竞态）。

### 6.4 QEMU 启动参数（已验证）

```
-M esp32-picsimlab
-drive file=flash_4mb.bin,if=mtd,format=raw
-nic user,model=esp32_wifi,net=192.168.4.0/24   # WiFi 仿真（对配套固件）
-display none                                    # 避免 keymap 依赖
```

### 6.5 时序推进

复用 PICSimLab 的 `GotoNow` + `Run_CPU_ns` 节流模式：
以 `qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL)` 为基准计算增量，限制单步推进不超过
`TTIMEOUT * 1.1`，防止仿真速度失控，保证界面组件更新与虚拟时钟同步。

## 七、前端设计（教学友好）

### 7.1 界面布局

```
┌─────────┬──────────────────────┬─────────────────┐
│ 文件树   │  代码编辑器 (Monaco)  │  实时仿真面板     │
│ + 组件库 │  或 电路图 (SVG)    │  - LED/按键可视化 │
│         │                      │  - 串口输出      │
├─────────┴──────────────────────┴─────────────────┤
│ 工具栏: [编译] [运行] [暂停] [重置]  状态: ● 运行中  │
└───────────────────────────────────────────────────┘
```

- **双视图**：代码 / 电路图 tab 切换，学生看着电路图改代码

- **组件库面板**：拖拽 LED、按键、电阻、电位器到画布，连线即生效

- **中文一切**：错误信息、组件名、示例库全部中文

### 7.2 教学特性

- 内置示例库（LED 闪烁 → 按键控制 → 呼吸灯 → 串口打印，逐步进阶）

- 编译错误中文化提示（映射 arduino-cli 输出）

- 一键重置仿真，便于课堂演示重复实验

### 7.3 电路图编辑器：混合路线（自研画布 + 复用 wokwi-elements）

**前提澄清**：Wokwi 官方开源的并非 wokwi.com 的编辑器本体（拖拽画布、连线交互均闭源），
而是三部分：`wokwi-elements`（组件 Web Components，MIT 许可）、`wokwi-docs`（diagram.json 格式规范）、
`wokwi-schematic`（原理图 SVG 渲染库）。因此**编辑器画布无论如何都要自研**，区别只在"组件层"。

**决策**：画布自研（SVG），组件复用 wokwi-elements，格式对齐 diagram.json。

**关键事实**：wokwi-elements 官方声明只提供硬件的外观展示，不提供功能仿真——仿真行为由宿主模拟器驱动。
因此**复用与否都不影响 QEMU 仿真引擎的工作量**，省下的是组件视觉绘制与教学迁移成本。

**集成机制**：

```
QEMU GPIO 输出 → Rust 引擎 → WebSocket → 前端 JS 设置元素属性（如 led.value=1）
按键按下       → 元素事件（buttonpress）→ set_pin 注入 QEMU
```

**选 SVG 而非 Canvas**：电路图"元件少（几十个）、交互多（拖拽/连线/命中检测）"，
SVG 每个元件即 DOM 节点，事件绑定与缩放天然支持；Canvas 优势在大量图形重绘，电路图用不上。

**边界情况**：wokwi-elements 缺失的器件（如需定制的 ESP32 板卡元素）自研补充，格式与 elements
一致即可混用；上游更新通过锁定版本打包规避。

## 八、编译链设计

### 8.1 编译流程

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32 -e <sketch>
```

产物 4 个 bin 按固定偏移合并，**填充 0xFF 到 4MB**（QEMU 兼容性要求）：

| 偏移      | 文件             |
| ------- | -------------- |
| 0x1000  | bootloader.bin |
| 0x8000  | partitions.bin |
| 0xe000  | boot\_app0.bin |
| 0x10000 | app.bin        |

### 8.2 离线打包

`toolchain/` 随安装包分发，运行时无需联网：

- arduino-cli + `xtensa-esp32-elf` 工具链 + Arduino-ESP32 core（3.3.10-cn）

- `libqemu-xtensa.dll`、`esp32-v3-rom.bin`、`esp32-v3-rom-app.bin`

- `keymaps/en-us`（qemu\_init 显示初始化需要）

- 首次使用即完成"安装"（目录解压），无需用户配置环境变量

## 九、里程碑

| 阶段         | 任务                                                                     | 验证标准                   |
| ---------- | ---------------------------------------------------------------------- | ---------------------- |
| **M1 MVP** | Tauri 骨架；Monaco 编辑器；Rust DLL 封装层（加载/符号/回调）；编译链封装；固定板卡视图（LED + BOOT 按键） | 编译闪烁程序 → 界面 LED 闪烁     |
| **M2 电路图** | Canvas 画布 + 拖拽 + 连线；diagram.json 解析/导出；网表→GPIO；LED/电阻/按键/电位器组件模型       | 拖 LED 接 GPIO2 能亮，按键能控制 |
| **M3 完善**  | 虚拟终端；更多组件（蜂鸣器/LCD1602/舵机）；WiFi 仿真；简单示波器                                | 串口打印、传感器交互             |
| **M4 教学**  | 中文示例库；引导教程；一键导出/分享                                                     | 学生独立完成"按键控制 LED"作业     |

## 十、风险与对策

| 风险                  | 等级 | 对策                                                  |
| ------------------- | -- | --------------------------------------------------- |
| DLL ABI/符号不匹配       | 低  | 符号表已实测确认（附录），FFI 声明以实测为准                            |
| BQL 线程死锁            | 中  | 严格照搬 bsim\_qemu.cc 的锁调用时序与等待模式                      |
| 仿真速度失控              | 中  | 复用 GotoNow + Run\_CPU\_ns 节流                        |
| 学生误操作崩溃             | 中  | Rust 线程 panic 隔离；仿真核心独立线程，UI 线程不受影响                 |
| 组件模型工作量大            | 高  | 复用 wokwi-elements（MIT）覆盖常见元件，缺失时自研补充；M2 先验证 4 个核心组件 |
| wokwi-elements 上游变更 | 低  | 锁定版本随应用打包；组件行为由本引擎驱动，不依赖上游仿真逻辑                      |
| arduino-cli 离线首装失败  | 中  | 完整打包 toolchain + core，安装包内自校验                       |

## 十一、附录：已验证事实清单

1. `libqemu-xtensa.dll` 已编译部署，PICSimLab 加载成功（见 DLL 编译与部署记录）。
2. GPIO 演示固件实测：LED 闪烁、BOOT 按键控制正常（回调链路完整）。
3. 网络：`open_eth` + slirp 验证 HTTP 200；`esp32_wifi` 仅支持配套固件。
4. Windows 下 slirp 内置 DNS 不可靠，固件需手动指定公网 DNS（如 223.5.5.5）。
5. QEMU ROM 文件必须位于 `qemu-bundle\qemu\share\`（或等效 datadir）才能被找到。

