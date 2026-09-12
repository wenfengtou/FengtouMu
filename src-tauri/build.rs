fn main() {
    // `bundle.resources` 里的 resources/esp32-sim.exe 由 scripts/build_release.ps1 生成
    // （cargo build --release --bins 之后复制过去）。tauri-build 在编译期就会校验该资源
    // 存在，缺失时报错信息不够直观，这里先给一句可执行的提示。
    // 想跳过打包资源直接跑 cargo check / cargo test 时，创建同名空文件占位即可。
    let resource = std::path::Path::new("resources/esp32-sim.exe");
    if !resource.is_file() {
        println!(
            "cargo:warning=缺少打包资源 resources/esp32-sim.exe：请先运行 scripts/build_release.ps1，\
             或执行 cargo build --release --bins 后把 target/release/esp32-sim.exe 复制到 src-tauri/resources/"
        );
    }

    tauri_build::build()
}
