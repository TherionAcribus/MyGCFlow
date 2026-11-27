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

const SIDES = ['right', 'left', 'top', 'bottom', 'bottom_right', 'bottom_left', 'top_right', 'top_left'];

function candidate(item, side) {
    const { x, y, w, h } = item;
    const gap = Math.max(0, Number(item.gap) || 0);
    // Diagonales : le coin le plus proche à `gap` du point (à 45°).
    const diag = gap / Math.SQRT2;
    if (side === 'right') return { x: x + gap, y: y - h / 2, w, h, side };
    if (side === 'left') return { x: x - gap - w, y: y - h / 2, w, h, side };
    if (side === 'top') return { x: x - w / 2, y: y - gap - h, w, h, side };
    if (side === 'bottom') return { x: x - w / 2, y: y + gap, w, h, side };
    if (side === 'bottom_right') return { x: x + diag, y: y + diag, w, h, side };
    if (side === 'bottom_left') return { x: x - diag - w, y: y + diag, w, h, side };
    if (side === 'top_right') return { x: x + diag, y: y - diag - h, w, h, side };
    return { x: x - diag - w, y: y - diag - h, w, h, side };
}

function inside(rect, width, height, margin) {
    return rect.x >= margin && rect.y >= margin
        && rect.x + rect.w <= width - margin && rect.y + rect.h <= height - margin;
}

function overlapArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

// Rectangle ramené dans l'image au plus près de sa position — une fiche
// plus large que l'image reste visible par son bord gauche ou haut.
function clampInside(rect, width, height, margin) {
    const x = Math.min(Math.max(rect.x, margin), Math.max(margin, width - margin - rect.w));
    const y = Math.min(Math.max(rect.y, margin), Math.max(margin, height - margin - rect.h));
    return { ...rect, x, y };
}

// Fiches posées à côté de leur étape, par priorité décroissante (ordre de
// `items` : l'étape en cours d'abord, puis de la plus récente à la plus
// ancienne). Chaque fiche essaie droite, gauche, dessus, dessous puis les
// quatre diagonales (`gap` : distance du point au bord de la fiche) et
// prend la première place dans l'image qui ne recouvre ni une fiche déjà
// posée ni un obstacle (pastilles des étapes, `obstacles`). Une fiche sans
// place est masquée — sauf `force` (l'étape en cours) : elle prend la place
// qui recouvre le moins (fiches posées et obstacles), à égalité dans
// l'ordre d'essai, ramenée dans l'image si elle en sortait — jamais hors
// cadre ni sur un cartouche qu'elle peut éviter. Renvoie, dans l'ordre
// d'`items`, { x, y, w, h, side } ou null.
//
// `memory` (Map key → side, optionnelle) stabilise le placement d'une image
// à l'autre : une fiche dont l'item porte une `key` essaie d'abord le côté
// qu'elle avait à l'image précédente et ne le quitte que s'il ne tient plus
// (hors cadre ou recouvert) — sinon les fiches changeraient de côté ou
// sauteraient à chaque mouvement de caméra. La Map est lue et mise à jour,
// jamais vidée : l'appelant la remplace quand le contexte change.
export function placeInfoLabels(items, { width, height, margin = 4, obstacles = [], memory = null } = {}) {
    const placed = [];
    const remember = (item, rect) => {
        if (memory && item.key !== null && item.key !== undefined) memory.set(item.key, rect.side);
    };
    return (items || []).map((item) => {
        if (!item || !(item.w > 0) || !(item.h > 0)) return null;
        const kept = memory && item.key !== null && item.key !== undefined ? memory.get(item.key) : null;
        const sides = kept && SIDES.includes(kept) ? [kept, ...SIDES.filter((side) => side !== kept)] : SIDES;
        for (const side of sides) {
            const rect = candidate(item, side);
            if (!inside(rect, width, height, margin)) continue;
            if (placed.some((p) => overlaps(rect, p))) continue;
            if (obstacles.some((o) => o !== item.self && overlaps(rect, o))) continue;
            placed.push(rect);
            remember(item, rect);
            return rect;
        }
        if (item.force) {
            // Aucune place libre : la moins mauvaise — recouvrement minimal,
            // à égalité la première dans l'ordre d'essai (le côté gardé
            // d'abord, donc stable) — ramenée dans l'image.
            let best = null;
            let bestScore = Infinity;
            for (const side of sides) {
                const rect = clampInside(candidate(item, side), width, height, margin);
                let score = 0;
                for (const p of placed) score += overlapArea(rect, p);
                for (const o of obstacles) if (o !== item.self) score += overlapArea(rect, o);
                if (score < bestScore) {
                    best = rect;
                    bestScore = score;
                }
            }
            placed.push(best);
            remember(item, best);
            return best;
        }
        return null;
    });
}

// Apparitions et disparitions en fondu des fiches : le placement est refait
// à chaque image et une fiche peut perdre sa place (ou la regagner) d'une
// image à l'autre — sans fondu, elle saute. Chaque clé placée monte
// progressivement vers 1, les clés qui ne sont plus placées descendent vers
// 0 avant d'être oubliées : l'appelant les dessine encore, à leur dernière
// place, tant que l'opacité n'est pas nulle.
//
// `time` est en secondes, monotone : temps de la chronologie en lecture
// (déterministe pour la vidéo image par image), horloge réelle au repos.
// Un retour en arrière (saut dans la lecture) fige l'état : clés placées à
// 1, fondu de sortie oublié — pas de fiche fantôme qui attendrait un temps
// déjà dépassé. `fadeS` (durée du fondu, à chaque image) à 0 — lecture
// réduite — : tout est immédiat.
export function createInfoVisibility() {
    const alphas = new Map();
    let lastTime = null;
    let moving = false;
    return {
        // present : clés placées à cette image. Renvoie une Map key →
        // opacité (clés placées et clés en train de disparaître).
        step(time, present, fadeS = 0.3) {
            const keys = new Set(present);
            if (lastTime !== null && time < lastTime) {
                alphas.clear();
                for (const key of keys) alphas.set(key, 1);
                lastTime = time;
                moving = false;
                return new Map(alphas);
            }
            const dt = lastTime === null ? 0 : Math.min(time - lastTime, fadeS || 1);
            lastTime = time;
            const move = fadeS > 0 ? dt / fadeS : 1;
            moving = false;
            const out = new Map();
            for (const key of keys) {
                const alpha = Math.min(1, (alphas.get(key) ?? 0) + move);
                alphas.set(key, alpha);
                if (alpha < 1) moving = true;
                out.set(key, alpha);
            }
            for (const [key, before] of [...alphas]) {
                if (keys.has(key)) continue;
                const alpha = before - move;
                if (alpha <= 0) {
                    alphas.delete(key);
                    continue;
                }
                alphas.set(key, alpha);
                moving = true;
                out.set(key, alpha);
            }
            return out;
        },
        // Vrai tant qu'une fiche n'a pas fini son fondu : le rendu doit
        // continuer sans attendre une interaction (repos).
        moving: () => moving,
        reset() {
            alphas.clear();
            lastTime = null;
            moving = false;
        },
    };
}

// Cartouche fixe de `w` × `h` dans une image `width` × `height` : centré en
// haut ou en bas, ou dans un coin, à `margin` du bord. `avoid` : cartouches
// de la carte (titre, ligne d'infos, légende — { x, y, w, h }) ; un
// cartouche en haut passe dessous, un cartouche en bas passe dessus.
// Borné dans l'image : même décalé sous plusieurs cartouches ou trop large
// pour l'image, il reste visible — quitte, en tout dernier recours, à
// recouvrir ce qu'il évitait.
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
    return {
        x: Math.min(Math.max(pos.x, margin), Math.max(margin, width - margin - w)),
        y: Math.min(Math.max(pos.y, margin), Math.max(margin, height - margin - h)),
    };
}

// Échelle du cartouche fixe : `maxScale` tant qu'il tient dans `fitWidth`
// (largeur de l'image moins ses marges), réduit sinon — un long nom ou une
// grande taille ne déborde pas en vidéo verticale. `layoutWidth` est la
// largeur mesurée à l'échelle 1 ; la largeur croît avec l'échelle.
export function fixedInfoScale(fitWidth, layoutWidth, maxScale) {
    if (!(layoutWidth > 0) || !(fitWidth > 0)) return maxScale;
    return Math.max(0.1, Math.min(maxScale, fitWidth / layoutWidth));
}
