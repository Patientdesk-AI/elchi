//! Commands behind Eshlik's Duyu Pro status (see crate::elchi_pro).

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::elchi_pro::{ElchiPro, ElchiProStatus};
use crate::settings::{get_settings, write_settings};

#[tauri::command]
#[specta::specta]
pub fn get_elchi_pro_status(elchi: State<'_, Arc<ElchiPro>>) -> ElchiProStatus {
    elchi.status()
}

/// Re-checks the plan with the server (e.g. when the window gains focus).
#[tauri::command]
#[specta::specta]
pub async fn refresh_elchi_pro(elchi: State<'_, Arc<ElchiPro>>) -> Result<ElchiProStatus, String> {
    let elchi = elchi.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        elchi
            .refresh()
            .map(|_| elchi.status())
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the Eshlik Pro page in the browser and watches for the activation.
#[tauri::command]
#[specta::specta]
pub async fn open_elchi_upgrade(elchi: State<'_, Arc<ElchiPro>>) -> Result<(), String> {
    let elchi = elchi.inner().clone();
    tauri::async_runtime::spawn_blocking(move || elchi.open_upgrade().map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether to use Duyu Pro when the plan includes it.
#[tauri::command]
#[specta::specta]
pub fn set_elchi_use_pro(
    app: AppHandle,
    elchi: State<'_, Arc<ElchiPro>>,
    enabled: bool,
) -> ElchiProStatus {
    let mut settings = get_settings(&app);
    settings.elchi_use_pro = enabled;
    write_settings(&app, settings);
    let status = elchi.status();
    let _ = app.emit("elchi-pro-changed", status.clone());
    status
}

/// Whether dictated text goes to Eshlik's formatter before it is pasted.
#[tauri::command]
#[specta::specta]
pub fn set_elchi_format(
    app: AppHandle,
    elchi: State<'_, Arc<ElchiPro>>,
    enabled: bool,
) -> ElchiProStatus {
    let mut settings = get_settings(&app);
    settings.elchi_format = enabled;
    write_settings(&app, settings);
    let status = elchi.status();
    let _ = app.emit("elchi-pro-changed", status.clone());
    status
}
