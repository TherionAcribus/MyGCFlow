// Mode présentation de la page Statistiques : un graphique par écran, en
// plein écran. Logique pure (diapositives, navigation, délais), testée par
// tests/js/present_model.test.mjs ; l'affichage vit dans stats_page_present.js.

// Délais du défilement automatique, en secondes.
export const PRESENT_DELAYS = Object.freeze([5, 10, 20, 30]);
export const PRESENT_DEFAULT_DELAY = 10;

export function presentDelay(value) {
    const n = Number(value);
    return PRESENT_DELAYS.includes(n) ? n : PRESENT_DEFAULT_DELAY;
}

// Diapositives : les graphiques du tableau dans leur ordre, sauf ceux dont
// une source a échoué (rien de lisible à montrer). `results` : Map id →
// { result, error }.
export function presentSlides(items, results) {
    return (items || [])
        .filter((item) => {
            const entry = results.get(item.spec.id);
            return entry && !entry.error && entry.result;
        })
        .map((item) => item.spec.id);
}

// Diapositive de départ : celle demandée si elle en est une, sinon la
// première.
export function startIndex(slides, chartId = null) {
    const i = chartId ? slides.indexOf(chartId) : -1;
    return i >= 0 ? i : 0;
}

// Pas en avant / en arrière. `loop` (défilement automatique) : après la
// dernière, la première ; sinon on reste au bord.
export function stepIndex(index, count, step, { loop = false } = {}) {
    if (count <= 0) return 0;
    const next = index + step;
    if (loop) return ((next % count) + count) % count;
    return Math.max(0, Math.min(count - 1, next));
}

// Touche → action ('next', 'prev', 'first', 'last', 'close', 'toggle'),
// null : touche laissée au navigateur.
export function keyAction(key) {
    switch (key) {
        case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter':
            return 'next';
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
            return 'prev';
        case 'Home': return 'first';
        case 'End': return 'last';
        case 'Escape': return 'close';
        case 'p': case 'P': return 'toggle';
        default: return null;
    }
}
