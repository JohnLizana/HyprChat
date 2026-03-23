const { WebSocketServer } = require('ws');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const readline = require('readline');

// Configuración Global
let db;
let allowRegistration = false; // Por defecto apagado
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
                            user = { username: msg.user };
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
                    
                    // Broadcast a todos que hay un nuevo usuario online
                    // Broadcast a todos que hay un nuevo usuario online
                    broadcastOnlineUsers();
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
                        const roomInfo = await db.get('SELECT * FROM rooms WHERE name = ?', [msg.room]);
                        if (roomInfo && roomInfo.password && msg.room !== 'general') {
                            if (msg.password !== roomInfo.password) {
                                ws.send(JSON.stringify({ 
                                    type: 'password_required', 
                                    room: msg.room, 
                                    message: msg.password ? 'Contraseña incorrecta.' : 'Esta sala requiere contraseña.' 
                                }));
                                return;
                            }
                        }
                        ws.room = msg.room;
                        const history = await db.all('SELECT * FROM (SELECT user, text, timestamp FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT 50) ORDER BY timestamp ASC', [ws.room]);                    
                        ws.send(JSON.stringify({ type: 'history', data: history }));
                    } catch (err) {
                        console.error("[JOIN ERROR]", err);
                        ws.send(JSON.stringify({ type: 'error', message: 'Error al unirse a la sala.' }));
                    }
                }
                else if (msg.type === 'chat') {
                    const room = ws.room || msg.room;
                    const now = new Date().toISOString();
                    
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
                else if (msg.type === 'private_chat') {
                    const now = new Date().toISOString();
                    
                    try {
                        const payload = JSON.stringify({ 
                            type: 'private_chat', 
                            user: msg.user, 
                            to: msg.to,
                            text: msg.text, 
                            timestamp: now
                        });
                        
                        let sent = false;
                        wss.clients.forEach(c => { 
                            if (c.readyState === 1 && (c.username === msg.to || c.username === ws.username)) {
                                c.send(payload);
                                if (c.username === msg.to) sent = true;
                            } 
                        });
                        
                        if (!sent && msg.to !== ws.username) {
                            ws.send(JSON.stringify({ type: 'error', message: `Usuario ${msg.to} no está conectado.` }));
                        }
                    } catch (err) {
                        console.error("[PRIVATE CHAT ERROR]", err);
                        ws.send(JSON.stringify({ type: 'error', message: 'Error al enviar mensaje privado.' }));
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

        // Detectar desconexión de usuario
        ws.on('close', () => {
            if (ws.username) {
            if (ws.username) {
                broadcastOnlineUsers();
            }
            }
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
        18: `${cCian}   ║ ${cBlanco}say       ${cGris}-> Send Msg to Room ${cCian}║`,
        19: `${cCian}   ║ ${cBlanco}kick      ${cGris}-> Kick User        ${cCian}║`,
        20: `${cCian}   ║ ${cBlanco}del       ${cGris}-> Delete & Ban     ${cCian}║`,
        21: `${cCian}   ║ ${cBlanco}reg       ${cGris}-> Toggle Signups   ${cCian}║`,
        22: `${cCian}   ║ ${cBlanco}promote   ${cGris}-> Make Admin       ${cCian}║`,
        23: `${cCian}   ║ ${cBlanco}demote    ${cGris}-> Make User        ${cCian}║`,
        24: `${cCian}   ║ ${cBlanco}cls       ${cGris}-> Clear Screen     ${cCian}║`,
        25: `${cCian}   ║ ${cBlanco}exit      ${cGris}-> Shutdown         ${cCian}║`,
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

            case 'say':
                if (input.length < 3) {
                    console.log("⚠️  Uso: say <room> <message>");
                    break;
                }
                const sayRoom = input[1];
                const sayText = input.slice(2).join(' ');
                const sayTime = new Date().toISOString();
                
                try {
                    await db.run('INSERT INTO messages (room, user, text, timestamp) VALUES (?, ?, ?, ?)', 
                        [sayRoom, 'Server', sayText, sayTime]);
                    
                    broadcastAll({ 
                        type: 'chat', 
                        user: 'Server', 
                        text: sayText, 
                        timestamp: sayTime,
                        room: sayRoom
                    });
                } catch (e) {
                    console.error("❌ Error al enviar mensaje desde consola:", e);
                }
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

function broadcastOnlineUsers() {
    let onlineUsers = [];
    wss.clients.forEach(c => { 
        if (c.username && c.readyState === 1) {
            onlineUsers.push(c.username);
        }
    });
    // Quitamos duplicados por si un usuario tiene varias pestañas
    onlineUsers = [...new Set(onlineUsers)];
    broadcastAll({ type: 'online_users', users: onlineUsers });
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
    if (kicked) {
        // Log desactivado
    }
    else {
        // Log desactivado
    }
}

init().catch(console.error);

