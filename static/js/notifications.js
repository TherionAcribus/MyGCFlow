/**
 * Système de notifications toast avec progress bars
 * Remplace les modales bloquantes par des indicateurs non-intrusifs
 */

import { getBsModal } from './ui_bootstrap.js';

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

        // Déduplication : un toast déjà affiché avec exactement le même
        // titre et le même message n'est pas réempilé — sa durée est
        // simplement relancée (évite les piles de notifications identiques
        // sur des actions répétées).
        const dedupKey = `${title}\n${message}`;
        const existing = [...this.container.querySelectorAll('.gcm-toast')]
            .find(el => !el._gcmHiding && el._gcmDedupKey === dedupKey);
        if (existing) {
            if (existing._gcmHideTimer) {
                clearTimeout(existing._gcmHideTimer);
                existing._gcmHideTimer = null;
            }
            if (existing._gcmDuration > 0) {
                existing._gcmHideTimer = setTimeout(() => this.hide(existing), existing._gcmDuration);
            }
            return existing;
        }

        const toast = document.createElement('div');
        toast.className = `gcm-toast ${type}`;

        // Annonce aux lecteurs d'écran : les erreurs interrompent (alert),
        // les autres attendent la fin de la lecture courante (status/polite).
        // aria-atomic pour que titre + message soient lus d'un bloc.
        if (type === 'error') {
            toast.setAttribute('role', 'alert');
        } else {
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');
        }
        toast.setAttribute('aria-atomic', 'true');

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

        // Le × seul n'a pas de nom accessible pour les lecteurs d'écran.
        toast.querySelector('.gcm-toast-close').setAttribute('aria-label', t('Fermer'));

        // Métadonnées internes : clé de déduplication (le titre est conservé
        // à part pour que updateMessage puisse la recalculer), durée et
        // caractère persistant (fermeture manuelle) pour le plafond de pile.
        toast._gcmDedupKey = dedupKey;
        toast._gcmDedupTitle = title;
        toast._gcmDuration = duration;
        toast._gcmPersistent = duration <= 0;

        this.container.appendChild(toast);

        // Animation d'entrée
        setTimeout(() => toast.classList.add('show'), 10);

        // Auto-suppression si durée définie. Le minuteur est mémorisé pour
        // pouvoir être relancé (déduplication) ou annulé (hide).
        if (duration > 0) {
            toast._gcmHideTimer = setTimeout(() => {
                this.hide(toast);
            }, duration);
        }

        // Plafond de pile : au-delà de 3 toasts affichés, le plus ancien est
        // retiré. Un toast persistant (chargement, fermeture manuelle) n'est
        // évincé que s'il n'y a pas d'alternative non-persistante — et le
        // toast qui vient d'être créé n'est jamais sa propre victime.
        const MAX_VISIBLE_TOASTS = 3;
        const visibleToasts = [...this.container.querySelectorAll('.gcm-toast')]
            .filter(el => !el._gcmHiding);
        while (visibleToasts.length > MAX_VISIBLE_TOASTS) {
            const victim = visibleToasts.find(el => el !== toast && !el._gcmPersistent)
                || visibleToasts.find(el => el !== toast);
            if (!victim) break;
            visibleToasts.splice(visibleToasts.indexOf(victim), 1);
            this.hide(victim);
        }

        return toast;
    }

    /**
     * Masque une notification
     * @param {HTMLElement} toast - Élément toast à masquer
     */
    hide(toast) {
        if (!toast) return;
        // Les confirmations sont désormais de vraies modales Bootstrap :
        // les fermer via l'API Bootstrap (backdrop, focus) plutôt qu'en
        // retirer le nœud, ce qui laisserait le fond grisé.
        if (toast.classList && toast.classList.contains('gcm-confirm-modal')) {
            const modal = getBsModal(toast);
            if (modal) {
                modal.hide();
            } else {
                toast.remove();
            }
            return;
        }
        // Marqué « en cours de fermeture » : ni la déduplication ni le
        // plafond de pile ne le comptent pendant la transition de sortie.
        toast._gcmHiding = true;
        if (toast._gcmHideTimer) {
            clearTimeout(toast._gcmHideTimer);
            toast._gcmHideTimer = null;
        }
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
            // La clé de déduplication suit le texte réellement affiché.
            if (toast._gcmDedupKey !== undefined) {
                toast._gcmDedupKey = `${toast._gcmDedupTitle}\n${message}`;
            }
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

// Fonction pour afficher une confirmation — vraie modale Bootstrap
// (role="dialog", aria-modal, focus piégé, Échap/backdrop = annulation),
// contrairement à l'ancien toast dont les boutons n'étaient pas annoncés
// et où Confirmer était en vert/Annuler en rouge alors que l'action
// confirmée pouvait être destructive.
let confirmSeq = 0;

export function showConfirmation(message, title = t('Confirmation'), onConfirm = null, onCancel = null, options = {}) {
    const {
        confirmText = t('Confirmer'),
        cancelText = t('Annuler'),
        danger = false,
    } = options;

    confirmSeq += 1;
    const titleId = `gcm-confirm-title-${confirmSeq}`;
    const descId = `gcm-confirm-desc-${confirmSeq}`;

    const modalEl = document.createElement('div');
    modalEl.className = 'modal bs-modal fade gcm-confirm-modal';
    modalEl.tabIndex = -1;
    modalEl.setAttribute('aria-labelledby', titleId);
    modalEl.setAttribute('aria-describedby', descId);
    // Seuls les intitulés passent par textContent : aucun HTML injecté,
    // quelle que soit la chaîne traduite.
    modalEl.innerHTML = `
        <div class="modal-dialog modal-dialog-centered modal-sm">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title gcm-confirm-title" id="${titleId}"></h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body"><p class="mb-0 gcm-confirm-message" id="${descId}"></p></div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-gcm-role="cancel"></button>
                    <button type="button" class="btn" data-gcm-role="confirm"></button>
                </div>
            </div>
        </div>`;
    modalEl.querySelector(`#${titleId}`).textContent = title;
    modalEl.querySelector(`#${descId}`).textContent = message;
    const closeBtn = modalEl.querySelector('.btn-close');
    const cancelBtn = modalEl.querySelector('[data-gcm-role="cancel"]');
    const confirmBtn = modalEl.querySelector('[data-gcm-role="confirm"]');
    closeBtn.setAttribute('aria-label', t('Fermer'));
    cancelBtn.textContent = cancelText;
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.add(danger ? 'btn-danger' : 'btn-primary');

    document.body.appendChild(modalEl);

    // Bootstrap rend le focus à l'élément déclencheur, mais ici l'ouverture
    // est programmatique : on le restaure nous-mêmes à la fermeture.
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const modal = getBsModal(modalEl);
    if (!modal) {
        // Bootstrap indisponible : ne pas exécuter une action potentiellement
        // destructive sans confirmation réelle.
        modalEl.remove();
        if (onCancel) onCancel();
        return null;
    }

    let settled = false;
    confirmBtn.addEventListener('click', () => {
        settled = true;
        modal.hide();
        if (onConfirm) onConfirm();
    });
    cancelBtn.addEventListener('click', () => {
        settled = true;
        modal.hide();
        if (onCancel) onCancel();
    });

    // À l'ouverture, focus sur l'action la moins risquée (Annuler pour une
    // action destructive, Confirmer sinon).
    modalEl.addEventListener('shown.bs.modal', () => {
        (danger ? cancelBtn : confirmBtn).focus();
    });
    // Échap, clic sur le backdrop ou croix = annulation.
    modalEl.addEventListener('hidden.bs.modal', () => {
        if (!settled) {
            settled = true;
            if (onCancel) onCancel();
        }
        modalEl.remove();
        // Différé : le focus trap de Bootstrap se désactive dans son propre
        // handler 'hidden' et pourrait reprendre le focus après nous.
        if (previouslyFocused && document.contains(previouslyFocused)) {
            setTimeout(() => previouslyFocused.focus({ preventScroll: true }), 0);
        }
    });

    modal.show();
    return modalEl;
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
