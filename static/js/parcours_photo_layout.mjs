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
import { DAY_RECAP_Q, dayRecaps, legPauses } from './parcours_timeline.mjs';

export const PHOTO_ASPECTS = Object.freeze(['original', '1:1', '4:3', '3:4', '16:9']);
export const PHOTO_FOCUS_RANGE = Object.freeze([0, 100]);
export const PHOTO_ZOOM_RANGE = Object.freeze([100, 300]);
export const PHOTO_CAPTION_MAX = 200;

const ASPECT_RATIOS = Object.freeze({ '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9 });

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function smooth(t) {
    return t * t * (3 - 2 * t);
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

// Fenêtre du zoom lent dans la fenêtre `src` de l'image : réduite de
// 1/scale et placée pour garder le point focal au même endroit (zoom vers
// lui, ou depuis lui) — au centre pour un point focal au milieu —, décalée
// de `shift` (-1..1 : d'un bord de la marge à l'autre) pour le travelling.
export function kenBurnsRect(src, natural, photo, scale, shift = 0) {
    if (!(scale > 1)) return src;
    const width = src.width / scale;
    const height = src.height / scale;
    const crop = photoCrop(photo);
    const fx = src.width > 0 ? clamp(((crop.focusX / 100) * (natural?.width || 0) - src.x) / src.width, 0, 1) : 0.5;
    const fy = src.height > 0 ? clamp(((crop.focusY / 100) * (natural?.height || 0) - src.y) / src.height, 0, 1) : 0.5;
    const px = clamp(fx + shift / 2, 0, 1);
    return { x: src.x + (src.width - width) * px, y: src.y + (src.height - height) * fy, width, height };
}

// Panoramas : une photo nettement plus large que haute, montrée entière,
// devenait une bande minuscule. Avec `pano_pan`, elle est montrée dans une
// fenêtre aux proportions PANORAMA_VIEW_RATIO qui la parcourt de gauche à
// droite pendant son affichage. Un cadrage choisi (proportions, zoom) prime :
// la photo n'est plus un panorama.
export const PANORAMA_MIN_RATIO = 2;
export const PANORAMA_VIEW_RATIO = 16 / 9;

export function isPanorama(photo) {
    if (!(photo?.width > 0) || !(photo?.height > 0)) return false;
    return isFullFrame(photoCrop(photo)) && photo.width / photo.height >= PANORAMA_MIN_RATIO;
}

// Fenêtre source d'un panorama, en px de l'image : toute la hauteur, aux
// proportions `viewRatio`, à la position `pan` (0 : bord gauche, 1 : droit).
export function panoramaRect(natural, viewRatio, pan) {
    const W = Number(natural?.width) || 0;
    const H = Number(natural?.height) || 0;
    const width = Math.min(W, H * viewRatio);
    return { x: (W - width) * clamp(pan, 0, 1), y: 0, width, height: H };
}

// Proportions (largeur / hauteur) de la photo telle que montrée, cadrage
// compris ; 4:3 quand les dimensions sont inconnues.
export function photoAspect(photo) {
    const crop = photoCrop(photo);
    if (ASPECT_RATIOS[crop.aspect]) return ASPECT_RATIOS[crop.aspect];
    return photo?.width > 0 && photo?.height > 0 ? photo.width / photo.height : 4 / 3;
}

// --- Photos des cartons -----------------------------------------------------------

// Photos favorites des cartons, parmi celles que montre la lecture (dans
// l'ordre de la chronologie, photos prises en chemin comprises — à la
// journée de l'étape d'où part leur trajet) : { open (carton d'ouverture), days (une par
// journée, ou null), end (mosaïque de fin, au plus `mosaicMax`, réparties
// sur tout le parcours) }. Le premier carton de journée ne reprend pas la
// photo d'ouverture qui vient de le précéder. Sans favorite, rien : les
// cartons restent du texte.
export const CARD_MOSAIC_MAX = 5;

export function cardPhotos(timeline, favorites, { mosaicMax = CARD_MOSAIC_MAX } = {}) {
    const days = (timeline?.days || []).map(() => null);
    const empty = { open: null, days, end: [] };
    if (!favorites?.size || !timeline?.stops?.length) return empty;
    const shown = [];
    const seen = new Set();
    const add = (id, day) => {
        if (!favorites.has(id) || seen.has(id)) return;
        seen.add(id);
        shown.push({ id, day });
    };
    const legsFrom = new Map();
    for (const leg of timeline.legs || []) {
        if (!legsFrom.has(leg.from)) legsFrom.set(leg.from, []);
        legsFrom.get(leg.from).push(leg);
    }
    timeline.stops.forEach((stop, i) => {
        for (const id of stop.photos || []) add(id, stop.day);
        for (const leg of legsFrom.get(i) || []) {
            for (const pause of legPauses(leg)) add(pause.id, stop.day);
        }
    });
    if (!shown.length) return empty;
    const open = shown[0].id;
    for (let d = 0; d < days.length; d++) {
        days[d] = shown.find((s) => s.day === d && !(d === 0 && s.id === open))?.id ?? null;
    }
    let end = shown.map((s) => s.id);
    const max = Math.max(1, Math.floor(mosaicMax));
    if (end.length > max) {
        end = max === 1 ? [end[0]] : Array.from({ length: max }, (_, i) => end[Math.round((i * (end.length - 1)) / (max - 1))]);
    }
    return { open, days, end };
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
export const PHOTO_FRAMES = Object.freeze(['postcard', 'polaroid', 'rounded', 'plain', 'stamp', 'tape', 'film']);
// `pop` : la photo sort du point de son étape en grandissant, et y rentre à
// la sortie (repli sur `zoom` quand l'étape n'est pas à l'écran).
export const PHOTO_EFFECTS = Object.freeze(['fade', 'slide', 'zoom', 'pop']);
export const PHOTO_SIZE_RANGE = Object.freeze([120, 600]);
export const PHOTO_PIN_SIZE_RANGE = Object.freeze([40, 160]);
// Forme des vignettes laissées sur la carte : `card` (la carte en petit, en
// petite pile), `round` (médaillon rond cerclé de la couleur de la journée,
// une par étape, avec le nombre de photos).
export const PHOTO_PIN_SHAPES = Object.freeze(['card', 'round']);
export const PHOTO_DURATION_RANGE = Object.freeze([0.5, 6]);
export const PHOTO_MAX_PER_STOP_RANGE = Object.freeze([1, 12]);
// Au-delà du plafond par étape : `share` (les photos se partagent le temps
// du plafond), `first` (seules les premières, dans l'ordre de prise de vue).
export const PHOTO_OVERFLOWS = Object.freeze(['share', 'first']);
export const PHOTO_CAPTION_TEMPLATE_MAX = 120;
export const PHOTO_CAPTION_TAGS = Object.freeze(['legende', 'etape', 'heure', 'jour', 'date']);

export const PHOTO_DISPLAY_DEFAULTS = Object.freeze({
    layout: PHOTO_LAYOUT_STOP,
    side: 'auto',
    anchor: 'top-right',
    leader: false,
    strip_edge: 'bottom',
    strip_reset: false,
    stack: false,
    pin: false,
    pin_size: 72,
    pin_shape: 'card',
    // Vignettes qui se chevauchent à l'écran regroupées sous la plus
    // récente, avec le nombre de photos (groupPins).
    pin_group: true,
    size: 220,
    frame: 'postcard',
    tilt: true,
    effect: 'fade',
    ken_burns: false,
    // Éclair sur l'étape à l'arrivée de chaque photo (photoFlashesAt).
    flash: false,
    duration: 1.5,
    max_per_stop: 4,
    overflow: 'share',
    // Photos prises en chemin, rattachées à aucune étape : montrées à leur
    // position, le géocacheur s'y arrête (routePhotos, legPauses).
    en_route: false,
    // Panoramas parcourus dans une fenêtre 16:9 (isPanorama, panoramaRect).
    pano_pan: true,
    // Planche de la journée : ses photos en planche-contact avant la nuit
    // (DAY_RECAP_Q, dayRecapAt de parcours_timeline.mjs, recapSheetLayout).
    day_recap: false,
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
        stack: flag('stack'),
        pin: flag('pin'),
        pin_size: Math.round(numberIn(o.pin_size, PHOTO_PIN_SIZE_RANGE, d.pin_size)),
        pin_shape: choice('pin_shape', PHOTO_PIN_SHAPES),
        pin_group: flag('pin_group'),
        size: Math.round(numberIn(o.size, PHOTO_SIZE_RANGE, d.size)),
        frame: choice('frame', PHOTO_FRAMES),
        tilt: flag('tilt'),
        effect: choice('effect', PHOTO_EFFECTS),
        ken_burns: flag('ken_burns'),
        flash: flag('flash'),
        duration: Math.round(numberIn(o.duration, PHOTO_DURATION_RANGE, d.duration) * 10) / 10,
        max_per_stop: Math.round(numberIn(o.max_per_stop, PHOTO_MAX_PER_STOP_RANGE, d.max_per_stop)),
        overflow: choice('overflow', PHOTO_OVERFLOWS),
        en_route: flag('en_route'),
        pano_pan: flag('pano_pan'),
        day_recap: flag('day_recap'),
        caption: caption !== null && caption.length <= PHOTO_CAPTION_TEMPLATE_MAX ? caption : d.caption,
    };
}

// Styles tout faits de l'onglet Photos : des combinaisons des réglages
// d'apparence et de placement — jamais la durée, le plafond, les photos en
// chemin ni la légende, qui tiennent au contenu du parcours. Un style ne
// pose que ses clés ; il est « actif » quand toutes valent la sienne.
export const PHOTO_DISPLAY_PRESETS = Object.freeze({
    postcard: Object.freeze({
        layout: PHOTO_LAYOUT_STOP, side: 'auto', frame: 'postcard', tilt: true, effect: 'fade',
        stack: false, pin: false, leader: false, ken_burns: false,
    }),
    scrapbook: Object.freeze({
        layout: PHOTO_LAYOUT_STOP, side: 'auto', frame: 'tape', tilt: true, effect: 'pop',
        stack: true, pin: true, leader: false, ken_burns: false,
    }),
    sober: Object.freeze({
        layout: PHOTO_LAYOUT_FIXED, anchor: 'top-right', frame: 'rounded', tilt: false, effect: 'fade',
        stack: false, pin: false, leader: false, ken_burns: true,
    }),
    film: Object.freeze({
        layout: PHOTO_LAYOUT_STRIP, strip_edge: 'bottom', strip_reset: true, frame: 'film', tilt: false,
        effect: 'fade', ken_burns: false,
    }),
});

// Nom du style tout fait que les réglages reproduisent, ou null.
export function photoDisplayPreset(display) {
    for (const [name, preset] of Object.entries(PHOTO_DISPLAY_PRESETS)) {
        if (Object.entries(preset).every(([key, value]) => display?.[key] === value)) return name;
    }
    return null;
}

// Options de buildParcoursTimeline (parcours_timeline.mjs) tirées des
// réglages : temps d'écran de chaque photo (quanta de 100 ms), plafond par
// étape et sort des photos au-delà. Sans photos dans la vidéo, la page ne lui
// en passe aucune.
export function photoTimelineOptions(display) {
    return {
        photoQ: Math.round(display.duration * 10),
        maxPhotosPerStop: display.max_per_stop,
        photoOverflow: display.overflow,
        dayRecapQ: display.day_recap && display.layout !== PHOTO_LAYOUT_NONE ? DAY_RECAP_Q : 0,
    };
}

// --- Planche de la journée ----------------------------------------------------------

// Colonnes de la grille selon le nombre de photos (9 au plus) : une rangée
// jusqu'à 3, 2 × 2, 3 × 2, 4 × 2, 3 × 3.
function recapColumns(count) {
    if (count <= 3) return count;
    if (count === 4) return 2;
    if (count <= 6) return 3;
    if (count <= 8) return 4;
    return 3;
}

const RECAP_TILE_MAX = 240;   // px CSS : grand côté d'une vignette au plus
const RECAP_GAP_SHARE = 0.14; // écart entre deux vignettes, en part de leur côté (bord blanc et inclinaison compris)
const RECAP_TITLE = 64;       // px CSS réservés au titre au-dessus
const RECAP_REVEAL = 0.45;    // part de la planche pendant laquelle les vignettes arrivent
const RECAP_TILE_IN = 0.12;   // part de la planche que dure l'arrivée d'une vignette
const RECAP_TILT_DEG = [-2.5, 1.5, -1, 2.5, -2, 1, 2, -1.5, 0.5];

// Disposition de la planche à `progress` (0..1) : vignettes carrées en
// grille, centrées, qui arrivent l'une après l'autre (fondu et petit
// rebond ; fondu seul en mouvement réduit). `view` : width, height (px
// réels), ratio. → { tiles: [{ index, x, y, size, rotation, alpha, scale }],
// title: { x, y, size } } (x, y : centres, px réels).
export function recapSheetLayout(count, progress, view, { tilt = true, reduced = false } = {}) {
    const n = Math.max(0, Math.floor(count));
    const ratio = view.ratio || 1;
    const out = { tiles: [], title: null };
    if (!n) return out;
    const cols = recapColumns(n);
    const rows = Math.ceil(n / cols);
    const titleH = RECAP_TITLE * ratio;
    const maxW = view.width * 0.72;
    const maxH = view.height * 0.66 - titleH;
    const g = RECAP_GAP_SHARE;
    const size = Math.max(8, Math.min(
        maxW / (cols + (cols - 1) * g),
        maxH / (rows + (rows - 1) * g),
        RECAP_TILE_MAX * ratio,
    ));
    const gap = size * g;
    const gridH = rows * size + (rows - 1) * gap;
    const top = (view.height - gridH + titleH) / 2;
    for (let i = 0; i < n; i++) {
        const row = Math.floor(i / cols);
        const inRow = row === rows - 1 ? n - row * cols : cols;
        const col = i - row * cols;
        const rowW = inRow * size + (inRow - 1) * gap;
        const start = n > 1 ? (RECAP_REVEAL - RECAP_TILE_IN) * (i / (n - 1)) : 0;
        const t = clamp((progress - start) / RECAP_TILE_IN, 0, 1);
        out.tiles.push({
            index: i,
            x: (view.width - rowW) / 2 + col * (size + gap) + size / 2,
            y: top + row * (size + gap) + size / 2,
            size,
            rotation: tilt ? RECAP_TILT_DEG[i % RECAP_TILT_DEG.length] * Math.PI / 180 : 0,
            alpha: t,
            scale: reduced ? 1 : 0.6 + 0.4 * eased('zoom', t),
        });
    }
    out.title = { x: view.width / 2, y: top - titleH * 0.55, size: 22 * ratio };
    return out;
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

// Créneaux des photos de la chronologie, dans l'ordre d'affichage (fromQ
// croissant) : [{ photoId, stop (index dans `stops`, null en chemin), day,
// order, k (rang dans l'étape), fromQ, toQ }]. Une photo est montrée de
// fromQ à toQ, puis s'efface en PHOTO_FADE_Q quanta (la suivante de l'étape
// entre à toQ). Photo en chemin : `route`, `leg` (index dans `legs`) et
// `at` ([lon, lat], où le géocacheur s'arrête) — son créneau est l'arrêt.
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
            slots.push({ photoId, stop: i, day: stop.day, order: 0, k, fromQ, toQ: fromQ + stop.photoQ });
        });
    });
    (timeline.legs || []).forEach((leg, li) => {
        for (const pause of legPauses(leg)) {
            const photo = leg.photos[pause.k];
            slots.push({
                photoId: pause.id, stop: null, route: true, leg: li, at: [photo.lon, photo.lat],
                day: timeline.stops?.[leg.from]?.day ?? null, order: 0, k: 0, fromQ: pause.fromQ, toQ: pause.toQ,
            });
        }
    });
    slots.sort((a, b) => a.fromQ - b.fromQ);
    slots.forEach((slot, order) => { slot.order = order; });
    slotsCache.set(timeline, slots);
    return slots;
}

// Éclair de l'étape (`flash`) : à l'arrivée de chaque photo, pendant
// PHOTO_FLASH_Q quanta, comme un déclencheur. → [{ slot, progress (0..1) }]
// des éclairs en cours à la position `qf` (créneaux triés par début :
// recherche par bissection, quelques créneaux parcourus).
export const PHOTO_FLASH_Q = 5;

export function photoFlashesAt(timeline, qf) {
    const slots = photoSlots(timeline);
    let lo = 0;
    let hi = slots.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (slots[mid].fromQ <= qf) lo = mid + 1;
        else hi = mid;
    }
    const out = [];
    for (let i = lo - 1; i >= 0 && slots[i].fromQ > qf - PHOTO_FLASH_Q; i--) {
        out.push({ slot: slots[i], progress: (qf - slots[i].fromQ) / PHOTO_FLASH_Q });
    }
    return out.reverse();
}

// Temps d'écran des photos de la chronologie : { count (photos montrées),
// quanta (leur temps cumulé, fondus compris dans les créneaux, planches de
// journée comprises), totalQ (toute la lecture) } — l'onglet Photos le
// convertit en secondes.
export function photoScreenTime(timeline) {
    const slots = photoSlots(timeline);
    const quanta = slots.reduce((sum, slot) => sum + Math.max(0, slot.toQ - slot.fromQ), 0)
        + dayRecaps(timeline).reduce((sum, recap) => sum + Math.max(0, recap.toQ - recap.fromQ), 0);
    return { count: slots.length, quanta, totalQ: Math.max(0, Number(timeline?.quanta) || 0) };
}

// --- Cartes ------------------------------------------------------------------------

// Cadre autour de l'image, en px CSS pour une taille `size` : marges (haut,
// côtés, bas), rayon, ombre, et où s'écrit la légende (`margin` : dans la
// marge blanche du bas ; `overlay` : sur un bandeau en bas de l'image).
// Timbre : papier blanc dentelé (`perforation` : rayon des dents) ; scotch :
// marge de carte postale et deux bandes adhésives aux coins du haut ;
// pellicule : bandes noires perforées en haut et en bas.
export function photoFrameMetrics(frame, size, hasCaption) {
    const captionSize = clamp(Math.round(size * 0.06), 11, 24);
    if (frame === 'stamp') {
        const side = Math.max(7, Math.round(size * 0.06));
        return {
            kind: frame, top: side, side, bottom: hasCaption ? side + Math.round(captionSize * 1.7) : side,
            radius: 0, shadow: true, captionIn: 'margin', captionSize, perforation: side * 0.36,
        };
    }
    if (frame === 'film') {
        const band = Math.max(10, Math.round(size * 0.1));
        return {
            kind: frame, top: band, side: Math.max(3, Math.round(size * 0.025)), bottom: band,
            radius: 0, shadow: true, captionIn: 'overlay', captionSize,
        };
    }
    if (frame === 'polaroid') {
        const side = Math.max(5, Math.round(size * 0.045));
        return {
            kind: frame, top: side, side, bottom: Math.max(Math.round(size * 0.17), Math.round(captionSize * 2.2)),
            radius: 2, shadow: true, captionIn: 'margin', captionSize,
        };
    }
    if (frame === 'postcard' || frame === 'tape') {
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
const POP_FROM = 0.08;    // échelle de départ de l'effet `pop`
const STOP_GAP = 18;      // px CSS entre l'étape et sa carte
const TILT_DEG = [-2.5, 2];
const KEN_BURNS_ZOOM = 0.08;

// Zoom lent (`ken_burns`) : trois mouvements en alternance selon le rang de
// la photo, pour que deux photos à la suite ne bougent pas pareil — avancée
// (vers le point d'intérêt), recul (depuis lui), travelling (fenêtre un peu
// plus serrée qui glisse d'un bord à l'autre, sens alterné). Un panorama,
// déjà parcouru, n'a que l'avancée. `t` : avancement (0..1) du créneau.
// → { scale, shift } : agrandissement de la fenêtre (> 1 : zoomée) et
// décalage horizontal de son centre (-1..1, en part de la marge) ;
// parcours_photo_draw.mjs centre la fenêtre sur le point d'intérêt.
export const KEN_BURNS_MOTIONS = Object.freeze(['in', 'out', 'drift']);
const KEN_BURNS_DRIFT_ZOOM = 0.12;

export function kenBurnsMotion(order, t, { panorama = false } = {}) {
    const k = clamp(t, 0, 1);
    const n = Math.max(0, Math.floor(order) || 0);
    const motion = panorama ? 'in' : KEN_BURNS_MOTIONS[n % KEN_BURNS_MOTIONS.length];
    if (motion === 'in') return { motion, scale: 1 + KEN_BURNS_ZOOM * k, shift: 0 };
    if (motion === 'out') return { motion, scale: 1 + KEN_BURNS_ZOOM * (1 - k), shift: 0 };
    const sense = Math.floor(n / KEN_BURNS_MOTIONS.length) % 2 ? -1 : 1;
    return { motion, scale: 1 + KEN_BURNS_DRIFT_ZOOM, shift: sense * (2 * smooth(k) - 1) };
}

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

// Point du cercle (centre, rayon) le plus proche de p (p lui-même s'il est dedans).
function nearestOnCircle(cx, cy, r, p) {
    const d = Math.hypot(p[0] - cx, p[1] - cy);
    if (d <= r) return [p[0], p[1]];
    return [cx + (p[0] - cx) * (r / d), cy + (p[1] - cy) * (r / d)];
}

function anchorCenter(anchor, width, height, cardW, cardH, margin) {
    const [v, h] = anchor.split('-');
    const x = h === 'left' ? margin + cardW / 2 : h === 'right' ? width - margin - cardW / 2 : width / 2;
    const y = v === 'top' ? margin + cardH / 2 : v === 'bottom' ? height - margin - cardH / 2 : height / 2;
    return [x, y];
}

// Côté de la carte autour de l'étape : réglé, ou vers le centre de l'écran
// (haut-droite tant que l'étape est près du centre : avec la caméra qui
// suit, la carte ne bascule pas d'un côté à l'autre). En `auto`, le côté
// est choisi à la première image d'une pile puis gardé tant qu'elle est
// montrée (`view.sideMemo`) : la caméra, lissée, déplace encore l'étape à
// l'écran à l'arrivée et au départ — la carte sautait d'un côté à l'autre
// quand l'étape franchissait un seuil.
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
//   pointPixel([lon, lat]) — idem pour un point (photo en chemin) ;
//   aspectOf(id)   — proportions de la photo montrée (photoAspect) ;
//   panoramaOf(id) — vrai pour un panorama (isPanorama) ;
//   captionOf(slot) — légende déjà composée ('' : aucune) ;
//   sideMemo       — facultatif, { timeline, sides } gardé d'une image à
//                    l'autre : côté `auto` de chaque pile montrée (stopSide).
// Retour : { cards: [{ photoId, slot, x, y, w, h, frame, scale, rotation,
// alpha, dx, dy, effectScale, kenBurns, kenBurnsShift, caption,
// captionAlpha, leader, pinned, round, pinSize, badge, thumb }] }, dans
// l'ordre de dessin (vignettes de la bande d'abord). x, y : centre ; w, h :
// image sans cadre ; frame : marges en px réels ; scale : réduction d'une
// vignette ; leader : { from, to } en px réels, ou null ; round (0..1) :
// part du médaillon (vignette ronde) dans le fondu depuis la carte, pinSize
// son diamètre (px réels) ; badge : nombre de photos d'une vignette
// regroupée ; thumb : vignette posée dans la bande, dessinée depuis la
// miniature plutôt que la pleine taille (qui peut être évincée).
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
        // Panorama : fenêtre 16:9 qui le parcourt pendant le créneau (adouci).
        const panorama = !!display.pano_pan && !!view.panoramaOf?.(slot.photoId);
        const aspect = panorama ? PANORAMA_VIEW_RATIO : (view.aspectOf?.(slot.photoId) || 4 / 3);
        const pan = panorama
            ? smooth(clamp((qf - slot.fromQ) / Math.max(1e-9, slot.toQ - slot.fromQ), 0, 1))
            : null;
        const { w, h } = imageSize(size, aspect);
        const caption = display.caption ? (view.captionOf?.(slot) || '') : '';
        const m = photoFrameMetrics(display.frame, display.size, !!caption);
        const frame = {
            kind: m.kind, top: m.top * ratio, side: m.side * ratio, bottom: m.bottom * ratio,
            radius: m.radius * ratio, shadow: m.shadow, captionIn: m.captionIn, captionSize: m.captionSize * ratio,
            perforation: (m.perforation || 0) * ratio,
        };
        return {
            photoId: slot.photoId, slot: slot.order, x: 0, y: 0, w, h, frame,
            cardW: w + 2 * frame.side, cardH: h + frame.top + frame.bottom,
            scale: 1, rotation: tilt(slot), alpha: 1, dx: 0, dy: 0, effectScale: 1,
            kenBurns: null, kenBurnsShift: 0, pan, caption, captionAlpha: 1, leader: null,
        };
    };

    // Entrée / sortie : opacité linéaire, mouvement de l'effet adouci.
    // `origin` : l'étape à l'écran (px), d'où sort une photo `pop`.
    const applyEffect = (card, t, ownRect, origin = null) => {
        const k = clamp(t, 0, 1);
        if (display.effect === 'pop' && k < 1 && insideScreen(origin, width, height)) {
            // Visible presque tout de suite : on la voit sortir du point.
            card.alpha *= clamp(k * 3, 0, 1);
            const move = eased('slide', k);
            card.dx += (origin[0] - card.x) * (1 - move);
            card.dy += (origin[1] - card.y) * (1 - move);
            card.effectScale = POP_FROM + (1 - POP_FROM) * eased('zoom', k);
            return;
        }
        card.alpha *= k;
        const effect = display.effect === 'pop' ? 'zoom' : display.effect;
        if (effect === 'fade' || t >= 1) return;
        const move = effectTransform(effect, eased(effect, k), ownRect, { width, height });
        card.dx += move.dx;
        card.dy += move.dy;
        card.effectScale = move.scale;
    };
    const rectOf = (card) => ({
        x: card.x - card.cardW / 2, y: card.y - card.cardH / 2, width: card.cardW, height: card.cardH,
    });
    // Zoom lent posé sur la carte : `kenBurns` (agrandissement) et
    // `kenBurnsShift` (kenBurnsMotion).
    const kenBurns = (card, slot, endQ) => {
        if (!display.ken_burns) return;
        const t = (qf - slot.fromQ) / Math.max(1e-9, endQ - slot.fromQ);
        const motion = kenBurnsMotion(slot.order, t, { panorama: card.pan != null });
        card.kenBurns = motion.scale;
        card.kenBurnsShift = motion.shift;
    };

    if (display.layout === PHOTO_LAYOUT_STRIP) {
        // Repère d'une photo de la bande, pour l'effet `pop`.
        const originOf = (slot) => (slot.route ? view.pointPixel?.(slot.at) : view.stopPixel?.(slot.stop)) || null;
        stripCards(out, slots, qf, display, {
            width, height, margin, ratio, cardOf, applyEffect, rectOf, kenBurns, timeline, originOf,
        });
        return out;
    }

    // Côtés `auto` mémorisés par pile (clé : rang de sa première photo),
    // oubliés quand la pile n'est plus montrée ou que la chronologie change.
    const memo = display.side === 'auto' ? view.sideMemo : null;
    if (memo && memo.timeline !== timeline) {
        memo.timeline = timeline;
        memo.sides = new Map();
    }
    const activePiles = new Set();
    const sideOf = (p, key) => {
        if (!memo) return stopSide(display.side, p, width, height);
        activePiles.add(key);
        let side = memo.sides.get(key);
        if (!side) {
            side = stopSide(display.side, p, width, height);
            memo.sides.set(key, side);
        }
        return side;
    };

    // Centre d'une boîte boxW × boxH : à l'ancre (emplacement fixe) ou à
    // côté de l'étape, gardée dans l'écran.
    const placeBox = (boxW, boxH, stop, key) => {
        if (display.layout === PHOTO_LAYOUT_FIXED) return anchorCenter(display.anchor, width, height, boxW, boxH, margin);
        const p = stop || [width / 2, height / 2];
        const { sx, sy } = sideOf(p, key);
        const gap = STOP_GAP * ratio;
        return [
            clamp(p[0] + sx * (gap + boxW / 2), boxW / 2 + margin / 2, width - boxW / 2 - margin / 2),
            clamp(p[1] + sy * (gap + boxH / 2), boxH / 2 + margin / 2, height - boxH / 2 - margin / 2),
        ];
    };
    const setLeader = (card, stop) => {
        if (!insideScreen(stop, width, height)) return;
        // Médaillon : jusqu'au bord du cercle, pas au coin de son carré.
        const to = card.round >= 1
            ? nearestOnCircle(card.x, card.y, card.pinSize / 2, stop)
            : nearestOnRect(card.x, card.y, card.cardW * card.scale / 2, card.cardH * card.scale / 2, stop);
        if (Math.hypot(to[0] - stop[0], to[1] - stop[1]) > 4 * ratio) card.leader = { from: stop, to };
    };

    // Vignettes laissées sur la carte, puis celles qui y descendent, puis
    // les photos montrées : les plus récentes par-dessus.
    const pinned = [];
    const landing = [];
    const shown = [];
    const pinPx = display.pin_size * ratio;
    const round = display.pin_shape === 'round';
    // Vignettes posées, par pile : { cards, stop, count, x, y } (groupPins).
    const pinEntries = [];
    for (const pile of photoPiles(timeline)) {
        const first = pile[0];
        const last = pile[pile.length - 1];
        if (qf < first.fromQ) break;
        if (!display.pin && qf > last.toQ + PHOTO_FADE_Q) continue;
        // Repère de la pile : l'étape, ou le point d'arrêt d'une photo en chemin.
        const stop = (first.route ? view.pointPixel?.(first.at) : view.stopPixel?.(first.stop)) || null;
        const cards = pile.map(cardOf);
        // Pile encore montrée (affichage, sortie ou descente vers sa
        // vignette) : elle seule a besoin d'une pose près de l'étape.
        const shownPile = qf <= last.toQ + Math.max(PHOTO_FADE_Q, display.pin ? PIN_LAND_Q : 0);
        // Pose de chaque photo pendant son affichage : seule à côté de
        // l'étape (ou à l'ancre), ou dans la pile.
        let pileCenter = null;
        if (display.stack && shownPile) {
            const spread = 2 * STACK_SPREAD * size;
            pileCenter = placeBox(Math.max(...cards.map((c) => c.cardW)) + spread,
                Math.max(...cards.map((c) => c.cardH)) + spread, stop, first.order);
        }
        const poseOf = (k) => {
            if (!pileCenter) {
                const [x, y] = placeBox(cards[k].cardW, cards[k].cardH, stop, first.order);
                return { x, y, rotation: tilt(pile[k]), scale: 1 };
            }
            const [ox, oy] = STACK_OFFSETS[k % STACK_OFFSETS.length];
            return {
                x: pileCenter[0] + ox * size,
                y: pileCenter[1] + oy * size,
                rotation: display.tilt ? STACK_TILT_DEG[k % STACK_TILT_DEG.length] * Math.PI / 180 : 0,
                scale: 1,
            };
        };
        // Vignette : grand côté pinPx, sur le côté de l'étape le plus libre
        // (pinDirection), en petite pile. Position strictement relative à
        // l'étape : rognée par le bord de l'écran plutôt que déplacée, pour
        // ne jamais glisser par rapport à la carte.
        // Médaillon : un seul par étape, chaque photo se pose sur la précédente.
        const pinOf = (k) => {
            const [dx, dy] = first.route ? pointPinDirection(timeline, first.at) : pinDirection(timeline, first.stop);
            const half = pinPx * (round ? 0.5 : 0.5 + PIN_SPREAD);
            const p = stop || [width / 2, height / 2];
            const [ox, oy] = round ? [0, 0] : STACK_OFFSETS[k % STACK_OFFSETS.length];
            const scale = pinPx / Math.max(cards[k].cardW, cards[k].cardH);
            return {
                x: p[0] + dx * (half + PIN_GAP * ratio) + ox * pinPx,
                y: p[1] + dy * (half + PIN_GAP * ratio) + oy * pinPx,
                rotation: !round && display.tilt ? STACK_TILT_DEG[k % STACK_TILT_DEG.length] * Math.PI / 180 : 0,
                scale,
            };
        };
        // Fin d'affichage (avant la sortie) : la pile part d'un bloc.
        const endOf = (slot) => (display.stack ? last.toQ : slot.toQ);
        let top = null;
        const pilePins = [];
        pile.forEach((slot, k) => {
            if (qf < slot.fromQ) return;
            const card = cards[k];
            const end = endOf(slot);
            if (display.pin && qf >= end) {
                const land = clamp((qf - end) / PIN_LAND_Q, 0, 1);
                const to = pinOf(k);
                // Posée : plus de pose de départ à calculer.
                const from = land >= 1 ? to : poseOf(k);
                const t = eased('slide', land);
                card.x = from.x + (to.x - from.x) * t;
                card.y = from.y + (to.y - from.y) * t;
                card.rotation = from.rotation + (to.rotation - from.rotation) * t;
                card.scale = 1 + (to.scale - 1) * t;
                card.captionAlpha = 1 - land;
                card.pinned = land >= 1;
                if (round) {
                    // Fondu de la carte vers le médaillon pendant la fin de
                    // la descente ; le médaillon suit la taille de la carte.
                    card.round = clamp((land - ROUND_FROM) / (1 - ROUND_FROM), 0, 1);
                    card.pinSize = Math.max(card.cardW, card.cardH) * card.scale;
                }
                if (!card.pinned) {
                    landing.push(card);
                } else if (!stop || onScreen(card, width, height)) {
                    pilePins.push(card);
                }
                return;
            }
            Object.assign(card, poseOf(k));
            const next = pile[k + 1];
            if (pileCenter && next && qf > next.fromQ) {
                card.captionAlpha = clamp(1 - (qf - next.fromQ) / PHOTO_FADE_Q, 0, 1);
            }
            const exit = (end + PHOTO_FADE_Q - qf) / PHOTO_FADE_Q;
            applyEffect(card, Math.min((qf - slot.fromQ) / PHOTO_FADE_Q, exit), rectOf(card), stop);
            kenBurns(card, slot, end + PHOTO_FADE_Q);
            if (card.alpha <= 0) return;
            if (display.leader && !pileCenter) setLeader(card, stop);
            shown.push(card);
            top = card;
        });
        if (top && display.leader && pileCenter) setLeader(top, stop);
        if (pilePins.length) {
            const topPin = pilePins[pilePins.length - 1];
            pinEntries.push({
                // Médaillon : seul celui du dessus se voit.
                cards: round ? [topPin] : pilePins, stop, count: pilePins.length, x: topPin.x, y: topPin.y,
            });
        }
    }
    if (memo) {
        for (const key of memo.sides.keys()) if (!activePiles.has(key)) memo.sides.delete(key);
    }
    const groups = display.pin_group ? groupPins(pinEntries, pinPx * PIN_GROUP_REACH) : pinEntries;
    for (const group of groups) {
        const topPin = group.cards[group.cards.length - 1];
        // Nombre de photos : sur tout médaillon qui en porte plusieurs, sur
        // une carte quand elle en a absorbé d'autres (sa pile se voit déjà).
        if (round ? group.count > 1 : group.merged) topPin.badge = group.count;
        setLeader(topPin, group.stop);
        pinned.push(...group.cards);
    }
    out.cards.push(...pinned, ...landing, ...shown);
    return out;
}

// Regroupement des vignettes (`pin_group`) : en partant de la plus récente,
// une vignette dont le centre tombe à moins de `reach` px d'une vignette
// gardée s'y ajoute (son nombre de photos compte, elle n'est plus dessinée).
// Grille de `reach` px : chaque vignette ne regarde que ses 9 cases. →
// groupes gardés dans l'ordre chronologique (les récents par-dessus), avec
// `count` cumulé et `merged`.
function groupPins(entries, reach) {
    const kept = [];
    const grid = new Map();
    const cell = (v) => Math.floor(v / reach);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const cx = cell(entry.x);
        const cy = cell(entry.y);
        let host = null;
        for (let gx = cx - 1; gx <= cx + 1 && !host; gx++) {
            for (let gy = cy - 1; gy <= cy + 1 && !host; gy++) {
                host = (grid.get(`${gx},${gy}`) || []).find((g) => Math.hypot(g.x - entry.x, g.y - entry.y) < reach) || null;
            }
        }
        if (host) {
            host.count += entry.count;
            host.merged = true;
            continue;
        }
        const group = { ...entry, merged: false };
        kept.push(group);
        const key = `${cx},${cy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(group);
    }
    return kept.reverse();
}

// Pile (près de l'étape, emplacement fixe) : les photos d'une étape se
// posent les unes sur les autres et restent jusqu'à la fin de la dernière,
// puis la pile s'efface d'un bloc. Chaque rang a son décalage et son
// inclinaison (fixes : la pile ne tremble pas d'une image à l'autre) autour
// du centre de la pile, placé comme une carte de la taille de la plus
// grande, décalages compris — la pile ne déborde ni de l'écran ni sur
// l'étape. La légende d'une photo recouverte s'efface à l'arrivée de la
// suivante ; le trait part de la photo du dessus.
//
// Vignettes sur la carte (`pin`) : au lieu de s'effacer, chaque photo (ou
// la pile entière) descend en PIN_LAND_Q quanta vers une petite pile posée
// à côté de son étape, et y reste jusqu'à la fin, attachée à l'étape (elle
// suit la carte : rognée au bord de l'écran plutôt que déplacée), avec un
// trait vers l'étape. En médaillon (`pin_shape: 'round'`), la carte se fond
// dans un rond à la fin de sa descente ; un médaillon par étape.
const STACK_OFFSETS = [[0, 0], [0.07, -0.05], [-0.06, 0.05], [0.05, 0.07], [-0.07, -0.06], [0.03, -0.08]];
const STACK_TILT_DEG = [-3, 4, -5.5, 2.5, 6, -4];
const STACK_SPREAD = 0.08;
const PIN_SPREAD = 0.08;
const PIN_GAP = 8;        // px CSS entre l'étape et sa vignette
export const PIN_LAND_Q = 4;
const ROUND_FROM = 0.5;   // part de la descente où commence le fondu vers le médaillon
// Deux vignettes se regroupent quand leurs centres sont à moins de cette
// part de leur taille (elles se recouvrent d'un bon quart).
export const PIN_GROUP_REACH = 0.75;

function onScreen(card, width, height) {
    const r = Math.max(card.cardW, card.cardH) * card.scale;
    return card.x + r > 0 && card.y + r > 0 && card.x - r < width && card.y - r < height;
}

// Photos regroupées par étape (créneaux contigus d'une même étape) ; une
// photo en chemin a sa pile à elle (son propre point d'arrêt).
const pilesCache = new WeakMap();
function photoPiles(timeline) {
    const cached = pilesCache.get(timeline);
    if (cached) return cached;
    const piles = [];
    for (const slot of photoSlots(timeline)) {
        const last = piles[piles.length - 1];
        if (last && !slot.route && !last[0].route && last[0].stop === slot.stop) last.push(slot);
        else piles.push([slot]);
    }
    pilesCache.set(timeline, piles);
    return piles;
}

// --- Côté libre autour d'une étape -----------------------------------------------

// Directions candidates (x vers la droite, y vers le bas de l'écran), dans
// l'ordre de préférence à coût égal.
const PIN_DIRECTIONS = Object.freeze([
    [1, -1], [-1, -1], [1, 1], [-1, 1], [1, 0], [-1, 0], [0, -1], [0, 1],
]);
export const PIN_CLEARANCE_KM = 0.5;

// Côté de l'étape `index` où poser sa vignette, en évitant le trajet : la
// direction (parmi 8) la moins encombrée par les trajets (tout le parcours,
// passé et à venir) et les autres étapes dans un rayon de
// PIN_CLEARANCE_KM — chaque point gêne d'autant plus qu'il est proche et
// dans l'axe. Calculée en distances au sol, pas en pixels : le côté ne
// change ni avec le zoom ni pendant que la caméra suit. → [dx, dy], chacun
// dans {-1, 0, 1} (une diagonale pose la vignette par son coin).
const directionCache = new WeakMap();
function directionMemo(timeline, key, compute) {
    let cache = directionCache.get(timeline);
    if (!cache) {
        cache = new Map();
        directionCache.set(timeline, cache);
    }
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
}

export function pinDirection(timeline, index) {
    const stop = timeline.stops[index];
    return directionMemo(timeline, index, () => freestDirection(timeline, stop?.lon, stop?.lat, index));
}

// Même choix pour le point d'arrêt d'une photo prise en chemin ([lon, lat]) :
// posé sur son trajet, qui le traverse, la vignette part en travers.
export function pointPinDirection(timeline, at) {
    if (!Array.isArray(at)) return PIN_DIRECTIONS[0];
    return directionMemo(timeline, `${at[0]},${at[1]}`, () => freestDirection(timeline, at[0], at[1], -1));
}

// Direction la moins encombrée autour de (lon, lat) ; `self` : l'étape
// elle-même, qui ne compte pas comme obstacle (-1 : aucune).
function freestDirection(timeline, lon, lat, self) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return PIN_DIRECTIONS[0];
    const R = PIN_CLEARANCE_KM;
    const kx = 111.32 * Math.cos(lat * Math.PI / 180);
    const ky = 110.57;
    // Point [lon, lat] → km à l'écran (y vers le bas).
    const local = (p) => [(p[0] - lon) * kx, -(p[1] - lat) * ky];
    const obstacles = [];
    const add = (p, weight = 1) => {
        const d = Math.hypot(p[0], p[1]);
        if (d < 0.005 || d > R) return;
        obstacles.push({ ux: p[0] / d, uy: p[1] / d, w: weight * (1 - d / R) ** 2 });
    };
    for (const leg of timeline.legs || []) {
        if (leg.night) continue;
        const a = timeline.stops[leg.from];
        const b = timeline.stops[leg.to];
        const path = (leg.path && leg.path.length >= 2 ? leg.path : [[a.lon, a.lat], [b.lon, b.lat]]).map(local);
        for (let i = 1; i < path.length; i++) {
            const p = path[i - 1];
            const q = path[i];
            const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
            // Segment hors du cercle : ignoré.
            if (Math.min(Math.hypot(p[0], p[1]), Math.hypot(q[0], q[1])) > R + length) continue;
            const steps = Math.max(1, Math.ceil(length / (R / 12)));
            for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
                add([p[0] + (q[0] - p[0]) * (s / steps), p[1] + (q[1] - p[1]) * (s / steps)]);
            }
        }
    }
    timeline.stops.forEach((other, i) => {
        if (i !== self) add(local([other.lon, other.lat]), 2);
    });
    let best = PIN_DIRECTIONS[0];
    let bestCost = Infinity;
    for (const dir of PIN_DIRECTIONS) {
        const n = Math.hypot(dir[0], dir[1]);
        let cost = 0;
        for (const o of obstacles) {
            const cos = (dir[0] * o.ux + dir[1] * o.uy) / n;
            if (cos > 0) cost += o.w * cos * cos;
        }
        if (cost < bestCost - 1e-9) {
            best = dir;
            bestCost = cost;
        }
    }
    return best;
}

// Bande de vignettes : chaque photo entre en grand au-dessus de la bande
// (en dessous pour une bande en haut), puis rejoint sa case en
// rétrécissant pendant la fin de son temps. La bande s'allonge vers la
// droite et défile vers la gauche quand elle déborde ; les vignettes
// sorties s'effacent.
function stripCards(out, slots, qf, display, ctx) {
    const { width, height, margin, ratio, cardOf, applyEffect, rectOf, kenBurns, timeline, originOf } = ctx;
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
            // Posée dans la bande, la vignette reste montrée longtemps après
            // la fin du créneau — au-delà de la fenêtre de préchargement et
            // de l'éviction des pleines tailles : elle est dessinée depuis
            // la miniature (320 px, toujours chargée), comme les vignettes
            // laissées sur la carte.
            card.thumb = true;
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
            applyEffect(card, enter, rectOf(card), originOf(m.slot));
        }
        kenBurns(card, m.slot, m.slot.toQ);
        if (card.alpha > 0) big.push(card);
    }
    out.cards.push(...big);
}
