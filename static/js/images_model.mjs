// Images posées sur la carte (onglet Images) : modèle de réglages, pur (ni DOM
// ni carte).
//
// Préférence GLOBALE (`images` dans settings.json). Une liste par page, comme
// `stats` : `items` pour « Mes Geocaches », `evolution_items` pour /evolution —
// indépendantes, `enabled` commun. Miroir exact de image_settings.py : les
// deux côtés passent les
// vecteurs partagés tests/fixtures/images/settings_cases.json. Les
// coercitions élémentaires et les marges de coin communes sont celles des
// panneaux de stats (stats_model.mjs).

import {
    STATS_ANCHORS,
    STATS_OFFSET_RANGE,
    STATS_POSITION_MODES,
    newStatsPanelId,
    shareCornerMargins,
    statsCoercers,
} from './stats_model.mjs';

const { intIn, unit, bool, choice, color, title, coerceBlock, isId } = statsCoercers;

export const IMAGES_MAX_ITEMS = 4;
// Tous les emplacements des panneaux sauf le centre de la carte.
export const IMAGE_ANCHORS = Object.freeze(STATS_ANCHORS.filter((anchor) => anchor !== 'middle-center'));
export const IMAGE_SHAPES = Object.freeze(['rect', 'rounded', 'circle']);
export const IMAGE_FITS = Object.freeze(['contain', 'cover']);
export const IMAGE_SIZE_RANGE = Object.freeze([40, 1200]);
export const IMAGE_RADIUS_RANGE = Object.freeze([0, 200]);
export const IMAGE_OPACITY_RANGE = Object.freeze([0, 100]);
export const IMAGE_PADDING_RANGE = Object.freeze([0, 100]);
export const IMAGE_BORDER_RANGE = Object.freeze([0, 50]);
export const IMAGE_FADE_RANGE = Object.freeze([0, 5000]);

export const IMAGES_DEFAULTS = Object.freeze({
    enabled: true, items: Object.freeze([]), evolution_items: Object.freeze([]),
});

// Liste d'images propre à chaque page : `items` pour « Mes Geocaches »,
// `evolution_items` pour /evolution (miroir de statsPanelsKey). Une clé
// absente normalise à [] — jamais une copie de l'autre liste, sinon retirer
// une image d'un côté la retirerait aussi de la vue normalisée de l'autre.
export function imagesItemsKey(evolution) {
    return evolution ? 'evolution_items' : 'items';
}

// Nom d'un fichier du dossier images/ (image_library.safe_image_name).
const FILE_RE = /^[0-9a-f]{16}\.(?:png|jpg)$/;

export function imageFileName(value) {
    return typeof value === 'string' && FILE_RE.test(value) ? value : '';
}

// Valeurs par défaut : en bas à droite (le titre et les infos occupent le
// haut par défaut), 160 px de large, hauteur d'après le ratio de l'image.
export function imageItemDefaults() {
    return {
        enabled: true,
        file: '',
        name: '',
        position: {
            mode: 'anchor', anchor: 'bottom-right', dx: 16, dy: 16,
            width: 160, height: null, x: 0, y: 0,
        },
        style: {
            shape: 'rounded',
            radius: 12,
            fit: 'contain',
            opacity: 100,
            background: '#ffffff',
            background_opacity: 0,
            padding: 0,
            shadow: false,
            border_color: '#ffffff',
            border_width: 0,
        },
        // Apparition/disparition pendant l'animation : dates « AAAA-MM-JJ »
        // (null = pas de borne), durée du fondu en ms.
        schedule: {
            start: null,
            end: null,
            fade: 600,
        },
    };
}

const POSITION_COERCERS = {
    mode: (v, d) => choice(v, STATS_POSITION_MODES, d),
    anchor: (v, d) => choice(v, IMAGE_ANCHORS, d),
    dx: (v, d) => intIn(v, d, STATS_OFFSET_RANGE),
    dy: (v, d) => intIn(v, d, STATS_OFFSET_RANGE),
    width: (v, d) => intIn(v, d, IMAGE_SIZE_RANGE),
    // Hauteur imposée, nullable : null (ou non numérique) = d'après le ratio.
    height: (v) => (v == null ? null : intIn(v, null, IMAGE_SIZE_RANGE)),
    x: unit,
    y: unit,
};

const STYLE_COERCERS = {
    shape: (v, d) => choice(v, IMAGE_SHAPES, d),
    radius: (v, d) => intIn(v, d, IMAGE_RADIUS_RANGE),
    fit: (v, d) => choice(v, IMAGE_FITS, d),
    opacity: (v, d) => intIn(v, d, IMAGE_OPACITY_RANGE),
    background: color,
    background_opacity: (v, d) => intIn(v, d, IMAGE_OPACITY_RANGE),
    padding: (v, d) => intIn(v, d, IMAGE_PADDING_RANGE),
    shadow: bool,
    border_color: color,
    border_width: (v, d) => intIn(v, d, IMAGE_BORDER_RANGE),
};

// Forme stricte d'une date de planing : « AAAA-MM-JJ » ET jour réel —
// « 2026-02-30 » ou « hier » deviennent null, comme le fromisoformat du
// miroir (new Date, lui, reporte le 30 février au 2 mars : le jour relu doit
// être le jour donné). Pas de guillemet dans la regex : le lexer JS de
// pybabel y verrait l'ouverture d'une chaîne (AGENTS.md).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function date(value) {
    if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return null;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
        ? value : null;
}

const SCHEDULE_COERCERS = {
    start: date,
    end: date,
    fade: (v, d) => intIn(v, d, IMAGE_FADE_RANGE),
};

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

// Image normalisée, ou null si l'entrée n'est pas un objet. Un fichier
// invalide devient '' (image à choisir, ou absente sur cette machine) :
// l'entrée est gardée, ses réglages ne sont pas perdus.
export function normalizeImageItem(raw) {
    if (!isObject(raw)) return null;
    const defaults = imageItemDefaults();
    return {
        id: isId(raw.id) ? raw.id : '',
        enabled: bool(raw.enabled, defaults.enabled),
        file: imageFileName(raw.file),
        name: title(raw.name),
        position: coerceBlock(raw.position, defaults.position, POSITION_COERCERS),
        style: coerceBlock(raw.style, defaults.style, STYLE_COERCERS),
        schedule: coerceBlock(raw.schedule, defaults.schedule, SCHEDULE_COERCERS),
    };
}

// Liste normalisée : invalides écartés, identifiants manquants ou en double
// régénérés, tronquée à IMAGES_MAX_ITEMS, marges de coin communes.
function normalizeItemList(source, newId) {
    const items = [];
    const seen = new Set();
    for (const raw of Array.isArray(source) ? source : []) {
        const item = normalizeImageItem(raw);
        if (!item) continue;
        while (!item.id || seen.has(item.id)) item.id = newId();
        seen.add(item.id);
        items.push(item);
        if (items.length >= IMAGES_MAX_ITEMS) break;
    }
    return shareCornerMargins(items);
}

// Bloc `images` normalisé. Patch de premier niveau, comme `stats` : une clé
// absente garde la valeur de `current`.
export function normalizeImagesSettings(raw, current = IMAGES_DEFAULTS, newId = newStatsPanelId) {
    const base = isObject(current) ? current : IMAGES_DEFAULTS;
    if (!isObject(raw)) {
        return {
            enabled: bool(base.enabled, true),
            items: Array.isArray(base.items) ? [...base.items] : [],
            evolution_items: Array.isArray(base.evolution_items) ? [...base.evolution_items] : [],
        };
    }
    return {
        enabled: bool(raw.enabled, bool(base.enabled, true)),
        items: normalizeItemList(Object.hasOwn(raw, 'items') ? raw.items : base.items, newId),
        evolution_items: normalizeItemList(
            Object.hasOwn(raw, 'evolution_items') ? raw.evolution_items : base.evolution_items, newId),
    };
}

// Nouvelle image prête à l'emploi (envoi ou choix dans la bibliothèque) :
// défauts, puis surcharges éventuelles, puis normalisation.
export function createImageItem(file, name = '', overrides = {}, newId = newStatsPanelId) {
    const defaults = imageItemDefaults();
    const item = normalizeImageItem({
        ...defaults,
        ...overrides,
        file,
        name,
        position: { ...defaults.position, ...(overrides.position || {}) },
        style: { ...defaults.style, ...(overrides.style || {}) },
        schedule: { ...defaults.schedule, ...(overrides.schedule || {}) },
    });
    item.id = newId();
    return item;
}
