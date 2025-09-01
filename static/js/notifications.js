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
        // Créer le conteneur de toasts
        this.container = document.createElement('div');
        this.container.className = 'toast-container';
        document.body.appendChild(this.container);
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
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const iconMap = {
            info: 'ℹ️',
            success: '✅',
            warning: '⚠️',
            error: '❌'
        };

        toast.innerHTML = `
            <div class="toast-icon">${iconMap[type] || 'ℹ️'}</div>
            <div class="toast-content">
                ${title ? `<div class="toast-title">${title}</div>` : ''}
                <div class="toast-message">${message}</div>
                ${showProgress ? `
                    <div class="toast-progress">
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${progress}%"></div>
                        </div>
                    </div>
                ` : ''}
            </div>
            <button class="toast-close" onclick="this.parentElement.remove()">×</button>
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
     * @param {number} progress - Valeur du progrès (0-100)
     */
    updateProgress(toast, progress) {
        const progressFill = toast.querySelector('.progress-fill');
        if (progressFill) {
            progressFill.style.width = `${Math.min(100, Math.max(0, progress))}%`;
        }
    }

    /**
     * Affiche une notification de chargement avec progress bar
     * @param {string} message - Message de chargement
     * @param {string} title - Titre optionnel
     */
    showLoading(message = 'Chargement en cours...', title = 'Chargement') {
        return this.show(message, 'info', title, 0, true, 0);
    }

    /**
     * Cache toutes les notifications
     */
    clearAll() {
        const toasts = this.container.querySelectorAll('.toast');
        toasts.forEach(toast => this.hide(toast));
    }
}

// Instance globale
const notificationManager = new NotificationManager();

// Fonctions d'export pour un usage facile
export function showToast(message, type = 'info', title = '', duration = 5000) {
    return notificationManager.show(message, type, title, duration, false);
}

export function showLoadingToast(message = 'Chargement en cours...', title = 'Chargement') {
    return notificationManager.showLoading(message, title);
}

export function updateToastProgress(toast, progress) {
    notificationManager.updateProgress(toast, progress);
}

export function hideToast(toast) {
    notificationManager.hide(toast);
}

export function clearAllToasts() {
    notificationManager.clearAll();
}

// Fonctions utilitaires pour usage courant
export function showSuccess(message, title = "Succès") {
    return showToast(message, "success", title, 5000);
}

export function showError(message, title = "Erreur") {
    return showToast(message, "error", title, 8000);
}

export function showWarning(message, title = "Attention") {
    return showToast(message, "warning", title, 7000);
}

export function showInfo(message, title = "Information") {
    return showToast(message, "info", title, 6000);
}

// Fonction pour afficher une confirmation
export function showConfirmation(message, title = "Confirmation", onConfirm = null, onCancel = null) {
    const toast = showToast(message, "warning", title, 0); // Ne se ferme pas automatiquement

    // Ajouter des boutons personnalisés
    const content = toast.querySelector('.toast-content');
    if (content) {
        const buttonContainer = document.createElement('div');
        buttonContainer.style.marginTop = '12px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '8px';

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Confirmer';
        confirmBtn.style.padding = '4px 8px';
        confirmBtn.style.background = '#4CAF50';
        confirmBtn.style.color = 'white';
        confirmBtn.style.border = 'none';
        confirmBtn.style.borderRadius = '4px';
        confirmBtn.style.cursor = 'pointer';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Annuler';
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
