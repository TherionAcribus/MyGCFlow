// Couche de zones de la carte : options du thème, couleurs, fondus, légende.
// Module pur (ni DOM, ni OpenLayers), testé par
// tests/js/zone_layer_model.test.mjs. Le dessin et le cycle de vie sont dans
// zone_layer.js ; le calcul des valeurs dans zone_model.mjs (partagé avec la
// page Statistiques). Doc : docs/carte-zones.md › Couche de la carte.

import { dayNumber, ymdOfDay } from './stats_model.mjs';
import { GRID_DEFAULT_SIZE, normalizeGridSize } from './zone_grid.mjs';

// Miroir de ZoneLayerOptions (settings_manager.py) et du bloc `zones` de
// static/json/defaultValues.json.
export const ZONE_LAYER_LEVELS = Object.freeze(['country', 'region', 'subregion', 'grid']);
export const ZONE_LAYER_MEASURES = Object.freeze(['count', 'distinct_types', 'dt_coverage', 'first_day']);
export const ZONE_LAYER_SCALES = Object.freeze(['quantile', 'linear', 'log']);
export const ZONE_LAYER_CLASSES_RANGE = Object.freeze([3, 7]);
export const ZONE_LAYER_OPACITY_RANGE = Object.freeze([20, 85]);
export const ZONE_LAYER_LEGEND_POSITIONS = Object.freeze(['bottom-left', 'bottom-right', 'top-left', 'top-right']);
export const ZONE_LAYER_DEFAULTS = Object.freeze({
    level: 'subregion',
    measure: 'count',
    scale: 'quantile',
    classes: 5,
    color: '#1E6FD9',
    opacity: 60,
    outline: true,
    glow: true,
    legend: true,
    legendPosition: 'bottom-left',
    gridSize: GRID_DEFAULT_SIZE,
});
// Fondu d'une zone qui change de classe, et éclat de son contour (ms).
export const ZONE_FADE_MS = 600;

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function clampInt(value, fallback, [min, max]) {
    if (typeof value === 'boolean') return fallback;
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

const choice = (value, list, fallback) => (list.includes(value) ? value : fallback);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

export function normalizeHex(value, fallback) {
    const m = typeof value === 'string' ? HEX_RE.exec(value.trim()) : null;
    if (!m) return fallback;
    const raw = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return '#' + raw.toUpperCase();
}

// Options de la couche (camelCase, pkg.options.zones).
export function normalizeZoneLayerOptions(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const d = ZONE_LAYER_DEFAULTS;
    return {
        level: choice(src.level, ZONE_LAYER_LEVELS, d.level),
        measure: choice(src.measure, ZONE_LAYER_MEASURES, d.measure),
        scale: choice(src.scale, ZONE_LAYER_SCALES, d.scale),
        classes: clampInt(src.classes, d.classes, ZONE_LAYER_CLASSES_RANGE),
        color: normalizeHex(src.color, d.color),
        opacity: clampInt(src.opacity, d.opacity, ZONE_LAYER_OPACITY_RANGE),
        outline: bool(src.outline, d.outline),
        glow: bool(src.glow, d.glow),
        legend: bool(src.legend, d.legend),
        legendPosition: choice(src.legendPosition, ZONE_LAYER_LEGEND_POSITIONS, d.legendPosition),
        gridSize: normalizeGridSize(src.gridSize),
    };
}

// Thème (snake_case, ZoneLayerOptions) ↔ options.
export function zoneLayerToProfile(options) {
    const o = normalizeZoneLayerOptions(options);
    return {
        level: o.level, measure: o.measure, scale: o.scale, classes: o.classes, color: o.color,
        opacity: o.opacity, outline: o.outline, glow: o.glow, legend: o.legend, legend_position: o.legendPosition,
        grid_size: o.gridSize,
    };
}

export function zoneLayerFromProfile(profile) {
    const p = profile && typeof profile === 'object' ? profile : {};
    return normalizeZoneLayerOptions({ ...p, legendPosition: p.legend_position, gridSize: p.grid_size });
}

// Mesure de zone_model.mjs.
export function zoneMeasureFor(measure) {
    if (measure === 'distinct_types') return { op: 'distinct', field: 'cache_type' };
    if (measure === 'dt_coverage') return { op: 'dt_coverage' };
    if (measure === 'first_day') return { op: 'first_day' };
    return { op: 'count' };
}

// ---------------------------------------------------------------------------
// Couleurs

function rgbOf(hex) {
    const raw = normalizeHex(hex, '#888888').slice(1);
    return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
}

const toHex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase();

export function mixHex(a, b, k) {
    const x = rgbOf(a);
    const y = rgbOf(b);
    const t = Math.min(1, Math.max(0, k));
    return toHex(x.map((c, i) => c + (y[i] - c) * t));
}

export function rgbaOf(hex, alpha) {
    const [r, g, b] = rgbOf(hex);
    return `rgba(${r},${g},${b},${Math.min(1, Math.max(0, alpha))})`;
}

// Teinte de chaque classe : du clair (la couleur mêlée de blanc) à la couleur
// choisie. La première classe reste nettement colorée (lisible sur un fond
// de carte clair).
export function classColors(color, classes) {
    const n = Math.max(1, classes);
    return Array.from({ length: n }, (_, c) => mixHex('#FFFFFF', color, n === 1 ? 1 : 0.4 + (0.6 * c) / (n - 1)));
}

// Éclat : 1 au changement de classe, 0 après ZONE_FADE_MS.
export function fadeProgress(start, now, duration = ZONE_FADE_MS) {
    if (!Number.isFinite(start) || !Number.isFinite(now)) return 1;
    if (duration <= 0) return 1;
    return Math.min(1, Math.max(0, (now - start) / duration));
}

// ---------------------------------------------------------------------------
// Légende

// Entrées de la légende : { color, label } du plus faible au plus fort.
// `scale` : zone_model.mjs › zoneScale. `formatNumber(v)` : nombre de la
// page (Intl) ; les années n'en ont pas besoin.
export function legendEntries(scale, options, { formatNumber = (v) => String(v) } = {}) {
    if (!scale || scale.min === null || scale.min === undefined) return [];
    const colors = classColors(options.color, scale.classes);
    const { breaks, min, max } = scale;
    const year = (day) => ymdOfDay(day).y;
    return colors.map((color, c) => {
        const lo = c === 0 ? min : breaks[c - 1];
        const upper = c === scale.classes - 1 ? null : breaks[c];
        let label;
        if (scale.mode === 'year') {
            const a = year(lo);
            const b = upper === null ? year(max) : year(upper) - 1;
            label = a === b ? String(a) : `${a}–${b}`;
        } else {
            // Mesures entières : « 4–7 ». Une borne d'échelle linéaire ou
            // logarithmique n'est pas entière : classe [3,33 ; 5,67[ = 4–5.
            const a = c === 0 ? min : Math.ceil(lo);
            const b = upper === null ? max : Math.ceil(upper) - 1;
            label = a >= b ? formatNumber(a) : `${formatNumber(a)}–${formatNumber(b)}`;
        }
        return { color, label };
    });
}

// Boîte de la légende en pixels CSS (dessin à l'écran et dans la vidéo) :
// titre, puis une ligne par classe.
export const LEGEND_STYLE = Object.freeze({
    padding: 8, swatch: 12, gap: 6, row: 18, titleSize: 12, labelSize: 11, margin: 12, radius: 6,
});

export function legendSize(entries, title, measureText) {
    const s = LEGEND_STYLE;
    const labels = entries.map((e) => measureText(e.label, s.labelSize));
    const width = Math.max(measureText(title, s.titleSize), s.swatch + s.gap + Math.max(0, ...labels)) + s.padding * 2;
    const height = s.padding * 2 + s.row + entries.length * s.row;
    return { width: Math.ceil(width), height: Math.ceil(height) };
}

// Coin d'ancrage → position du coin haut-gauche, dans une surface w × h.
export function legendOrigin(position, size, w, h, margin = LEGEND_STYLE.margin) {
    const left = position.endsWith('left');
    const top = position.startsWith('top');
    return {
        x: left ? margin : w - margin - size.width,
        y: top ? margin : h - margin - size.height,
    };
}

// Jour de fin d'un instant (Date locale) en numéro de jour.
export function dayOfDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return dayNumber({ y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
}
