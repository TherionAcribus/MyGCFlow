// Image d'un tableau de bord entier : calculs purs (sans DOM), testés par
// tests/js/dashboard_image.test.mjs. Le dessin lui-même vit dans
// stats_image.js.

// Netteté : deux pixels par pixel d'écran, sans dépasser ce qu'un canvas
// accepte (côté et surface) — un très long tableau sort un peu moins fin.
export const IMAGE_RATIO = 2;
export const IMAGE_MAX_SIDE = 16000;
export const IMAGE_MAX_AREA = 100e6;

export function imageRatio(width, height, { preferred = IMAGE_RATIO, maxSide = IMAGE_MAX_SIDE, maxArea = IMAGE_MAX_AREA } = {}) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const ratio = Math.min(preferred, maxSide / w, maxSide / h, Math.sqrt(maxArea / (w * h)));
    // Arrondi vers le bas au centième : les côtés restent sous la limite.
    return Math.max(0.1, Math.floor(ratio * 100) / 100);
}

// Texte coupé à la largeur donnée, terminé par « … » (comme text-overflow).
export function ellipsize(text, maxWidth, measure) {
    if (measure(text) <= maxWidth) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (measure(text.slice(0, mid).trimEnd() + '…') <= maxWidth) low = mid;
        else high = mid - 1;
    }
    return low ? text.slice(0, low).trimEnd() + '…' : '';
}

// Répartit les mots d'un texte sur des lignes de largeurs données (les
// fragments que le navigateur a mis en page) : chaque ligne prend autant de
// mots qu'elle peut, la dernière prend le reste.
export function splitLines(text, widths, measure, tolerance = 2) {
    const words = text.split(/\s+/).filter(Boolean);
    if (!widths.length) return [];
    const lines = [];
    let index = 0;
    for (let line = 0; line < widths.length; line += 1) {
        if (line === widths.length - 1) {
            lines.push(words.slice(index).join(' '));
            break;
        }
        let end = index + 1;
        while (end < words.length && measure(words.slice(index, end + 1).join(' ')) <= widths[line] + tolerance) end += 1;
        lines.push(words.slice(index, Math.min(end, words.length)).join(' '));
        index = Math.min(end, words.length);
    }
    return lines;
}

// Lignes d'un texte libre dans une largeur (en-tête de l'image).
export function wrapText(text, maxWidth, measure) {
    const lines = [];
    let current = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
        const next = current ? current + ' ' + word : word;
        if (current && measure(next) > maxWidth) {
            lines.push(current);
            current = word;
        } else current = next;
    }
    if (current) lines.push(current);
    return lines;
}

// Glyphe d'une icône (contenu CSS de ::before) : « "\ea4f" » → le caractère.
export function iconGlyph(content) {
    if (!content || content === 'none' || content === 'normal') return '';
    const match = /^(["'])(.*)\1$/s.exec(content);
    return match ? match[2] : '';
}

// Couleur CSS calculée visible (ni « transparent » ni alpha nul).
export function colorVisible(color) {
    if (!color || color === 'transparent') return false;
    const match = /^rgba?\(([^)]+)\)$/.exec(color.trim());
    if (!match) return true;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length < 4 || Number.parseFloat(parts[3]) > 0;
}

export function applyTextTransform(text, transform) {
    if (transform === 'uppercase') return text.toUpperCase();
    if (transform === 'lowercase') return text.toLowerCase();
    if (transform === 'capitalize') return text.replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toUpperCase());
    return text;
}
