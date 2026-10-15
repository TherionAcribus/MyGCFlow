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
// cochée. null sinon — et pour une musique illisible, que ffmpeg ferait
// échouer l'export entier.
export function includedMusicFile() {
    if (!pkg.options?.record?.audio?.enabled || musicTrack.isUnreadable()) return null;
    return musicTrack.file();
}

// Version lisible d'une musique que le navigateur ne sait pas décoder (.wma,
// .aiff…), convertie par ffmpeg sur le serveur (cf. audio_library.py) et
// retenue par musicTrack. Renvoie { playable } une fois obtenue,
// { unreadable: true } si ffmpeg ne la lit pas non plus (musique alors
// marquée illisible), null sur un autre échec (serveur injoignable), qui ne
// prouve rien sur la musique.
export async function ensurePlayableMusic(file) {
    const known = musicTrack.playable(file);
    if (known && known !== file) return { playable: known };
    const name = await musicTrack.serverName(file);
    if (!name) return null;
    try {
        const response = await fetchWithTimeout(`${CONFIG.BASE_URL}/api/audio/playable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: name }),
        }, { timeoutMs: FETCH_TIMEOUTS.upload, t: pkg.t });
        const result = await response.json().catch(() => null);
        if (result?.unreadable) {
            musicTrack.markUnreadable(file);
            return { unreadable: true };
        }
        if (!result?.success || !result.file) return null;
        const fileResponse = await fetch(`${CONFIG.BASE_URL}/audio/${encodeURIComponent(result.file)}`);
        if (!fileResponse.ok) return null;
        const blob = await fileResponse.blob();
        const playable = new File([blob], `${file.name}.flac`, { type: 'audio/flac' });
        musicTrack.setPlayable(file, playable);
        return { playable };
    } catch (e) {
        console.warn('Version lisible de la musique non obtenue:', e);
        return null;
    }
}
