//! 文本文件读写命令：用于电路图（diagram.json）等工程文件的导入导出。

use std::path::Path;

#[tauri::command]
pub fn cmd_read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取 {path} 失败: {e}"))
}

#[tauri::command]
pub fn cmd_write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(dir) = Path::new(&path).parent() {
        if !dir.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(dir);
        }
    }
    std::fs::write(&path, contents).map_err(|e| format!("写入 {path} 失败: {e}"))
}
