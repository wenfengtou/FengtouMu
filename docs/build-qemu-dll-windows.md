# libqemu-xtensa.dll 编译指南（Windows + MSYS2）

> 目标：从本仓库（`picsimlab-esp32` 分支）编译出 PICSimLab / 本 IDE 可直接 `LoadLibrary` 的
> `libqemu-xtensa.dll`。本文记录的是**实测可用**的参数组合。

## 0. 环境

- Windows + MSYS2（`D:\msys64`），使用 **MINGW64** 终端（不是 MSYS/UCRT64）
- 依赖包：`mingw-w64-x86_64-gcc`、`glib2`、`pixman`、`libslirp`、`libgcrypt`、`capstone`、`zstd`、`ncurses`、`meson`、`ninja`、`python`、`pkgconf`

## 1. 配置（关键：不要用 --enable-debug）

```bash
cd /d/work/Esp32Qume/wenfengtou/qemu
mkdir -p build-dll && cd build-dll
../configure --target-list=xtensa-softmmu \
             --enable-slirp --enable-gcrypt \
             --disable-werror --disable-pie --disable-docs --disable-plugins
```

> **务必不要加 `--enable-debug`**：它会带来 `optimization=0` + `debug_tcg/debug_mutex/debug_graph_lock=true`，
> 编译出的 DLL 运行异常（实测固件启动后抛 EXCCAUSE 崩溃、且大量冷启动卡死）。
> 可用 `build/meson-info/intro-buildoptions.json` 核对：应为 `optimization=2`、`debug_tcg=False`。

## 2. 编译 exe

```bash
ninja -j8 qemu-system-xtensa.exe
```

## 3. 保留链接响应文件（rsp）

ninja 正常构建后会删除 rsp，需要强制重链一次：

```bash
rm -f qemu-system-xtensa.exe
ninja -v -d keeprsp qemu-system-xtensa.exe     # 生成 qemu-system-xtensa.exe.rsp
```

## 4. 由 exe 响应文件重链为 DLL

原理：同一套对象与库，去掉 `main()` 所在对象，改用 `-shared` 链接。

```bash
cp -f qemu-system-xtensa.exe.rsp libqemu-xtensa.dll.rsp
sed -i 's# -o qemu-system-xtensa\.exe # -shared -o libqemu-xtensa.dll #' libqemu-xtensa.dll.rsp
sed -i 's#[^ ]*system_main\.c\.obj *##g' libqemu-xtensa.dll.rsp

cc -m64 -Wl,--export-all-symbols @libqemu-xtensa.dll.rsp
```

> **`-Wl,--export-all-symbols` 必须加**：MinGW 的 `-shared` 不会自动把所有全局符号写进 PE 导出表，
> 不加的话 Rust/PICSimLab 侧 `GetProcAddress("qemu_init")` 会失败（表现为 DLL 能加载但找不到符号）。

## 5. 校验

```bash
objdump -p libqemu-xtensa.dll > /tmp/objd.txt
for s in qemu_init qemu_main_loop qemu_cleanup qmp_quit qmp_stop qmp_cont qmp_system_reset \
         bql_lock_impl bql_unlock qemu_picsimlab_register_callbacks qemu_picsimlab_set_pin \
         qemu_picsimlab_set_apin qemu_picsimlab_flash_dump qemu_picsimlab_uart_receive \
         qemu_clock_get_ns qemu_picsimlab_get_internals qemu_picsimlab_get_TIOCM; do
  grep -qE "(^|[[:space:]])$s\$" /tmp/objd.txt && echo "OK $s" || echo "MISS $s"
done
```

产物大小约 68 MB。

## 6. 部署

- IDE：`<项目>/lib/qemu/libqemu-xtensa.dll`（与 glib 等依赖 DLL 同目录）
- PICSimLab：`PICSimLab/picsimlab_win64/lib/qemu/libqemu-xtensa.dll`

## 7. 功能验证

```bash
# 无 GUI 集成测试：DLL 加载 -> 仿真启动 -> GPIO 回调 -> LED 闪烁
cd src-tauri && cargo test --test sim_integration -- --nocapture

# UI 自动化：同一会话内连续两次 [运行 -> LED 闪烁 -> 停止]
npm run test:ui
```

> 说明：宿主负载高时 QEMU 冷启动存在偶发卡死（旧版 DLL 同样存在），应用内已实现"检测卡死 → 杀掉子进程重试"，
> 集成测试若正好碰上卡死可重跑；UI 自动化走重试链路，更接近真实使用。
