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
        CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT);
        CREATE TABLE IF NOT EXISTS rooms (name TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, user TEXT, text TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
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
                    ws.send(JSON.stringify({ type: 'auth', status: 'success' }));
                    const rooms = await db.all('SELECT name FROM rooms');
                    ws.send(JSON.stringify({ type: 'rooms_list', rooms: rooms.map(r => r.name) }));
                }
                
                // CHAT Y SALAS (Resumido para ahorrar espacio, funciona igual)
                else if (msg.type === 'create_room') {
                    await db.run('INSERT OR IGNORE INTO rooms (name) VALUES (?)', [msg.room]);
                    broadcastAll({ type: 'room_created', room: msg.room });
                }
                else if (msg.type === 'join') {
                    ws.room = msg.room;
                    const history = await db.all('SELECT user, text, timestamp FROM messages WHERE room = ? ORDER BY timestamp ASC LIMIT 50', [msg.room]);                    ws.send(JSON.stringify({ type: 'history', data: history }));
                }
                else if (msg.type === 'chat') {
                    const now = new Date().toISOString();
                    
                    // Guardamos incluyendo el timestamp (asumiendo que tu tabla tiene esa columna)
                    await db.run('INSERT INTO messages (room, user, text, timestamp) VALUES (?, ?, ?, ?)', 
                        [msg.room, msg.user, msg.text, now]);
                    
                    // IMPORTANTE: Enviamos el timestamp a la sala para que el cliente lo renderice
                    broadcastRoom(msg.room, { 
                        type: 'chat', 
                        user: msg.user, 
                        text: msg.text, 
                        timestamp: now 
                    });
                }
                else if (msg.type === 'rename_room') {
                    try {
                        // 1. Actualizar el nombre en la tabla de salas
                        await db.run('UPDATE rooms SET name = ? WHERE name = ?', [msg.newRoom, msg.oldRoom]);
                        
                        // 2. IMPORTANTE: Actualizar los mensajes para que pertenezcan al nuevo nombre de sala
                        await db.run('UPDATE messages SET room = ? WHERE room = ?', [msg.newRoom, msg.oldRoom]);

                        // 3. Avisar a todos que el nombre cambió
                        broadcastAll({ 
                            type: 'rooms_list', 
                            rooms: (await db.all('SELECT name FROM rooms')).map(r => r.name) 
                        });
                    } catch (error) {
                        console.error("Error al renombrar sala:", error);
                    }
                }
                else if (msg.type === 'delete_room') {
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
        21: `${cCian}   ║ ${cBlanco}cls       ${cGris}-> Clear Screen     ${cCian}║`,
        22: `${cCian}   ║ ${cBlanco}exit      ${cGris}-> Shutdown         ${cCian}║`,
        23: `${cCian}   ╚═════════════════════════════════╝`
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
                const users = await db.all('SELECT username FROM users');
                console.table(users);
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

