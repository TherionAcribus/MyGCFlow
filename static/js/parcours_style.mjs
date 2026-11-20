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
});
export const PARCOURS_STYLE_RANGES = Object.freeze({
    size: Object.freeze([7, 18]),
    trail_width: Object.freeze([1, 12]),
    trail_opacity: Object.freeze([10, 100]),
});

// Couleurs des journées (DAY_PALETTE de parcours_style.py) : reprises au
// début au-delà de huit journées.
export const PARCOURS_DAY_PALETTE = Object.freeze([
    '#1971c2', '#e8590c', '#2f9e44', '#c2255c',
    '#0c8599', '#6741d9', '#5c940d', '#9c5221',
]);

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
        trail_width: 3,
        trail_opacity: 100,
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
    const out = {
        render: choice('render'),
        numbers: choice('numbers'),
        color_by: choice('color_by'),
        trail_by_day: typeof src.trail_by_day === 'boolean' ? src.trail_by_day
            : (typeof base.trail_by_day === 'boolean' ? base.trail_by_day : defaults.trail_by_day),
        plan_line: choice('plan_line'),
        trail_color: color(src.trail_color, color(base.trail_color, defaults.trail_color)),
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
export function dayColor(dayIndex) {
    const n = PARCOURS_DAY_PALETTE.length;
    const i = Number.isInteger(dayIndex) ? ((dayIndex % n) + n) % n : 0;
    return PARCOURS_DAY_PALETTE[i];
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
    if (mode === 'day') fill = dayColor(dayIndex);
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
    if (style?.trail_by_day) return dayColor(dayIndex);
    return color(style?.trail_color, parcoursStyleDefaults().trail_color);
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
