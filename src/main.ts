// main.ts
import './styles.css'; 
import { initSettings } from './settings';
import { linkify, saveCredentials, getSavedCredentials, scrollToBottom } from './chatUtils.ts';

// --- Interfaces ---
interface HostEntry { ip: string; alias: string; }

// --- Estado Global ---
let currentUser = "";
let currentRoom = "general";
let socket: WebSocket | null = null;
let tempIp = "";
let tempAlias = "";
let lastDateDisplayed: string | null = null;

const getEl = (id: string) => document.getElementById(id);

// --- Carga Inicial de Datos ---

function loadInitialData() {
    // 1. Cargar lista de hosts para el datalist
    loadSavedHosts();
    
    // 2. Cargar credenciales y último servidor en los inputs
    const creds = getSavedCredentials();
    const userEl = getEl('username-input') as HTMLInputElement;
    const passEl = getEl('password-input') as HTMLInputElement;
    const ipEl = getEl('server-ip') as HTMLInputElement;
    const aliasEl = getEl('server-alias') as HTMLInputElement;

    if (creds.user && userEl) userEl.value = creds.user;
    if (creds.pass && passEl) passEl.value = creds.pass;
    if (creds.server && ipEl) ipEl.value = creds.server;
    if (creds.alias && aliasEl) aliasEl.value = creds.alias;
}

function loadSavedHosts() {
    const datalist = getEl('saved-hosts');
    if (!datalist) return;
    const rawData = localStorage.getItem('hypr_saved_hosts');
    let hosts: HostEntry[] = [];
    try {
        hosts = rawData ? JSON.parse(rawData) : [];
        if (!Array.isArray(hosts)) hosts = [];
    } catch (e) { hosts = []; }
    
    datalist.innerHTML = ''; 
    hosts.forEach(host => {
        if (host && host.ip) {
            const option = document.createElement('option');
            option.value = host.alias ? `${host.alias} | ${host.ip}` : String(host.ip);
            datalist.appendChild(option);
        }
    });
}

function saveHost(ipToSave: string, aliasToSave: string) {
    if (!ipToSave || ipToSave === "[object Object]") return;
    const rawData = localStorage.getItem('hypr_saved_hosts');
    let hosts: HostEntry[] = [];
    try {
        hosts = rawData ? JSON.parse(rawData) : [];
    } catch(e) { hosts = []; }

    const existingIndex = hosts.findIndex(h => h.ip === ipToSave);
    if (existingIndex >= 0) {
        if (aliasToSave) hosts[existingIndex].alias = aliasToSave;
    } else {
        hosts.push({ ip: ipToSave.trim(), alias: aliasToSave });
    }
    localStorage.setItem('hypr_saved_hosts', JSON.stringify(hosts));
    loadSavedHosts();
}

// --- WebSocket Logic ---

function conectarAlServidor(ip: string, pass: string) {
    if (socket) socket.close();
    const url = ip.includes(':') ? `ws://${ip}` : `ws://${ip}:8080`;
    socket = new WebSocket(url);

    socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'login', user: currentUser, password: pass }));
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
            case 'auth':
                if (msg.status === 'success') {
                    // Al entrar con éxito, guardamos todo vía chatUtils
                    const passValue = (getEl('password-input') as HTMLInputElement).value;
                    saveCredentials(currentUser, passValue, tempIp, tempAlias);
                    saveHost(tempIp, tempAlias);
                    mostrarChat();
                } else {
                    alert("ACCESO DENEGADO");
                    socket?.close();
                }
                break;

            case 'history':
                const chatBox = getEl('chat-box');
                if (chatBox) {
                    chatBox.innerHTML = ""; 
                    lastDateDisplayed = null;
                    msg.data.forEach((m: any) => renderizarMensaje(m.user, m.text, m.timestamp));
                    scrollToBottom(true); // Espera imágenes antes de hacer scroll
                }
                break;

            case 'chat':
                renderizarMensaje(msg.user, msg.text, msg.timestamp);
                scrollToBottom();
                break;

            case 'rooms_list':
            // Limpia la lista actual antes de cargar todas (evita duplicados al reconectar)
                const lista = getEl('rooms-list');
                if (lista) lista.innerHTML = "";
                msg.rooms.forEach((r: string) => añadirSalaVisual(r));
                break;

            case 'room_created':
                // ESTE ES EL CASO CLAVE:
                // Cuando el servidor confirma que se creó una sala, la añadimos visualmente
                añadirSalaVisual(msg.room);
                
                // Opcional: Cambiar automáticamente a la nueva sala recién creada
                cambiarSala(msg.room);
                break;
                
            // Dentro del switch(msg.type) en main.ts
            case 'room_deleted':
                console.log("Sala eliminada por el servidor:", msg.room);
                const itemAEliminar = document.querySelector(`[data-room="${msg.room}"]`);
                if (itemAEliminar) {
                    itemAEliminar.remove();
                    // Si estábamos en esa sala, saltamos a general
                    if (currentRoom === msg.room) {
                        cambiarSala('general');
                    }
                }
                break;
        
        }
    };
}

// --- Renderizado e Interfaz ---

function renderizarMensaje(usuario: string, texto: string, timestamp?: any) {
    const chatBox = getEl('chat-box');
    if (!chatBox) return;

    const fechaMensaje = timestamp ? new Date(timestamp) : new Date();
    const fechaLegible = fechaMensaje.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
    const hora = fechaMensaje.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    if (fechaLegible !== lastDateDisplayed) {
        const divider = document.createElement('div');
        divider.className = 'date-divider';
        divider.innerHTML = `<span>--- ${fechaLegible} ---</span>`;
        chatBox.appendChild(divider);
        lastDateDisplayed = fechaLegible;
        
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = 'message';
    const colorUser = (usuario === currentUser) ? 'var(--border-color)' : 'var(--accent)';
    
    msgDiv.innerHTML = `
        <span class="time">[${hora}]</span> 
        <span class="user" style="color: ${colorUser}">#${usuario}:</span> 
        <span class="text">${linkify(texto)}</span>
    `;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
    
}

function añadirSalaVisual(nombre: string) {
    const lista = getEl('rooms-list');
    // Verificamos si ya existe un elemento con ese data-room para no duplicar
    if (lista && !document.querySelector(`[data-room="${nombre}"]`)) {
        const li = document.createElement('li');
        li.className = 'room-item';
        li.setAttribute('data-room', nombre);
        li.textContent = `# ${nombre}`;
        
        // Si queremos que la sala nueva aparezca marcada como activa si acabamos de entrar
        if (nombre === currentRoom) li.classList.add('active');
        
        lista.appendChild(li);
    }
}

function cambiarSala(nuevaSala: string) {
    if (nuevaSala === currentRoom || !socket) return;
    currentRoom = nuevaSala;
    lastDateDisplayed = null;
    getEl('current-room-display')!.textContent = nuevaSala;
    document.querySelectorAll('.room-item').forEach(el => el.classList.toggle('active', el.getAttribute('data-room') === nuevaSala));
    getEl('chat-box')!.innerHTML = "";
    socket.send(JSON.stringify({ type: 'join', room: currentRoom }));
}

function mostrarChat() {
    getEl('login-screen')!.style.setProperty('display', 'none', 'important');
    getEl('chat-container')!.style.setProperty('display', 'flex', 'important');
    socket?.send(JSON.stringify({ type: 'join', room: "general" }));
}

// --- Eventos ---

window.onload = () => {
    initSettings();
    loadInitialData(); 
    
    //Boot de la app
    const bootLines = [
    "[  OK  ] Initializing HC_Kernel...",
    "[  OK  ] Loading Hypr_Modules...",
    "[ WAIT ] Connecting to WebSocket...",
    "[  OK  ] Establishing Secure Link...",
    "[  OK  ] System Ready. Launching UI...",
];

async function startBootSequence() {
    const textContainer = document.getElementById('terminal-text');
    const progressBar = document.querySelector('.progress-bar') as HTMLElement;
    const bootScreen = document.getElementById('boot-screen');

    for (let i = 0; i < bootLines.length; i++) {
        const line = document.createElement('div');
        line.className = 'terminal-line';
        // Coloreamos el [ OK ]
        line.innerHTML = bootLines[i].replace("[  OK  ]", "<span class='ok'>[  OK  ]</span>");
        textContainer?.appendChild(line);
        
        // Actualizamos barra
        if (progressBar) {
            progressBar.style.width = `${(i + 1) * (100 / bootLines.length)}%`;
        }
        
        // Delay aleatorio para realismo
        await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
    }

    // Finalizar
    setTimeout(() => {
        bootScreen?.classList.add('boot-exit');
        setTimeout(() => bootScreen?.remove(), 1000);
    }, 500);
}

// Ejecutar al cargar
startBootSequence();
    

    // Aplicar color de acento
    const savedColor = localStorage.getItem('hypr_accent') || '#cba6f7';
    document.documentElement.style.setProperty('--border-color', savedColor);

    // --- ELEMENTOS DEL DOM ---
    const contextMenu = getEl('custom-context-menu');
    const deleteModal = getEl('delete-modal');
    const editModal = getEl('edit-modal');
    const editInput = getEl('edit-room-input') as HTMLInputElement;
    
    // Variable global de control para saber sobre qué sala operamos
    let roomTarget = ""; 

    // 1. LOGICA DE LOGIN
    getEl('login-btn')?.addEventListener('click', () => {
        const userEl = getEl('username-input') as HTMLInputElement;
        const passEl = getEl('password-input') as HTMLInputElement;
        const ipEl = getEl('server-ip') as HTMLInputElement;
        const aliasEl = getEl('server-alias') as HTMLInputElement;

        currentUser = userEl.value.trim();
        tempIp = ipEl.value.trim().includes(' | ') ? ipEl.value.split(' | ')[1].trim() : ipEl.value.trim();
        tempAlias = aliasEl.value.trim();

        if (currentUser && tempIp) conectarAlServidor(tempIp, passEl.value);
    });

    // 2. ENVÍO DE MENSAJES
    getEl('message-input')?.addEventListener('keydown', (e) => {
        const input = e.target as HTMLInputElement;
        if (e.key === 'Enter' && input.value.trim() !== "") {
            socket?.send(JSON.stringify({ type: 'chat', user: currentUser, text: input.value.trim(), room: currentRoom }));
            input.value = "";
        }
    });

    // 3. CAMBIO DE SALA (Click Izquierdo)
    getEl('rooms-list')?.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest('.room-item');
        if (item) cambiarSala(item.getAttribute('data-room') || 'general');
    });

    // 4. CREAR SALA (Botón +)
    const btnCrear = getEl('add-room-btn');
    const containerInput = getEl('new-room-container');
    const inputNuevaSala = getEl('new-room-input') as HTMLInputElement;

    btnCrear?.addEventListener('click', () => {
        btnCrear.classList.add('hidden');
        containerInput?.classList.remove('hidden');
        inputNuevaSala.focus();
    });

    inputNuevaSala?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const nombre = inputNuevaSala.value.trim().toLowerCase().replace(/\s+/g, '-');
            if (nombre && socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'create_room', room: nombre }));
                inputNuevaSala.value = "";
                containerInput?.classList.add('hidden');
                btnCrear?.classList.remove('hidden');
            }
        } else if (e.key === 'Escape') {
            containerInput?.classList.add('hidden');
            btnCrear?.classList.remove('hidden');
        }
    });

    // 5. MENÚ CONTEXTUAL (Click Derecho)
    getEl('rooms-list')?.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        const item = (e.target as HTMLElement).closest('.room-item');
        
        if (item) {
            roomTarget = item.getAttribute('data-room') || "";
            // Protegemos salas principales
            if (roomTarget === 'general' || roomTarget === 'dev') return;

            if (contextMenu) {
                contextMenu.style.top = `${e.clientY}px`;
                contextMenu.style.left = `${e.clientX}px`;
                contextMenu.classList.remove('hidden');
            }
        }
    });

    // Cerrar menú al hacer clic en cualquier parte
    document.addEventListener('click', () => contextMenu?.classList.add('hidden'));

    // Acciones del Menú Contextual (Delegación de eventos)
    // Acciones del Menú Contextual con DEPURACIÓN
    contextMenu?.addEventListener('click', (e) => {
        // Evitamos que el clic se propague al fondo
        e.preventDefault();
        e.stopPropagation();

        const target = e.target as HTMLElement;
        // Buscamos el LI más cercano al punto donde se hizo clic
        const btn = target.closest('li');

        console.log("Clic detectado en el menú. Elemento:", btn?.id);

        if (!btn || !roomTarget) {
            console.warn("No hay botón válido o roomTarget está vacío:", roomTarget);
            return;
        }

        if (btn.id === 'menu-edit') {
            if (editModal) {
                editModal.classList.remove('hidden');
                editModal.style.display = 'flex';
                if (editInput) editInput.value = roomTarget;
                editInput?.focus();
            }
        }

        if (btn.id === 'menu-delete') {
            if (deleteModal) {
                deleteModal.classList.remove('hidden');
                deleteModal.style.display = 'flex';
            }
        }

        // Siempre ocultamos el menú después de un clic exitoso
        contextMenu.classList.add('hidden');
    });

    // 6. LÓGICA DE MODALES (Confirmar / Cancelar)

    // Modal Eliminar
    getEl('confirm-delete-btn')?.addEventListener('click', () => {
        if (roomTarget && socket) {
            socket.send(JSON.stringify({ type: 'delete_room', room: roomTarget }));
        }
        if (deleteModal) {
            deleteModal.style.display = 'none';
            deleteModal.classList.add('hidden');
        }
    });

    getEl('cancel-delete-btn')?.addEventListener('click', () => {
        if (deleteModal) {
            deleteModal.style.display = 'none';
            deleteModal.classList.add('hidden');
        }
    });

    // Modal Editar
    getEl('confirm-edit-btn')?.addEventListener('click', () => {
        const nuevoNombre = editInput.value.trim().toLowerCase().replace(/\s+/g, '-');
        if (nuevoNombre && nuevoNombre !== roomTarget && socket) {
            socket.send(JSON.stringify({ 
                type: 'rename_room', 
                oldRoom: roomTarget, 
                newRoom: nuevoNombre 
            }));
        }
        if (editModal) {
            editModal.style.display = 'none';
            editModal.classList.add('hidden');
        }
    });

    getEl('cancel-edit-btn')?.addEventListener('click', () => {
        if (editModal) {
            editModal.style.display = 'none';
            editModal.classList.add('hidden');
        }
    });

    // 7. CERRAR SESIÓN
    getEl('logout-btn')?.addEventListener('click', () => location.reload());
};

//Fin de window.onload --------------------------------