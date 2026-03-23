// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Actualiza el badge del icono en el Dock (macOS) / Taskbar (Linux).
#[tauri::command]
fn set_app_badge(app: tauri::AppHandle, count: i32) {
    use tauri::Manager;
    eprintln!("[HyprChat] set_app_badge llamado con count={}", count);
    
    match app.get_webview_window("main") {
        Some(window) => {
            let label = if count <= 0 { None } else { Some(count.to_string()) };
            eprintln!("[HyprChat] Ventana 'main' encontrada, badge_label={:?}", label);
            
            #[cfg(target_os = "macos")]
            match window.set_badge_label(label.clone()) {
                Ok(_) => eprintln!("[HyprChat] Badge (label) actualizado correctamente (macOS)."),
                Err(e) => eprintln!("[HyprChat] Error al actualizar badge (label): {}", e),
            }

            #[cfg(not(target_os = "macos"))]
            match window.set_badge_count(if count <= 0 { None } else { Some(count as i64) }) {
                Ok(_) => eprintln!("[HyprChat] Badge (count) actualizado correctamente (Linux/Windows)."),
                Err(e) => eprintln!("[HyprChat] Error al actualizar badge (count): {}", e),
            }
        }
        None => {
            eprintln!("[HyprChat] ⚠️ No se encontró la ventana 'main'. Ventanas disponibles:");
            for (label, _) in app.webview_windows() {
                eprintln!("  - '{}'", label);
            }
        }
    }
}

/// Envía una notificación nativa del Sistema Operativo.
#[tauri::command]
fn send_os_notification(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    eprintln!("[HyprChat] Enviando notificación: {} | {}", title, body);
    if let Err(e) = app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
    {
        eprintln!("[HyprChat] Error al enviar notificación nativa: {}", e);
    } else {
        eprintln!("[HyprChat] Notificación enviada con éxito.");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, send_os_notification, set_app_badge])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
