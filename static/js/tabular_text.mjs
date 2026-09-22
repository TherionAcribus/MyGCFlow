// Chiffres à largeur fixe (font-variant-numeric: tabular-nums) pour le rendu
// Canvas des overlays.
//
// Le navigateur applique tout seul `font-variant-numeric` au texte HTML, mais
// pas au texte dessiné avec fillText() : un compteur qui défile ferait donc
// danser les caractères dans la vidéo alors qu'il est stable à l'écran. On
// réimplémente la règle ici, comme overlay_canvas.js réimplémente déjà les
// bordures, dégradés et interlettrages CSS.
//
// Aucune dépendance au DOM : `measure` est injectée, la logique est testable.

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function isTabularNums(cssValue) {
    return typeof cssValue === 'string' && cssValue.includes('tabular-nums');
}

// Largeur commune des chiffres : celle du plus large, comme le fait une police
// en mode tabulaire.
export function digitAdvance(measure) {
    let widest = 0;
    for (const digit of DIGITS) widest = Math.max(widest, measure(digit));
    return widest;
}

// Position de chaque glyphe, en partant de 0, et largeur totale du texte.
// `digitWidth` à 0 (ou absent) laisse les chiffres à leur largeur naturelle.
export function layoutTabularText(text, measure, { letterSpacing = 0, digitWidth = 0 } = {}) {
    const glyphs = Array.from(text || '');
    const positions = [];
    let cursor = 0;
    for (const glyph of glyphs) {
        const isDigit = digitWidth > 0 && glyph >= '0' && glyph <= '9';
        const width = isDigit ? digitWidth : measure(glyph);
        // Un chiffre est centré dans sa case, comme dans une police tabulaire.
        const offset = isDigit ? (digitWidth - measure(glyph)) / 2 : 0;
        positions.push({ glyph, x: cursor + offset });
        cursor += width + letterSpacing;
    }
    // Le dernier glyphe ne traîne pas d'interlettrage derrière lui.
    const width = Math.max(0, cursor - (glyphs.length ? letterSpacing : 0));
    return { positions, width };
}
