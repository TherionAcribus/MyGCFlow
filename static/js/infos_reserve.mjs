// Largeur réservée par la cartouche d'infos (nombre de caches · date).
//
// Le contenu grandit pendant l'animation : le compteur gagne des chiffres et la
// date change de jour. Sans réserve, la boîte — ancrée à droite — s'élargit vers
// la gauche à chaque palier, et son bord bouge sans arrêt.
//
// On réserve donc dès le départ la place du plus grand contenu à venir. Ce texte
// sert aux deux rendus : la boîte HTML de l'aperçu (frames.js, via un doublon
// invisible) et le tracé Canvas de la vidéo (overlay_canvas.js). Les deux doivent
// réserver exactement la même chose, d'où cette source unique.
//
// Aucune dépendance au DOM : logique pure, testable.

// Séparateur entre le compteur et la date, identique au DOM (#spanInfosSep).
export const INFOS_SEPARATOR = ' · ';

// Toutes les dates jj/mm/aaaa ont le même nombre de caractères ; avec des
// chiffres à largeur fixe (cf. tabular_text.mjs) elles ont donc toutes la même
// largeur. Le 8 reste le plus large des chiffres pour les autres polices.
const WIDEST_DATE = '88/88/8888';

export function reservedInfosText({
    showCount = false,
    showDate = false,
    currentValue = 0,
    finalValue = 0,
} = {}) {
    const parts = [];
    if (showCount) {
        // Le compteur ne dépasse jamais le total final, mais un filtre peut
        // l'abaisser après coup : on garde la plus large des deux valeurs.
        const count = Math.max(0, toCount(currentValue), toCount(finalValue));
        parts.push(String(count));
    }
    if (showDate) parts.push(WIDEST_DATE);
    return parts.join(INFOS_SEPARATOR);
}

function toCount(value) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? number : 0;
}
