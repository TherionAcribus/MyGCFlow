// Mise en page des photos d'un parcours dans la lecture et la vidéo
// (MyGCFlow_Plan_Parcours.md, § 14) : recadrage par photo (lot 8),
// réglages d'affichage et placements (lot 9).
//
// Le cadrage d'une photo (parcours_photos.py) : proportions (`aspect`),
// point focal (`focusX`/`focusY`, % de l'image) et zoom (%, 100 = la plus
// grande fenêtre aux proportions voulues). Les bornes sont celles du
// serveur.
//
// L'affichage (préférence globale `parcours_photo_display`, mêmes clés et
// bornes que settings_manager.py) choisit l'un des trois placements :
// - `stop`  : près de l'étape, sur un côté (auto : vers le centre de l'écran) ;
// - `fixed` : un emplacement fixe de l'écran (8 ancres) ;
// - `strip` : une bande de vignettes le long d'un bord ; la photo courante
//   entre en grand au-dessus, puis rejoint sa case en rétrécissant.
// `photoFrameAt` rend, pour une position du moteur, la liste des cartes à
// dessiner (parcours_photo_draw.mjs) : centre, taille, cadre, rotation,
// opacité, effet, légende, trait vers l'étape.
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_photo_layout.test.mjs).

import { IMAGE_EFFECT_EASINGS, cubicBezier, effectTransform } from './images_render.mjs';

export const PHOTO_ASPECTS = Object.freeze(['original', '1:1', '4:3', '3:4', '16:9']);
export const PHOTO_FOCUS_RANGE = Object.freeze([0, 100]);
export const PHOTO_ZOOM_RANGE = Object.freeze([100, 300]);
export const PHOTO_CAPTION_MAX = 200;

const ASPECT_RATIOS = Object.freeze({ '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9 });

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function numberIn(value, [min, max], fallback) {
    return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

// Cadrage d'une photo, valeurs bornées : { aspect, focusX, focusY, zoom }.
export function photoCrop(photo) {
    return {
        aspect: PHOTO_ASPECTS.includes(photo?.aspect) ? photo.aspect : 'original',
        focusX: numberIn(photo?.focusX, PHOTO_FOCUS_RANGE, 50),
        focusY: numberIn(photo?.focusY, PHOTO_FOCUS_RANGE, 50),
        zoom: numberIn(photo?.zoom, PHOTO_ZOOM_RANGE, 100),
    };
}

// Vrai si le cadrage montre l'image entière (rien à rogner).
export function isFullFrame(crop) {
    return crop.aspect === 'original' && crop.zoom <= 100;
}

// Fenêtre de l'image source à dessiner, en px de l'image : { x, y, width,
// height }. La plus grande fenêtre aux proportions voulues, réduite de
// 1/zoom, centrée sur le point focal et gardée dans l'image (le point
// focal reste visible, au plus près du centre).
export function photoCropRect(natural, photo) {
    const W = Number(natural?.width) || 0;
    const H = Number(natural?.height) || 0;
    if (!(W > 0) || !(H > 0)) return { x: 0, y: 0, width: W, height: H };
    const crop = photoCrop(photo);
    const ratio = ASPECT_RATIOS[crop.aspect] ?? W / H;
    let width = W;
    let height = W / ratio;
    if (height > H) {
        height = H;
        width = H * ratio;
    }
    width /= crop.zoom / 100;
    height /= crop.zoom / 100;
    const x = clamp((crop.focusX / 100) * W - width / 2, 0, W - width);
    const y = clamp((crop.focusY / 100) * H - height / 2, 0, H - height);
    return { x, y, width, height };
}

// Proportions (largeur / hauteur) de la photo telle que montrée, cadrage
// compris ; 4:3 quand les dimensions sont inconnues.
export function photoAspect(photo) {
    const crop = photoCrop(photo);
    if (ASPECT_RATIOS[crop.aspect]) return ASPECT_RATIOS[crop.aspect];
    return photo?.width > 0 && photo?.height > 0 ? photo.width / photo.height : 4 / 3;
}

// --- Réglages d'affichage (lot 9) ------------------------------------------------

export const PHOTO_LAYOUT_STOP = 'stop';
export const PHOTO_LAYOUT_FIXED = 'fixed';
export const PHOTO_LAYOUT_STRIP = 'strip';
export const PHOTO_LAYOUT_NONE = 'none';
export const PHOTO_LAYOUTS = Object.freeze([PHOTO_LAYOUT_STOP, PHOTO_LAYOUT_FIXED, PHOTO_LAYOUT_STRIP, PHOTO_LAYOUT_NONE]);
export const PHOTO_SIDES = Object.freeze(['auto', 'top-right', 'top-left', 'bottom-right', 'bottom-left']);
export const PHOTO_ANCHORS = Object.freeze([
    'top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right',
]);
export const PHOTO_STRIP_EDGES = Object.freeze(['bottom', 'top']);
export const PHOTO_FRAMES = Object.freeze(['postcard', 'polaroid', 'rounded', 'plain']);
export const PHOTO_EFFECTS = Object.freeze(['fade', 'slide', 'zoom']);
export const PHOTO_SIZE_RANGE = Object.freeze([120, 600]);
export const PHOTO_DURATION_RANGE = Object.freeze([0.5, 6]);
export const PHOTO_MAX_PER_STOP_RANGE = Object.freeze([1, 12]);
export const PHOTO_CAPTION_TEMPLATE_MAX = 120;
export const PHOTO_CAPTION_TAGS = Object.freeze(['legende', 'etape', 'heure', 'jour', 'date']);

export const PHOTO_DISPLAY_DEFAULTS = Object.freeze({
    layout: PHOTO_LAYOUT_STOP,
    side: 'auto',
    anchor: 'top-right',
    leader: false,
    strip_edge: 'bottom',
    strip_reset: false,
    size: 220,
    frame: 'postcard',
    tilt: true,
    effect: 'fade',
    ken_burns: false,
    duration: 1.5,
    max_per_stop: 4,
    caption: '{legende}',
});

export function normalizePhotoDisplay(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const d = PHOTO_DISPLAY_DEFAULTS;
    const choice = (key, list) => (list.includes(o[key]) ? o[key] : d[key]);
    const flag = (key) => (typeof o[key] === 'boolean' ? o[key] : d[key]);
    const caption = typeof o.caption === 'string' ? o.caption.split(/\s+/).filter(Boolean).join(' ') : null;
    return {
        layout: choice('layout', PHOTO_LAYOUTS),
        side: choice('side', PHOTO_SIDES),
        anchor: choice('anchor', PHOTO_ANCHORS),
        leader: flag('leader'),
        strip_edge: choice('strip_edge', PHOTO_STRIP_EDGES),
        strip_reset: flag('strip_reset'),
        size: Math.round(numberIn(o.size, PHOTO_SIZE_RANGE, d.size)),
        frame: choice('frame', PHOTO_FRAMES),
        tilt: flag('tilt'),
        effect: choice('effect', PHOTO_EFFECTS),
        ken_burns: flag('ken_burns'),
        duration: Math.round(numberIn(o.duration, PHOTO_DURATION_RANGE, d.duration) * 10) / 10,
        max_per_stop: Math.round(numberIn(o.max_per_stop, PHOTO_MAX_PER_STOP_RANGE, d.max_per_stop)),
        caption: caption !== null && caption.length <= PHOTO_CAPTION_TEMPLATE_MAX ? caption : d.caption,
    };
}

// Options de buildParcoursTimeline (parcours_timeline.mjs) tirées des
// réglages : temps d'écran de chaque photo (quanta de 100 ms) et plafond par
// étape. Sans photos dans la vidéo, la page ne lui en passe aucune.
export function photoTimelineOptions(display) {
    return { photoQ: Math.round(display.duration * 10), maxPhotosPerStop: display.max_per_stop };
}

// --- Légende ---------------------------------------------------------------------

const SEPARATOR_RE = /^[\s·•|,;:–—-]+|[\s·•|,;:–—-]+$/g;
const DOUBLE_SEPARATOR_RE = /(\s*[·•|,;:–—-]\s*){2,}/g;

// Légende d'une photo : balises du gabarit remplacées par `values` (texte
// déjà formaté). Une balise vide ne laisse pas de séparateur orphelin
// (« {etape} · {heure} » sans heure → le nom seul).
export function photoCaptionText(template, values = {}) {
    if (!template) return '';
    const filled = String(template).replace(/\{\s*([a-z]+)\s*\}/gi, (match, name) => {
        const key = name.toLowerCase();
        return PHOTO_CAPTION_TAGS.includes(key) ? String(values[key] ?? '') : match;
    });
    return filled
        .replace(DOUBLE_SEPARATOR_RE, (run) => {
            const first = run.trim()[0];
            return ` ${first} `;
        })
        .replace(SEPARATOR_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// --- Chronologie des photos --------------------------------------------------------

// Quanta entre l'arrivée sur une étape et sa première photo, et durée des
// fondus d'entrée et de sortie.
export const PHOTO_LEAD_Q = 2;
export const PHOTO_FADE_Q = 2;

// Créneaux des photos de la chronologie, dans l'ordre d'affichage :
// [{ photoId, stop (index dans `stops`), day, order, k (rang dans l'étape),
// fromQ, toQ }]. Une photo est montrée de fromQ à toQ, puis s'efface en
// PHOTO_FADE_Q quanta (la suivante de l'étape entre à toQ).
const slotsCache = new WeakMap();
export function photoSlots(timeline) {
    if (!timeline || typeof timeline !== 'object') return [];
    const cached = slotsCache.get(timeline);
    if (cached) return cached;
    const slots = [];
    (timeline.stops || []).forEach((stop, i) => {
        const photos = Array.isArray(stop.photos) ? stop.photos : [];
        photos.forEach((photoId, k) => {
            const fromQ = stop.q + PHOTO_LEAD_Q + k * stop.photoQ;
            slots.push({ photoId, stop: i, day: stop.day, order: slots.length, k, fromQ, toQ: fromQ + stop.photoQ });
        });
    });
    slotsCache.set(timeline, slots);
    return slots;
}

// --- Cartes ------------------------------------------------------------------------

// Cadre autour de l'image, en px CSS pour une taille `size` : marges (haut,
// côtés, bas), rayon, ombre, et où s'écrit la légende (`margin` : dans la
// marge blanche du bas ; `overlay` : sur un bandeau en bas de l'image).
export function photoFrameMetrics(frame, size, hasCaption) {
    const captionSize = clamp(Math.round(size * 0.06), 11, 24);
    if (frame === 'polaroid') {
        const side = Math.max(5, Math.round(size * 0.045));
        return {
            kind: frame, top: side, side, bottom: Math.max(Math.round(size * 0.17), Math.round(captionSize * 2.2)),
            radius: 2, shadow: true, captionIn: 'margin', captionSize,
        };
    }
    if (frame === 'postcard') {
        const side = Math.max(4, Math.round(size * 0.032));
        return {
            kind: frame, top: side, side, bottom: hasCaption ? side + Math.round(captionSize * 1.7) : side,
            radius: 0, shadow: true, captionIn: 'margin', captionSize,
        };
    }
    return {
        kind: frame, top: 0, side: 0, bottom: 0,
        radius: frame === 'rounded' ? Math.max(6, Math.round(size * 0.05)) : 0,
        shadow: frame === 'rounded', captionIn: 'overlay', captionSize,
    };
}

const MARGIN = 16;        // px CSS entre une carte et le bord de l'écran
const STOP_GAP = 18;      // px CSS entre l'étape et sa carte
const TILT_DEG = [-2.5, 2];
const KEN_BURNS_ZOOM = 0.08;

const easings = Object.fromEntries(Object.entries(IMAGE_EFFECT_EASINGS).map(([k, v]) => [k, cubicBezier(...v)]));
function eased(effect, t) {
    return easings[effect] ? easings[effect](t) : t;
}

// Taille de l'image (sans cadre) : grand côté = size.
function imageSize(size, aspect) {
    return aspect >= 1 ? { w: size, h: size / aspect } : { w: size * aspect, h: size };
}

// Point du rectangle (centre, demi-tailles) le plus proche de p.
function nearestOnRect(cx, cy, hw, hh, p) {
    return [clamp(p[0], cx - hw, cx + hw), clamp(p[1], cy - hh, cy + hh)];
}

function anchorCenter(anchor, width, height, cardW, cardH, margin) {
    const [v, h] = anchor.split('-');
    const x = h === 'left' ? margin + cardW / 2 : h === 'right' ? width - margin - cardW / 2 : width / 2;
    const y = v === 'top' ? margin + cardH / 2 : v === 'bottom' ? height - margin - cardH / 2 : height / 2;
    return [x, y];
}

// Côté de la carte autour de l'étape : réglé, ou vers le centre de l'écran
// (haut-droite tant que l'étape est près du centre : avec la caméra qui
// suit, la carte ne bascule pas d'un côté à l'autre).
function stopSide(side, p, width, height) {
    if (side !== 'auto') {
        const [v, h] = side.split('-');
        return { sx: h === 'left' ? -1 : 1, sy: v === 'top' ? -1 : 1 };
    }
    return { sx: p[0] > width * 0.65 ? -1 : 1, sy: p[1] < height * 0.35 ? 1 : -1 };
}

function insideScreen(p, width, height) {
    return p && p[0] >= 0 && p[1] >= 0 && p[0] <= width && p[1] <= height;
}

// Cartes à dessiner à la position `qf` du moteur. `view` :
//   width, height  — canevas en px réels ; ratio — px réels par px CSS ;
//   stopPixel(i)   — position à l'écran de l'étape i ([x, y] px réels) ;
//   aspectOf(id)   — proportions de la photo montrée (photoAspect) ;
//   captionOf(slot) — légende déjà composée ('' : aucune).
// Retour : { cards: [{ photoId, slot, x, y, w, h, frame, scale, rotation,
// alpha, dx, dy, effectScale, kenBurns, caption, captionAlpha, leader }] },
// dans l'ordre de dessin (vignettes de la bande d'abord). x, y : centre ;
// w, h : image sans cadre ; frame : marges en px réels ; scale : réduction
// d'une vignette ; leader : { from, to } en px réels, ou null.
export function photoFrameAt(timeline, qf, display, view) {
    const out = { cards: [] };
    if (!timeline || display.layout === PHOTO_LAYOUT_NONE) return out;
    const slots = photoSlots(timeline);
    if (slots.length === 0) return out;
    const ratio = view.ratio || 1;
    const width = view.width;
    const height = view.height;
    const margin = MARGIN * ratio;
    const size = display.size * ratio;
    const tilt = (slot) => (display.tilt ? TILT_DEG[slot.order % 2] * Math.PI / 180 : 0);

    const cardOf = (slot) => {
        const aspect = view.aspectOf?.(slot.photoId) || 4 / 3;
        const { w, h } = imageSize(size, aspect);
        const caption = display.caption ? (view.captionOf?.(slot) || '') : '';
        const m = photoFrameMetrics(display.frame, display.size, !!caption);
        const frame = {
            kind: m.kind, top: m.top * ratio, side: m.side * ratio, bottom: m.bottom * ratio,
            radius: m.radius * ratio, shadow: m.shadow, captionIn: m.captionIn, captionSize: m.captionSize * ratio,
        };
        return {
            photoId: slot.photoId, slot: slot.order, x: 0, y: 0, w, h, frame,
            cardW: w + 2 * frame.side, cardH: h + frame.top + frame.bottom,
            scale: 1, rotation: tilt(slot), alpha: 1, dx: 0, dy: 0, effectScale: 1,
            kenBurns: null, caption, captionAlpha: 1, leader: null,
        };
    };

    // Entrée / sortie : opacité linéaire, mouvement de l'effet adouci.
    const applyEffect = (card, t, ownRect) => {
        card.alpha *= clamp(t, 0, 1);
        if (display.effect === 'fade' || t >= 1) return;
        const move = effectTransform(display.effect, eased(display.effect, clamp(t, 0, 1)), ownRect, { width, height });
        card.dx += move.dx;
        card.dy += move.dy;
        card.effectScale = move.scale;
    };
    const rectOf = (card) => ({
        x: card.x - card.cardW / 2, y: card.y - card.cardH / 2, width: card.cardW, height: card.cardH,
    });
    const kenBurns = (slot, endQ) => (display.ken_burns
        ? 1 + KEN_BURNS_ZOOM * clamp((qf - slot.fromQ) / Math.max(1e-9, endQ - slot.fromQ), 0, 1)
        : null);

    if (display.layout === PHOTO_LAYOUT_STRIP) {
        stripCards(out, slots, qf, display, { width, height, margin, ratio, cardOf, applyEffect, rectOf, kenBurns, timeline });
        return out;
    }

    for (const slot of slots) {
        if (qf < slot.fromQ || qf > slot.toQ + PHOTO_FADE_Q) continue;
        const card = cardOf(slot);
        const stop = view.stopPixel?.(slot.stop) || null;
        if (display.layout === PHOTO_LAYOUT_FIXED) {
            [card.x, card.y] = anchorCenter(display.anchor, width, height, card.cardW, card.cardH, margin);
        } else {
            const p = stop || [width / 2, height / 2];
            const { sx, sy } = stopSide(display.side, p, width, height);
            const gap = STOP_GAP * ratio;
            card.x = clamp(p[0] + sx * (gap + card.cardW / 2), card.cardW / 2 + margin / 2, width - card.cardW / 2 - margin / 2);
            card.y = clamp(p[1] + sy * (gap + card.cardH / 2), card.cardH / 2 + margin / 2, height - card.cardH / 2 - margin / 2);
        }
        const enter = (qf - slot.fromQ) / PHOTO_FADE_Q;
        const exit = (slot.toQ + PHOTO_FADE_Q - qf) / PHOTO_FADE_Q;
        applyEffect(card, Math.min(enter, exit), rectOf(card));
        card.kenBurns = kenBurns(slot, slot.toQ + PHOTO_FADE_Q);
        if (display.leader && insideScreen(stop, width, height)) {
            const to = nearestOnRect(card.x, card.y, card.cardW / 2, card.cardH / 2, stop);
            if (Math.hypot(to[0] - stop[0], to[1] - stop[1]) > 4 * ratio) card.leader = { from: stop, to };
        }
        if (card.alpha > 0) out.cards.push(card);
    }
    return out;
}

// Bande de vignettes : chaque photo entre en grand au-dessus de la bande
// (en dessous pour une bande en haut), puis rejoint sa case en
// rétrécissant pendant la fin de son temps. La bande s'allonge vers la
// droite et défile vers la gauche quand elle déborde ; les vignettes
// sorties s'effacent.
function stripCards(out, slots, qf, display, ctx) {
    const { width, height, margin, ratio, cardOf, applyEffect, rectOf, kenBurns, timeline } = ctx;
    const thumbH = clamp(display.size * 0.36, 44, 140) * ratio;
    const gap = 6 * ratio;
    const bottom = display.strip_edge !== 'top';
    const rowY = bottom ? height - margin - thumbH / 2 : margin + thumbH / 2;
    let day = null;
    if (display.strip_reset) {
        // Journée de la dernière étape atteinte : la bande se vide à
        // l'arrivée sur la première étape d'une nouvelle journée.
        let reached = -1;
        for (let i = 0; i < timeline.stops.length && timeline.stops[i].q <= qf; i++) reached = i;
        day = reached >= 0 ? timeline.stops[reached].day : null;
    }
    const members = [];
    for (const slot of slots) {
        if (qf < slot.fromQ) break;
        if (day !== null && slot.day !== day) continue;
        const card = cardOf(slot);
        const landQ = clamp((slot.toQ - slot.fromQ) * 0.3, 1, 4);
        const land = clamp((qf - (slot.toQ - landQ)) / landQ, 0, 1);
        const thumbScale = thumbH / card.cardH;
        members.push({ slot, card, land, thumbW: card.cardW * thumbScale, thumbScale });
    }
    if (members.length === 0) return;
    const available = width - 2 * margin;
    const total = members.reduce((sum, m) => sum + (m.thumbW + gap) * m.land, 0) - (members.some((m) => m.land > 0) ? gap : 0);
    let cursor = margin + Math.min(0, available - total);
    const big = [];
    for (const m of members) {
        const { card, land } = m;
        const thumbX = cursor + m.thumbW / 2;
        cursor += (m.thumbW + gap) * land;
        if (land >= 1) {
            card.x = thumbX;
            card.y = rowY;
            card.scale = m.thumbScale;
            card.rotation = 0;
            card.captionAlpha = 0;
            // Vignette sortie à gauche : effacée à mesure.
            const left = thumbX - m.thumbW / 2;
            card.alpha = clamp((left + m.thumbW - margin) / m.thumbW, 0, 1);
            if (card.alpha > 0) out.cards.push(card);
            continue;
        }
        const bigY = bottom
            ? height - margin - thumbH - gap * 2 - card.cardH / 2
            : margin + thumbH + gap * 2 + card.cardH / 2;
        const bigX = width / 2;
        const t = eased('slide', land);
        card.x = bigX + (thumbX - bigX) * t;
        card.y = bigY + (rowY - bigY) * t;
        card.scale = 1 + (m.thumbScale - 1) * t;
        card.rotation *= 1 - t;
        card.captionAlpha = 1 - land;
        if (land === 0) {
            const enter = (qf - m.slot.fromQ) / PHOTO_FADE_Q;
            card.x = bigX;
            card.y = bigY;
            applyEffect(card, enter, rectOf(card));
        }
        card.kenBurns = kenBurns(m.slot, m.slot.toQ);
        if (card.alpha > 0) big.push(card);
    }
    out.cards.push(...big);
}
