// chatUtils.ts
const getElement = (id: string) => document.getElementById(id);

export function linkify(text: string): string {
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;

    return text.replace(urlPattern, (url) => {
        const isImage = /\.(jpeg|jpg|gif|png|webp|svg)([?#]|$)/i.test(url);

        if (isImage) {
            const escapedUrl = url.replace(/'/g, "\\'");
            const fallback = `this.closest('.chat-image-container').innerHTML='<a href=\\'${escapedUrl}\\' target=\\'_blank\\' rel=\\'noopener noreferrer\\' class=\\'chat-link\\'>${escapedUrl}</a>'`;
            return `<div class="chat-image-container">
                <a href="${url}" target="_blank" rel="noopener noreferrer">
                    <img src="${url}"
                         class="chat-inline-img"
                         loading="lazy"
                         referrerpolicy="no-referrer"
                         onerror="${fallback}">
                </a>
            </div>`;
        }

        return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
    });
}

export function saveCredentials(user: string, pass: string, server: string, alias: string) {
    localStorage.setItem('hypr_remember_user', user);
    localStorage.setItem('hypr_remember_pass', pass);
    localStorage.setItem('hypr_last_server', server);
    localStorage.setItem('hypr_last_alias', alias);
}

export function getSavedCredentials() {
    return {
        user: localStorage.getItem('hypr_remember_user') || "",
        pass: localStorage.getItem('hypr_remember_pass') || "",
        server: localStorage.getItem('hypr_last_server') || "",
        alias: localStorage.getItem('hypr_last_alias') || ""
    };
}

/**
 * Hace scroll al fondo del chat.
 * @param waitForImages - si es true, espera a que las imágenes del historial carguen antes de hacer scroll
 */
export function scrollToBottom(waitForImages = false) {
    const chatBox = getElement('chat-box');
    if (!chatBox) return;

    const doScroll = () => {
        requestAnimationFrame(() => {
            chatBox.scrollTop = chatBox.scrollHeight;
        });
    };

    if (waitForImages) {
        // Toma todas las imágenes que aún no han sido marcadas como procesadas
        const imgs = Array.from(
            chatBox.querySelectorAll<HTMLImageElement>('img:not([data-scroll-tracked])')
        );

        if (imgs.length === 0) {
            doScroll();
            return;
        }

        let pending = imgs.length;
        const onSettled = () => {
            pending--;
            if (pending <= 0) doScroll();
        };

        imgs.forEach(img => {
            img.setAttribute('data-scroll-tracked', '1');
            if (img.complete) {
                onSettled();
            } else {
                img.addEventListener('load', onSettled, { once: true });
                img.addEventListener('error', onSettled, { once: true });
            }
        });

        // Fallback: si las imágenes tardan más de 2s, scroll de todos modos
        setTimeout(doScroll, 2000);
    } else {
        doScroll();
    }
}