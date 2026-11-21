// Apparence des étapes et du trait de la page Parcours : bloc du thème
// `points.parcours_style` (docs/parcours.md).
//
// Copie de parcours_style.py (source de vérité des défauts, choix et bornes) ;
// tests/js/parcours_style.test.mjs compare les deux via
// tests/fixtures/parcours/parcours_style.json.
//
// Module pur (aucun DOM, ni OpenLayers) : testé par node --test.

export const PARCOURS_STYLE_KINDS = Object.freeze(['find', 'lab', 'dnf', 'place', 'base']);
export const PARCOURS_STYLE_CHOICES = Object.freeze({
    render: Object.freeze(['stops', 'theme']),
    color_by: Object.freeze(['kind', 'day', 'type']),
    numbers: Object.freeze(['trip', 'day', 'none']),
    plan_line: Object.freeze(['dashed', 'solid', 'none']),
    play_past: Object.freeze(['normal', 'dim', 'dim_days']),
});
export const PARCOURS_STYLE_RANGES = Object.freeze({
    size: Object.freeze([7, 18]),
    trail_width: Object.freeze([1, 12]),
    trail_opacity: Object.freeze([10, 100]),
});

// Couleurs des journées par défaut (DAY_PALETTE de parcours_style.py) ; la
// palette du thème (`day_palette`) en compte de 2 à 12 (PALETTE_SIZE),
// reprises au début au-delà de la dernière.
export const PARCOURS_DAY_PALETTE = Object.freeze([
    '#1971c2', '#e8590c', '#2f9e44', '#c2255c',
    '#0c8599', '#6741d9', '#5c940d', '#9c5221',
]);
export const PARCOURS_PALETTE_SIZE = Object.freeze([2, 12]);

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function parcoursStyleDefaults() {
    return {
        render: 'stops',
        size: 11,
        numbers: 'trip',
        color_by: 'kind',
        colors: { find: '#0072c6', lab: '#f59f00', dnf: '#868e96', place: '#ae3ec9', base: '#343a40' },
        plan_line: 'dashed',
        trail_color: '#00b8d4',
        trail_by_day: false,
        day_palette: [...PARCOURS_DAY_PALETTE],
        trail_width: 3,
        trail_opacity: 100,
        play_current: true,
        play_past: 'normal',
        play_preview: false,
    };
}

function color(value, fallback) {
    return typeof value === 'string' && HEX_RE.test(value) ? value.toLowerCase() : fallback;
}

function integer(value, fallback, [low, high]) {
    if (typeof value === 'boolean' || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.round(Math.min(high, Math.max(low, number)));
}

// Comme _palette : couleurs valides en minuscules, 12 au plus ; moins de 2 :
// `fallback`.
function palette(value, fallback) {
    if (!Array.isArray(value)) return [...fallback];
    const colors = value.map((c) => color(c, null)).filter(Boolean).slice(0, PARCOURS_PALETTE_SIZE[1]);
    return colors.length >= PARCOURS_PALETTE_SIZE[0] ? colors : [...fallback];
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Bloc normalisé : valeurs bornées, champs absents = valeur courante (défaut
// sinon) — comme coerce_parcours_style.
export function normalizeParcoursStyle(raw, current = null) {
    const defaults = parcoursStyleDefaults();
    const cur = isObject(current) ? current : {};
    const base = { ...defaults };
    for (const key of Object.keys(defaults)) if (key in cur) base[key] = cur[key];
    const src = isObject(raw) ? raw : {};
    const choice = (key) => (PARCOURS_STYLE_CHOICES[key].includes(src[key]) ? src[key]
        : (PARCOURS_STYLE_CHOICES[key].includes(base[key]) ? base[key] : defaults[key]));
    const bool = (key) => (typeof src[key] === 'boolean' ? src[key]
        : (typeof base[key] === 'boolean' ? base[key] : defaults[key]));
    const out = {
        render: choice('render'),
        numbers: choice('numbers'),
        color_by: choice('color_by'),
        trail_by_day: typeof src.trail_by_day === 'boolean' ? src.trail_by_day
            : (typeof base.trail_by_day === 'boolean' ? base.trail_by_day : defaults.trail_by_day),
        plan_line: choice('plan_line'),
        trail_color: color(src.trail_color, color(base.trail_color, defaults.trail_color)),
        day_palette: palette(src.day_palette, palette(base.day_palette, defaults.day_palette)),
        play_current: bool('play_current'),
        play_past: choice('play_past'),
        play_preview: bool('play_preview'),
    };
    for (const [key, range] of Object.entries(PARCOURS_STYLE_RANGES)) {
        out[key] = integer(src[key], integer(base[key], defaults[key], range), range);
    }
    const colorsSrc = isObject(src.colors) ? src.colors : {};
    const colorsCur = isObject(base.colors) ? base.colors : {};
    out.colors = {};
    for (const kind of PARCOURS_STYLE_KINDS) {
        out.colors[kind] = color(colorsSrc[kind], color(colorsCur[kind], defaults.colors[kind]));
    }
    return Object.fromEntries(Object.keys(defaults).map((key) => [key, out[key]]));
}

// Numéro affiché de chaque étape comptée (clé → texte) : rang sur tout le
// parcours (`stop.index`), rang dans la journée, ou rien. Lieux et bases n'en
// ont jamais (`index` null).
export function stopNumberLabels(ordered, mode) {
    const labels = new Map();
    if (mode === 'none') return labels;
    for (const day of ordered?.days || []) {
        let rank = 0;
        for (const stop of day.stops || []) {
            if (!Number.isFinite(stop.index)) continue;
            rank++;
            labels.set(stop.key, String(mode === 'day' ? rank : stop.index));
        }
    }
    return labels;
}

// Couleur de la journée d'index `dayIndex` (rang dans la plage du parcours,
// jours vides compris : le même jour garde sa couleur quand un autre se vide).
export function dayColor(dayIndex, colors = PARCOURS_DAY_PALETTE) {
    const list = Array.isArray(colors) && colors.length ? colors : PARCOURS_DAY_PALETTE;
    const n = list.length;
    const i = Number.isInteger(dayIndex) ? ((dayIndex % n) + n) % n : 0;
    return list[i];
}

// Couleur proposée pour une case ajoutée à la palette : la première couleur
// par défaut absente, sinon la teinte la plus éloignée de celles de la
// palette (par pas de 10°), foncée pour un numéro blanc.
export function nextPaletteColor(colors) {
    const used = new Set((colors || []).map((c) => String(c).toLowerCase()));
    const free = PARCOURS_DAY_PALETTE.find((c) => !used.has(c));
    if (free) return free;
    const hues = [...used].map(hexHue).filter((h) => h !== null);
    let best = 0;
    let bestGap = -1;
    for (let hue = 0; hue < 360; hue += 10) {
        const gap = Math.min(360, ...hues.map((h) => Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h))));
        if (gap > bestGap) {
            best = hue;
            bestGap = gap;
        }
    }
    return hslToHex(best, 0.65, 0.38);
}

function hexHue(hex) {
    const value = color(hex, null);
    if (!value) return null;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return null;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
}

function hslToHex(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return `#${[0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, '0')).join('')}`;
}

// Peinture d'une étape : `fill` (couleur d'identité) et `hollow` (pastille
// creuse : fond blanc, contour et numéro de la couleur). Lieux et bases :
// leur couleur, toujours. Étapes comptées : selon `color_by` — par nature,
// par journée, par type de cache (`typeColors` : type → couleur, l'Adventure
// Lab sous « Adventure Lab » ; à défaut la couleur de la nature). Hors du
// mode par nature, un DNF n'a plus sa couleur propre : il passe en creux.
export function stopPaint(stop, style, { dayIndex = 0, typeColors = null } = {}) {
    const colors = style?.colors || parcoursStyleDefaults().colors;
    const kind = stop?.kind;
    const own = colors[kind] || colors.find;
    if (kind === 'place' || kind === 'base') return { fill: own, hollow: false };
    const mode = style?.color_by;
    let fill = own;
    if (mode === 'day') fill = dayColor(dayIndex, style.day_palette);
    else if (mode === 'type') {
        const type = kind === 'lab' ? 'Adventure Lab' : stop?.type;
        fill = color(typeColors?.[type], null) || own;
    }
    return { fill, hollow: mode !== 'kind' && mode != null && kind === 'dnf' };
}

// Couleur du numéro : contraste sur la pastille pleine ; sur une pastille
// creuse, la couleur elle-même si elle est assez foncée pour le fond blanc.
export function paintTextColor(paint) {
    if (!paint?.hollow) return contrastTextColor(paint?.fill);
    return contrastTextColor(paint.fill) === '#ffffff' ? color(paint.fill, '#212529') : '#212529';
}

// Couleur du trait (et de la ligne du plan, du géocacheur) d'une journée.
export function trailColorFor(style, dayIndex) {
    if (style?.trail_by_day) return dayColor(dayIndex, style.day_palette);
    return color(style?.trail_color, parcoursStyleDefaults().trail_color);
}

// Pendant la lecture, ce qu'est une étape comptée à la position `q` du
// moteur (quanta) : `current` (le géocacheur y est, de son arrivée à son
// départ), `past` (quittée — selon `play_past`, toutes ou seulement celles
// des journées d'avant `day`), `upcoming` (à venir) ou `normal`.
export function playPhase(stop, q, { day = null, past = 'normal' } = {}) {
    const arrival = Number(stop?.q);
    const depart = Number.isFinite(Number(stop?.departQ)) ? Number(stop.departQ) : arrival;
    if (!Number.isFinite(arrival) || q < arrival) return 'upcoming';
    if (q < depart) return 'current';
    if (past === 'dim') return 'past';
    if (past === 'dim_days' && day != null && stop.day < day) return 'past';
    return 'normal';
}

// Anneau de l'étape en cours : rayon qui pulse d'une seconde d'écran
// (10 quanta), de `radius` + 6 à `radius` + 12 px — assez large pour
// déborder du géocacheur, posé sur l'étape pendant la visite. Fonction de la
// position du moteur seule : identique en aperçu et en capture image par
// image.
export const CURRENT_RING_PERIOD = 10;

export function currentRingRadius(radius, elapsedQ) {
    const phase = (2 * Math.PI * Math.max(0, Number(elapsedQ) || 0)) / CURRENT_RING_PERIOD;
    return Math.max(1, Number(radius) || 1) + 9 - 3 * Math.cos(phase);
}

// Apparition d'une étape pendant la lecture : la pastille grossit de rien à
// sa taille en STOP_POP_QUANTA quanta (300 ms d'écran), avec un léger
// dépassement (≈ ×1,1) avant de se poser. `elapsedQ` : quanta écoulés depuis
// l'arrivée (négatif : pas encore là).
export const STOP_POP_QUANTA = 3;

export function stopPopScale(elapsedQ) {
    const value = Number(elapsedQ);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value >= STOP_POP_QUANTA) return 1;
    const t = value / STOP_POP_QUANTA - 1;
    const c1 = 1.70158;
    return 1 + (c1 + 1) * t ** 3 + c1 * t ** 2;
}

// Rendu « points du thème » : numéro dans une petite pastille posée en haut
// à droite du point, sans le recouvrir. `themeRadius` : rayon du point du
// thème (centre + contour, px). Décalage en px, y vers le haut (convention
// `displacement` d'OpenLayers).
export function themeNumberBadge(size, themeRadius) {
    const radius = Math.max(6, Math.round(Number(size) * 0.7) || 6);
    const reach = Math.max(0, Number(themeRadius) || 0) + radius * 0.45;
    const offset = Math.round(reach * Math.SQRT1_2);
    return { radius, offset: [offset, offset] };
}

// Taille de police d'un numéro dans une pastille de rayon `radius` : la
// pleine taille jusqu'à deux chiffres, réduite au-delà pour tenir dedans.
export function numberFontPx(radius, label) {
    const length = String(label ?? '').length;
    const factor = length <= 2 ? 1 : (length === 3 ? 0.8 : 0.66);
    return Math.max(6, Math.round(radius * factor));
}

// Couleur lisible sur un fond `hex` : blanc, sauf sur un fond clair
// (luminance relative WCAG au-dessus de 0,3 — l'ambre des Labs, 0,44, y
// passe ; le gris des DNF, 0,27, garde le blanc). Le meilleur contraste
// basculerait vers 0,21 : le seuil penche vers le blanc des pastilles.
export function contrastTextColor(hex) {
    const value = color(hex, null);
    if (!value) return '#ffffff';
    const channel = (i) => {
        const c = parseInt(value.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    return luminance > 0.3 ? '#212529' : '#ffffff';
}

// « #rrggbb » + opacité (0-1) → « rgba(r, g, b, a) ».
export function hexToRgba(hex, alpha = 1) {
    const value = color(hex, '#000000');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    const a = Math.min(1, Math.max(0, Number(alpha)));
    return `rgba(${r}, ${g}, ${b}, ${Number.isFinite(a) ? +a.toFixed(3) : 1})`;
}
