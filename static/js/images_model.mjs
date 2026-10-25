// Images posées sur la carte (onglet Images) : modèle de réglages, pur (ni DOM
// ni carte).
//
// Préférence GLOBALE (`images` dans settings.json). Une liste par page, comme
// `stats` : `items` pour « Mes Geocaches », `evolution_items` pour /evolution —
// indépendantes, `enabled` commun ; `configs` : configurations nommées
// {name, items}, applicables sur les deux pages. Miroir exact de image_settings.py : les
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
import { modeOf } from './app_mode.mjs';

const { intIn, unit, bool, choice, color, title, coerceBlock, configName, isId } = statsCoercers;

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
// Ombre portée : décalages en px CSS (négatifs permis), flou, couleur et
// opacité — paramètres identiques entre drop-shadow CSS (aperçu) et les
// shadow* du canvas (vidéo), cf. images_render.mjs › imageShadowParams.
export const IMAGE_SHADOW_OFFSET_RANGE = Object.freeze([-80, 80]);
export const IMAGE_SHADOW_BLUR_RANGE = Object.freeze([0, 80]);
// Point focal du recadrage « cover », en % de l'image (50 = centré).
export const IMAGE_FOCUS_RANGE = Object.freeze([0, 100]);
// Orientation : quarts de tour dans le sens horaire, et miroir horizontal
// (appliqué dans l'espace de l'image, avant la rotation).
export const IMAGE_ROTATIONS = Object.freeze([0, 90, 180, 270]);
export const IMAGE_FADE_RANGE = Object.freeze([0, 5000]);
// Planing : par dates, ou par jalons du compteur de trouvailles (« à la
// 1000e trouvaille »), converti en date au moment de l'animation.
export const IMAGE_SCHEDULE_BY = Object.freeze(['date', 'find']);
export const IMAGE_FIND_RANGE = Object.freeze([1, 10_000_000]);
// Effet d'entrée et de sortie : fondu seul, glissement depuis le bord le plus
// proche, ou zoom (« pop »), tous combinés au fondu.
export const IMAGE_EFFECTS = Object.freeze(['fade', 'slide', 'zoom']);
// Configurations nommées : instantanés de la liste d'une page.
export const IMAGES_MAX_CONFIGS = 12;

export const IMAGES_DEFAULTS = Object.freeze({
    enabled: true, items: Object.freeze([]), evolution_items: Object.freeze([]),
    poses_items: Object.freeze([]), configs: Object.freeze([]),
});

// Liste d'images propre à chaque page : `items` pour « Mes Geocaches »,
// `evolution_items` pour /evolution, `poses_items` pour /poses (miroir de
// statsPanelsKey). Une clé absente normalise à [] — jamais une copie d'une
// autre liste, sinon retirer une image d'un côté la retirerait aussi de la
// vue normalisée de l'autre. `mode` = nom de mode ou ancien booléen.
const IMAGES_ITEMS_KEYS = Object.freeze({ main: 'items', evolution: 'evolution_items', poses: 'poses_items' });
export function imagesItemsKey(mode) {
    return IMAGES_ITEMS_KEYS[modeOf(mode)];
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
            // Point focal de « Remplir la forme » : la zone de l'image gardée
            // au centre du recadrage (50 = cadrage centré).
            focus_x: 50,
            focus_y: 50,
            rotate: 0,
            mirror: false,
            opacity: 100,
            background: '#ffffff',
            background_opacity: 0,
            padding: 0,
            shadow: false,
            shadow_x: 0,
            shadow_y: 4,
            shadow_blur: 12,
            shadow_color: '#000000',
            shadow_opacity: 35,
            border_color: '#ffffff',
            border_width: 0,
        },
        // Apparition/disparition pendant l'animation : par dates
        // « AAAA-MM-JJ » (`by: date`) ou par numéros de trouvaille
        // (`by: find`) — null = pas de borne ; les deux paires sont gardées
        // pour qu'un aller-retour entre les modes ne perde rien. Durée de la
        // transition en ms, effet d'entrée/sortie.
        schedule: {
            by: 'date',
            start: null,
            end: null,
            start_find: null,
            end_find: null,
            fade: 600,
            effect: 'fade',
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
    focus_x: (v, d) => intIn(v, d, IMAGE_FOCUS_RANGE),
    focus_y: (v, d) => intIn(v, d, IMAGE_FOCUS_RANGE),
    rotate: (v, d) => (IMAGE_ROTATIONS.includes(Number(v)) ? Number(v) : d),
    mirror: bool,
    opacity: (v, d) => intIn(v, d, IMAGE_OPACITY_RANGE),
    background: color,
    background_opacity: (v, d) => intIn(v, d, IMAGE_OPACITY_RANGE),
    padding: (v, d) => intIn(v, d, IMAGE_PADDING_RANGE),
    shadow: bool,
    shadow_x: (v, d) => intIn(v, d, IMAGE_SHADOW_OFFSET_RANGE),
    shadow_y: (v, d) => intIn(v, d, IMAGE_SHADOW_OFFSET_RANGE),
    shadow_blur: (v, d) => intIn(v, d, IMAGE_SHADOW_BLUR_RANGE),
    shadow_color: color,
    shadow_opacity: (v, d) => intIn(v, d, IMAGE_OPACITY_RANGE),
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

// Numéro de trouvaille nullable : null (ou non numérique) = pas de borne.
const find = (v) => (v == null ? null : intIn(v, null, IMAGE_FIND_RANGE));

const SCHEDULE_COERCERS = {
    by: (v, d) => choice(v, IMAGE_SCHEDULE_BY, d),
    start: date,
    end: date,
    start_find: find,
    end_find: find,
    fade: (v, d) => intIn(v, d, IMAGE_FADE_RANGE),
    effect: (v, d) => choice(v, IMAGE_EFFECTS, d),
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

// Configuration nommée normalisée { name, items }, ou null si le nom est
// vide après aplatissement. Les images suivent les règles d'une liste.
export function normalizeImagesConfig(raw, newId = newStatsPanelId) {
    if (!isObject(raw)) return null;
    const name = configName(raw.name);
    if (!name) return null;
    return { name, items: normalizeItemList(raw.items, newId) };
}

// Configurations : premier nom gagnant (un doublon serait impossible à
// distinguer), tronquées à IMAGES_MAX_CONFIGS — comme stats.configs.
function normalizeConfigList(source, newId) {
    const configs = [];
    const names = new Set();
    for (const raw of Array.isArray(source) ? source : []) {
        const config = normalizeImagesConfig(raw, newId);
        if (!config || names.has(config.name)) continue;
        names.add(config.name);
        configs.push(config);
        if (configs.length >= IMAGES_MAX_CONFIGS) break;
    }
    return configs;
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
            poses_items: Array.isArray(base.poses_items) ? [...base.poses_items] : [],
            configs: Array.isArray(base.configs) ? [...base.configs] : [],
        };
    }
    return {
        enabled: bool(raw.enabled, bool(base.enabled, true)),
        items: normalizeItemList(Object.hasOwn(raw, 'items') ? raw.items : base.items, newId),
        evolution_items: normalizeItemList(
            Object.hasOwn(raw, 'evolution_items') ? raw.evolution_items : base.evolution_items, newId),
        poses_items: normalizeItemList(
            Object.hasOwn(raw, 'poses_items') ? raw.poses_items : base.poses_items, newId),
        configs: normalizeConfigList(Object.hasOwn(raw, 'configs') ? raw.configs : base.configs, newId),
    };
}

// Fichier accepté par l'onglet Images (PNG, JPEG, WebP, GIF ; SVG rastérisé
// dans le navigateur) : aiguillage des dépôts de fichiers sur la fenêtre
// (bdd.js, evolution_data.js), comme isAudioFile pour les musiques.
// HEIC/HEIF (photos iPhone) : le navigateur ne les décode pas, mais le
// serveur les normalise (pillow-heif) — ils passent donc le filtre.
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
    'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif|svg|heic|heif)$/i;

export function isImageFile(file) {
    if (!file) return false;
    if (typeof file.type === 'string' && IMAGE_MIME_TYPES.has(file.type)) return true;
    return IMAGE_EXTENSIONS.test(file.name || '');
}

// Préréglages d'apparence (boutons de l'onglet) : chacun repart du style par
// défaut, le résultat ne dépend donc pas des réglages précédents. Position et
// largeur ne bougent pas.
export const IMAGE_STYLE_PRESETS = Object.freeze({
    // Photo de profil : ronde, remplie, liseré blanc, ombre.
    avatar: Object.freeze({ shape: 'circle', fit: 'cover', border_width: 3, border_color: '#ffffff', shadow: true }),
    // Logo posé sur un cartouche blanc : lisible sur n'importe quel fond de carte.
    badge: Object.freeze({ shape: 'rounded', radius: 12, fit: 'contain', background: '#ffffff',
        background_opacity: 90, padding: 8, shadow: true }),
    // Filigrane : rien autour, image atténuée.
    discreet: Object.freeze({ shape: 'rect', fit: 'contain', opacity: 70 }),
    // Tirage photo : cadre blanc épais, ombre.
    photo: Object.freeze({ shape: 'rect', fit: 'cover', border_width: 6, border_color: '#ffffff', shadow: true }),
});

// Style et hauteur d'une image après un préréglage, ou null si le nom est
// inconnu. Une forme ronde rend la hauteur aux proportions (sinon une hauteur
// imposée en ferait une ellipse).
export function imageStylePreset(item, name) {
    const preset = Object.hasOwn(IMAGE_STYLE_PRESETS, name) ? IMAGE_STYLE_PRESETS[name] : null;
    if (!preset) return null;
    const style = { ...imageItemDefaults().style, ...preset };
    const height = style.shape === 'circle' ? null : (item?.position?.height ?? null);
    return { style, height };
}

// Préréglage dont l'image porte exactement le style (bouton mis en
// évidence), ou null dès qu'un réglage s'en écarte. Couleurs comparées sans
// la casse : « #FFFFFF » vaut « #ffffff ».
export function matchingStylePreset(style) {
    if (!style) return null;
    const same = (a, b) => (typeof a === 'string' && typeof b === 'string'
        ? a.toLowerCase() === b.toLowerCase() : a === b);
    const defaults = imageItemDefaults().style;
    for (const [name, preset] of Object.entries(IMAGE_STYLE_PRESETS)) {
        const expected = { ...defaults, ...preset };
        if (Object.keys(expected).every((key) => same(style[key], expected[key]))) return name;
    }
    return null;
}

// Réglages d'apparence qui ont un effet avec ce style (le formulaire masque
// ou grise les autres) : le rayon ne sert qu'aux coins arrondis, la couleur
// de bordure qu'avec une bordure, l'ajustement que si la boîte ne suit pas
// les proportions de l'image — ronde, ou hauteur imposée. Sinon « Image
// entière » et « Remplir la forme » donnent le même dessin (imagePanelHeight
// taille la boîte sur l'image). Le point focal ne sert qu'avec cet
// ajustement en « Remplir la forme ».
export function imageStyleFieldStates(item) {
    const style = item?.style || {};
    const fit = style.shape === 'circle' || item?.position?.height != null;
    return {
        radius: style.shape === 'rounded',
        borderColor: style.border_width > 0,
        fit,
        focus: fit && style.fit === 'cover',
    };
}

// Couleur de fond choisie : un fond transparent devient opaque, sinon le
// choix ne se verrait pas (l'opacité du fond vaut 0 par défaut). Une opacité
// déjà réglée est gardée.
export function withBackgroundColor(style, background) {
    return {
        ...style,
        background,
        background_opacity: style.background_opacity > 0 ? style.background_opacity : 100,
    };
}

// Jour (numéro de jour) où le compteur de trouvailles atteint `n` :
// `dayCounts` = [[jour, trouvailles du jour], …] trié par jour croissant —
// le compteur de la carte, qui part des trouvailles antérieures au début de
// l'animation. null si le total n'atteint jamais `n`.
export function dayOfNthFind(dayCounts, n) {
    if (!(n >= 1)) return null;
    let total = 0;
    for (const [day, count] of dayCounts) {
        total += count;
        if (total >= n) return day;
    }
    return null;
}

// Numéro de jour (jours depuis l'époque, cf. evolution_timeline.mjs) → date
// « AAAA-MM-JJ ».
export function dayNumberToIso(day) {
    return Number.isFinite(day) ? new Date(day * 86_400_000).toISOString().slice(0, 10) : null;
}

// Apparition d'un jalon jamais atteint : plus tard que toute animation.
export const SCHEDULE_UNREACHED = '9999-12-31';

// Le planing a-t-il au moins une borne dans son mode ? Sinon : toujours
// visible.
export function hasSchedule(schedule) {
    if (!schedule) return false;
    return schedule.by === 'find'
        ? !!(schedule.start_find || schedule.end_find)
        : !!(schedule.start || schedule.end);
}

// Bornes effectives du planing en dates « AAAA-MM-JJ » (null = pas de
// borne). Mode `find` : `isoOfFind(n)` donne la date de la Ne trouvaille,
// null si elle n'est jamais atteinte — une apparition qui n'a jamais lieu
// (SCHEDULE_UNREACHED), une disparition non plus (pas de borne).
export function scheduleBounds(schedule, isoOfFind = () => null) {
    if (!schedule) return { start: null, end: null };
    if (schedule.by === 'find') {
        return {
            start: schedule.start_find ? (isoOfFind(schedule.start_find) || SCHEDULE_UNREACHED) : null,
            end: schedule.end_find ? isoOfFind(schedule.end_find) : null,
        };
    }
    return { start: schedule.start || null, end: schedule.end || null };
}

// Planing comparé à la période animée (dates « AAAA-MM-JJ », comparables
// telles quelles ; `schedule` : bornes effectives, cf. scheduleBounds) :
// 'empty' si la fenêtre est vide, 'after' si l'image
// n'apparaît qu'après la fin, 'before' si elle a disparu avant le début —
// trois cas où elle ne se voit jamais dans la vidéo. null sinon, ou sans
// période connue.
export function scheduleRangeIssue(schedule, rangeStart, rangeEnd) {
    const start = schedule?.start || null;
    const end = schedule?.end || null;
    if (start && end && end <= start) return 'empty';
    if (!rangeStart || !rangeEnd) return null;
    if (start && start > rangeEnd) return 'after';
    if (end && end <= rangeStart) return 'before';
    return null;
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
