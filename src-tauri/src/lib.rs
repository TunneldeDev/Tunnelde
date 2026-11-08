mod commands;
mod db;
mod error;
mod logs;
mod models;
mod mounts;
mod network;
mod platform;
mod plugins;
mod preview;
mod settings;
mod settings_profiles;
mod ssh;
mod state;
mod storage;
mod update;
mod vault;

pub fn run() {
    use platform::{menu, tray, window};

    tauri::Builder::default()
        .manage(window::StartupWindow::default())
        .manage(platform::background::BackgroundWindow::default())
        .manage(preview::Registry::default())
        .register_asynchronous_uri_scheme_protocol("preview", |context, request, responder| {
            let app = context.app_handle().clone();
            let origin = if cfg!(dev) {
                "http://localhost:1420"
            } else if cfg!(target_os = "windows") {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .to_string();
            tauri::async_runtime::spawn(async move {
                use tauri::Manager;
                responder.respond(
                    preview::serve(&app.state::<preview::Registry>(), request, origin).await,
                );
            });
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            use tauri::Manager;
            if plugins::security::cli_restricted(args.iter()) {
                if let Some(state) = app.try_state::<state::AppState>() {
                    state.plugins.force_cli_restricted(app, &state.db);
                }
            }
            window::show_main(app);
        }))
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                window.state::<preview::Registry>().clear();
                platform::background::destroyed(window.app_handle());
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window::SAVED_STATE_FLAGS)
                .skip_initial_state("main")
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            state::init(&handle)?;
            window::restore_main_geometry(&handle);
            let (theme, title_bar_style, locale) = {
                use tauri::Manager;
                let state = handle.state::<state::AppState>();
                let settings = state.settings();
                (settings.theme, settings.title_bar_style, state.locale())
            };
            window::apply_theme(&handle, &theme);
            window::apply_title_bar_style(&handle, &title_bar_style)?;
            tray::setup(&handle)?;
            menu::apply(&handle, &locale)?;
            window::install_close_handler(&handle);
            window::configure_webview(&handle);
            update::spawn_auto_check(&handle);
            let cleanup_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                ssh::files::local_editor::on_start(&cleanup_app).await;
                ssh::files::durable::on_reconnect(&cleanup_app).await;
                ssh::files::remote_editor::on_reconnect(&cleanup_app).await;
            });
            tracing::info!(
                version = %handle.package_info().version,
                "Tunnelde started"
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::main_window_ready,
            platform::restart::app_restart,
            platform::background::main_window_snapshot,
            platform::background::main_window_suspend,
            mounts::plugin_mounts_action,
            ssh::files::durable::durable_transfer_list,
            ssh::files::remote_editor::editor_cleanup_list,
            ssh::files::remote_editor::editor_cleanup_retry,
            ssh::files::durable::durable_transfer_clear,
            ssh::files::durable::durable_transfer_pause,
            ssh::files::durable::durable_transfer_resume,
            ssh::files::bandwidth::transfer_set_speed_limit,
            ssh::forward::forwarding_list,
            ssh::forward::forwarding_save,
            ssh::forward::forwarding_remove,
            ssh::forward::forwarding_start,
            ssh::forward::forwarding_stop,
            network::connection_route_get,
            network::connection_route_save,
            network::proxy_password_save,
            network::proxy_test,
            network::diagnostics::proxy_test_quality,
            plugins::security::plugin_security_state,
            plugins::security::plugin_set_restricted,
            plugins::security::plugin_set_permissions,
            plugins::status_bar::plugin_status_bar_snapshot,
            plugins::status_bar::plugin_status_bar_execute,
            plugins::tab_bar::plugin_tab_bar_snapshot,
            plugins::tab_bar::plugin_tab_bar_execute,
            plugins::api::plugin_workspace_reply,
            plugins::api::plugin_workspace_authorize,
            commands::app_info,
            storage::storage_status,
            storage::storage_restart_pending,
            storage::storage_schedule,
            storage::storage_cancel,
            storage::storage_open,
            storage::storage_pick,
            commands::clipboard_read_text,
            commands::clipboard_write_text,
            commands::settings_get,
            commands::settings_update,
            commands::settings_reset,
            settings_profiles::settings_profiles_list,
            settings_profiles::settings_profile_save,
            settings_profiles::settings_profile_delete,
            settings_profiles::settings_file_import,
            settings_profiles::settings_file_export,
            commands::set_locale,
            commands::hosts_snapshot,
            commands::host_create,
            commands::host_update,
            commands::host_delete,
            commands::host_mark_used,
            commands::hosts_reorder,
            commands::group_create,
            commands::group_update,
            commands::group_delete,
            commands::tabs_snapshot,
            commands::tabs_save,
            commands::system_stats,
            commands::update_state,
            commands::update_check,
            commands::update_install,
            commands::update_history,
            commands::open_release_page,
            commands::open_log_dir,
            commands::open_latest_log,
            logs::logs_read,
            logs::logs_output_read,
            commands::open_local_path,
            commands::reveal_local_path,
            commands::open_external,
            commands::user_css_import,
            commands::user_css_export,
            commands::key_import,
            commands::key_pick,
            commands::ssh_probe,
            commands::ssh_test_connection,
            commands::ssh_cancel_test,
            commands::ssh_trust,
            commands::ssh_connect,
            commands::ssh_attach,
            commands::ssh_detach,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::ssh_install_key,
            commands::ssh_sessions,
            commands::credential_save,
            commands::credential_forget,
            commands::credential_status,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::fs_transfer,
            commands::local_create_file,
            commands::sftp_create_file,
            commands::local_read_text,
            commands::local_write_text,
            commands::sftp_read_text,
            commands::sftp_write_text,
            commands::sftp_copy,
            commands::local_copy,
            commands::local_list,
            commands::files_search,
            commands::files_search_cancel,
            commands::search_preview_local,
            preview::file_preview_open,
            preview::file_preview_close,
            commands::local_mkdir,
            commands::local_rename,
            commands::local_delete,
            commands::local_home,
            commands::transfer_cancel,
            commands::remote_stats,
            commands::remote_processes,
            commands::remote_kill,
            commands::plugins_list,
            commands::plugin_start,
            commands::plugin_stop,
            commands::plugin_run,
            commands::plugin_open_dir,
            commands::plugin_pick_folder,
            commands::plugin_pick_executable,
            commands::plugin_pick_archive,
            commands::app_open_data_dir,
            commands::plugin_render_view,
            commands::marketplace_install,
            commands::plugin_config,
            commands::plugin_sources_save,
            commands::plugin_source_test,
            commands::marketplace_catalogue,
            commands::marketplace_download,
            commands::plugin_download_cancel,
            commands::node_detect,
            commands::node_install,
            commands::node_set_path,
            commands::node_allow_system,
            commands::node_pick,
            commands::plugin_install,
            commands::plugin_inspect,
            commands::plugin_uninstall,
            commands::plugin_reload,
            commands::history_record,
            commands::history_list,
            commands::history_delete,
            commands::history_clear,
            commands::known_hosts_list,
            commands::known_hosts_forget,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tunnelde")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = &event
            {
                if platform::background::keep_alive(app) {
                    api.prevent_exit();
                }
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                // A closed main window is retained for its sessions and drafts.
                // Always restore it, including when it is merely minimized.
                window::show_main(app);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                if let Some(state) = app.try_state::<state::AppState>() {
                    state.forwards.stop_all();
                    tauri::async_runtime::block_on(async {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(5),
                            state.mounts.shutdown(),
                        )
                        .await;
                    });
                    if let Err(error) = state.plugins.mark_clean(&state.db) {
                        tracing::warn!(%error, "could not clear extension recovery marker");
                    }
                }
            }
        });
}
