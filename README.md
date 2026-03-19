# 💬 HyprChat (Tauri + Vanilla TS)

Una aplicación de chat moderna y fluida construida con **Tauri**, **TypeScript** (Vanilla) y un servidor backend en **Node.js**.

## ✨ Características y Cambios Recientes

- **Animaciones UI/UX**: Transiciones suaves al entrar a salas (`roomFadeIn`), al recibir nuevos mensajes (`msgSlideIn`) y en las transiciones de la pantalla de inicio de sesión.
- **Boot Screen Interactivo**: Pantalla de carga inicial con un estilo de terminal y un efecto *glitch* llamativo.
- **Temas y Personalización**: 
  - Paleta de colores basada en **Catppuccin**.
  - Selección de **fondos dinámicos** (Wallpapers) directamente desde la interfaz.
- **Notificaciones**: *Badges* visuales en la lista de salas para indicar mensajes no leídos.
- **Menú Contextual**: Posibilidad de interactuar con mensajes individuales de forma nativa (por ejemplo, para eliminarlos con un modal).
- **Backend Local**: Integración directa con `server.js` (SQLite) para guardar la base de datos de mensajes (`chat.db`).

## 🚀 Inicio Rápido

1. **Instalar dependencias**:
   ```bash
   npm install
   ```
2. **Iniciar el servidor local** (en una terminal):
   ```bash
   cd servidor-chat
   node server.js
   ```
3. **Ejecutar la App (Tauri)** (en otra terminal):
   ```bash
   npm run tauri dev
   ```

## 🛠️ Tecnologías

- **Frontend**: HTML5, CSS3, Vanilla TypeScript.
- **Backend/Servidor**: Node.js, Express/WebSockets, SQLite (`chat.db`).
- **Escritorio**: Tauri (Rust).
