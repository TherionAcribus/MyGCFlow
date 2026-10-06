// Écran de fin d'export : présente la vidéo qui vient d'être produite (aperçu,
// nom, taille, durée, dossier) et les actions pour y accéder. Les deux
// pipelines d'enregistrement l'appellent avec le résultat renvoyé par le
// serveur (cf. describe_video dans capture.py).

import { CONFIG } from './init.js';
import { showToast, t } from './notifications.js';
import { hideBsModal, showBsModal } from './ui_bootstrap.js';
import { fetchWithTimeout, FETCH_TIMEOUTS } from './fetch_with_timeout.mjs';

const MODAL_ID = 'modal_video_ready';

// Fichier présenté par la modale ; les boutons agissent sur lui.
let currentFile = null;
let bound = false;

function videoUrl(file, { inline = false } = {}) {
    const url = `${CONFIG.BASE_URL}/download_video/${encodeURIComponent(file)}`;
    return inline ? `${url}?inline=1` : url;
}

function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const locale = document.documentElement.lang || undefined;
    const megabytes = bytes / (1024 * 1024);
    if (megabytes >= 1024) {
        const n = (megabytes / 1024).toLocaleString(locale, { maximumFractionDigits: 2 });
        return t('${n} Go', { n });
    }
    const n = megabytes.toLocaleString(locale, { maximumFractionDigits: megabytes < 10 ? 1 : 0 });
    return t('${n} Mo', { n });
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

// Les deux actions qui lancent un programme sur la machine (Explorateur,
// lecteur vidéo) passent par le serveur local : le navigateur n'y a pas accès.
function postVideoAction(route, errorMessage) {
    if (!currentFile) return;
    fetchWithTimeout(`${CONFIG.BASE_URL}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: currentFile }),
    }, { timeoutMs: FETCH_TIMEOUTS.control, t })
        .then((response) => response.json())
        .then((data) => {
            if (!data?.success) throw new Error(data?.message || errorMessage);
        })
        .catch((error) => {
            showToast(error?.message || errorMessage, 'error', t('Vidéo'), 6000);
        });
}

function downloadCopy(file) {
    const a = document.createElement('a');
    a.href = videoUrl(file);
    a.download = file;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
}

// « Enregistrer sous » : le sélecteur de fichier du navigateur laisse choisir
// le dossier et le nom. Là où il n'existe pas (Firefox, Safari), repli sur un
// téléchargement classique.
async function saveCopyAs() {
    const file = currentFile;
    if (!file) return;
    if (typeof window.showSaveFilePicker !== 'function') {
        downloadCopy(file);
        return;
    }
    let handle;
    try {
        const extension = file.includes('.') ? file.slice(file.lastIndexOf('.')) : '.mp4';
        handle = await window.showSaveFilePicker({
            suggestedName: file,
            types: [{
                description: t('Vidéo'),
                accept: { [extension === '.webm' ? 'video/webm' : 'video/mp4']: [extension] },
            }],
        });
    } catch (error) {
        // Sélecteur fermé sans choisir : rien à signaler.
        if (error?.name === 'AbortError') return;
        downloadCopy(file);
        return;
    }
    const button = document.getElementById('btnVideoReadySaveAs');
    if (button) button.disabled = true;
    try {
        const response = await fetch(videoUrl(file));
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        // pipeTo ferme le fichier en fin de flux, sans charger la vidéo en mémoire.
        await response.body.pipeTo(await handle.createWritable());
        showToast(t('Copie enregistrée : ${name}', { name: handle.name }), 'success', t('Vidéo'));
    } catch (error) {
        console.error('[VIDEO READY] Copie échouée :', error);
        showToast(t('La copie de la vidéo a échoué.'), 'error', t('Vidéo'), 6000);
    } finally {
        if (button) button.disabled = false;
    }
}

function bindOnce() {
    if (bound) return;
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    bound = true;
    document.getElementById('btnVideoReadyReveal')?.addEventListener('click', () => {
        postVideoAction('reveal_video', t('Impossible d’afficher la vidéo dans son dossier'));
    });
    document.getElementById('btnVideoReadyOpen')?.addEventListener('click', () => {
        // Deux lectures simultanées sinon : l'aperçu et le lecteur du système.
        try { document.getElementById('videoReadyPlayer')?.pause(); } catch (_) {}
        postVideoAction('open_video', t('Impossible d’ouvrir la vidéo'));
    });
    document.getElementById('btnVideoReadySaveAs')?.addEventListener('click', saveCopyAs);
    // Vidéo illisible par ce navigateur (4:4:4, codec absent) : mieux vaut pas
    // d'aperçu qu'un cadre noir. Le fichier, lui, est bon — les actions restent.
    document.getElementById('videoReadyPlayer')?.addEventListener('error', (event) => {
        if (event.target.getAttribute('src')) event.target.hidden = true;
    });
    modal.addEventListener('hidden.bs.modal', () => {
        const player = document.getElementById('videoReadyPlayer');
        if (!player) return;
        try { player.pause(); } catch (_) {}
        player.removeAttribute('src');
        try { player.load(); } catch (_) {}
    });
}

/**
 * Ouvre l'écran de fin d'export pour une vidéo du dossier des vidéos.
 * @param {{file?: string, folder?: string, size_bytes?: number, duration_seconds?: number}} info
 * @returns {boolean} false si la modale n'a pas pu être affichée (fichier
 *   inconnu, page sans modale) : à l'appelant de prévenir autrement.
 */
export function showVideoReady(info) {
    const file = info?.file;
    const modal = document.getElementById(MODAL_ID);
    if (!file || !modal) return false;
    bindOnce();
    currentFile = file;

    const fileEl = document.getElementById('videoReadyFile');
    if (fileEl) fileEl.textContent = file;
    const metaEl = document.getElementById('videoReadyMeta');
    if (metaEl) {
        metaEl.textContent = [formatDuration(info.duration_seconds), formatSize(info.size_bytes)]
            .filter(Boolean).join(' · ');
    }
    const folderEl = document.getElementById('videoReadyFolder');
    if (folderEl) folderEl.textContent = info.folder || '';

    const player = document.getElementById('videoReadyPlayer');
    // #t : fait afficher une première image au lieu d'un cadre noir tant que
    // la lecture n'a pas été lancée.
    if (player) {
        player.hidden = false;
        player.src = `${videoUrl(file, { inline: true })}#t=0.1`;
    }

    showBsModal(MODAL_ID);
    return true;
}

export function hideVideoReady() {
    hideBsModal(MODAL_ID);
}
