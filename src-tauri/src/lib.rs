// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

mod commands;
mod db;
mod error;
mod logging;
mod models;
mod monitor;
mod plugins;
mod settings;
mod sftp;
mod ssh;
mod state;
mod system;
mod tray;
mod update;
mod vault;
mod window;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            state::init(&handle)?;
            let theme = {
                use tauri::Manager;
                handle.state::<state::AppState>().settings().theme
            };
            window::apply_theme(&handle, &theme);
            tray::setup(&handle)?;
            window::install_close_handler(&handle);
            update::spawn_auto_check(&handle);
            tracing::info!(
                version = %handle.package_info().version,
                "Tunnelde started"
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_update,
            commands::settings_reset,
            commands::set_locale,
            commands::hosts_snapshot,
            commands::host_create,
            commands::host_update,
            commands::host_delete,
            commands::host_mark_used,
            commands::group_create,
            commands::group_update,
            commands::group_delete,
            commands::tabs_snapshot,
            commands::tabs_save,
            commands::system_stats,
            commands::update_state,
            commands::update_check,
            commands::update_install,
            commands::open_release_page,
            commands::open_log_dir,
            commands::open_external,
            commands::user_css_import,
            commands::user_css_export,
            commands::ssh_probe,
            commands::ssh_trust,
            commands::ssh_connect,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::ssh_sessions,
            commands::credential_save,
            commands::credential_forget,
            commands::credential_status,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_read_text,
            commands::sftp_write_text,
            commands::local_list,
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
            commands::history_record,
            commands::history_list,
            commands::history_delete,
            commands::history_clear,
            commands::known_hosts_list,
            commands::known_hosts_forget,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tunnelde");
}
