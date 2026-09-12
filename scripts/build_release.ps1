# 构建 ESP32 离线仿真 IDE（release）
#   1) 编译两个二进制：esp32-ide（主程序）与 esp32-sim（仿真子进程）
#   2) 把 esp32-sim.exe 同步为打包资源（安装包会一并安装到 resources 目录）
#   3) 调用 tauri build 生成内嵌前端的 exe（以及 MSI/NSIS 安装包）
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build_release.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$srcTauri = Join-Path $root "src-tauri"

Write-Host "==> 1/3 编译 release 二进制（主程序 + 仿真子进程）"
Push-Location $srcTauri
cargo build --release --bins
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cargo build 失败" }

Write-Host "==> 2/3 同步仿真子进程到打包资源"
if (-not (Test-Path "resources")) { New-Item -ItemType Directory -Path "resources" | Out-Null }
Copy-Item "target\release\esp32-sim.exe" "resources\esp32-sim.exe" -Force
Pop-Location

Write-Host "==> 3/3 tauri build（内嵌前端 + 安装包）"
Push-Location $root
npm run tauri -- build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "tauri build 失败" }
Pop-Location

Write-Host "完成：src-tauri\target\release\esp32-ide.exe"
