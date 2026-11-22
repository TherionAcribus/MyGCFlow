// Envois photos/traces de la page Parcours : quelques fichiers à la fois
// plutôt qu'un par un (bien plus court sur un gros lot), et « Arrêter »
// interrompt — les envois partis se terminent, les suivants ne partent pas.
// Chaque lot emporte son jeton : un second envoi démarré en cours de route
// a le sien.
//
// Le parcours cible est lu via `getSelectedId()` AU DÉBUT de l'envoi : tout
// part dans le parcours alors ouvert, en ouvrir un autre en cours de route
// ne déroute pas la suite.
import { showToast, t } from './notifications.js';
import { CONFIG } from './init.js';
import { FETCH_TIMEOUTS, fetchWithTimeout } from './fetch_with_timeout.mjs';
import { refuseSummary } from './parcours_labels.mjs';
import { isImageFile } from './images_model.mjs';
import { isAudioFile } from './music_track.mjs';

const el = (id) => document.getElementById(id);
const UPLOAD_CONCURRENCY = 3;

const UPLOAD_KINDS = {
    photo: {
        field: 'photo',
        path: 'photos',
        status: 'parcoursPhotoStatus',
        stop: 'btnParcoursPhotosStop',
        fullError: 'photos-full',
        progress: (done, total) => t('Envoi des photos : ${done} / ${total}', { done, total }),
        refusedTitle: () => t('Photos refusées'),
        stopped: (sent, total) => t('Envoi interrompu : ${sent} photos sur ${total} envoyées', { sent, total }),
    },
    track: {
        field: 'track',
        path: 'tracks',
        status: 'parcoursTrackStatus',
        stop: 'btnParcoursTracksStop',
        fullError: 'tracks-full',
        progress: (done, total) => t('Envoi des traces : ${done} / ${total}', { done, total }),
        refusedTitle: () => t('Traces refusées'),
        stopped: (sent, total) => t('Envoi interrompu : ${sent} traces sur ${total} envoyées', { sent, total }),
    },
};

// deps : { getSelectedId, reloadAdjustments }
export function createParcoursUploads(deps) {
    const uploadJobs = { photo: [], track: [] };

    function refreshUploadStop(kind) {
        const btn = el(UPLOAD_KINDS[kind].stop);
        if (btn) btn.hidden = uploadJobs[kind].length === 0;
    }

    function cancel(kind) {
        for (const job of uploadJobs[kind]) job.cancel = true;
    }

    async function run(kind, files) {
        const spec = UPLOAD_KINDS[kind];
        const targetId = deps.getSelectedId();
        const status = el(spec.status);
        const job = { cancel: false };
        uploadJobs[kind].push(job);
        refreshUploadStop(kind);
        const refused = [];
        let done = 0;
        let index = 0;
        let fullMessage = null;
        const showProgress = () => {
            if (status) status.textContent = spec.progress(done, files.length);
        };
        showProgress();
        const worker = async () => {
            while (index < files.length && !job.cancel && !fullMessage) {
                const file = files[index++];
                const body = new FormData();
                body.append(spec.field, file, file.name);
                try {
                    const response = await fetchWithTimeout(
                        `${CONFIG.BASE_URL}/api/parcours/${targetId}/${spec.path}`,
                        { method: 'POST', body },
                        { timeoutMs: FETCH_TIMEOUTS.upload, t });
                    if (!response.ok) {
                        const payload = await response.json().catch(() => ({}));
                        const message = payload.message || `HTTP ${response.status}`;
                        refused.push({ name: file.name, message });
                        // Le plafond ne bougera pas d'ici la fin de l'envoi :
                        // les suivants seraient refusés de la même façon.
                        if (payload.error === spec.fullError) fullMessage = message;
                    }
                } catch (error) {
                    refused.push({ name: file.name, message: error.message });
                }
                done++;
                showProgress();
            }
        };
        await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
        uploadJobs[kind].splice(uploadJobs[kind].indexOf(job), 1);
        refreshUploadStop(kind);
        // Jamais partis (plafond atteint) : refusés de la même cause.
        if (fullMessage) {
            for (const rest of files.slice(index)) refused.push({ name: rest.name, message: fullMessage });
        }
        if (status) status.textContent = '';
        if (refused.length) showToast(refuseSummary(refused), 'warning', spec.refusedTitle());
        else if (job.cancel) {
            const sent = files.length - files.slice(index).length;
            showToast(spec.stopped(sent, files.length), 'info', t('Parcours'));
        }
        // Autre parcours ouvert entre-temps : ses entrées sont déjà fraîches.
        // Relecture absorbée : les fichiers sont arrivés, un échec ici
        // n'est qu'un affichage non rafraîchi — signalé, pas propagé
        // (l'appelant n'attend pas la promesse : rejet = unhandled).
        try {
            await deps.reloadAdjustments(targetId, { tracks: kind === 'track' });
        } catch (error) {
            showToast(t('Envoi terminé, mais l’affichage n’a pas pu être rechargé : ${message}', { message: error.message }),
                'warning', t('Parcours'));
        }
    }

    return { run, cancel };
}

const isGpxFile = (file) => /\.gpx$/i.test(file?.name || '');

// Fichiers déposés n'importe où sur la page : les photos rejoignent le
// parcours ouvert (onglet Photos, pour les voir arriver), les .gpx ses traces
// (onglet Données), une musique Animation > Musique. Sans ce gestionnaire, le
// navigateur ouvrirait le fichier à la place de l'application.
function routeDroppedFiles(files, deps) {
    const music = files.find(isAudioFile);
    if (music) deps.dropMusicFile?.(music);
    const photos = files.filter(isImageFile);
    const tracks = files.filter(isGpxFile);
    const ignored = files.filter((f) => f !== music && !isImageFile(f) && !isGpxFile(f));
    if (ignored.length) {
        const shown = ignored.slice(0, 3).map((f) => f.name).join(', ');
        const more = ignored.length > 3 ? t(' et ${n} autres', { n: ignored.length - 3 }) : '';
        showToast(shown + more, 'warning', t('Fichiers non pris en charge'));
    }
    if (!photos.length && !tracks.length) return;
    if (!deps.getSelectedId()) {
        showToast(t('Ouvrez un parcours avant d’y déposer des photos ou des traces.'), 'info', t('Parcours'));
        return;
    }
    if (photos.length) {
        deps.showBsTab?.(document.querySelector('#mainTabs a[href="#photos"]'));
        deps.uploadPhotos(photos);
    } else {
        deps.showBsTab?.(document.querySelector('#mainTabs a[href="#data"]'));
    }
    if (tracks.length) deps.uploadTracks(tracks);
}

// deps : { getSelectedId, uploadPhotos, uploadTracks, showBsTab, dropMusicFile }
export function bindParcoursFileDrop(deps) {
    const overlay = document.createElement('div');
    overlay.id = 'parcoursDropOverlay';
    overlay.className = 'gpx-drop-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.className = 'gpx-drop-overlay__inner';
    const icon = document.createElement('i');
    icon.className = 'ti ti-file-upload';
    const text = document.createElement('div');
    text.className = 'gpx-drop-overlay__text';
    text.textContent = t('Déposez vos photos ou traces (.gpx) pour les ajouter au parcours, ou une musique');
    inner.append(icon, text);
    overlay.append(inner);
    document.body.append(overlay);

    // Compteur de profondeur : dragenter/dragleave se déclenchent aussi d'un
    // élément enfant à l'autre.
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    const hide = () => { depth = 0; overlay.classList.remove('is-visible'); };
    window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth++;
        overlay.classList.add('is-visible');
    });
    window.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    });
    window.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) hide();
    });
    window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        hide();
        routeDroppedFiles([...(e.dataTransfer.files || [])], deps);
    });
    window.addEventListener('dragend', hide);
}
