// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn enviar_a_servidor(user: String, message: String, ip: String) {
    // Por ahora solo imprimimos en la consola de la terminal
    println!("[RED] De: {} | Msg: {} | Hacia: {}", user, message, ip);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![enviar_a_servidor])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}