mod desktop_lifecycle;
mod desktop_notification;
mod development;
mod proxy;
mod storage;
mod telegram;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    development::load_environment();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            desktop_lifecycle::show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            desktop_lifecycle::setup(app)
        })
        .on_window_event(desktop_lifecycle::handle_window_event)
        .manage(telegram::TelegramRuntime::new())
        .manage(telegram::media_stream::MediaStreamRegistry::default())
        .register_asynchronous_uri_scheme_protocol(
            "notgram-media",
            |context, request, responder| {
                telegram::media_stream::respond(context.app_handle().clone(), request, responder);
            },
        )
        .invoke_handler(tauri::generate_handler![
            desktop_notification::notgram_show_notification,
            telegram::telegram_runtime_status,
            proxy::telegram_proxy_settings,
            proxy::telegram_save_proxy_settings,
            storage::telegram_storage_settings,
            storage::telegram_save_storage_settings,
            storage::telegram_save_downloaded_file,
            storage::telegram_open_cached_file,
            storage::telegram_save_cached_file_as,
            storage::telegram_open_download_directory,
            storage::telegram_cache_usage,
            storage::telegram_clear_media_cache,
            storage::telegram_read_snapshot_cache,
            storage::telegram_write_snapshot_cache,
            storage::telegram_clear_snapshot_cache,
            storage::account::telegram_account_state,
            storage::account::telegram_register_account,
            storage::account::telegram_select_account,
            storage::account::telegram_remove_account,
            telegram::telegram_start,
            telegram::telegram_send,
            telegram::telegram_log_performance,
            telegram::telegram_register_media_stream,
            telegram::telegram_pick_and_send_file,
            telegram::telegram_shutdown,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Notgram");
}
