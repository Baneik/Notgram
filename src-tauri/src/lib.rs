mod proxy;
mod storage;
mod telegram;

fn load_environment() {
    if let Ok(executable) = std::env::current_exe()
        && let Some(directory) = executable.parent()
    {
        dotenvy::from_path(directory.join(".env")).ok();
    }
    dotenvy::dotenv().ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_environment();
    tauri::Builder::default()
        .manage(telegram::TelegramRuntime::new())
        .invoke_handler(tauri::generate_handler![
            telegram::telegram_runtime_status,
            proxy::telegram_proxy_settings,
            proxy::telegram_save_proxy_settings,
            storage::telegram_storage_settings,
            storage::telegram_save_storage_settings,
            storage::telegram_save_downloaded_file,
            storage::telegram_read_snapshot_cache,
            storage::telegram_write_snapshot_cache,
            storage::telegram_clear_snapshot_cache,
            storage::telegram_account_state,
            storage::telegram_register_account,
            storage::telegram_select_account,
            storage::telegram_remove_account,
            telegram::telegram_start,
            telegram::telegram_send,
            telegram::telegram_shutdown,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Notgram");
}
