// Flashs par événement de la page Mes poses (docs/mode-poses.md).
//
// Chaque type d'événement de la vie d'une cache a son flash, réglé dans le
// thème (`flash.events.<type>`) : forme, taille, couleur, contour — comme le
// flash de disparition du mode Évolution. Les défauts et la liste des formes
// permises sont ceux de event_flash.py (source de vérité côté serveur ; le
// test tests/js/event_flash.test.mjs compare les deux tables).
//
// Un seul flash par cache et par lot de jours affichés : le type le plus
// marquant l'emporte (ordre de EVENT_FLASH_KINDS), et sa taille grandit avec
// le nombre de logs de la cache dans le lot (flashScale).
//
// Seconde table, mêmes règles : les étapes du poseur sur ses propres caches,
// sur la carte principale (« Mes caches posées », `flash.owner`, voir
// owner_model.mjs) — pose, maintenance, désactivation, réactivation, archivage.
//
// Module pur (aucun DOM) : testé par node --test.

// Ordre = priorité décroissante.
export const EVENT_FLASH_KINDS = Object.freeze([
    'archive', 'disable', 'enable', 'publish', 'milestone', 'alert', 'maintenance',
    'ftf', 'favorite', 'find', 'dnf', 'note', 'reviewer',
]);

// « same » reprend le flash principal (celui des trouvailles du thème).
export const EVENT_FLASH_MODES = Object.freeze([
    'same', 'none', 'circle', 'implode', 'echo', 'target', 'star', 'sparkle',
    'square', 'triangle', 'diamond', 'fireworks',
]);

const COLOR_TYPES = ['gc', 'none', 'fix'];
const BORDER_TYPES = ['auto', 'gc', 'none', 'fix'];
const SIZE_MIN = 5;
const SIZE_MAX = 200;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function kindDefaults(mode, size, color, colorType = 'fix') {
    return Object.freeze({
        mode, size, color, color_type: colorType, border_color: '#ffffff', border_color_type: 'auto',
    });
}

export const EVENT_FLASH_DEFAULTS = Object.freeze({
    archive: kindDefaults('implode', 40, '#616161'),
    disable: kindDefaults('implode', 30, '#9e9e9e'),
    enable: kindDefaults('echo', 30, '#66bb6a'),
    publish: kindDefaults('same', 40, '#ffffff'),
    // Palier rond de trouvailles d'une cache : seulement si l'effet est coché
    // (points.poses_effects.milestone_flash, poses_effects.mjs).
    milestone: kindDefaults('fireworks', 50, '#ffd54f'),
    alert: kindDefaults('target', 30, '#ff9800'),
    maintenance: kindDefaults('sparkle', 28, '#43a047'),
    ftf: kindDefaults('fireworks', 34, '#009dff'),
    favorite: kindDefaults('star', 36, '#ffc107'),
    find: kindDefaults('circle', 20, '#ffffff', 'gc'),
    dnf: kindDefaults('circle', 20, '#263238'),
    note: kindDefaults('none', 16, '#90a4ae'),
    reviewer: kindDefaults('none', 16, '#7e57c2'),
});

// Étapes du poseur (carte principale), ordre = priorité décroissante.
export const OWNER_FLASH_KINDS = Object.freeze(['archive', 'disable', 'enable', 'place', 'maintenance']);

export const OWNER_FLASH_DEFAULTS = Object.freeze({
    archive: kindDefaults('implode', 40, '#616161'),
    disable: kindDefaults('implode', 30, '#9e9e9e'),
    enable: kindDefaults('echo', 30, '#66bb6a'),
    place: kindDefaults('star', 42, '#ffc107'),
    maintenance: kindDefaults('sparkle', 30, '#43a047'),
});

// Étape servie par owner_geojson.py → type de flash : un désarchivage joue
// la réactivation.
export function ownerFlashKindOf(eventKind) {
    if (eventKind === 'unarchive') return 'enable';
    return OWNER_FLASH_KINDS.includes(eventKind) ? eventKind : null;
}

const OWNER_RANK = new Map(OWNER_FLASH_KINDS.map((kind, i) => [kind, i]));
export function ownerFlashPriority(kind) {
    return OWNER_RANK.has(kind) ? OWNER_RANK.get(kind) : Infinity;
}

// Type de log (poses_dataset.POSES_LOG_KINDS) → type de flash. Une trouvaille
// avec point favori joue le flash du favori.
const FLASH_KIND_OF_LOG = Object.freeze({
    publish: 'publish',
    find: 'find',
    dnf: 'dnf',
    note: 'note',
    owner_note: 'note',
    other: 'note',
    alert: 'alert',
    maintenance: 'maintenance',
    disable: 'disable',
    enable: 'enable',
    unarchive: 'enable',
    archive: 'archive',
    reviewer: 'reviewer',
});

export function flashKindOfLog(logKind, favorite = false) {
    if (logKind === 'find' && favorite) return 'favorite';
    return FLASH_KIND_OF_LOG[logKind] || 'note';
}

// Rang de priorité (0 = le plus marquant) ; Infinity pour un type inconnu.
const RANK = new Map(EVENT_FLASH_KINDS.map((kind, i) => [kind, i]));
export function flashPriority(kind) {
    return RANK.has(kind) ? RANK.get(kind) : Infinity;
}

function normalizeOne(raw, defaults) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const size = Number(src.size);
    return {
        mode: EVENT_FLASH_MODES.includes(src.mode) ? src.mode : defaults.mode,
        size: Number.isFinite(size) ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(size))) : defaults.size,
        color: HEX_RE.test(src.color || '') ? src.color.toLowerCase() : defaults.color,
        color_type: COLOR_TYPES.includes(src.color_type) ? src.color_type : defaults.color_type,
        border_color: HEX_RE.test(src.border_color || '') ? src.border_color.toLowerCase() : defaults.border_color,
        border_color_type: BORDER_TYPES.includes(src.border_color_type) ? src.border_color_type : defaults.border_color_type,
    };
}

// Bloc `flash.events` d'un thème : chaque type connu, défauts pour les
// absents ou invalides, types inconnus écartés.
export function normalizeEventFlashes(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const kind of EVENT_FLASH_KINDS) out[kind] = normalizeOne(src[kind], EVENT_FLASH_DEFAULTS[kind]);
    return out;
}

// Bloc `flash.owner` d'un thème, mêmes règles.
export function normalizeOwnerFlashes(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const kind of OWNER_FLASH_KINDS) out[kind] = normalizeOne(src[kind], OWNER_FLASH_DEFAULTS[kind]);
    return out;
}

// Même forme que pkg.hexToRgb (flash_styles.js lit rgb.r / rgb.g / rgb.b).
function hexToRgb(hex) {
    if (!HEX_RE.test(hex || '')) return null;
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Options de flash prêtes pour flashStyleAt, ou null si ce type ne flashe
// pas. `flash` = options.flash du thème (flash principal + `events`).
// « same » reprend le flash principal ; un flash principal « none » éteint
// aussi les types qui le reprennent. Chaque appel crée un objet : résoudre
// une fois par animation (l'identité sert de clé aux regroupements).
export function resolveEventFlash(kind, flash) {
    const events = flash?.events && typeof flash.events === 'object' ? flash.events : {};
    return resolveOptions(normalizeOne(events[kind], EVENT_FLASH_DEFAULTS[kind] || EVENT_FLASH_DEFAULTS.note), flash);
}

// Même chose pour une étape du poseur (`flash.owner`).
export function resolveOwnerFlash(kind, flash) {
    const defaults = OWNER_FLASH_DEFAULTS[kind];
    if (!defaults) return null;
    const owner = flash?.owner && typeof flash.owner === 'object' ? flash.owner : {};
    return resolveOptions(normalizeOne(owner[kind], defaults), flash);
}

function resolveOptions(opts, flash) {
    if (opts.mode === 'none') return null;
    if (opts.mode === 'same') {
        if (!flash || !flash.mode || flash.mode === 'none') return null;
        return flash;
    }
    return { ...opts, rgb: hexToRgb(opts.color), border_rgb: hexToRgb(opts.border_color) };
}

// Facteur de taille selon le nombre de logs de la cache dans le lot :
// 1 log → 1 ; doublement à chaque ×8 (log2(n)/3), plafonné à 2,5 ; quantifié
// au 1/8 pour que les styles mis en cache servent d'un lot à l'autre.
export const FLASH_SCALE_CAP = 2.5;
export function flashScale(count) {
    const n = Math.max(1, Number(count) || 1);
    const raw = Math.min(FLASH_SCALE_CAP, 1 + Math.log2(n) / 3);
    return Math.round(raw * 8) / 8;
}

// Options agrandies d'un facteur (taille seule). Le résultat est mémorisé
// par (options, facteur) : la file de flashs de mapgl.js regroupe par
// identité d'options et le cache de styles par taille.
const scaledMemo = new WeakMap();
export function scaledFlash(options, scale) {
    if (!options || !(scale > 1)) return options;
    let byScale = scaledMemo.get(options);
    if (!byScale) scaledMemo.set(options, (byScale = new Map()));
    let out = byScale.get(scale);
    if (!out) {
        out = { ...options, size: Math.round((Number(options.size) || 0) * scale) };
        byScale.set(scale, out);
    }
    return out;
}
