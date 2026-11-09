// Page Statistiques : sauvegarde du document des tableaux de bord
// (file d'écriture, révision, conflit, copie de secours).

import { showConfirmation, showError, t } from './notifications.js';
import { markSaved, markSaveError, markSaving } from './saved_indicator.mjs';
import { closingSaveRequest, createSaveQueue } from './dashboard_saver.mjs';
import { normalizeDocument } from './dashboard_model.mjs';
import { renderDashboard } from './stats_page_cards.js';
import { $, SAVE_DELAY_MS, SAVE_RETRY_DELAY_MS, state } from './stats_page_state.js';

// ---------------------------------------------------------------------------
// Sauvegarde
// ---------------------------------------------------------------------------

// Une écriture à la fois ; la dernière version du document gagne. En-tête
// X-Dashboard-Rev : la révision chargée — si le fichier a bougé depuis
// (autre onglet), le serveur répond 409 plutôt que d'écraser à l'aveugle.
export const saveQueue = createSaveQueue(async (doc, rev) => {
    try {
        const response = await fetch('/api/dashboards', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json',
                       'X-Dashboard-Rev': rev === null ? 'none' : rev },
            body: JSON.stringify(doc),
        });
        const body = await response.json().catch(() => ({}));
        if (response.status === 409) return { ok: 'conflict' };
        if (!response.ok || body.success === false) return { ok: false };
        return { ok: true, rev: typeof body.rev === 'string' ? body.rev : rev };
    } catch (_) {
        return { ok: false };
    }
});

export function flushSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (!state.docDirty) return Promise.resolve(true);
    const seq = state.saveSeq;
    const status = $('statsSaveStatus');
    markSaving(status);
    state.saveFailed = false;
    return saveQueue.push(state.doc, state.docRev).then((result) => {
        if (result?.ok === true) {
            state.docRev = result.rev ?? state.docRev;
            // Modifié pendant le vol : reste « à enregistrer », le minuteur
            // armé par scheduleSave renverra la file.
            if (state.saveSeq === seq) state.docDirty = false;
            markSaved(status);
            return true;
        }
        if (result?.ok === 'conflict') {
            handleSaveConflict();
            return false;
        }
        state.saveFailed = true;
        markSaveError(status);
        scheduleSaveRetry();
        return false;
    });
}

// « Non enregistré » : une relance automatique, puis un clic sur l'état
// en propose une autre (le document reste en file tant qu'il n'est pas écrit).
function scheduleSaveRetry() {
    clearTimeout(state.saveRetryTimer);
    state.saveRetryTimer = setTimeout(() => {
        if (state.docDirty && state.saveFailed) flushSave();
    }, SAVE_RETRY_DELAY_MS);
}

// Le fichier a changé depuis notre chargement (autre onglet, autre machine) :
// l'utilisateur choisit d'écraser ou de reprendre la version du disque.
// `conflictOpen` évite d'empiler les dialogues si une écriture échoue de
// nouveau pendant que la première est affichée.
async function handleSaveConflict() {
    if (state.conflictOpen) return;
    state.conflictOpen = true;
    markSaveError($('statsSaveStatus'));
    let body;
    try {
        body = await (await fetch('/api/dashboards', { headers: { Accept: 'application/json' } })).json();
    } catch (_) {
        state.conflictOpen = false;
        state.saveFailed = true;
        scheduleSaveRetry();
        return;
    }
    const other = normalizeDocument(body.document);
    const rev = typeof body.rev === 'string' ? body.rev : null;
    showConfirmation(
        t('Ce tableau de bord a été modifié dans un autre onglet. Écraser ces modifications par les vôtres ?'),
        t('Conflit de sauvegarde'),
        () => {
            state.conflictOpen = false;
            state.docRev = rev;
            state.docDirty = true;
            state.saveFailed = false;
            flushSave();
        },
        () => {
            state.conflictOpen = false;
            state.saveFailed = false;
            // Plus rien à reprendre côté disque : garder notre version.
            if (other) {
                state.doc = other;
                state.docRev = rev;
                state.docDirty = false;
                markSaved($('statsSaveStatus'));
                renderDashboard();
                return;
            }
            state.docRev = rev;
            state.docDirty = true;
            flushSave();
        },
        { confirmText: t('Écraser'), cancelText: t('Reprendre l\'autre version'), danger: true });
}

// Actions discrètes (ajout, suppression, déplacement) : `immediate`, pour
// qu'un rechargement juste après ne perde rien.
export function scheduleSave({ immediate = false } = {}) {
    state.docDirty = true;
    state.saveSeq += 1;
    state.saveFailed = false;
    clearTimeout(state.saveTimer);
    if (immediate) return flushSave();
    state.saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
    return null;
}

// Fichier illisible au chargement : proposer la copie de sécurité `.bak`.
// Refus ou échec → document neuf (le serveur garde le corrompu sous
// `.corrupt` au lieu de l'écraser, la preuve et la `.bak` survivent).
export function recoverCorruptDocument() {
    if (!state.backupAvailable) {
        showError(t('Le fichier des tableaux de bord est illisible et aucune sauvegarde n\'existe : un tableau neuf sera créé.'));
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        showConfirmation(
            t('Le fichier des tableaux de bord est illisible. Restaurer la dernière sauvegarde ?'),
            t('Tableaux de bord'),
            () => restoreBackupDocument().then(resolve),
            () => resolve(null),
            { confirmText: t('Restaurer'), cancelText: t('Repartir à zéro') });
    });
}

async function restoreBackupDocument() {
    try {
        const response = await fetch('/api/dashboards/restore', { method: 'POST' });
        const body = await response.json();
        if (!response.ok || body.success === false) throw new Error(body.error || `HTTP ${response.status}`);
        state.docRev = typeof body.rev === 'string' ? body.rev : null;
        const doc = normalizeDocument(body.document);
        if (doc) return doc;
        throw new Error('empty');
    } catch (e) {
        console.warn('[stats] Restauration impossible :', e?.message || e);
    }
    showError(t('La restauration de la sauvegarde a échoué.'));
    return null;
}

window.addEventListener('pagehide', () => {
    if (!state.docDirty) return;
    // Dernière chance : keepalive survit au déchargement de la page. La
    // révision voyage aussi : un conflit est refusé plutôt qu'écrasé.
    // Au-delà de 64 Kio, le navigateur refuse l'envoi keepalive : seul le
    // tableau affiché part alors (closingSaveRequest).
    const request = closingSaveRequest(state.doc);
    if (!request) return;
    try {
        fetch(request.url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json',
                       'X-Dashboard-Rev': state.docRev === null ? 'none' : state.docRev },
            body: request.body,
            keepalive: true,
        }).catch(() => {});
    } catch (_) {}
});

