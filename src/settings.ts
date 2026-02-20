// settings.ts

// Definición de temas para la lógica de selección


export function initSettings() {
    try {
        const panel = document.getElementById('settings-panel');
        const openBtn = document.getElementById('open-settings-btn');
        const closeBtn = document.getElementById('close-settings');
        
        // Selectores de inputs
        const fontSelect = document.getElementById('font-family-select') as HTMLSelectElement;
        const accentPicker = document.getElementById('settings-color-picker') as HTMLInputElement;
        const bgPicker = document.getElementById('bg-color-picker') as HTMLInputElement;
        const textPicker = document.getElementById('text-color-picker') as HTMLInputElement; // NUEVO

        const applyProperty = (prop: string, value: string) => {
            document.documentElement.style.setProperty(prop, value);
        };

        const updateVisualLabels = () => {
            if (accentPicker) document.getElementById('color-hex-code')!.textContent = accentPicker.value.toUpperCase();
            if (bgPicker) document.getElementById('bg-hex-code')!.textContent = bgPicker.value.toUpperCase();
            if (textPicker) document.getElementById('text-hex-code')!.textContent = textPicker.value.toUpperCase(); // NUEVO
        };

        const loadPrefs = () => {
            const savedAccent = localStorage.getItem('hypr_accent') || '#cba6f7';
            const savedBg = localStorage.getItem('hypr_bg') || 'rgba(17, 17, 27, 0.95)';
            const savedText = localStorage.getItem('hypr_text') || '#cdd6f4'; // NUEVO
            const savedFont = localStorage.getItem('hypr_font') || "-apple-system, 'SF Pro Text', sans-serif";

            applyProperty('--border-color', savedAccent);
            applyProperty('--bg-color', savedBg);
            applyProperty('--text-main', savedText); // APLICA COLOR TEXTO
            applyProperty('--main-font', savedFont); // APLICA FUENTE

            if (accentPicker) accentPicker.value = savedAccent;
            if (bgPicker) bgPicker.value = savedBg;
            if (textPicker) textPicker.value = savedText;
            if (fontSelect) fontSelect.value = savedFont;
            
            updateVisualLabels();
        };

        // --- EVENTOS ---
        openBtn?.addEventListener('click', () => panel?.classList.remove('hidden'));
        closeBtn?.addEventListener('click', () => panel?.classList.add('hidden'));

        // Cambio de Fuente
        fontSelect?.addEventListener('change', (e) => {
            const val = (e.target as HTMLSelectElement).value;
            applyProperty('--main-font', val);
            localStorage.setItem('hypr_font', val);
        });

        // Color de Acento
        accentPicker?.addEventListener('input', (e) => {
            const val = (e.target as HTMLInputElement).value;
            applyProperty('--border-color', val);
            localStorage.setItem('hypr_accent', val);
            updateVisualLabels();
        });

        // Color de Fondo
        bgPicker?.addEventListener('input', (e) => {
            const val = (e.target as HTMLInputElement).value;
            applyProperty('--bg-color', val);
            localStorage.setItem('hypr_bg', val);
            updateVisualLabels();
        });

        // Color de Texto (NUEVO)
        textPicker?.addEventListener('input', (e) => {
            const val = (e.target as HTMLInputElement).value;
            applyProperty('--text-main', val);
            localStorage.setItem('hypr_text', val);
            updateVisualLabels();
        });

        loadPrefs();

    } catch (error) {
        console.error("Error crítico en initSettings:", error);
    }
}