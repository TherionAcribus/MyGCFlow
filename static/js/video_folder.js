// Dossier des vidéos (onglet Export) : affiche le dossier où les exports sont
// enregistrés et permet d'en changer. Le choix passe par le serveur local, seul
// à pouvoir ouvrir le sélecteur de dossier du système et à connaître le chemin
// retenu (cf. /api/video_folder dans blueprints/media.py).

import { CONFIG } from './init.js';
import { t } from './notifications.js';

// Dernier état reçu du serveur ; null tant qu'il n'a pas répondu.
let folderState = null;

const el = (id) => document.getElementById(id);

// Émis après chaque changement : le récapitulatif d'export (ui.js) affiche la
// destination.
function announce() {
    window.dispatchEvent(new CustomEvent('mygcflow:video-folder-changed'));
}

function showError(message) {
    const box = el('videoFolderError');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
}

function render() {
    if (!folderState) return;
    const path = el('videoFolderPath');
    if (path) path.textContent = folderState.folder || '';
    const reset = el('btnVideoFolderReset');
    if (reset) reset.hidden = !!folderState.is_default;
    const warning = el('videoFolderWarning');
    if (warning) {
        const missing = folderState.unavailable_folder;
        warning.textContent = missing
            ? t('Le dossier choisi (${folder}) est inaccessible : les vidéos sont enregistrées dans le dossier par défaut en attendant.', { folder: missing })
            : '';
        warning.hidden = !missing;
    }
}

function applyResponse(data) {
    if (!data?.success) return false;
    folderState = data;
    render();
    announce();
    return true;
}

async function post(route, body) {
    const response = await fetch(`${CONFIG.BASE_URL}/api/video_folder/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    return response.json();
}

function revealManualEntry() {
    const manual = el('videoFolderManual');
    if (!manual) return;
    manual.hidden = false;
    const input = el('inputVideoFolderPath');
    if (input) {
        if (!input.value) input.value = folderState?.folder || '';
        input.focus();
    }
}

// Sans délai d'attente : la requête dure le temps que l'utilisateur choisisse
// dans la boîte de dialogue ouverte par le serveur.
async function chooseFolder() {
    const button = el('btnVideoFolderChoose');
    showError('');
    if (button) button.disabled = true;
    try {
        const data = await post('choose');
        if (data?.picker_unavailable) {
            revealManualEntry();
        } else if (!data?.cancelled && !applyResponse(data)) {
            showError(data?.message || t('Le dossier des vidéos n’a pas pu être modifié.'));
        }
    } catch (error) {
        console.error('[VIDEO FOLDER] Choix du dossier échoué :', error);
        showError(t('Le dossier des vidéos n’a pas pu être modifié.'));
    } finally {
        if (button) button.disabled = false;
    }
}

async function applyManualFolder() {
    const input = el('inputVideoFolderPath');
    showError('');
    try {
        const data = await post('choose', { path: input?.value || '' });
        if (applyResponse(data)) {
            const manual = el('videoFolderManual');
            if (manual) manual.hidden = true;
        } else {
            showError(data?.message || t('Le dossier des vidéos n’a pas pu être modifié.'));
        }
    } catch (error) {
        console.error('[VIDEO FOLDER] Saisie du dossier échouée :', error);
        showError(t('Le dossier des vidéos n’a pas pu être modifié.'));
    }
}

async function resetFolder() {
    showError('');
    try {
        applyResponse(await post('reset'));
    } catch (error) {
        console.error('[VIDEO FOLDER] Retour au dossier par défaut échoué :', error);
        showError(t('Le dossier des vidéos n’a pas pu être modifié.'));
    }
}

/**
 * Destination à afficher dans le récapitulatif d'export : le dossier choisi,
 * ou null pour le dossier par défaut (et tant que le serveur n'a pas répondu).
 */
export function customVideoFolder() {
    return folderState && !folderState.is_default ? folderState.folder : null;
}

function initVideoFolder() {
    if (!el('videoFolderSetting')) return;
    el('btnVideoFolderChoose')?.addEventListener('click', chooseFolder);
    el('btnVideoFolderReset')?.addEventListener('click', resetFolder);
    el('btnVideoFolderApply')?.addEventListener('click', applyManualFolder);
    el('inputVideoFolderPath')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') applyManualFolder();
    });
    fetch(`${CONFIG.BASE_URL}/api/video_folder`)
        .then((response) => response.json())
        .then(applyResponse)
        .catch((error) => console.warn('[VIDEO FOLDER] État du dossier indisponible :', error));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVideoFolder);
} else {
    initVideoFolder();
}
