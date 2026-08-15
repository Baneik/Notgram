mod context_menu_window;
mod desktop_lifecycle;
mod desktop_notification;
mod development;
mod diagnostics;
mod distribution;
mod external_links;
mod media_viewer_window;
mod proxy;
mod settings_window;
mod storage;
mod telegram;
mod video_window;
mod webview_security;
mod window_placement;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if distribution::run_release_probe_if_requested() {
        return;
    }
    development::load_environment();
    let context = tauri::generate_context!();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !desktop_lifecycle::arguments_include_startup(args) {
                desktop_lifecycle::show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            webview_security::setup(app)?;
            app.manage(diagnostics::setup(app.handle())?);
            window_placement::setup(app)?;
            if distribution::supports_native_updater() {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
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
            diagnostics::notgram_diagnostics_settings,
            diagnostics::notgram_export_diagnostics,
            diagnostics::notgram_set_crash_reporting_enabled,
            distribution::notgram_distribution_kind,
            desktop_lifecycle::notgram_desktop_settings,
            desktop_lifecycle::notgram_set_launch_on_startup,
            desktop_notification::notgram_show_notification,
            context_menu_window::notgram_close_context_menu_window,
            context_menu_window::notgram_open_context_menu_window,
            context_menu_window::notgram_resize_context_menu_window,
            external_links::notgram_open_external_url,
            settings_window::notgram_open_settings_window,
            media_viewer_window::notgram_close_media_viewer_window,
            media_viewer_window::notgram_open_media_viewer_window,
            video_window::notgram_close_video_window,
            video_window::notgram_open_video_window,
            telegram::telegram_runtime_status,
            proxy::telegram_proxy_settings,
            proxy::telegram_save_proxy_settings,
            storage::telegram_storage_settings,
            storage::telegram_save_storage_settings,
            storage::file_actions::telegram_save_downloaded_file,
            storage::file_actions::telegram_open_cached_file,
            storage::file_actions::telegram_save_cached_file_as,
            storage::file_actions::telegram_open_download_directory,
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
            telegram::telegram_log_performance_batch,
            telegram::telegram_read_performance_records,
            telegram::telegram_clear_performance_records,
            telegram::telegram_register_media_stream,
            telegram::telegram_update_media_stream,
            telegram::telegram_suspend_media_stream,
            telegram::telegram_media_stream_status,
            telegram::telegram_send_pasted_files,
            telegram::telegram_pick_and_send_file,
            telegram::telegram_pick_profile_photo,
            telegram::telegram_pick_chat_photo,
            telegram::telegram_shutdown,
        ])
        .run(context)
        .expect("failed to run Notgram");
}
