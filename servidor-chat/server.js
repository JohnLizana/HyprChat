const { WebSocketServer } = require('ws');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const readline = require('readline');

// Configuración Global
let db;
let allowRegistration = true; // Por defecto
let wss;

// Interfaz de consola
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'HyprChat> '
});

async function init() {
    // 1. Conexión a Base de Datos
    db = await open({ 
        filename: './chat.db', 
        driver: sqlite3.Database 
    });

    // 2. Tablas
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY, 
            password TEXT, 
            role TEXT DEFAULT 'user'
        );
        CREATE TABLE IF NOT EXISTS rooms (
            name TEXT PRIMARY KEY,
            password TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, user TEXT, text TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Ensure 'role' column exists for existing databases
    try {
        await db.run('ALTER TABLE users ADD COLUMN role TEXT DEFAULT "user"');
    } catch (e) {
        // Column probably already exists
    }

    // Ensure 'password' column exists in rooms for existing databases
    try {
        await db.run('ALTER TABLE rooms ADD COLUMN password TEXT');
    } catch (e) {
        // Column probably already exists
    }
    await db.run('INSERT OR IGNORE INTO rooms (name) VALUES (?), (?)', ['general', 'dev']);

    // 3. Iniciar Servidor WebSocket
    wss = new WebSocketServer({ port: 8080 });
    
    // --- LÓGICA DE WEBSOCKET (Tu chat normal) ---
    wss.on('connection', (ws) => {
        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data);

                // LOGIN / REGISTRO
                if (msg.type === 'login') {
                    let user = await db.get('SELECT * FROM users WHERE username = ?', [msg.user]);
                    
                    if (!user) {
                        if (allowRegistration) {
                            await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [msg.user, msg.password]);
                            user = { username: msg.user };
                            console.log(`\n[INFO] 🆕 Nuevo usuario registrado: ${msg.user}`);
                            rl.prompt();
                        } else {
                            ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Registro cerrado por Admin.' }));
                            return;
                        }
                    } else if (user.password !== msg.password) {
                        ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Password incorrecto.' }));
                        return;
                    }

                    // Éxito
                    ws.username = msg.user;
                    ws.role = user.role || 'user';
                    ws.send(JSON.stringify({ 
                        type: 'auth', 
                        status: 'success', 
                        role: ws.role 
                    }));
                    const rooms = await db.all('SELECT name, password FROM rooms');
                    ws.send(JSON.stringify({ type: 'rooms_list', rooms: rooms.map(r => ({ name: r.name, locked: !!r.password })) }));
                }
                
                // CHAT Y SALAS (Resumido para ahorrar espacio, funciona igual)
                else if (msg.type === 'create_room') {
                    if (ws.role !== 'admin') {
                        ws.send(JSON.stringify({ type: 'error', message: 'Solo los administradores pueden crear salas.' }));
                        return;
                    }
                    await db.run('INSERT OR IGNORE INTO rooms (name, password) VALUES (?, ?)', [msg.room, msg.password || null]);
                    broadcastAll({ type: 'room_created', room: msg.room, creator: ws.username, locked: !!(msg.password) });
                }
                else if (msg.type === 'join') {
                    try {
                        console.log(`[JOIN] Usuario ${ws.username} intenta unirse a: ${msg.room}`);
                        const roomInfo = await db.get('SELECT * FROM rooms WHERE name = ?', [msg.room]);
                        
                        if (roomInfo && roomInfo.password && msg.room !== 'general') {
                            console.log(`[JOIN] La sala ${msg.room} requiere contraseña.`);
                            if (msg.password !== roomInfo.password) {
                                console.log(`[JOIN] Contraseña incorrecta o ausente para ${msg.room}`);
                                ws.send(JSON.stringify({ 
                                    type: 'password_required', 
                                    room: msg.room, 
                                    message: msg.password ? 'Contraseña incorrecta.' : 'Esta sala requiere contraseña.' 
                                }));
                                return;
                            }
                            console.log(`[JOIN] Contraseña correcta para ${msg.room}`);
                        }

                        ws.room = msg.room;
                        console.log(`[JOIN] ${ws.username} se unió exitosamente a ${ws.room}`);
                        
                        const history = await db.all('SELECT * FROM (SELECT user, text, timestamp FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT 50) ORDER BY timestamp ASC', [ws.room]);                    
                        console.log(`[JOIN] Enviando historial para ${ws.room} (${history.length} mensajes)`);
                        ws.send(JSON.stringify({ type: 'history', data: history }));
                    } catch (err) {
                        console.error("[JOIN ERROR]", err);
                        ws.send(JSON.stringify({ type: 'error', message: 'Error al unirse a la sala.' }));
                    }
                }
                else if (msg.type === 'chat') {
                    const room = ws.room || msg.room;
                    const now = new Date().toISOString();
                    console.log(`[CHAT] Mensaje de ${ws.username || msg.user} en sala ${room}: ${msg.text.substring(0, 20)}...`);
                    
                    try {
                        await db.run('INSERT INTO messages (room, user, text, timestamp) VALUES (?, ?, ?, ?)', 
                            [room, msg.user, msg.text, now]);
                        
                        // Enviamos a TODOS los clientes con el campo room
                        // para que clientes en otras salas puedan mostrar notificaciones
                        broadcastAll({ 
                            type: 'chat', 
                            user: msg.user, 
                            text: msg.text, 
                            timestamp: now,
                            room: room
                        });
                    } catch (err) {
                        console.error("[CHAT ERROR]", err);
                        ws.send(JSON.stringify({ type: 'error', message: 'Error al enviar mensaje.' }));
                    }
                }
                else if (msg.type === 'load_more') {
                    try {
                        const room = msg.room || ws.room;
                        const before = msg.before; // timestamp ISO string
                        const older = await db.all(
                            'SELECT * FROM (SELECT user, text, timestamp FROM messages WHERE room = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 50) ORDER BY timestamp ASC',
                            [room, before]
                        );
                        ws.send(JSON.stringify({ type: 'older_messages', data: older, room: room }));
                    } catch (err) {
                        console.error("[LOAD_MORE ERROR]", err);
                    }
                }
                else if (msg.type === 'rename_room') {
                    if (ws.role !== 'admin') {
                        ws.send(JSON.stringify({ type: 'error', message: 'Solo los administradores pueden renombrar salas.' }));
                        return;
                    }
                    try {
                        // 1. Actualizar el nombre en la tabla de salas
                        await db.run('UPDATE rooms SET name = ? WHERE name = ?', [msg.newRoom, msg.oldRoom]);
                        
                        // 2. IMPORTANTE: Actualizar los mensajes para que pertenezcan al nuevo nombre de sala
                        await db.run('UPDATE messages SET room = ? WHERE room = ?', [msg.newRoom, msg.oldRoom]);

                        // 3. Avisar a todos que el nombre cambió
                        broadcastAll({ 
                            type: 'rooms_list', 
                            rooms: (await db.all('SELECT name, password FROM rooms')).map(r => ({ name: r.name, locked: !!r.password })) 
                        });
                    } catch (error) {
                        console.error("Error al renombrar sala:", error);
                    }
                }
                else if (msg.type === 'delete_room') {
                    if (ws.role !== 'admin') {
                        ws.send(JSON.stringify({ type: 'error', message: 'Solo los administradores pueden eliminar salas.' }));
                        return;
                    }
                    try {
                        // 1. Borramos la sala de la tabla de salas
                        await db.run('DELETE FROM rooms WHERE name = ?', [msg.room]);
                        
                        // 2. Borramos todos los mensajes asociados a esa sala (Limpieza)
                        await db.run('DELETE FROM messages WHERE room = ?', [msg.room]);
                        
                        console.log(`Sala #${msg.room} eliminada de la DB.`);

                        // 3. Avisamos a TODOS los clientes conectados para que la quiten de su UI
                        broadcastAll({ 
                            type: 'room_deleted', 
                            room: msg.room 
                        });
                    } catch (error) {
                        console.error("Error al eliminar la sala:", error);
                    }
                }

                else if (msg.type === 'set_room_password') {
                    if (ws.role !== 'admin') {
                        ws.send(JSON.stringify({ type: 'error', message: 'Solo los administradores pueden cambiar contraseñas.' }));
                        return;
                    }
                    if (msg.room === 'general') {
                        ws.send(JSON.stringify({ type: 'error', message: 'No se puede poner contraseña a la sala general.' }));
                        return;
                    }
                    try {
                        await db.run('UPDATE rooms SET password = ? WHERE name = ?', [msg.password || null, msg.room]);
                        ws.send(JSON.stringify({ type: 'info', message: `Contraseña de #${msg.room} actualizada.` }));
                    } catch (error) {
                        console.error("Error al setear contraseña:", error);
                    }
                }
            } catch (err) { console.error(err); }
        });
    });

    
    // 4. INICIAR SISTEMA DE COMANDOS
    function printBanner() {
    console.clear();

    // Colores
    const cMorado = "\x1b[37m";
    const cCian = "\x1b[36m";
    const cBlanco = "\x1b[37m";
    const cGris = "\x1b[90m";
    const reset = "\x1b[0m";

    // 1. EL ARTE (Tu ASCII)
    // Nota: Usamos split('\n') para manejarlo línea por línea
    const asciiArt = `
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣀⣀⣀⣀⣀⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⣴⣶⣿⠿⠛⠛⠛⠻⠿⣿⣿⣿⣿⣿⣶⣤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣴⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⣷⣻⠶⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠄⠂⠀⢀⣠⣾⣿⣿⣿⣿⣿⣿⣿⡄⠀⠀⠀⢀⣤⣾⣿⣿⣿⣿⣿⣿⡿⣽⣻⣳⢎⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠄⢡⠂⠄⣢⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣟⡷⣯⡞⣝⢆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⠀⠁⡐⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣳⣟⡾⣹⢎⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠠⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠂⣼⣿⣿⣿⣿⡿⠿⠛⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠉⠉⠛⠻⠿⣿⣿⣿⣿⣿⡿⣾⣝⣧⢻⡜⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢂⠐⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡀⠂⢸⣿⡿⠟⠋⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠻⠿⣿⣳⢯⣞⡳⣎⠅⠀⠀⠀⠀⠀⠀⠀⠀⠀⠠⢈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠄⠁⠚⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁⠛⢯⡞⣵⣋⠆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⠱⣍⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⡞⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡄⢀⣾⡇⠀⣾⣇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⠁⣾⣿⡇⢰⣿⣿⠀⠀⣆⠀⠀⠀⠀⢰⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⣿⠁⠀⠀⠀⠀⠀⠀⠀⠀⡀⠀⠀⣼⡏⢰⣿⣿⠇⣾⣿⣿⡆⠀⣿⠀⠀⠀⠀⢸⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⡇⠀⠀⠀⠀⠀⠀⠀⠀⠰⠃⠀⠒⠛⠃⠚⠿⣿⢰⣿⣿⣿⡇⣤⣿⣤⣶⣦⣀⢼⣿⣧⠀⢰⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⢠⣶⢰⣿⣿⣿⣧⡹⢓⣾⣾⣿⣿⣿⣧⣿⣿⣿⣿⣋⣁⣀⣀⣀⣁⠘⠃⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣾⡟⢋⠁⡀⠀⠉⠙⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠱⣚⣭⡿⢿⣿⣷⣦⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡄⢠⣆⠀⠀⠀⠀⣿⣏⡀⣾⠀⠀⠀⠀⣰⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏⣁⠀⢠⠀⠀⠉⠻⢿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⢇⣾⣿⣷⠀⠀⠀⣿⣿⣿⣞⡓⠥⠬⣒⣷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢿⠀⠀⠀⠀⠀⣦⠈⢳⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣾⣿⣿⣿⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣮⡢⢄⡀⠤⠾⢧⣦⣼⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⡇⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢟⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣶⣶⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⢁⣿⣿⠇⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣏⢾⡅⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠆⣼⣿⣿⣦⣾⠀⠀⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣾⣷⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠀⠀⠀⠀⠀⢀⠰⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⣻⢿⣯⡿⣟⠇⠀⡜⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠇⠀⠀⠀⠀⠀⠌⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⣰⢧⡟⡿⣾⡽⢏⣿⣾⣿⡌⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣛⣻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⢀⡰⣣⢻⡜⣯⢳⡝⣼⣿⣿⣿⣿⣆⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡀⢂⠐⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⢠⠎⡵⢣⢧⡹⣜⢣⣿⣿⣿⣿⣿⣿⣿⣷⡌⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋⠀⠀⠀⠀⠀⠀⠀⢀⠂⠔⡀⢂⠐⡀⢂⠠⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠡⢚⠴⣉⠦⡑⢎⢣⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⣙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⡩⠂⠀⠀⠀⠀⠀⣀⡔⢦⠃⢈⠐⡀⢂⠐⠠⠀⠄⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠁⠎⡰⢡⠙⡌⣸⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⠟⠒⠌⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠛⠉⠀⠈⠀⠀⠀⠀⠀⣀⠶⡱⢎⢧⢋⠀⡐⢀⠂⠌⢀⠂⢀⠂⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁⠢⠑⡨⣟⠿⠟⠟⠋⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠛⠟⠛⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢴⡩⢞⡱⢫⠜⡪⢅⠀⠂⠄⠂⠠⠀⠂⢀⠐⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢢⡙⢦⡙⡔⢣⠈⢀⠂⠈⡀⠐⠀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢤⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠂⠴⢉⠆⡁⠀⡀⠁⢀⠐⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠐⠡⠀⠀⠐⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠂⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀`.split('\n');

    // 2. LA COLUMNA DE INFORMACIÓN (Derecha)
    // Definimos qué texto va en qué línea relativa a la imagen
    const infoMap = {
        6:  `${cCian}   >>> HYPR-CHAT SERVER ${cBlanco}v1.0.0`,
        7:  `${cCian}   >>> STATUS: ${cBlanco}ONLINE ${cCian}●`,
        9:  `${cCian}   ╔════ SERVER INFO ════════════════╗`,
        10: `${cCian}   ║ ${cGris}PORT:     ${cBlanco}8080                ${cCian}║`,
        11: `${cCian}   ║ ${cGris}DB:       ${cBlanco}SQLITE (Connected)  ${cCian}║`,
        12: `${cCian}   ║ ${cGris}MODE:     ${cBlanco}${allowRegistration ? 'REGISTRATION OPEN' : 'REGISTRATION CLOSED'}   ${cCian}║`,
        13: `${cCian}   ╚═════════════════════════════════╝`,
        15: `${cCian}   ╔════ COMMANDS ═══════════════════╗`,
        16: `${cCian}   ║ ${cBlanco}list      ${cGris}-> List Users       ${cCian}║`,
        17: `${cCian}   ║ ${cBlanco}online    ${cGris}-> Show Active      ${cCian}║`,
        18: `${cCian}   ║ ${cBlanco}kick      ${cGris}-> Kick User        ${cCian}║`,
        19: `${cCian}   ║ ${cBlanco}del       ${cGris}-> Delete & Ban     ${cCian}║`,
        20: `${cCian}   ║ ${cBlanco}reg       ${cGris}-> Toggle Signups   ${cCian}║`,
        21: `${cCian}   ║ ${cBlanco}promote   ${cGris}-> Make Admin       ${cCian}║`,
        22: `${cCian}   ║ ${cBlanco}demote    ${cGris}-> Make User        ${cCian}║`,
        23: `${cCian}   ║ ${cBlanco}cls       ${cGris}-> Clear Screen     ${cCian}║`,
        24: `${cCian}   ║ ${cBlanco}exit      ${cGris}-> Shutdown         ${cCian}║`,
        25: `${cCian}   ╚═════════════════════════════════╝`
    };

    // 3. RENDERIZADO (Mezclar Izquierda + Derecha)
    console.log(""); // Margen superior
    
    // Iteramos por cada línea del dibujo
    for (let i = 0; i < asciiArt.length; i++) {
        const leftCol = asciiArt[i] || "";
        const rightCol = infoMap[i] || ""; // Si no hay texto para esa línea, pone vacío
        
        // Imprimimos: [Arte Morado] + [Espacio] + [Texto Info]
        console.log(`${cMorado}${leftCol}${reset}${rightCol}`);
    }
    
    console.log("\n"); // Margen inferior
}   
    printBanner();
    startConsoleCLI();

}
// --- GESTOR DE COMANDOS DE CONSOLA ---
function startConsoleCLI() {
    
    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim().split(' ');
        const cmd = input[0].toLowerCase();
        const arg = input[1];

        switch (cmd) {
            case 'list':
                const users = await db.all('SELECT username, role FROM users');
                if (users.length === 0) {
                    console.log("ℹ️  No hay usuarios registrados.");
                } else {
                    console.log(`\n👥 Usuarios registrados (${users.length}):`);
                    users.forEach(u => {
                        const icon = u.role === 'admin' ? '🛡️  ADMIN' : '👤 USER ';
                        console.log(`   ${icon}  │  ${u.username}`);
                    });
                    console.log('');
                }
                break;

            case 'online':
                let onlineUsers = [];
                wss.clients.forEach(c => { if(c.username) onlineUsers.push(c.username) });
                console.log("🟢 Conectados:", onlineUsers.length > 0 ? onlineUsers.join(', ') : "Nadie");
                break;

            case 'reg':
                if (arg === 'on') allowRegistration = true;
                else if (arg === 'off') allowRegistration = false;
                console.log(`🔧 Registro de usuarios: ${allowRegistration ? 'ABIERTO ✅' : 'CERRADO 🔒'}`);
                break;

            case 'del':
                if (!arg) { console.log("⚠️  Uso: del <username>"); break; }
                // 1. Desconectar
                kickUser(arg);
                // 2. Borrar de DB
                await db.run('DELETE FROM users WHERE username = ?', [arg]);
                console.log(`🔥 Usuario ${arg} ELIMINADO de la base de datos.`);
                break;

            case 'kick':
                if (!arg) { console.log("⚠️  Uso: kick <username>"); break; }
                kickUser(arg);
                break;

            case 'promote':
                if (!arg) { console.log("⚠️  Uso: promote <username>"); break; }
                await db.run('UPDATE users SET role = "admin" WHERE username = ?', [arg]);
                updateUserRoleInSessions(arg, 'admin');
                console.log(`🛡️  Usuario ${arg} ahora es ADMINISTRADOR.`);
                break;

            case 'demote':
                if (!arg) { console.log("⚠️  Uso: demote <username>"); break; }
                await db.run('UPDATE users SET role = "user" WHERE username = ?', [arg]);
                updateUserRoleInSessions(arg, 'user');
                console.log(`👤 Usuario ${arg} ahora es USUARIO NORMAL.`);
                break;

            case 'cls':
                console.clear();
                break;

            case 'exit':
                console.log("Apagando...");
                process.exit(0);
                break;

            default:
                if (cmd) console.log(`Comando '${cmd}' no reconocido.`);
                break;
        }
        rl.prompt();
    });
}

// --- UTILITIES ---
function broadcastAll(msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}

function broadcastRoom(room, msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach(c => { if (c.readyState === 1 && c.room === room) c.send(payload); });
}

function updateUserRoleInSessions(username, role) {
    wss.clients.forEach((client) => {
        if (client.username === username) {
            client.role = role;
            client.send(JSON.stringify({ type: 'role_updated', role: role }));
        }
    });
}

function kickUser(username) {
    let kicked = false;
    wss.clients.forEach((client) => {
        if (client.username === username) {
            client.send(JSON.stringify({ type: 'chat', user: 'system', text: 'Has sido desconectado por el administrador.' }));
            client.close(); // Cierra la conexión WebSocket
            kicked = true;
        }
    });
    if (kicked) console.log(`🥾 ${username} ha sido expulsado.`);
    else console.log(`ℹ️  ${username} no estaba conectado.`);
}

init().catch(console.error);

