// Enchaînement de plusieurs morceaux : opérations sur la liste [{ file, name,
// duration }] (nom dans audio/, nom d'origine, durée en secondes). Le serveur
// assemble les morceaux en une seule musique (audio_library.build_playlist_mix),
// que l'application traite ensuite comme une autre. Module pur (testé par
// test_music_playlist.mjs).

// Même borne que le serveur (settings_manager.PLAYLIST_MAX).
export const PLAYLIST_MAX = 20;

// Liste avec `added` à la fin. Sans enchaînement en cours, la musique
// courante (`current`) en devient le premier morceau.
export function playlistWith(playlist, current, added) {
    const base = Array.isArray(playlist) && playlist.length ? playlist : [current];
    return [...base, added].slice(0, PLAYLIST_MAX);
}

// Liste où le morceau `index` a pris la place de son voisin (`delta` : -1
// vers le haut, +1 vers le bas). Inchangée au bord.
export function playlistMoved(playlist, index, delta) {
    const target = index + delta;
    if (!Array.isArray(playlist) || index < 0 || target < 0 || index >= playlist.length || target >= playlist.length) {
        return playlist;
    }
    const moved = [...playlist];
    [moved[index], moved[target]] = [moved[target], moved[index]];
    return moved;
}

export function playlistWithout(playlist, index) {
    return (Array.isArray(playlist) ? playlist : []).filter((_, i) => i !== index);
}

// Nom affiché de l'enchaînement : ses morceaux, dans l'ordre.
export function playlistDisplayName(playlist) {
    return (Array.isArray(playlist) ? playlist : []).map((t) => t.name || t.file).join(' + ');
}

// Durée d'un morceau pour la liste : « 3:07 », vide si inconnue.
export function trackDurationText(seconds) {
    if (!(seconds > 0)) return '';
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
