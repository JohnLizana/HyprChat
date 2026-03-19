// main.ts
import './styles.css';
import { initSettings } from './settings';
import { linkify, saveCredentials, getSavedCredentials, scrollToBottom } from './chatUtils.ts';

// --- Interfaces ---
interface HostEntry { ip: string; alias: string; }

// --- Estado Global ---
let currentUser = "";
let currentUserRole = "user";
let currentRoom = "general";
let socket: WebSocket | null = null;
let tempIp = "";
let tempAlias = "";
let lastDateDisplayed: string | null = null;
let oldestTimestamp: string | null = null;
let isLoadingMore = false;
let hasMoreMessages = true;
let unreadCounts: Record<string, number> = {};

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
    } catch (e) { hosts = []; }

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
        console.log("RAW WS MSG:", event.data);
        const msg = JSON.parse(event.data);
        console.log("PARSED MSG TYPE:", msg.type);
        switch (msg.type) {
            case 'auth':
                if (msg.status === 'success') {
                    // Al entrar con éxito, guardamos todo vía chatUtils
                    const passValue = (getEl('password-input') as HTMLInputElement).value;
                    saveCredentials(currentUser, passValue, tempIp, tempAlias);
                    saveHost(tempIp, tempAlias);
                    currentUserRole = msg.role || 'user';
                    mostrarChat();
                } else {
                    alert("ACCESO DENEGADO");
                    socket?.close();
                }
                break;

            case 'role_updated':
                currentUserRole = msg.role;
                console.log("Rol actualizado a:", currentUserRole);
                break;

            case 'error':
                alert(msg.message);
                break;

            case 'history':
                console.log(`Recibido historial de ${msg.data.length} mensajes para sala.`);
                const chatBox = getEl('chat-box');
                if (chatBox) {
                    chatBox.innerHTML = "";
                    lastDateDisplayed = null;
                    oldestTimestamp = null;
                    hasMoreMessages = true;
                    msg.data.forEach((m: any) => {
                        try {
                            renderizarMensaje(m.user, m.text, m.timestamp);
                            if (!oldestTimestamp || m.timestamp < oldestTimestamp) {
                                oldestTimestamp = m.timestamp;
                            }
                        } catch (e) {
                            console.error("Error al renderizar mensaje del historial:", e, m);
                        }
                    });
                    if (msg.data.length < 50) hasMoreMessages = false;
                    scrollToBottom(true);

                    // Animación de entrada
                    chatBox.classList.remove('room-enter');
                    void chatBox.offsetWidth; // force reflow
                    chatBox.classList.add('room-enter');
                }
                break;

            case 'older_messages':
                if (msg.room === currentRoom && msg.data.length > 0) {
                    const chatBoxOlder = getEl('chat-box');
                    if (chatBoxOlder) {
                        const prevHeight = chatBoxOlder.scrollHeight;
                        const prevScroll = chatBoxOlder.scrollTop;
                        const tempLastDate = lastDateDisplayed;
                        lastDateDisplayed = null;

                        // Crear fragmento con mensajes antiguos
                        const fragment = document.createDocumentFragment();
                        const tempContainer = document.createElement('div');

                        msg.data.forEach((m: any) => {
                            try {
                                renderizarMensajeEn(tempContainer, m.user, m.text, m.timestamp);
                                if (!oldestTimestamp || m.timestamp < oldestTimestamp) {
                                    oldestTimestamp = m.timestamp;
                                }
                            } catch (e) {
                                console.error("Error al renderizar mensaje antiguo:", e, m);
                            }
                        });

                        // Mover nodos del tempContainer al fragmento
                        while (tempContainer.firstChild) {
                            fragment.appendChild(tempContainer.firstChild);
                        }

                        // Insertar al inicio del chat
                        chatBoxOlder.insertBefore(fragment, chatBoxOlder.firstChild);

                        // Mantener posición de scroll
                        const newHeight = chatBoxOlder.scrollHeight;
                        chatBoxOlder.scrollTop = prevScroll + (newHeight - prevHeight);

                        lastDateDisplayed = tempLastDate;
                    }
                }
                if (msg.data.length < 50) hasMoreMessages = false;
                isLoadingMore = false;
                break;

            case 'chat':
                console.log("[DEBUG] CHAT RECIBIDO:", msg, "currentRoom:", currentRoom);
                const targetRoom = msg.room || currentRoom; // Respaldo si el servidor no ha sido reiniciado
                if (targetRoom === currentRoom) {
                    // Mensaje en la sala actual: renderizar
                    renderizarMensaje(msg.user, msg.text, msg.timestamp);
                    scrollToBottom();
                } else {
                    // Mensaje en otra sala: notificación
                    incrementBadge(targetRoom, msg.user, msg.text);
                }
                break;

            case 'rooms_list':
                // Limpia la lista actual antes de cargar todas (evita duplicados al reconectar)
                const lista = getEl('rooms-list');
                if (lista) lista.innerHTML = "";
                msg.rooms.forEach((r: any) => {
                    if (typeof r === 'string') {
                        añadirSalaVisual(r, false);
                    } else {
                        añadirSalaVisual(r.name, r.locked);
                    }
                });
                break;

            case 'room_created':
                console.log("Nueva sala creada:", msg.room);
                añadirSalaVisual(msg.room, msg.locked || false);

                // Solo auto-cambiar de sala si somos nosotros quien la creó (o si somos admin y queremos)
                // Para simplificar: solo cambiamos si el server nos dice que fuimos nosotros.
                if (msg.creator === currentUser) {
                    console.log("Sala propia creada, entrando...");
                    cambiarSala(msg.room);
                }
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

            case 'password_required':
                console.log("Servidor solicita contraseña para sala:", msg.room);
                const joinPassModal = getEl('join-password-modal');
                if (joinPassModal) {
                    const passText = getEl('join-pass-text');
                    if (passText) passText.textContent = msg.message || "Esta sala requiere contraseña:";
                    joinPassModal.classList.remove('hidden');
                    joinPassModal.style.display = 'flex';
                    (getEl('join-room-password-input') as HTMLInputElement).focus();
                }
                break;

            case 'info':
                console.info("Server Info:", msg.message);
                break;

        }
    };
}

// --- Renderizado e Interfaz ---

function renderizarMensaje(usuario: string, texto: string, timestamp?: any) {
    console.log(`[RENDER] Iniciando render para: User=${usuario}, Text=${texto?.substring(0, 15)}...`);
    try {
        const chatBox = getEl('chat-box');
        if (!chatBox) {
            console.error("[RENDER] No se encontró chat-box en el DOM");
            return;
        }

        const fechaMensaje = timestamp ? new Date(timestamp) : new Date();

        // Verificamos si la fecha es válida
        if (isNaN(fechaMensaje.getTime())) {
            console.warn("Fecha inválida recibida:", timestamp, "para mensaje de:", usuario);
            // Si es inválida, usamos la fecha actual como fallback para evitar fallos
        }

        const fechaLegible = !isNaN(fechaMensaje.getTime())
            ? fechaMensaje.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
            : "FECHA DESCONOCIDA";

        const hora = !isNaN(fechaMensaje.getTime())
            ? fechaMensaje.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            : "--:--:--";

        if (fechaLegible !== lastDateDisplayed) {
            const divider = document.createElement('div');
            divider.className = 'date-divider';
            divider.innerHTML = `<span>--- ${fechaLegible} ---</span>`;
            chatBox.appendChild(divider);
            lastDateDisplayed = fechaLegible;
        }

        const msgDiv = document.createElement('div');
        msgDiv.className = 'message msg-new';
        const colorUser = (usuario === currentUser) ? 'var(--border-color)' : 'var(--accent)';

        // Linkify puede fallar si el texto no es string o tiene cosas raras
        const safeText = String(texto || "");
        let htmlTexto = safeText;
        try {
            htmlTexto = linkify(safeText);
        } catch (e) {
            console.error("Error en linkify:", e);
        }

        msgDiv.innerHTML = `
            <span class="time">[${hora}]</span> 
            <span class="user" style="color: ${colorUser}">#${usuario}:</span> 
            <span class="text">${htmlTexto}</span>
        `;
        chatBox.appendChild(msgDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
    } catch (error) {
        console.error("Error FATAL en renderizarMensaje:", error);
    }
}

// Versión que renderiza en un contenedor específico (para mensajes antiguos)
function renderizarMensajeEn(container: HTMLElement, usuario: string, texto: string, timestamp?: any) {
    try {
        const fechaMensaje = timestamp ? new Date(timestamp) : new Date();

        const fechaLegible = !isNaN(fechaMensaje.getTime())
            ? fechaMensaje.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
            : "FECHA DESCONOCIDA";

        const hora = !isNaN(fechaMensaje.getTime())
            ? fechaMensaje.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            : "--:--:--";

        if (fechaLegible !== lastDateDisplayed) {
            const divider = document.createElement('div');
            divider.className = 'date-divider';
            divider.innerHTML = `<span>--- ${fechaLegible} ---</span>`;
            container.appendChild(divider);
            lastDateDisplayed = fechaLegible;
        }

        const msgDiv = document.createElement('div');
        msgDiv.className = 'message';
        const colorUser = (usuario === currentUser) ? 'var(--border-color)' : 'var(--accent)';

        const safeText = String(texto || "");
        let htmlTexto = safeText;
        try {
            htmlTexto = linkify(safeText);
        } catch (e) {
            console.error("Error en linkify:", e);
        }

        msgDiv.innerHTML = `
            <span class="time">[${hora}]</span> 
            <span class="user" style="color: ${colorUser}">#${usuario}:</span> 
            <span class="text">${htmlTexto}</span>
        `;
        container.appendChild(msgDiv);
    } catch (error) {
        console.error("Error en renderizarMensajeEn:", error);
    }
}

function añadirSalaVisual(nombre: string, locked: boolean = false) {
    const lista = getEl('rooms-list');
    // Verificamos si ya existe un elemento con ese data-room para no duplicar
    if (lista && !document.querySelector(`[data-room="${nombre}"]`)) {
        const li = document.createElement('li');
        li.className = 'room-item';
        li.setAttribute('data-room', nombre);
        li.textContent = locked ? `🔒 ${nombre}` : `# ${nombre}`;

        // Si queremos que la sala nueva aparezca marcada como activa si acabamos de entrar
        if (nombre === currentRoom) li.classList.add('active');

        lista.appendChild(li);
        
        // Renderizar badge si hay notificaciones pendientes para esta sala nueva
        actualizarBadgeVisual(nombre);
    }
}

// --- Notificaciones y Badges ---
function incrementBadge(room: string, sender: string, text: string) {
    if (!unreadCounts[room]) unreadCounts[room] = 0;
    unreadCounts[room]++;
    actualizarBadgeVisual(room);

    // Notificación Push (HTML5)
    if (Notification.permission === 'granted') {
        new Notification(`Mensaje en #${room}`, { body: `#${sender}: ${text}` });
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                new Notification(`Mensaje en #${room}`, { body: `#${sender}: ${text}` });
            }
        });
    }
}

function clearBadge(room: string) {
    unreadCounts[room] = 0;
    actualizarBadgeVisual(room);
}

function actualizarBadgeVisual(room: string) {
    const li = document.querySelector(`[data-room="${room}"]`);
    if (li) {
        let badge = li.querySelector('.badge');
        const count = unreadCounts[room] || 0;
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'badge';
                li.appendChild(badge);
            }
            badge.textContent = count > 99 ? '99+' : count.toString();
        } else {
            if (badge) badge.remove();
        }
    }
}

function cambiarSala(nuevaSala: string, password?: string) {
    if (!socket) return;
    currentRoom = nuevaSala;
    lastDateDisplayed = null;
    oldestTimestamp = null;
    isLoadingMore = false;
    hasMoreMessages = true;
    
    clearBadge(nuevaSala); // Limpiar notificaciones al entrar
    
    getEl('current-room-display')!.textContent = nuevaSala;
    document.querySelectorAll('.room-item').forEach(el => el.classList.toggle('active', el.getAttribute('data-room') === nuevaSala));
    getEl('chat-box')!.innerHTML = "";
    socket.send(JSON.stringify({ type: 'join', room: currentRoom, password }));
}

function mostrarChat() {
    const loginScreen = getEl('login-screen')!;
    const chatContainer = getEl('chat-container')!;

    // 1. Animar salida del login
    loginScreen.classList.add('login-exit');

    setTimeout(() => {
        // 2. Ocultar login, preparar chat
        loginScreen.style.setProperty('display', 'none', 'important');
        loginScreen.classList.remove('login-exit');

        chatContainer.style.setProperty('display', 'flex', 'important');
        chatContainer.classList.add('chat-enter');

        // Si somos admin, mostramos el botón de añadir sala
        const btnCrear = getEl('add-room-btn');
        if (btnCrear) {
            if (currentUserRole === 'admin') btnCrear.classList.remove('hidden');
            else btnCrear.classList.add('hidden');
        }

        // Forzamos la entrada a general correctamente
        cambiarSala("general");

        // 3. Limpiar clase después de la animación
        setTimeout(() => chatContainer.classList.remove('chat-enter'), 600);
    }, 400);
}

// --- Eventos ---

window.onload = () => {
    initSettings();
    loadInitialData();

    // Scroll listener para cargar mensajes antiguos
    getEl('chat-box')?.addEventListener('scroll', () => {
        const chatBox = getEl('chat-box');
        if (!chatBox || isLoadingMore || !hasMoreMessages || !oldestTimestamp || !socket) return;
        if (chatBox.scrollTop <= 50) {
            isLoadingMore = true;
            socket.send(JSON.stringify({ type: 'load_more', room: currentRoom, before: oldestTimestamp }));
        }
    });

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
    const inputNuevaSalaPass = getEl('new-room-pass') as HTMLInputElement;

    btnCrear?.addEventListener('click', () => {
        btnCrear.classList.add('hidden');
        containerInput?.classList.remove('hidden');
        inputNuevaSala.focus();
    });

    const finishCreateRoom = () => {
        const nombre = inputNuevaSala.value.trim().toLowerCase().replace(/\s+/g, '-');
        const pass = inputNuevaSalaPass.value.trim();
        if (nombre && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'create_room', room: nombre, password: pass || null }));
            inputNuevaSala.value = "";
            inputNuevaSalaPass.value = "";
            containerInput?.classList.add('hidden');
            btnCrear?.classList.remove('hidden');
        }
    };

    inputNuevaSala?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            finishCreateRoom();
        } else if (e.key === 'Escape') {
            containerInput?.classList.add('hidden');
            btnCrear?.classList.remove('hidden');
        }
    });

    inputNuevaSalaPass?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            finishCreateRoom();
        } else if (e.key === 'Escape') {
            containerInput?.classList.add('hidden');
            btnCrear?.classList.remove('hidden');
        }
    });

    // 5. MENÚ CONTEXTUAL (Click Derecho)
    getEl('rooms-list')?.addEventListener('contextmenu', (e: MouseEvent) => {
        // Solo los admins pueden ver el menú contextual de salas
        if (currentUserRole !== 'admin') return;

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

        if (btn.id === 'menu-password') {
            const passModal = getEl('password-modal');
            if (passModal) {
                passModal.classList.remove('hidden');
                passModal.style.display = 'flex';
                (getEl('room-password-input') as HTMLInputElement).focus();
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

    // Modal Password
    getEl('confirm-pass-btn')?.addEventListener('click', () => {
        const passInput = getEl('room-password-input') as HTMLInputElement;
        const nuevaPass = passInput.value.trim();
        if (roomTarget && socket) {
            socket.send(JSON.stringify({
                type: 'set_room_password',
                room: roomTarget,
                password: nuevaPass || null
            }));
        }
        const passModal = getEl('password-modal');
        if (passModal) {
            passModal.style.display = 'none';
            passModal.classList.add('hidden');
        }
        passInput.value = "";
    });

    getEl('cancel-pass-btn')?.addEventListener('click', () => {
        const passModal = getEl('password-modal');
        if (passModal) {
            passModal.style.display = 'none';
            passModal.classList.add('hidden');
        }
    });

    // Modal Join Password
    getEl('confirm-join-pass-btn')?.addEventListener('click', () => {
        const passInput = getEl('join-room-password-input') as HTMLInputElement;
        const pass = passInput.value.trim();
        if (currentRoom && socket) {
            socket.send(JSON.stringify({ type: 'join', room: currentRoom, password: pass }));
        }
        const joinModal = getEl('join-password-modal');
        if (joinModal) {
            joinModal.style.display = 'none';
            joinModal.classList.add('hidden');
        }
        passInput.value = "";
    });

    getEl('cancel-join-pass-btn')?.addEventListener('click', () => {
        const joinModal = getEl('join-password-modal');
        if (joinModal) {
            joinModal.style.display = 'none';
            joinModal.classList.add('hidden');
        }
    });

    getEl('join-room-password-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            getEl('confirm-join-pass-btn')?.click();
        } else if (e.key === 'Escape') {
            getEl('cancel-join-pass-btn')?.click();
        }
    });

    // 7. CERRAR SESIÓN
    getEl('logout-btn')?.addEventListener('click', () => location.reload());
};

//Fin de window.onload --------------------------------