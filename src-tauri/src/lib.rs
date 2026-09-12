pub mod envcheck;
pub mod fsio;
pub mod project;
pub mod sim;

use sim::worker_host::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sim::worker_host::cmd_load_dll,
            sim::worker_host::cmd_sim_start,
            sim::worker_host::cmd_sim_stop,
            sim::worker_host::cmd_sim_pause,
            sim::worker_host::cmd_sim_resume,
            sim::worker_host::cmd_pin_write,
            sim::worker_host::cmd_uart_send,
            sim::worker_host::cmd_set_apin,
            sim::worker_host::cmd_pin_states,
            sim::worker_host::cmd_uart_poll,
            sim::worker_host::cmd_sim_status,
            sim::worker_host::cmd_dll_loaded,
            sim::worker_host::cmd_auto_load_dll,
            sim::buildchain::cmd_compile,
            fsio::cmd_read_text_file,
            fsio::cmd_write_text_file,
            project::cmd_project_save,
            project::cmd_project_load,
            project::cmd_prefs_load,
            project::cmd_prefs_save,
            project::cmd_app_paths,
            project::cmd_import_wokwi_zip,
            project::cmd_export_wokwi_zip,
            envcheck::cmd_env_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
