// Comparaison animée en vidéo : un graphique de la page Statistiques dessiné
// image par image, les valeurs apparaissant le long de l'axe (mois après
// mois, les années « font la course »). Module pur : il ne fait que dériver,
// pour une avancée donnée, un résultat partiel et figer l'échelle — le
// dessin (ECharts) et l'enregistrement (MediaRecorder) sont dans
// stats_page.js. Testé par tests/js/chart_video.test.mjs.

// Formats proposés : paysage HD, Full HD, carré (réseaux sociaux).
export const VIDEO_SIZES = Object.freeze({
    hd: Object.freeze({ width: 1280, height: 720 }),
    fullhd: Object.freeze({ width: 1920, height: 1080 }),
    square: Object.freeze({ width: 1080, height: 1080 }),
});
export const VIDEO_DURATIONS = Object.freeze([6, 10, 15, 20, 30]);
export const VIDEO_FPS = 30;
// Fin de vidéo : le graphique complet reste affiché (part de la durée).
export const VIDEO_HOLD = 0.15;

// Axes ordonnés : l'animation suit le temps (ou les cases d'une année).
const ORDERED_DIMS = new Set([
    'year', 'quarter', 'month', 'week', 'day', 'month_of_year', 'week_of_year', 'day_of_year',
]);

// Le graphique s'anime-t-il ? Barres, courbes, aires sur un axe de temps,
// sans écart (barres signées) ni « Autres ».
export function chartAnimates(spec, result = null) {
    if (!['bar', 'line', 'area'].includes(spec.view.chart)) return false;
    if (!ORDERED_DIMS.has(spec.groupBy)) return false;
    if (result && (result.delta || result.keys.length < 2)) return false;
    return true;
}

// Avancée de l'animation (0 → 1) au temps `elapsed` d'une vidéo de
// `duration` (mêmes unités) : linéaire, puis le graphique complet reste.
export function revealProgress(elapsed, duration, hold = VIDEO_HOLD) {
    if (!(duration > 0)) return 1;
    const run = duration * (1 - hold);
    return Math.min(1, Math.max(0, elapsed / run));
}

// Clé atteinte par l'animation (index sur l'axe).
export function revealIndex(result, progress) {
    const n = result.keys.length;
    return Math.min(n - 1, Math.max(0, Math.floor(progress * n - 1e-9)));
}

// Résultat partiel : les clés déjà atteintes gardent leur valeur, la clé
// en cours grandit (barre) ou glisse depuis la précédente (courbe), les
// suivantes sont vides.
export function revealResult(result, progress, { chart = 'bar' } = {}) {
    const n = result.keys.length;
    const position = Math.min(n, Math.max(0, progress * n));
    const whole = Math.floor(position);
    const frac = position - whole;
    const series = result.series.map((s) => ({
        ...s,
        values: s.values.map((v, k) => {
            if (k < whole) return v;
            if (k > whole || frac === 0 || v === null || v === undefined) return null;
            if (chart === 'bar') return v * frac;
            const prev = k > 0 ? s.values[k - 1] : null;
            return prev === null || prev === undefined ? v : prev + (v - prev) * frac;
        }),
    }));
    return { ...result, series };
}

// Plus grande valeur dessinée (barres empilées : plus grande somme).
export function valueMax(result, { stacked = false } = {}) {
    let max = 0;
    if (stacked) {
        for (let k = 0; k < result.keys.length; k++) {
            let sum = 0;
            for (const s of result.series) sum += Math.max(0, s.values[k] || 0);
            max = Math.max(max, sum);
        }
        return max;
    }
    for (const s of result.series) for (const v of s.values) if (v > max) max = v;
    return max;
}

// Borne « ronde » au-dessus de `value` (1, 2, 2,5, 5 × 10ⁿ).
export function niceCeil(value) {
    if (!(value > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5, 10]) {
        if (value <= step * power) return step * power;
    }
    return 10 * power;
}

// Fige l'échelle des axes de valeurs (sinon elle bondit à chaque image) et
// retire ce qui n'a pas sa place dans une vidéo (glissière de zoom,
// animations ECharts : chaque image est dessinée d'un coup).
export function lockOption(option, max) {
    const lock = (axes) => {
        for (const axis of Array.isArray(axes) ? axes : [axes]) {
            if (axis && axis.type === 'value') {
                axis.max = max;
                if (axis.min === undefined) axis.min = 0;
            }
            if (axis && axis.type === 'log') axis.max = max;
        }
    };
    lock(option.xAxis);
    lock(option.yAxis);
    delete option.dataZoom;
    option.animation = false;
    return option;
}
