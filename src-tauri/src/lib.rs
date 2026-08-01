mod proxy;
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
            telegram::telegram_start,
            telegram::telegram_send,
            telegram::telegram_shutdown,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Notgram");
}
