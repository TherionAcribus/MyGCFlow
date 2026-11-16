// Thèmes de couleurs de la page Statistiques. Module pur, testé par
// tests/js/stats_theme_model.test.mjs. Plan :
// MyGCFlow_Plan_Themes_Statistiques.md ; doc : docs/page-statistiques.md.
//
// Un thème donne les teintes des séries (8), le dégradé (5 pas, du plus
// faible au plus fort), la paire hausse / baisse et, facultativement, une
// couleur par type de cache. Le reste (quadrillage, « Autres », cases vides,
// textes) reste neutre : stats_page.css.
//
// Thèmes fournis (lecture seule) : une variante claire et une sombre,
//   { id, builtin: true, light: Variant, dark: Variant }
//   Variant = { series: [8], heat: '#hex' (dégradé généré) | [5], up, down }
// Thèmes personnels (document des tableaux de bord, `themes`) : un seul jeu
// de couleurs pour les deux modes,
//   { id, name, series: [8], heat: { color } | { colors: [5] }, up, down,
//     types: null | { 'Traditional Cache': '#hex', … } }
// `heat.color` : dégradé généré pour chaque fond (heatRamp) ; `heat.colors`
// : cinq couleurs prises telles quelles.

export const THEME_SERIES = 8;
export const THEME_HEAT = 5;
export const MAX_THEMES = 30;
export const THEME_NAME_MAX = 40;
export const DEFAULT_THEME_ID = 'default';
// Fonds de l'app (--color-surface clair / sombre) : dégradés générés et
// avertissements de lisibilité sont calculés sur eux.
export const SURFACES = Object.freeze({ light: '#ffffff', dark: '#1b2635' });

const ID_RE = /^[0-9a-f]{6,32}$/;
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Défaut : les valeurs de stats_page.css (le thème « Défaut » ne pose
// aucune variable, ces valeurs servent à le dupliquer et à l'aperçu).
const freezeVariant = (v) => Object.freeze({ ...v, series: Object.freeze(v.series), heat: Array.isArray(v.heat) ? Object.freeze(v.heat) : v.heat });
const builtin = (id, light, dark) => Object.freeze({ id, builtin: true, light: freezeVariant(light), dark: freezeVariant(dark) });

export const BUILTIN_THEMES = Object.freeze([
    builtin('default', {
        series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
        heat: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'],
        up: '#2a78d6', down: '#e34948',
    }, {
        series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
        heat: ['#1c3554', '#1c5cab', '#2a78d6', '#5598e7', '#9ec5f4'],
        up: '#3987e5', down: '#e66767',
    }),
    builtin('pastel', {
        series: ['#6f9fd8', '#ef9a72', '#6cbf91', '#e0b04f', '#dc8cb4', '#93b85a', '#a08bd6', '#e57f7f'],
        heat: '#6f9fd8', up: '#6f9fd8', down: '#e57f7f',
    }, {
        series: ['#9cc3f0', '#f7b99a', '#9fdcb9', '#f6d58e', '#f0b8d4', '#c0dc85', '#c7b6ea', '#f4a3a3'],
        heat: '#8ab8ec', up: '#9cc3f0', down: '#f4a3a3',
    }),
    builtin('vivid', {
        series: ['#0062ff', '#ff5a00', '#00a64b', '#f2a900', '#e6007e', '#7a00e6', '#00a9b8', '#d50000'],
        heat: '#7a00e6', up: '#00a64b', down: '#d50000',
    }, {
        series: ['#4d8dff', '#ff7a2e', '#22cc6b', '#ffc233', '#ff3d9e', '#a64dff', '#26d4e3', '#ff4d4d'],
        heat: '#a64dff', up: '#22cc6b', down: '#ff4d4d',
    }),
    builtin('earth', {
        series: ['#8c5a2b', '#d08c2f', '#5f8a3a', '#bfb23a', '#a6493a', '#3f6f6a', '#8f6fa8', '#6b6b47'],
        heat: '#8c5a2b', up: '#5f8a3a', down: '#a6493a',
    }, {
        series: ['#c08a55', '#e3a650', '#86b35f', '#e0d36a', '#d0705f', '#6aa39d', '#b9a0cf', '#a3a372'],
        heat: '#c08a55', up: '#86b35f', down: '#d0705f',
    }),
    builtin('ocean', {
        series: ['#005f99', '#0096c7', '#2a9d8f', '#3fb6d3', '#264653', '#5e60ce', '#e07a5f', '#7b9fd4'],
        heat: '#0077b6', up: '#2a9d8f', down: '#d1495b',
    }, {
        series: ['#3a9ad9', '#33b8e0', '#4fc3b4', '#7fdcf0', '#8fb3c4', '#8f91e8', '#f2967d', '#a6c1ea'],
        heat: '#33a3e0', up: '#4fc3b4', down: '#ef6f7f',
    }),
    // Okabe-Ito : distinguable dans les trois formes de daltonisme ; en
    // clair, le jaune est foncé et le noir garde sa place, en sombre le noir
    // devient un gris clair.
    builtin('colorblind', {
        series: ['#0072b2', '#e69f00', '#009e73', '#d55e00', '#cc79a7', '#56b4e9', '#b8a600', '#000000'],
        heat: '#0072b2', up: '#0072b2', down: '#d55e00',
    }, {
        series: ['#3a9ad6', '#e69f00', '#00b386', '#e36b1a', '#d68fb7', '#56b4e9', '#f0e442', '#d0d0d0'],
        heat: '#56b4e9', up: '#56b4e9', down: '#e36b1a',
    }),
]);

const BUILTIN_BY_ID = new Map(BUILTIN_THEMES.map((theme) => [theme.id, theme]));

export const isBuiltinTheme = (id) => BUILTIN_BY_ID.has(id);
export const builtinTheme = (id) => BUILTIN_BY_ID.get(id) || null;
// Référence acceptée dans un document : un thème fourni ou un identifiant
// de thème personnel (son existence se vérifie à part).
export const isThemeRef = (id) => typeof id === 'string' && (BUILTIN_BY_ID.has(id) || ID_RE.test(id));

// ---------------------------------------------------------------------------
// Couleurs
// ---------------------------------------------------------------------------

export function normalizeHex(value) {
    if (typeof value !== 'string' || !HEX_RE.test(value.trim())) return null;
    const raw = value.trim().slice(1).toLowerCase();
    return '#' + (raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw);
}

function rgbOf(hex) {
    const full = normalizeHex(hex).slice(1);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklab(hex) {
    const [r, g, b] = rgbOf(hex).map(toLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
}

function fromOklab([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255)
        .toString(16).padStart(2, '0')).join('');
}

// Mélange perceptif : `t` = 0 → a, 1 → b.
export function mixColors(a, b, t) {
    const p = oklab(a);
    const q = oklab(b);
    return fromOklab(p.map((v, i) => v + (q[i] - v) * t));
}

export function colorDistance(a, b) {
    const p = oklab(a);
    const q = oklab(b);
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function luminance(hex) {
    const [r, g, b] = rgbOf(hex).map(toLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

// Dégradé de 5 pas autour d'une couleur, pour le fond d'un mode : les deux
// premiers pas partent du fond (une case proche de zéro s'y fond, comme le
// dégradé par défaut), la couleur est au milieu, les deux derniers
// s'éloignent du fond (plus foncés en clair, plus lumineux en sombre).
export function heatRamp(color, mode = 'light') {
    const base = normalizeHex(color) || '#3987e5';
    const surface = SURFACES[mode] || SURFACES.light;
    const far = mode === 'dark' ? '#ffffff' : '#000000';
    return [
        mixColors(surface, base, mode === 'dark' ? 0.3 : 0.22),
        mixColors(surface, base, 0.58),
        base,
        mixColors(base, far, 0.28),
        mixColors(base, far, 0.55),
    ];
}

// ---------------------------------------------------------------------------
// Thèmes personnels
// ---------------------------------------------------------------------------

function flatName(value) {
    if (typeof value !== 'string') return '';
    return Array.from(value.replace(/[\r\n\t]+/g, ' ').trim()).slice(0, THEME_NAME_MAX).join('');
}

const DEFAULT_LIGHT = BUILTIN_BY_ID.get(DEFAULT_THEME_ID).light;

function normalizeHeat(raw) {
    if (isObject(raw) && Array.isArray(raw.colors)) {
        const colors = raw.colors.slice(0, THEME_HEAT).map(normalizeHex);
        if (colors.length === THEME_HEAT && colors.every(Boolean)) return { colors };
    }
    return { color: normalizeHex(isObject(raw) ? raw.color : null) || DEFAULT_LIGHT.heat[2] };
}

function normalizeTypes(raw) {
    if (!isObject(raw)) return null;
    const out = {};
    for (const [type, color] of Object.entries(raw)) {
        const hex = normalizeHex(color);
        if (hex && type && type.length <= 80) out[type] = hex;
    }
    return Object.keys(out).length ? out : null;
}

// Thème personnel lu (document, fichier importé) ; null s'il n'est pas un
// objet. Une couleur illisible prend celle du thème Défaut à la même place.
export function normalizeTheme(raw, { newId } = {}) {
    if (!isObject(raw)) return null;
    const series = Array.from({ length: THEME_SERIES },
        (_, i) => normalizeHex(Array.isArray(raw.series) ? raw.series[i] : null) || DEFAULT_LIGHT.series[i]);
    const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : (newId ? newId() : null);
    if (!id) return null;
    return {
        id,
        name: flatName(raw.name),
        series,
        heat: normalizeHeat(raw.heat),
        up: normalizeHex(raw.up) || DEFAULT_LIGHT.up,
        down: normalizeHex(raw.down) || DEFAULT_LIGHT.down,
        types: normalizeTypes(raw.types),
    };
}

export function normalizeThemes(raw, { newId } = {}) {
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(raw) ? raw : []) {
        const theme = normalizeTheme(entry, { newId });
        if (!theme) continue;
        while (seen.has(theme.id) && newId) theme.id = newId();
        if (seen.has(theme.id)) continue;
        seen.add(theme.id);
        out.push(theme);
        if (out.length >= MAX_THEMES) break;
    }
    return out;
}

// Thème fourni ou personnel ; null pour une référence inconnue.
export function findTheme(themes, id) {
    if (BUILTIN_BY_ID.has(id)) return BUILTIN_BY_ID.get(id);
    return (themes || []).find((theme) => theme.id === id) || null;
}

// Identifiant du thème appliqué à un tableau : le sien, sinon celui de la
// page, sinon Défaut (une référence disparue retombe d'un cran).
export function effectiveThemeId(doc, dashboard) {
    const themes = doc?.themes || [];
    if (dashboard?.theme && findTheme(themes, dashboard.theme)) return dashboard.theme;
    if (doc?.theme && findTheme(themes, doc.theme)) return doc.theme;
    return DEFAULT_THEME_ID;
}

// ---------------------------------------------------------------------------
// Résolution
// ---------------------------------------------------------------------------

// Couleurs d'un thème pour un mode : { series, heat, up, down }.
export function resolveTheme(theme, mode = 'light') {
    const key = mode === 'dark' ? 'dark' : 'light';
    if (theme?.builtin) {
        const variant = theme[key];
        return {
            series: [...variant.series],
            heat: Array.isArray(variant.heat) ? [...variant.heat] : heatRamp(variant.heat, key),
            up: variant.up,
            down: variant.down,
        };
    }
    if (!theme) return resolveTheme(BUILTIN_BY_ID.get(DEFAULT_THEME_ID), key);
    return {
        series: [...theme.series],
        heat: theme.heat.colors ? [...theme.heat.colors] : heatRamp(theme.heat.color, key),
        up: theme.up,
        down: theme.down,
    };
}

// Variables CSS à poser sur <html> ; null pour le thème Défaut, dont les
// valeurs sont celles de stats_page.css (clair et sombre).
export function themeCssVars(theme, mode = 'light') {
    if (!theme || theme.id === DEFAULT_THEME_ID) return null;
    const colors = resolveTheme(theme, mode);
    const vars = { '--chart-up': colors.up, '--chart-down': colors.down };
    colors.series.forEach((c, i) => { vars[`--chart-series-${i + 1}`] = c; });
    colors.heat.forEach((c, i) => { vars[`--chart-heat-${i + 1}`] = c; });
    return vars;
}

export const THEME_CSS_VARS = Object.freeze([
    '--chart-up', '--chart-down',
    ...Array.from({ length: THEME_SERIES }, (_, i) => `--chart-series-${i + 1}`),
    ...Array.from({ length: THEME_HEAT }, (_, i) => `--chart-heat-${i + 1}`),
]);

// Couleurs des types d'un thème : celles de la carte (`defaults`), et par
// dessus celles choisies dans le thème. Même objet tant que le thème n'a
// pas de couleurs de types (distinctTypeColors mémorise par objet).
export function themeTypeColors(theme, defaults) {
    if (!theme?.types) return defaults;
    return { ...defaults, ...theme.types };
}

// ---------------------------------------------------------------------------
// Avertissements (éditeur)
// ---------------------------------------------------------------------------

// Contraste minimal sur le fond : en deçà, une barre ou un trait se
// distingue mal (le jaune du thème Défaut est à ~2:1 en clair).
export const FAINT_CONTRAST = 1.5;
// Écart OKLab minimal entre deux séries.
export const CLOSE_DISTANCE = 0.06;

// [{ kind: 'faint', slot, index, mode }, { kind: 'close', index, other }].
// `slot` : 'series' | 'up' | 'down' ; `index` : rang dans les séries.
export function themeWarnings(theme) {
    const warnings = [];
    for (const mode of ['light', 'dark']) {
        const colors = resolveTheme(theme, mode);
        const surface = SURFACES[mode];
        colors.series.forEach((color, index) => {
            if (contrastRatio(color, surface) < FAINT_CONTRAST) warnings.push({ kind: 'faint', slot: 'series', index, mode });
        });
        for (const slot of ['up', 'down']) {
            if (contrastRatio(colors[slot], surface) < FAINT_CONTRAST) warnings.push({ kind: 'faint', slot, index: 0, mode });
        }
    }
    const series = resolveTheme(theme, 'light').series;
    for (let i = 0; i < series.length; i++) {
        for (let j = i + 1; j < series.length; j++) {
            if (colorDistance(series[i], series[j]) < CLOSE_DISTANCE) warnings.push({ kind: 'close', index: i, other: j });
        }
    }
    return warnings;
}

// ---------------------------------------------------------------------------
// Créer, partager
// ---------------------------------------------------------------------------

// Nom libre parmi les thèmes personnels : « Nom », sinon « Nom (2) »…
export function uniqueThemeName(themes, name) {
    const base = flatName(name) || 'Thème';
    const taken = new Set((themes || []).map((theme) => theme.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const suffix = ` (${n})`;
        const candidate = Array.from(base).slice(0, THEME_NAME_MAX - suffix.length).join('') + suffix;
        if (!taken.has(candidate)) return candidate;
    }
}

// Thème personnel tiré d'un autre : un thème fourni donne sa variante du
// mode affiché ; son dégradé devient un dégradé généré depuis sa couleur
// centrale (il suit ainsi le fond de chaque mode).
export function duplicateTheme(source, { mode = 'light', newId, name = '' } = {}) {
    if (source?.builtin) {
        const variant = source[mode === 'dark' ? 'dark' : 'light'];
        return normalizeTheme({
            id: newId(),
            name,
            series: variant.series,
            heat: { color: Array.isArray(variant.heat) ? variant.heat[2] : variant.heat },
            up: variant.up,
            down: variant.down,
            types: null,
        });
    }
    const copy = structuredClone(source);
    return normalizeTheme({ ...copy, id: newId(), name });
}

// Contenu partagé (fichier d'un tableau de bord) : sans identifiant.
export function exportTheme(theme) {
    const { id, ...body } = structuredClone(theme);
    return body;
}

function sameColors(a, b) {
    const pick = (t) => JSON.stringify([t.series, t.heat, t.up, t.down, t.types || null]);
    return pick(a) === pick(b);
}

// Thème reçu (import d'un tableau) → { themes, id }. Un thème personnel de
// mêmes couleurs est réutilisé ; sinon il est ajouté sous un nom libre.
// id null : rien d'utilisable, ou plus de place.
export function adoptTheme(themes, raw, { newId, defaultName = '' } = {}) {
    const list = themes || [];
    const theme = normalizeTheme({ ...(isObject(raw) ? raw : {}), id: undefined }, { newId });
    if (!isObject(raw) || !theme) return { themes: list, id: null };
    const same = list.find((existing) => sameColors(existing, theme));
    if (same) return { themes: list, id: same.id };
    if (list.length >= MAX_THEMES) return { themes: list, id: null };
    theme.name = uniqueThemeName(list, theme.name || defaultName);
    return { themes: [...list, theme], id: theme.id };
}
