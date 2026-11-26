// Fiche des caches de la page Parcours : bloc du thème `points.parcours_info`
// (docs/parcours.md, « Fiche des caches »).
//
// Copie de parcours_info.py (source de vérité des défauts, choix et bornes) ;
// tests/js/parcours_info.test.mjs compare les deux via
// tests/fixtures/parcours/parcours_info.json.
//
// Ce que montre la fiche d'une étape (`infoContent`), quand elle se montre
// pendant la lecture (`infoAlpha`, `currentInfo`), où la poser à côté des
// étapes sans chevauchement (`placeInfoLabels`) ou dans un cartouche
// (`fixedInfoPosition`). Le dessin est dans parcours_info_draw.mjs.
//
// Module pur (aucun DOM, ni OpenLayers) : testé par node --test.
import { isCountedStop } from './parcours_reconstruct.mjs';
import { reachedIndex } from './parcours_timeline.mjs';

export const PARCOURS_INFO_FIELDS = Object.freeze(['name', 'dt', 'owner', 'favorites']);
export const PARCOURS_INFO_CHOICES = Object.freeze({
    near: Object.freeze(['none', 'current', 'all']),
    fixed: Object.freeze(['none', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right']),
    design: Object.freeze(['tag', 'card', 'banner', 'text']),
    font: Object.freeze(['sans', 'serif', 'mono', 'rounded', 'condensed', 'handwritten']),
    accent: Object.freeze(['stop', 'fixed']),
});
export const PARCOURS_INFO_RANGES = Object.freeze({
    duration: Object.freeze([1, 15]),
    size: Object.freeze([9, 28]),
    background_opacity: Object.freeze([0, 100]),
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const COLOR_KEYS = ['text_color', 'background_color', 'accent_color'];

export function parcoursInfoDefaults() {
    return {
        near: 'none',
        fixed: 'none',
        duration: 3,
        name: true,
        dt: true,
        owner: false,
        favorites: true,
        design: 'card',
        font: 'sans',
        size: 13,
        text_color: '#212529',
        background_color: '#ffffff',
        background_opacity: 92,
        accent: 'stop',
        accent_color: '#0072c6',
    };
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function integer(value, fallback, [low, high]) {
    if (typeof value === 'boolean' || value === null || value === '' || value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.round(Math.min(high, Math.max(low, number)));
}

// Bloc normalisé : valeurs bornées, champs absents = valeur courante (défaut
// sinon) — comme coerce_parcours_info.
export function normalizeParcoursInfo(raw, current = null) {
    const defaults = parcoursInfoDefaults();
    const cur = isObject(current) ? current : {};
    const base = { ...defaults };
    for (const key of Object.keys(defaults)) if (key in cur) base[key] = cur[key];
    const src = isObject(raw) ? raw : {};
    const out = {};
    for (const [key, allowed] of Object.entries(PARCOURS_INFO_CHOICES)) {
        out[key] = allowed.includes(src[key]) ? src[key] : (allowed.includes(base[key]) ? base[key] : defaults[key]);
    }
    for (const key of PARCOURS_INFO_FIELDS) {
        out[key] = typeof src[key] === 'boolean' ? src[key]
            : (typeof base[key] === 'boolean' ? base[key] : defaults[key]);
    }
    const color = (value, fallback) => (typeof value === 'string' && HEX_RE.test(value) ? value.toLowerCase() : fallback);
    for (const key of COLOR_KEYS) out[key] = color(src[key], color(base[key], defaults[key]));
    for (const [key, range] of Object.entries(PARCOURS_INFO_RANGES)) {
        out[key] = integer(src[key], integer(base[key], defaults[key], range), range);
    }
    return Object.fromEntries(Object.keys(defaults).map((key) => [key, out[key]]));
}

// Au moins un élément coché.
export function infoHasContent(info) {
    return PARCOURS_INFO_FIELDS.some((key) => info?.[key] === true);
}

// Fiche affichée quelque part (à côté des caches ou dans un cartouche).
export function infoEnabled(info) {
    return !!info && (info.near !== 'none' || info.fixed !== 'none') && infoHasContent(info);
}

function finite(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

// Contenu de la fiche d'une étape comptée (trouvaille, Lab, DNF) selon les
// éléments cochés : null pour un lieu, une base, ou quand rien de coché
// n'est connu (Lab sans D/T ni propriétaire, PF jamais collectés…).
export function infoContent(stop, info) {
    if (!stop || !isCountedStop(stop)) return null;
    const name = info?.name && typeof stop.name === 'string' && stop.name.trim() ? stop.name.trim() : null;
    const d = finite(stop.difficulty);
    const t = finite(stop.terrain);
    const dt = info?.dt && d !== null && t !== null ? { d, t } : null;
    const owner = info?.owner && typeof stop.owner === 'string' && stop.owner.trim() ? stop.owner.trim() : null;
    const pf = finite(stop.favoritePoints);
    const favorites = info?.favorites && pf !== null && pf >= 0 ? Math.round(pf) : null;
    if (!name && !dt && !owner && favorites === null) return null;
    return { name, dt, owner, favorites };
}

// Note D ou T : « 2 », « 2,5 » (séparateur de la langue `locale`).
export function formatRating(value, locale) {
    const number = finite(value);
    if (number === null) return '';
    return number.toLocaleString(locale, { maximumFractionDigits: 1 });
}

// Fenêtre « temporaire » d'une étape : de son arrivée jusqu'à son départ, et
// au moins `holdQ` quanta (la durée réglée), coupée à `untilQ` (arrivée de
// l'étape suivante : jamais deux fiches temporaires à la fois). Opacité
// 0-1, avec un fondu de `fadeQ` quanta à l'entrée et à la sortie.
export function infoAlpha(stop, q, { holdQ = 0, fadeQ = 0, untilQ = Infinity } = {}) {
    const start = Number(stop?.q);
    if (!Number.isFinite(start) || !(q >= start)) return 0;
    const depart = Number.isFinite(Number(stop?.departQ)) ? Number(stop.departQ) : start;
    let end = Math.max(depart, start + Math.max(0, holdQ));
    if (Number.isFinite(untilQ)) end = Math.min(end, untilQ);
    if (q >= end) return 0;
    if (!(fadeQ > 0)) return 1;
    return Math.max(0, Math.min(1, (q - start) / fadeQ, (end - q) / fadeQ));
}

// Fiche « temporaire » à la position `q` : la dernière étape comptée
// atteinte, tant que sa fenêtre court. { index, alpha } ou null.
export function currentInfo(timeline, q, { holdQ = 0, fadeQ = 0 } = {}) {
    const stops = timeline?.stops || [];
    let i = reachedIndex(timeline, q);
    while (i >= 0 && !isCountedStop(stops[i])) i--;
    if (i < 0) return null;
    let next = i + 1;
    while (next < stops.length && !isCountedStop(stops[next])) next++;
    const untilQ = next < stops.length ? Number(stops[next].q) : Infinity;
    const alpha = infoAlpha(stops[i], q, { holdQ, fadeQ, untilQ });
    return alpha > 0 ? { index: i, alpha } : null;
}

// Secondes d'écran → quanta de la chronologie (`msPerDay` = durée d'un
// quantum à la lecture).
export function secondsToQuanta(seconds, msPerDay) {
    const ms = Number(msPerDay) > 0 ? Number(msPerDay) : 100;
    return (Math.max(0, Number(seconds) || 0) * 1000) / ms;
}

function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const SIDES = ['right', 'left', 'top', 'bottom'];

function candidate(item, side) {
    const { x, y, w, h } = item;
    const gap = Math.max(0, Number(item.gap) || 0);
    if (side === 'right') return { x: x + gap, y: y - h / 2, w, h, side };
    if (side === 'left') return { x: x - gap - w, y: y - h / 2, w, h, side };
    if (side === 'top') return { x: x - w / 2, y: y - gap - h, w, h, side };
    return { x: x - w / 2, y: y + gap, w, h, side };
}

function inside(rect, width, height, margin) {
    return rect.x >= margin && rect.y >= margin
        && rect.x + rect.w <= width - margin && rect.y + rect.h <= height - margin;
}

// Fiches posées à côté de leur étape, par priorité décroissante (ordre de
// `items` : l'étape en cours d'abord, puis de la plus récente à la plus
// ancienne). Chaque fiche essaie droite, gauche, dessus, dessous (`gap` :
// distance du point au bord de la fiche) et prend la première place dans
// l'image qui ne recouvre ni une fiche déjà posée ni un obstacle (pastilles
// des étapes, `obstacles`). Une fiche sans place est masquée — sauf
// `force` (l'étape en cours) : elle prend la première place dans l'image,
// même sur une autre. Renvoie, dans l'ordre d'`items`, { x, y, w, h, side }
// ou null.
export function placeInfoLabels(items, { width, height, margin = 4, obstacles = [] } = {}) {
    const placed = [];
    return (items || []).map((item) => {
        if (!item || !(item.w > 0) || !(item.h > 0)) return null;
        let fallback = null;
        for (const side of SIDES) {
            const rect = candidate(item, side);
            if (!inside(rect, width, height, margin)) continue;
            if (!fallback) fallback = rect;
            if (placed.some((p) => overlaps(rect, p))) continue;
            if (obstacles.some((o) => o !== item.self && overlaps(rect, o))) continue;
            placed.push(rect);
            return rect;
        }
        if (item.force) {
            const rect = fallback || candidate(item, 'right');
            placed.push(rect);
            return rect;
        }
        return null;
    });
}

// Cartouche fixe de `w` × `h` dans une image `width` × `height` : centré en
// haut ou en bas, ou dans un coin, à `margin` du bord. `avoid` : cartouches
// de la carte (titre, ligne d'infos, légende — { x, y, w, h }) ; un
// cartouche en haut passe dessous, un cartouche en bas passe dessus.
export function fixedInfoPosition(position, w, h, width, height, { margin = 16, avoid = [] } = {}) {
    const left = margin;
    const right = width - margin - w;
    const center = (width - w) / 2;
    const top = margin;
    const bottom = height - margin - h;
    let pos;
    switch (position) {
    case 'top': pos = { x: center, y: top }; break;
    case 'bottom': pos = { x: center, y: bottom }; break;
    case 'top_left': pos = { x: left, y: top }; break;
    case 'top_right': pos = { x: right, y: top }; break;
    case 'bottom_left': pos = { x: left, y: bottom }; break;
    case 'bottom_right': pos = { x: right, y: bottom }; break;
    default: return null;
    }
    const downward = position.startsWith('top');
    // Un décalage peut en faire chevaucher un autre : au plus un passage
    // par cartouche, dans le sens du bord vers le centre.
    for (let pass = 0; pass < avoid.length; pass++) {
        const hit = avoid.find((r) => r && overlaps({ x: pos.x, y: pos.y, w, h }, r));
        if (!hit) break;
        pos = { x: pos.x, y: downward ? hit.y + hit.h + margin / 2 : hit.y - margin / 2 - h };
    }
    return pos;
}
