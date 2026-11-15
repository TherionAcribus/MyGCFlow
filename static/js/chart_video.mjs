// Comparaison animée en vidéo : un graphique de la page Statistiques dessiné
// image par image, les valeurs apparaissant le long de l'axe (mois après
// mois, les années « font la course »). Module pur : il ne fait que dériver,
// pour une avancée donnée, un résultat partiel et figer l'échelle — le
// dessin (ECharts) et l'enregistrement (MediaRecorder) sont dans
// stats_page_video.js. Testé par tests/js/chart_video.test.mjs.

// Formats proposés : paysage HD, Full HD, carré (réseaux sociaux).
export const VIDEO_SIZES = Object.freeze({
    hd: Object.freeze({ width: 1280, height: 720 }),
    fullhd: Object.freeze({ width: 1920, height: 1080 }),
    square: Object.freeze({ width: 1080, height: 1080 }),
    // Stories, Reels, Shorts.
    portrait: Object.freeze({ width: 1080, height: 1920 }),
});
export const VIDEO_DURATIONS = Object.freeze([6, 10, 15, 20, 30]);
export const VIDEO_FPS = 30;
// Fin de vidéo : le graphique complet reste affiché (part de la durée),
// avec un plancher — 15 % d'un clip de 6 s ne laissait que 0,9 s pour
// lire le résultat (la vidéo de la carte retient 3 s, cf.
// DEFAULT_END_HOLD_MS de video_timing.mjs).
export const VIDEO_HOLD = 0.15;
export const VIDEO_HOLD_MIN_MS = 2000;

// Axes ordonnés : l'animation suit le temps (ou les cases d'une année).
const ORDERED_DIMS = new Set([
    'year', 'quarter', 'month', 'week', 'day', 'month_of_year', 'week_of_year', 'day_of_year',
]);

// Formes sans axe de temps : révélées dans l'ordre des clés — parts de
// l'anneau qui balaient, cases de la grille qui se remplissent.
export const SWEEP_CHARTS = new Set(['donut', 'heatmap', 'calendar', 'challenge']);

// Le graphique s'anime-t-il ? Barres, courbes, aires sur un axe de temps ;
// anneau, grilles et calendrier dans l'ordre de leurs clés — sans écart
// (barres signées) ni « Autres ».
export function chartAnimates(spec, result = null) {
    if (result && (result.delta || result.keys.length < 2)) return false;
    if (SWEEP_CHARTS.has(spec.view.chart)) return true;
    if (!['bar', 'line', 'area'].includes(spec.view.chart)) return false;
    if (!ORDERED_DIMS.has(spec.groupBy)) return false;
    return true;
}

// Avancée de l'animation (0 → 1) au temps `elapsed` d'une vidéo de
// `duration` (mêmes unités) : linéaire, puis le graphique complet reste.
// `hold` est la part de pause finale ; `minHold` (mêmes unités) en pose
// le plancher — plafonné à la moitié de la vidéo pour garder une
// animation.
export function revealProgress(elapsed, duration, hold = VIDEO_HOLD, minHold = 0) {
    if (!(duration > 0)) return 1;
    const holdMs = Math.min(Math.max(duration * hold, minHold), duration * 0.5);
    const run = duration - holdMs;
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

// ---------------------------------------------------------------------------
// Textes du canevas vidéo : le 4ᵉ argument de fillText (maxWidth) compresse
// les glyphes au lieu de tronquer — un titre long devient illisible. Il faut
// donc rogner ou réduire soi-même.
// ---------------------------------------------------------------------------

// Texte rogné pour tenir dans `maxWidth` (px), terminé par « … » quand il est
// coupé. `measure` = (s) => largeur en px (g.measureText(s).width, la police
// étant déjà posée) : injecté pour rester testable sans canevas. Si même
// « … » seul ne tient pas, il est rendu quand même (mieux qu'un dépassement).
export function ellipsize(text, maxWidth, measure) {
    const s = text === null || text === undefined ? '' : String(text);
    if (!s || !(maxWidth > 0)) return '';
    if (measure(s) <= maxWidth) return s;
    // Dichotomie : la plus grande coupe qui tient avec « … » (inclut le cas
    // où seul « … » rentre, ou pas : la coupe vide donne « … »).
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measure(s.slice(0, mid) + '…') <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return s.slice(0, lo) + '…';
}

// En-tête d'une image : titre à gauche, repère de l'axe atteint à droite
// (« septembre 2024 »). Le repère avait une largeur fixe (6 fois la taille
// du titre) : en gras et plus gros, un libellé mois + année n'y tenait
// jamais, l'année sautait quel que soit le format. Sa place est réservée
// sur le plus long des repères (mesuré une fois : le titre ne bouge pas
// d'une image à l'autre), au plus 45 % de la largeur — davantage si le
// titre, court, laisse la place ; le titre prend le reste.
//   inner   largeur entre les marges (px)
//   gap     écart entre titre et repère (px)
//   title   largeur du titre entier (px, à sa police)
//   heads   largeur de chaque repère (px, à la sienne)
// → { titleMax, headMax } en px.
export const HEAD_SHARE = 0.45;
export function headerLayout({ inner, gap, title, heads }) {
    const longest = heads.length ? Math.max(...heads) : 0;
    if (!longest) return { titleMax: inner, headMax: 0 };
    const room = Math.max(inner * HEAD_SHARE, inner - gap - title);
    const headMax = Math.min(longest, room);
    return { titleMax: Math.max(0, inner - gap - headMax), headMax };
}

// Taille réduite pour que `text` tienne dans `maxWidth` (px) :
// `baseSize * maxWidth / largeur`, la largeur étant mesurée à `baseSize`.
// Bornée en bas par `baseSize * minRatio` : au plancher, un léger dépassement
// est préféré à un texte minuscule — à l'appelant de tronquer ensuite si le
// contenu s'y prête (pas un nombre).
export function fitFontSize(text, baseSize, maxWidth, measure, minRatio = 0.5) {
    const s = text === null || text === undefined ? '' : String(text);
    if (!(baseSize > 0)) return 0;
    const width = s ? measure(s) : 0;
    if (!(width > maxWidth)) return baseSize;
    return Math.max(baseSize * minRatio, baseSize * (maxWidth / width));
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
    // Même idée pour l'échelle d'intensité des grilles (carte de chaleur,
    // calendrier) : sinon elle grandit au fil de la révélation et les
    // cases déjà dessinées changent de couleur.
    if (max !== undefined && option.visualMap) {
        for (const vm of Array.isArray(option.visualMap) ? option.visualMap : [option.visualMap]) vm.max = max;
    }
    delete option.dataZoom;
    option.animation = false;
    return option;
}
