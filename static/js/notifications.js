/**
 * Système de notifications toast avec progress bars
 * Remplace les modales bloquantes par des indicateurs non-intrusifs
 */

class NotificationManager {
    constructor() {
        this.container = null;
        this.init();
    }

    init() {
        // Créer le conteneur de toasts (avec classes namespacées pour éviter les conflits CSS)
        this.container = document.createElement('div');
        this.container.className = 'gcm-toast-container';
        document.body.appendChild(this.container);
    }

    ensureContainer() {
        // Si le conteneur a été supprimé du DOM (par erreur ou nettoyage trop large), le recréer
        try {
            if (!this.container || !(this.container instanceof HTMLElement)) {
                this.init();
                return;
            }
            if (!document.body.contains(this.container)) {
                document.body.appendChild(this.container);
            }
        } catch (_) {
            try { this.init(); } catch (_) {}
        }
    }

    /**
     * Affiche une notification toast
     * @param {string} message - Message principal
     * @param {string} type - Type: 'info', 'success', 'warning', 'error'
     * @param {string} title - Titre optionnel
     * @param {number} duration - Durée en ms (0 = manuel)
     * @param {boolean} showProgress - Afficher une progress bar
     * @param {number} progress - Valeur initiale du progrès (0-100)
     */
    show(message, type = 'info', title = '', duration = 5000, showProgress = false, progress = 0) {
        this.ensureContainer();
        const toast = document.createElement('div');
        toast.className = `gcm-toast ${type}`;

        const iconMap = {
            info: '',
            success: '',
            warning: '',
            error: ''
        };

        toast.innerHTML = `
            <div class="gcm-toast-icon">${iconMap[type] || ''}</div>
            <div class="gcm-toast-content">
                ${title ? `<div class="gcm-toast-title">${title}</div>` : ''}
                <div class="gcm-toast-message">${message}</div>
                ${showProgress ? `
                    <div class="gcm-toast-progress">
                        <div class="gcm-progress-bar">
                            <div class="gcm-progress-fill${progress <= 0 ? ' indeterminate' : ''}" style="width: ${progress <= 0 ? '30' : progress}%"></div>
                        </div>
                    </div>
                ` : ''}
            </div>
            <button class="gcm-toast-close" onclick="this.parentElement.remove()">×</button>
        `;

        this.container.appendChild(toast);

        // Animation d'entrée
        setTimeout(() => toast.classList.add('show'), 10);

        // Auto-suppression si durée définie
        if (duration > 0) {
            setTimeout(() => {
                this.hide(toast);
            }, duration);
        }

        return toast;
    }

    /**
     * Masque une notification
     * @param {HTMLElement} toast - Élément toast à masquer
     */
    hide(toast) {
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }

    /**
     * Met à jour la progress bar d'une notification
     * @param {HTMLElement} toast - Élément toast
     * @param {number} progress - Valeur du progrès (0-100). Si <= 0 ou NaN, garde l'animation indéterminée
     */
    updateProgress(toast, progress) {
        const progressFill = toast.querySelector('.gcm-progress-fill');
        if (progressFill) {
            const clampedProgress = Math.min(100, Math.max(0, progress));

            // Si la progression est 0 ou invalide, activer l'animation indéterminée
            if (clampedProgress === 0 || isNaN(progress) || progress < 0) {
                // Activer l'animation indéterminée
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '30%'; // Largeur de base pour l'animation
            } else {
                // Progression réelle connue, désactiver l'animation et mettre la vraie valeur
                progressFill.style.width = `${clampedProgress}%`;
                progressFill.classList.remove('indeterminate');
            }
        }
    }

    /**
     * Met à jour le texte principal d'une notification (ex: progression d'un
     * transfert réseau exprimée en %, changement de phase d'un traitement).
     * @param {HTMLElement} toast - Élément toast
     * @param {string} message - Nouveau message
     */
    updateMessage(toast, message) {
        const messageEl = toast && toast.querySelector('.gcm-toast-message');
        if (messageEl) {
            messageEl.textContent = message;
        }
    }

    /**
     * Marque la progress bar comme indéterminée (animation continue)
     * @param {HTMLElement} toast - Élément toast
     */
    setIndeterminateProgress(toast) {
        const progressFill = toast.querySelector('.gcm-progress-fill');
        if (progressFill) {
            progressFill.classList.add('indeterminate');
            progressFill.style.width = '30%'; // Largeur de base pour l'animation
        }
    }

    /**
     * Affiche une notification de chargement avec progress bar
     * @param {string} message - Message de chargement
     * @param {string} title - Titre optionnel
     */
    showLoading(message = t('Chargement en cours...'), title = t('Chargement')) {
        return this.show(message, 'info', title, 0, true, 0);
    }

    /**
     * Cache toutes les notifications
     */
    clearAll() {
        this.ensureContainer();
        const toasts = this.container.querySelectorAll('.gcm-toast');
        toasts.forEach(toast => this.hide(toast));
    }
}

// Instance globale
const notificationManager = new NotificationManager();

export function t(msgid, vars) {
    try {
        if (typeof globalThis !== 'undefined' && typeof globalThis.t === 'function') {
            return globalThis.t(msgid, vars);
        }
    } catch (_) {}
    if (vars && typeof vars === 'object') {
        try {
            return String(msgid).replace(/\$\{(\w+)\}/g, (m, key) => {
                if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null) {
                    return String(vars[key]);
                }
                return m;
            });
        } catch (_) {}
    }
    return msgid;
}

// Fonctions d'export pour un usage facile
export function showToast(message, type = 'info', title = '', duration = 5000) {
    const msg = (typeof message === 'string') ? t(message) : message;
    const ttl = (typeof title === 'string' && title) ? t(title) : title;
    return notificationManager.show(msg, type, ttl, duration, false);
}

export function showLoadingToast(message = t('Chargement en cours...'), title = t('Chargement')) {
    const msg = (typeof message === 'string') ? t(message) : message;
    const ttl = (typeof title === 'string' && title) ? t(title) : title;
    return notificationManager.showLoading(msg, ttl);
}

export function updateToastProgress(toast, progress) {
    notificationManager.updateProgress(toast, progress);
}

export function updateToastMessage(toast, message) {
    notificationManager.updateMessage(toast, message);
}

export function setIndeterminateProgress(toast) {
    notificationManager.setIndeterminateProgress(toast);
}

export function hideToast(toast) {
    notificationManager.hide(toast);
}

// Gestion centralisée des toasts d'affichage des points
let currentPointsToast = null;

export function showPointsToast(message = t('Affichage des points...'), title = t('Affichage des points')) {
    // Masquer tout toast existant
    if (currentPointsToast) {
        try {
            hideToast(currentPointsToast);
        } catch(e) {
            console.warn('[POINTS_TOAST] Erreur masquage toast existant:', e);
        }
    }

    try {
        currentPointsToast = showLoadingToast(message, title);
        return currentPointsToast;
    } catch(e) {
        console.warn('[POINTS_TOAST] Erreur création toast:', e);
        currentPointsToast = null;
        return null;
    }
}

export function hidePointsToast() {
    if (currentPointsToast) {
        try {
            hideToast(currentPointsToast);
        } catch(e) {
            console.warn('[POINTS_TOAST] Erreur masquage toast:', e);
        }
        currentPointsToast = null;
    }
}

export function clearAllToasts() {
    notificationManager.clearAll();
}

// Fonctions utilitaires pour usage courant
export function showSuccess(message, title = t('Succès')) {
    return showToast(message, "success", title, 5000);
}

export function showError(message, title = t('Erreur')) {
    return showToast(message, "error", title, 8000);
}

export function showWarning(message, title = t('Attention')) {
    return showToast(message, "warning", title, 7000);
}

export function showInfo(message, title = t('Information')) {
    return showToast(message, "info", title, 6000);
}

// Fonction pour afficher une confirmation
export function showConfirmation(message, title = t('Confirmation'), onConfirm = null, onCancel = null) {
    const toast = showToast((typeof message === 'string') ? t(message) : message, "warning", title, 0); // Ne se ferme pas automatiquement

    // Ajouter des boutons personnalisés
    const content = toast.querySelector('.gcm-toast-content');
    if (content) {
        const buttonContainer = document.createElement('div');
        buttonContainer.style.marginTop = '12px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '8px';

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = t('Confirmer');
        confirmBtn.style.padding = '4px 8px';
        confirmBtn.style.background = '#4CAF50';
        confirmBtn.style.color = 'white';
        confirmBtn.style.border = 'none';
        confirmBtn.style.borderRadius = '4px';
        confirmBtn.style.cursor = 'pointer';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = t('Annuler');
        cancelBtn.style.padding = '4px 8px';
        cancelBtn.style.background = '#f44336';
        cancelBtn.style.color = 'white';
        cancelBtn.style.border = 'none';
        cancelBtn.style.borderRadius = '4px';
        cancelBtn.style.cursor = 'pointer';

        confirmBtn.onclick = () => {
            hideToast(toast);
            if (onConfirm) onConfirm();
        };

        cancelBtn.onclick = () => {
            hideToast(toast);
            if (onCancel) onCancel();
        };

        buttonContainer.appendChild(confirmBtn);
        buttonContainer.appendChild(cancelBtn);
        content.appendChild(buttonContainer);
    }

    return toast;
}

// ==================== EXEMPLE D'UTILISATION ====================
// Pour tester le système de notifications, vous pouvez utiliser ces exemples :
//
// // Toast simple
// showToast("Opération réussie !", "success", "Succès");
//
// // Toast avec progress bar
// const loadingToast = showLoadingToast("Chargement en cours...");
// updateToastProgress(loadingToast, 50); // Mettre à jour à 50%
//
// // Toast avec confirmation
// showConfirmation("Êtes-vous sûr de vouloir supprimer ?",
//                  "Confirmation",
//                  () => console.log("Confirmé"),
//                  () => console.log("Annulé"));
//
// // Fonctions utilitaires
// showSuccess("Données sauvegardées");
// showError("Erreur de connexion");
// showWarning("Attention : données non sauvegardées");
// showInfo("Nouveau message disponible");

// Export de la classe pour usage avancé
export { NotificationManager };
export default notificationManager;
