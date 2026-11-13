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
export const ZONE_LAYER_MEASURES = Object.freeze(['count', 'distinct_types', 'dt_coverage', 'dt_missing', 'first_day', 'found_share']);
// Mesures qui acceptent la densité (valeur par km²) : ce qui se compte.
export const ZONE_LAYER_DENSITY_MEASURES = Object.freeze(['count', 'distinct_types']);
// Part trouvée : caches actives à la date (défaut) ou toutes celles apparues.
export const ZONE_LAYER_SHARE_BASES = Object.freeze(['active', 'all']);
export const ZONE_LAYER_SCALES = Object.freeze(['quantile', 'linear', 'log']);
export const ZONE_LAYER_CLASSES_RANGE = Object.freeze([3, 7]);
export const ZONE_LAYER_OPACITY_RANGE = Object.freeze([20, 85]);
export const ZONE_LAYER_LEGEND_POSITIONS = Object.freeze(['bottom-left', 'bottom-right', 'top-left', 'top-right']);
export const ZONE_LAYER_DEFAULTS = Object.freeze({
    level: 'subregion',
    measure: 'count',
    perKm2: false,
    scale: 'quantile',
    classes: 5,
    color: '#1E6FD9',
    opacity: 60,
    outline: true,
    glow: true,
    legend: true,
    legendPosition: 'bottom-left',
    gridSize: GRID_DEFAULT_SIZE,
    // Jeu Évolution croisé sur « Mes Géocaches » (0 = aucun).
    shareDataset: 0,
    shareBase: 'active',
    // Comparaison à une date ('AAAA-MM-JJ', '' = état du jour) : la couleur
    // montre alors le gain ou la perte depuis cette date (rouge/teinte).
    compareDate: '',
    // « Zones seules » : masque points, trajet et flashs pour lire la carte
    // colorée seule (mapgl.syncSoloLayers).
    solo: false,
    // Valeur de chaque zone écrite sur la carte (zone_layer.js › labelStyle).
    labels: false,
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
    const measure = choice(src.measure, ZONE_LAYER_MEASURES, d.measure);
    return {
        level: choice(src.level, ZONE_LAYER_LEVELS, d.level),
        measure,
        // Gardée quelle que soit la mesure (l'utilisateur la retrouve en
        // revenant à un décompte) ; appliquée seulement pour les mesures
        // de ZONE_LAYER_DENSITY_MEASURES — voir zone_layer.js.
        perKm2: bool(src.perKm2, d.perKm2),
        scale: choice(src.scale, ZONE_LAYER_SCALES, d.scale),
        classes: clampInt(src.classes, d.classes, ZONE_LAYER_CLASSES_RANGE),
        color: normalizeHex(src.color, d.color),
        opacity: clampInt(src.opacity, d.opacity, ZONE_LAYER_OPACITY_RANGE),
        outline: bool(src.outline, d.outline),
        glow: bool(src.glow, d.glow),
        legend: bool(src.legend, d.legend),
        legendPosition: choice(src.legendPosition, ZONE_LAYER_LEGEND_POSITIONS, d.legendPosition),
        gridSize: normalizeGridSize(src.gridSize),
        shareDataset: clampInt(src.shareDataset, d.shareDataset, [0, 9999999999]),
        shareBase: choice(src.shareBase, ZONE_LAYER_SHARE_BASES, d.shareBase),
        compareDate: typeof src.compareDate === 'string' && COMPARE_DATE_RE.test(src.compareDate) ? src.compareDate : '',
        solo: bool(src.solo, d.solo),
        labels: bool(src.labels, d.labels),
    };
}

// Référence de la comparaison, en « AAAA-MM-JJ » (champ date du navigateur).
const COMPARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Thème (snake_case, ZoneLayerOptions) ↔ options.
export function zoneLayerToProfile(options) {
    const o = normalizeZoneLayerOptions(options);
    return {
        level: o.level, measure: o.measure, per_km2: o.perKm2, scale: o.scale, classes: o.classes, color: o.color,
        opacity: o.opacity, outline: o.outline, glow: o.glow, legend: o.legend, legend_position: o.legendPosition,
        grid_size: o.gridSize, share_dataset: o.shareDataset, share_base: o.shareBase, compare_date: o.compareDate,
        solo: o.solo, labels: o.labels,
    };
}

export function zoneLayerFromProfile(profile) {
    const p = profile && typeof profile === 'object' ? profile : {};
    return normalizeZoneLayerOptions({
        ...p, legendPosition: p.legend_position, gridSize: p.grid_size, perKm2: p.per_km2,
        shareDataset: p.share_dataset, shareBase: p.share_base, compareDate: p.compare_date, solo: p.solo,
        labels: p.labels,
    });
}

// Mesure de zone_model.mjs.
export function zoneMeasureFor(measure) {
    if (measure === 'distinct_types') return { op: 'distinct', field: 'cache_type' };
    if (measure === 'dt_coverage') return { op: 'dt_coverage' };
    if (measure === 'dt_missing') return { op: 'dt_missing' };
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

// Teinte des classes négatives en comparaison à une date (les positives
// gardent la couleur du thème).
export const COMPARE_NEGATIVE_COLOR = '#C0392B';

// Rampe divergente de la comparaison à une date : les classes sous zéro
// descendent en rouge, celles au-dessus montent dans la teinte choisie —
// dans les deux cas, plus la valeur s'éloigne de zéro, plus elle est foncée.
// Le signe d'une classe est celui de sa borne HAUTE : une classe qui finit
// à 0 ou sous 0 est négative. Avec l'échelle divergente (zoneScale ›
// signed), aucune classe n'est à cheval sur zéro, et la classe « vide »
// d'un côté absent ([min, 0) sur une échelle de gains) prend bien le rouge
// des pertes vues pendant l'animation.
export function compareClassColors(scale, color) {
    const n = Math.max(1, scale?.classes || 0);
    const signs = Array.from({ length: n }, (_, c) => {
        const upper = c === n - 1 ? null : scale.breaks[c];
        return upper !== null && upper <= 0 ? -1 : 1;
    });
    const neg = signs.filter((s) => s < 0).length;
    const posRamp = classColors(color, Math.max(1, n - neg));
    const negRamp = classColors(COMPARE_NEGATIVE_COLOR, Math.max(1, neg));
    let up = 0;
    let down = 0;
    return signs.map((s) => (s < 0 ? negRamp[neg - 1 - down++] : posRamp[up++]));
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
// `percent` : valeurs continues en pourcentage (part trouvée) — « 12–31 % ».
// `float` : valeurs fractionnaires (densité) — mêmes bornes ouvertes, sans
// « % » ; `formatNumber` les met dans l'unité affichée (pour 1 000 km²).
// `signed` : écarts d'une comparaison à une date — signe explicite
// (« +3 », « −2 ») et rampe divergente (compareClassColors).
// Classes extrêmes ouvertes : l'échelle est celle de l'état final, mais des
// valeurs plus basses (cumul qui démarre) ou plus fortes (caches actives
// d'Évolution) tombent dedans pendant l'animation — « ≤ 2 », « ≥ 3 ».
export function legendEntries(scale, options, { formatNumber = (v) => String(v), percent = false, float = false, signed = false } = {}) {
    if (!scale || scale.min === null || scale.min === undefined) return [];
    const colors = signed ? compareClassColors(scale, options.color) : classColors(options.color, scale.classes);
    const { breaks, min, max } = scale;
    const year = (day) => ymdOfDay(day).y;
    const last = scale.classes - 1;
    const signedNumber = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + formatNumber(Math.abs(v));
    return colors.map((color, c) => {
        const lo = c === 0 ? min : breaks[c - 1];
        const upper = c === last ? null : breaks[c];
        let label;
        if (percent || float || signed) {
            const suffix = percent ? ' %' : '';
            const n = signed ? signedNumber : formatNumber;
            const a = n(lo);
            const b = n(upper ?? max);
            if (c === 0 && last === 0) label = `${a}${suffix}`;
            else if (c === 0) label = `< ${n(upper)}${suffix}`;
            else if (upper === null) label = `≥ ${a}${suffix}`;
            else label = `${a === b ? a : `${a}–${b}`}${suffix}`;
        } else if (scale.mode === 'year') {
            const a = year(lo);
            const b = upper === null ? year(max) : year(upper) - 1;
            label = a === b ? String(a) : `${a}–${b}`;
        } else if (last === 0) {
            label = formatNumber(min);
        } else if (c === 0) {
            label = `≤ ${formatNumber(Math.ceil(upper) - 1)}`;
        } else if (upper === null) {
            label = `≥ ${formatNumber(Math.ceil(lo))}`;
        } else {
            // Mesures entières : « 4–7 ». Une borne d'échelle linéaire ou
            // logarithmique n'est pas entière : classe [3,33 ; 5,67[ = 4–5.
            const a = Math.ceil(lo);
            const b = Math.ceil(upper) - 1;
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

// ---------------------------------------------------------------------------
// Valeurs écrites sur les zones (option `labels`)

// Texte d'une valeur sur sa zone, court comme la légende qui donne l'unité :
// année d'une première trouvaille, densité pour 1 000 km² (2 chiffres
// significatifs), pourcentage arrondi sans « % », « 12 k » au-delà de
// 10 000, signe explicite pour un écart (comparaison à une date).
// Formateurs réutilisés : la couche écrit chaque valeur à chaque image de
// l'animation, et créer un Intl.NumberFormat coûte des dizaines de µs.
const numberFormats = new Map();
function numberFormat(locale, kind) {
    const key = locale + '|' + kind;
    let fmt = numberFormats.get(key);
    if (!fmt) {
        const options = kind === 'density' ? { maximumSignificantDigits: 2 }
            : kind === 'compact' ? { notation: 'compact', maximumFractionDigits: 1 }
                : { maximumFractionDigits: 0 };
        fmt = new Intl.NumberFormat(locale, options);
        numberFormats.set(key, fmt);
    }
    return fmt;
}

export function zoneLabelText(value, { measure = 'count', density = false, signed = false, locale = 'fr' } = {}) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '';
    if (measure === 'first_day' && !signed) return String(ymdOfDay(value).y);
    const v = density ? value * 1000 : value;
    const abs = Math.abs(v);
    const kind = density ? 'density' : abs >= 10000 ? 'compact' : 'integer';
    const text = numberFormat(locale, kind).format(signed ? abs : v);
    if (!signed) return text;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + text;
}

const DARK_TEXT = '#1F2B38';

function luminance(hex) {
    const channel = (c) => {
        const x = c / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = rgbOf(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// Couleurs du texte sur une zone de teinte `hex` posée à l'opacité `alpha`
// sur un fond de carte clair : blanc (halo sombre) ou presque noir (halo
// blanc), selon le meilleur contraste WCAG. Le halo garde la valeur lisible
// quand elle déborde sur une voisine ou sur un fond sombre.
export function zoneLabelColors(hex, alpha = 1) {
    const seen = mixHex('#FFFFFF', hex, alpha);
    const l = luminance(seen);
    const onWhite = 1.05 / (l + 0.05);
    const onDark = (l + 0.05) / (luminance(DARK_TEXT) + 0.05);
    return onWhite >= onDark
        ? { fill: '#FFFFFF', stroke: 'rgba(0,0,0,0.45)' }
        : { fill: DARK_TEXT, stroke: 'rgba(255,255,255,0.8)' };
}

// Une valeur tient dans sa zone : texte (largeur `textWidth`, taille
// `fontSize`) dans l'emprise de la partie qui porte l'étiquette, en pixels.
export function labelFits(textWidth, fontSize, widthPx, heightPx) {
    return textWidth <= widthPx * 0.9 && fontSize * 1.1 <= heightPx;
}

// Jour de fin d'un instant (Date locale) en numéro de jour.
export function dayOfDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return dayNumber({ y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
}
