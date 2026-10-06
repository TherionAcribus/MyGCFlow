// « Dernières vidéos » (onglet Export) : les exports les plus récents du
// dossier des vidéos, pour les retrouver après avoir fermé l'écran de fin.
// Un clic sur une vidéo rouvre cet écran (aperçu, lecteur, copie) ; chaque
// ligne propose aussi « Afficher dans le dossier » et « Supprimer ».

import { CONFIG } from './init.js';
import { showToast, t } from './notifications.js';
import { formatVideoSize, showVideoReady } from './video_ready.js';

const LIMIT = 8;
// Délai laissé pour confirmer une suppression avant que le bouton ne se réarme.
const DELETE_CONFIRM_MS = 4000;

// Jeton anti-course : seule la dernière liste demandée est affichée.
let refreshToken = 0;

const el = (id) => document.getElementById(id);

function formatDate(epochSeconds) {
    const date = new Date(epochSeconds * 1000);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(document.documentElement.lang || undefined, {
        dateStyle: 'short', timeStyle: 'short',
    });
}

function iconButton(icon, label, extraClass = 'btn-secondary') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn-sm flex-shrink-0 text-nowrap ${extraClass}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    const glyph = document.createElement('i');
    glyph.className = `ti ${icon}`;
    glyph.setAttribute('aria-hidden', 'true');
    button.appendChild(glyph);
    return button;
}

function postJson(route, body) {
    return fetch(`${CONFIG.BASE_URL}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then((response) => response.json());
}

function revealVideo(file) {
    postJson('reveal_video', { file })
        .then((data) => { if (!data?.success) throw new Error(data?.message); })
        .catch((error) => {
            showToast(error?.message || t('Impossible d’afficher la vidéo dans son dossier'), 'error', t('Vidéo'), 6000);
        });
}

// Suppression en deux temps, sans fenêtre de confirmation : le premier clic
// arme le bouton (« Supprimer ? »), le second supprime. Sans second clic, le
// bouton se réarme tout seul.
function bindDelete(button, file) {
    const label = t('Supprimer');
    let armedTimer = null;
    const disarm = () => {
        clearTimeout(armedTimer);
        armedTimer = null;
        button.classList.replace('btn-danger', 'btn-ghost-danger');
        button.querySelector('.recent-video-confirm')?.remove();
        button.title = label;
        button.setAttribute('aria-label', label);
    };
    button.addEventListener('click', () => {
        if (!armedTimer) {
            button.classList.replace('btn-ghost-danger', 'btn-danger');
            const text = document.createElement('span');
            text.className = 'recent-video-confirm ms-1';
            text.textContent = t('Supprimer ?');
            button.appendChild(text);
            const confirmLabel = t('Confirmer la suppression de ${name}', { name: file });
            button.title = confirmLabel;
            button.setAttribute('aria-label', confirmLabel);
            armedTimer = setTimeout(disarm, DELETE_CONFIRM_MS);
            return;
        }
        disarm();
        button.disabled = true;
        postJson('api/videos/delete', { file })
            .then((data) => {
                if (!data?.success) throw new Error(data?.message);
                showToast(
                    data.recoverable ? t('Vidéo envoyée à la Corbeille.') : t('Vidéo supprimée.'),
                    'success', t('Vidéo'),
                );
            })
            .catch((error) => {
                showToast(error?.message || t('La vidéo n’a pas pu être supprimée.'), 'error', t('Vidéo'), 6000);
            })
            .finally(refreshRecentVideos);
    });
}

function buildRow(video, folder) {
    const row = document.createElement('li');
    row.className = 'list-group-item d-flex align-items-center gap-2 py-2';
    row.dataset.file = video.file;

    const open = document.createElement('button');
    open.type = 'button';
    // .btn est un conteneur flex : en colonne, le nom passe au-dessus de la
    // date et de la taille au lieu de se serrer à côté.
    open.className = 'btn btn-link p-0 text-start text-break flex-fill flex-column align-items-start recent-video-open';
    const name = document.createElement('span');
    name.className = 'd-block';
    name.textContent = video.file;
    const meta = document.createElement('small');
    meta.className = 'd-block text-muted';
    meta.textContent = [formatDate(video.modified), formatVideoSize(video.size_bytes)].filter(Boolean).join(' · ');
    open.append(name, meta);
    open.addEventListener('click', () => showVideoReady({ ...video, folder }));

    const reveal = iconButton('ti-folder-open', t('Afficher dans le dossier'));
    reveal.addEventListener('click', () => revealVideo(video.file));
    const remove = iconButton('ti-trash', t('Supprimer'), 'btn-ghost-danger recent-video-delete');
    bindDelete(remove, video.file);

    row.append(open, reveal, remove);
    return row;
}

export function refreshRecentVideos() {
    const list = el('recentVideosList');
    if (!list) return Promise.resolve();
    const token = ++refreshToken;
    return fetch(`${CONFIG.BASE_URL}/api/videos?limit=${LIMIT}`)
        .then((response) => response.json())
        .then((data) => {
            if (token !== refreshToken || !data?.success) return;
            const videos = data.videos || [];
            list.replaceChildren(...videos.map((video) => buildRow(video, data.folder)));
            list.hidden = videos.length === 0;
            const empty = el('recentVideosEmpty');
            if (empty) empty.hidden = videos.length > 0;
            const more = el('recentVideosMore');
            if (more) {
                const hiddenCount = (data.total || 0) - videos.length;
                more.textContent = hiddenCount > 1
                    ? t('${n} autres vidéos dans le dossier.', { n: hiddenCount })
                    : hiddenCount === 1 ? t('1 autre vidéo dans le dossier.') : '';
                more.hidden = hiddenCount <= 0;
            }
        })
        .catch((error) => console.warn('[RECENT VIDEOS] Liste indisponible :', error));
}

function initRecentVideos() {
    if (!el('recentVideosList')) return;
    // Nouvel export, ou autre dossier : la liste ne décrit plus le dossier.
    window.addEventListener('mygcflow:video-exported', refreshRecentVideos);
    window.addEventListener('mygcflow:video-folder-changed', refreshRecentVideos);
    refreshRecentVideos();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRecentVideos);
} else {
    initRecentVideos();
}
