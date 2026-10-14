// Musique choisie, branchée sur le serveur (cf. music_track.mjs).
import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { fetchWithTimeout, FETCH_TIMEOUTS } from './fetch_with_timeout.mjs';
import { createMusicTrack } from './music_track.mjs';

// Copie la musique dans le dossier audio/ du serveur et renvoie son nom (tiré
// du contenu : renvoyer la même musique ne la duplique pas).
async function uploadMusic(file) {
    const fd = new FormData();
    fd.append('audio', file, file.name || 'music');
    const response = await fetchWithTimeout(
        `${CONFIG.BASE_URL}/upload_audio`, { method: 'POST', body: fd },
        { timeoutMs: FETCH_TIMEOUTS.upload, t: pkg.t },
    );
    const result = await response.json().catch(() => null);
    if (!result?.success || !result.file) throw new Error(result?.message || `HTTP ${response.status}`);
    return result.file;
}

export const musicTrack = createMusicTrack({
    upload: uploadMusic,
    onUploadError: (err) => console.warn('Copie de la musique vers le serveur échouée:', err),
});

// Musique à intégrer à la vidéo : un fichier choisi ET « Inclure la musique »
// cochée. null sinon.
export function includedMusicFile() {
    return pkg.options?.record?.audio?.enabled ? musicTrack.file() : null;
}
