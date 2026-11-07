// Pseudos flottants de la page Mes poses (docs/mode-poses.md) : bloc du thème
// `points.poses_names` (apparence) et préférence globale
// `poses_names_privacy` (pseudos abrégés, masqués ou exclus).
//
// Copie de poses_names.py (source de vérité des défauts, choix, bornes et
// styles prêts à l'emploi) ; tests/js/poses_names.test.mjs compare les deux
// via tests/fixtures/poses/poses_names.json.
//
// Module pur (aucun DOM) : testé par node --test.

export const NAME_KINDS = Object.freeze(['find', 'dnf', 'note']);
export const NAME_COLOR_KINDS = Object.freeze(['find', 'ftf', 'milestone', 'favorite', 'loyal', 'dnf', 'note']);
export const NAME_PRIVACY_MODES = Object.freeze(['show', 'initials', 'hidden']);

export const NAME_CHOICES = Object.freeze({
    grouping: Object.freeze(['merge', 'separate']),
    path: Object.freeze(['away', 'toward', 'still']),
    direction: Object.freeze(['up', 'down', 'left', 'right', 'radial', 'random']),
    trajectory: Object.freeze(['straight', 'arc', 'wave', 'spiral']),
    easing: Object.freeze(['smooth', 'linear', 'accelerate', 'elastic']),
    entrance: Object.freeze(['none', 'fade', 'pop', 'zoom', 'typewriter', 'drop']),
    exit: Object.freeze(['none', 'fade', 'shrink', 'grow', 'scatter', 'blink']),
    font: Object.freeze(['sans', 'serif', 'mono', 'rounded', 'condensed', 'handwritten']),
    color_mode: Object.freeze(['fixed', 'event', 'finder', 'cache_type']),
    background: Object.freeze(['none', 'pill', 'box', 'bubble']),
    // Durée de vie fixe ou selon le rythme (names_density.mjs).
    duration_mode: Object.freeze(['fixed', 'rhythm']),
});

export const NAME_RANGES = Object.freeze({
    loyal_min: Object.freeze([2, 100]),
    max_visible: Object.freeze([1, 60]),
    stagger_ms: Object.freeze([0, 2000]),
    distance: Object.freeze([0, 400]),
    duration_ms: Object.freeze([500, 10000]),
    wobble: Object.freeze([0, 100]),
    tilt: Object.freeze([0, 45]),
    offset_y: Object.freeze([-80, 80]),
    size: Object.freeze([8, 64]),
    opacity: Object.freeze([10, 100]),
    outline_width: Object.freeze([0, 8]),
    glow: Object.freeze([0, 30]),
    background_opacity: Object.freeze([0, 100]),
    emphasis: Object.freeze([1, 2.5]),
    duration_days: Object.freeze([1, 120]),
    duration_min_ms: Object.freeze([500, 10000]),
    duration_max_ms: Object.freeze([500, 10000]),
});
const FLOAT_KEYS = new Set(['emphasis']);

export const NAME_TEMPLATE_MAX = 80;
export const NAME_EXCLUDE_MAX = 200;
export const NAME_PSEUDO_MAX = 60;

// Clés touchées par un style prêt à l'emploi : mouvement et texte.
export const NAME_PRESET_KEYS = Object.freeze([
    'grouping', 'stagger_ms', 'path', 'direction', 'distance', 'trajectory', 'easing',
    'duration_ms', 'entrance', 'exit', 'wobble', 'tilt', 'offset_y', 'connector',
    'font', 'size', 'bold', 'italic', 'uppercase', 'color_mode', 'color',
    'outline_width', 'outline_color', 'glow', 'glow_color',
    'background', 'background_color', 'background_opacity',
]);

const BASE_STYLE = Object.freeze({
    grouping: 'merge', stagger_ms: 150, path: 'away', direction: 'up',
    distance: 60, trajectory: 'straight', easing: 'smooth', duration_ms: 2200,
    entrance: 'fade', exit: 'fade', wobble: 0, tilt: 0, offset_y: -14,
    connector: false, font: 'sans', size: 14, bold: true, italic: false,
    uppercase: false, color_mode: 'fixed', color: '#ffffff',
    outline_width: 3, outline_color: '#000000', glow: 0, glow_color: '#ffffff',
    background: 'none', background_color: '#000000', background_opacity: 55,
});

export const NAME_PRESETS = Object.freeze({
    rise: Object.freeze({ ...BASE_STYLE }),
    bubbles: Object.freeze({
        ...BASE_STYLE, path: 'still', entrance: 'pop', exit: 'shrink',
        duration_ms: 2600, offset_y: -22, outline_width: 0,
        background: 'bubble', background_color: '#ffffff', background_opacity: 92,
        color: '#263238', size: 13,
    }),
    burst: Object.freeze({
        ...BASE_STYLE, grouping: 'separate', stagger_ms: 80, direction: 'radial',
        distance: 90, trajectory: 'arc', entrance: 'zoom', exit: 'scatter',
        duration_ms: 2400, offset_y: 0, color_mode: 'finder',
    }),
    landing: Object.freeze({
        ...BASE_STYLE, path: 'toward', direction: 'random', distance: 160,
        trajectory: 'arc', exit: 'shrink', duration_ms: 2600, offset_y: -12,
        connector: false,
    }),
    typewriter: Object.freeze({
        ...BASE_STYLE, path: 'still', entrance: 'typewriter', exit: 'fade',
        duration_ms: 3000, offset_y: -20, font: 'mono', bold: false,
        outline_width: 0, background: 'box', background_opacity: 70,
        color: '#c5e1a5', connector: true,
    }),
    arcade: Object.freeze({
        ...BASE_STYLE, entrance: 'pop', exit: 'grow', easing: 'elastic',
        duration_ms: 1800, distance: 45, wobble: 30, uppercase: true,
        size: 16, outline_width: 4, color_mode: 'event',
    }),
    leaves: Object.freeze({
        ...BASE_STYLE, direction: 'right', distance: 120, trajectory: 'wave',
        easing: 'linear', duration_ms: 3500, wobble: 60, tilt: 20,
        font: 'serif', bold: false, italic: true, outline_width: 2,
        offset_y: -8,
    }),
    swirl: Object.freeze({
        ...BASE_STYLE, grouping: 'separate', stagger_ms: 120, direction: 'radial',
        distance: 70, trajectory: 'spiral', duration_ms: 3000, offset_y: 0,
        glow: 12, glow_color: '#ffd54f', outline_width: 2, color_mode: 'finder',
    }),
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const BOOL_KEYS = ['enabled', 'only_notable', 'badges', 'avoid_overlap', 'connector', 'bold', 'italic', 'uppercase'];
const COLOR_KEYS = ['color', 'outline_color', 'glow_color', 'background_color'];

export function nameKindColorsDefaults() {
    return {
        find: '#a5d6a7', ftf: '#ffd54f', milestone: '#b388ff', favorite: '#ff80ab',
        loyal: '#4fc3f7', dnf: '#90caf9', note: '#cfd8dc',
    };
}

// Ordre des clés : celui du serveur (comparaison de la fixture).
export function posesNamesDefaults() {
    return {
        enabled: false,
        kinds: { find: true, dnf: false, note: false },
        only_notable: false,
        loyal_min: 3,
        template: '{pseudo}',
        badges: true,
        max_visible: 12,
        avoid_overlap: true,
        emphasis: 1.3,
        duration_mode: 'fixed',
        duration_days: 10,
        duration_min_ms: 1000,
        duration_max_ms: 4000,
        ...BASE_STYLE,
        opacity: 100,
        kind_colors: nameKindColorsDefaults(),
    };
}

export function namesPrivacyDefaults() {
    return { mode: 'show', exclude: [] };
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const choice = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const color = (value, fallback) => (HEX_RE.test(value || '') ? value.toLowerCase() : fallback);
const section = (raw, key) => (raw && typeof raw[key] === 'object' && raw[key] !== null ? raw[key] : {});

function number(value, fallback, [low, high], integer) {
    if (typeof value === 'boolean' || value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const clamped = Math.min(high, Math.max(low, n));
    return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

function template(value, fallback) {
    if (typeof value !== 'string') return fallback;
    return value.replace(/[\r\n]/g, ' ').slice(0, NAME_TEMPLATE_MAX);
}

// Bloc normalisé : valeurs bornées, champs absents = valeur de `current`
// (défauts sinon).
export function normalizePosesNames(raw, current = null) {
    const defaults = posesNamesDefaults();
    const cur = current && typeof current === 'object' ? current : {};
    const base = { ...defaults };
    for (const key of Object.keys(defaults)) if (key in cur) base[key] = cur[key];
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const key of BOOL_KEYS) out[key] = bool(src[key], bool(base[key], defaults[key]));
    for (const [key, allowed] of Object.entries(NAME_CHOICES)) {
        out[key] = choice(src[key], allowed, choice(base[key], allowed, defaults[key]));
    }
    for (const key of COLOR_KEYS) out[key] = color(src[key], color(base[key], defaults[key]));
    for (const [key, range] of Object.entries(NAME_RANGES)) {
        const integer = !FLOAT_KEYS.has(key);
        out[key] = number(src[key], number(base[key], defaults[key], range, integer), range, integer);
    }
    out.template = template(src.template, template(base.template, defaults.template));
    const kindsSrc = section(src, 'kinds');
    const kindsCur = section(base, 'kinds');
    out.kinds = {};
    for (const k of NAME_KINDS) out.kinds[k] = bool(kindsSrc[k], bool(kindsCur[k], defaults.kinds[k]));
    const colorsSrc = section(src, 'kind_colors');
    const colorsCur = section(base, 'kind_colors');
    out.kind_colors = {};
    for (const k of NAME_COLOR_KINDS) {
        out.kind_colors[k] = color(colorsSrc[k], color(colorsCur[k], defaults.kind_colors[k]));
    }
    const ordered = {};
    for (const key of Object.keys(defaults)) ordered[key] = out[key];
    return ordered;
}

// Copie dont le mouvement et le texte sont ceux du style `preset` ; un nom
// inconnu rend une copie inchangée.
export function withPosesNamesPreset(names, preset) {
    const out = normalizePosesNames(names);
    const style = Object.prototype.hasOwnProperty.call(NAME_PRESETS, preset) ? NAME_PRESETS[preset] : null;
    if (!style) return out;
    for (const key of NAME_PRESET_KEYS) out[key] = style[key];
    return out;
}

// Style prêt à l'emploi dont le mouvement et le texte correspondent
// exactement au bloc, null sinon (le menu affiche alors « Personnalisé »).
export function posesNamesPresetOf(names) {
    const n = normalizePosesNames(names);
    for (const [name, style] of Object.entries(NAME_PRESETS)) {
        if (NAME_PRESET_KEYS.every((key) => style[key] === n[key])) return name;
    }
    return null;
}

// Style prêt à l'emploi le plus proche du bloc (le moins de réglages de
// mouvement et de texte qui diffèrent) et le nombre de ces écarts ; 0 écart
// = posesNamesPresetOf. Premier style de NAME_PRESETS en cas d'égalité.
export function posesNamesNearestPreset(names) {
    const n = normalizePosesNames(names);
    let best = null;
    for (const [name, style] of Object.entries(NAME_PRESETS)) {
        const diff = NAME_PRESET_KEYS.filter((key) => style[key] !== n[key]).length;
        if (!best || diff < best.diff) best = { name, diff };
    }
    return best;
}

// Préférence globale normalisée : exclusions sans doublon (casse ignorée),
// bornées en nombre et en longueur. Une chaîne est découpée aux retours à
// la ligne, virgules et points-virgules (saisie du champ).
export function normalizeNamesPrivacy(raw, current = null) {
    const base = current && typeof current === 'object' ? current : namesPrivacyDefaults();
    const src = raw && typeof raw === 'object' ? raw : {};
    const mode = choice(src.mode, NAME_PRIVACY_MODES, choice(base.mode, NAME_PRIVACY_MODES, 'show'));
    let list = 'exclude' in src ? src.exclude : base.exclude;
    if (typeof list === 'string') list = list.split(/[\n,;]/);
    const exclude = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
        if (typeof item !== 'string') continue;
        const name = item.trim().slice(0, NAME_PSEUDO_MAX);
        const key = foldPseudo(name);
        if (!name || seen.has(key)) continue;
        seen.add(key);
        exclude.push(name);
        if (exclude.length >= NAME_EXCLUDE_MAX) break;
    }
    return { mode, exclude };
}

// Comparaison des pseudos, casse ignorée (casefold côté serveur).
export function foldPseudo(name) {
    return String(name || '').trim().toLowerCase();
}
