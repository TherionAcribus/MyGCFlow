// Mise en page des photos d'un parcours (parcours_photo_layout.mjs) et leur
// dessin (parcours_photo_draw.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CARD_MOSAIC_MAX,
    PHOTO_DISPLAY_DEFAULTS,
    PHOTO_DISPLAY_PRESETS,
    PHOTO_FADE_Q,
    cardPhotos,
    isFullFrame,
    isPanorama,
    panoramaRect,
    normalizePhotoDisplay,
    photoAspect,
    photoCaptionText,
    photoCrop,
    photoCropRect,
    photoDisplayPreset,
    photoFrameAt,
    photoSlots,
    photoTimelineOptions,
    pinDirection,
} from '../../static/js/parcours_photo_layout.mjs';
import { drawPhotoCard, drawPhotoLeader } from '../../static/js/parcours_photo_draw.mjs';

const round = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 100) / 100]));

test('photos des cartons : favorites montrées, une par journée, mosaïque répartie', () => {
    // Deux journées : étapes 0-1 le jour 0, 2-3 le jour 1.
    const timeline = {
        days: [{}, {}, {}],
        stops: [
            { day: 0, photos: [1, 2] }, { day: 0, photos: [3] },
            { day: 1, photos: [4, 5] }, { day: 1, photos: [6, 7, 8] },
        ],
    };
    assert.deepEqual(cardPhotos(timeline, new Set()), { open: null, days: [null, null, null], end: [] });
    // Favorite non montrée (absente de la chronologie) : ignorée.
    assert.deepEqual(cardPhotos(timeline, new Set([99])).open, null);
    // L'ouverture prend la première ; « Jour 1 » ne la répète pas.
    assert.deepEqual(cardPhotos(timeline, new Set([2, 3, 5])), { open: 2, days: [3, 5, null], end: [2, 3, 5] });
    assert.deepEqual(cardPhotos(timeline, new Set([2, 5])).days, [null, 5, null]);
    // Plus de favorites que la mosaïque n'en tient : réparties du début à la fin.
    assert.deepEqual(cardPhotos(timeline, new Set([1, 2, 3, 4, 5, 6, 7, 8]), { mosaicMax: 3 }).end, [1, 5, 8]);
    assert.equal(CARD_MOSAIC_MAX, 5);
});

test('cadrage : valeurs bornées, défauts', () => {
    assert.deepEqual(photoCrop({}), { aspect: 'original', focusX: 50, focusY: 50, zoom: 100 });
    assert.deepEqual(photoCrop({ aspect: '2:1', focusX: -5, focusY: 140, zoom: 900 }),
        { aspect: 'original', focusX: 0, focusY: 100, zoom: 300 });
    assert.equal(isFullFrame(photoCrop({})), true);
    assert.equal(isFullFrame(photoCrop({ zoom: 120 })), false);
    assert.equal(isFullFrame(photoCrop({ aspect: '1:1' })), false);
    assert.equal(photoAspect({ width: 4000, height: 3000 }), 4 / 3);
    assert.equal(photoAspect({ width: 4000, height: 3000, aspect: '3:4' }), 3 / 4);
    assert.equal(photoAspect({}), 4 / 3);
});

test('cadrage : image entière, proportions, zoom, point focal gardé dans l’image', () => {
    const natural = { width: 4000, height: 3000 };
    assert.deepEqual(photoCropRect(natural, {}), { x: 0, y: 0, width: 4000, height: 3000 });
    // Carré : toute la hauteur, centré.
    assert.deepEqual(photoCropRect(natural, { aspect: '1:1' }), { x: 500, y: 0, width: 3000, height: 3000 });
    // Portrait 3:4 sur un paysage, point focal à gauche : collé au bord.
    assert.deepEqual(round(photoCropRect(natural, { aspect: '3:4', focusX: 0 })), { x: 0, y: 0, width: 2250, height: 3000 });
    // Zoom 200 % centré sur le quart haut droit.
    assert.deepEqual(photoCropRect(natural, { zoom: 200, focusX: 75, focusY: 25 }), { x: 2000, y: 0, width: 2000, height: 1500 });
    // 16:9 sur un portrait : toute la largeur.
    assert.deepEqual(round(photoCropRect({ width: 900, height: 1600 }, { aspect: '16:9' })),
        { x: 0, y: 546.88, width: 900, height: 506.25 });
    // Dimensions inconnues : rien à rogner.
    assert.deepEqual(photoCropRect({ width: 0, height: 0 }, { zoom: 200 }), { x: 0, y: 0, width: 0, height: 0 });
});

test('réglages d’affichage : défauts, bornes, valeurs inconnues', () => {
    assert.deepEqual(normalizePhotoDisplay(null), { ...PHOTO_DISPLAY_DEFAULTS });
    const d = normalizePhotoDisplay({
        layout: 'strip', size: 5000, duration: 0.123, max_per_stop: 0, frame: 'doré', tilt: 'oui',
        caption: '  {etape}\n·  {heure} ', anchor: 'middle-center', overflow: 'all',
    });
    assert.equal(d.layout, 'strip');
    assert.equal(d.size, 600);
    assert.equal(d.duration, 0.5);
    assert.equal(d.max_per_stop, 1);
    assert.equal(d.frame, 'postcard');
    assert.equal(d.tilt, true);
    assert.equal(d.caption, '{etape} · {heure}');
    assert.equal(d.anchor, 'top-right');
    assert.equal(d.overflow, 'share');
    assert.deepEqual(photoTimelineOptions(normalizePhotoDisplay({ duration: 2.5, max_per_stop: 6 })),
        { photoQ: 25, maxPhotosPerStop: 6, photoOverflow: 'share' });
    assert.equal(photoTimelineOptions(normalizePhotoDisplay({ overflow: 'first' })).photoOverflow, 'first');
});

test('styles tout faits : valides, reconnus, sans toucher au contenu', () => {
    // Le défaut est la carte postale.
    assert.equal(photoDisplayPreset(PHOTO_DISPLAY_DEFAULTS), 'postcard');
    for (const [name, preset] of Object.entries(PHOTO_DISPLAY_PRESETS)) {
        const applied = normalizePhotoDisplay({ ...PHOTO_DISPLAY_DEFAULTS, duration: 3, caption: '{etape}', ...preset });
        // Chaque valeur survit à la normalisation, et le style est reconnu.
        for (const [key, value] of Object.entries(preset)) assert.equal(applied[key], value, `${name}.${key}`);
        assert.equal(photoDisplayPreset(applied), name);
        // Durée, plafond, photos en chemin, légende : jamais posés.
        for (const key of ['duration', 'max_per_stop', 'overflow', 'en_route', 'caption', 'size']) {
            assert.ok(!(key in preset), `${name} pose ${key}`);
        }
    }
    // Un réglage du style changé : plus reconnu.
    assert.equal(photoDisplayPreset({ ...PHOTO_DISPLAY_DEFAULTS, frame: 'plain' }), null);
});

test('légende : balises, séparateurs orphelins retirés', () => {
    const values = { legende: 'Vue sur le lac', etape: 'GC123 La Tournette', heure: '10:42', jour: '2', date: 'sam. 12 juil.' };
    assert.equal(photoCaptionText('{legende}', values), 'Vue sur le lac');
    assert.equal(photoCaptionText('{etape} · {heure}', values), 'GC123 La Tournette · 10:42');
    assert.equal(photoCaptionText('{etape} · {heure}', { etape: 'Lac' }), 'Lac');
    assert.equal(photoCaptionText('{legende} · {etape} · {heure}', { heure: '10:42' }), '10:42');
    assert.equal(photoCaptionText('Jour {jour} — {legende}', { jour: '3' }), 'Jour 3');
    assert.equal(photoCaptionText('{LEGENDE} {inconnue}', values), 'Vue sur le lac {inconnue}');
    assert.equal(photoCaptionText('', values), '');
    assert.equal(photoCaptionText('{legende}', {}), '');
});

// Deux étapes : la première a deux photos, la seconde (jour suivant) une.
function timeline() {
    return {
        stops: [
            { q: 10, departQ: 52, day: 0, photos: [1, 2], photoQ: 15, lat: 45, lon: 6 },
            { q: 80, departQ: 107, day: 1, photos: [3], photoQ: 15, lat: 46, lon: 7 },
        ],
    };
}

const VIEW = {
    width: 1000, height: 600, ratio: 1,
    stopPixel: (i) => (i === 0 ? [500, 300] : [900, 100]),
    aspectOf: (id) => (id === 2 ? 3 / 4 : 4 / 3),
    captionOf: (slot) => (slot.photoId === 1 ? 'Le lac' : ''),
};

test('créneaux : à la suite dans l’étape, après un court délai', () => {
    const tl = timeline();
    const slots = photoSlots(tl);
    assert.deepEqual(slots.map((s) => [s.photoId, s.stop, s.day, s.order, s.fromQ, s.toQ]),
        [[1, 0, 0, 0, 12, 27], [2, 0, 0, 1, 27, 42], [3, 1, 1, 2, 82, 97]]);
    assert.equal(photoSlots(tl), slots); // mémorisé par chronologie
});

test('près de l’étape : côté vers le centre, gardée dans l’écran, fondu, trait', () => {
    const display = normalizePhotoDisplay({ leader: true, tilt: false });
    assert.deepEqual(photoFrameAt(timeline(), 11, display, VIEW).cards, []);
    // En plein affichage de la photo 1 : au-dessus à droite de l'étape.
    let [card] = photoFrameAt(timeline(), 20, display, VIEW).cards;
    assert.equal(card.photoId, 1);
    assert.equal(card.alpha, 1);
    assert.equal(card.caption, 'Le lac');
    assert.ok(card.x > 500 && card.y < 300);
    assert.equal(card.w, 220);
    assert.ok(Math.abs(card.h - 165) < 1e-9);
    assert.ok(card.leader && card.leader.from[0] === 500);
    // Fondu d'entrée à mi-chemin.
    [card] = photoFrameAt(timeline(), 13, display, VIEW).cards;
    assert.equal(card.alpha, 0.5);
    // Relais entre les photos 1 et 2 : les deux, la sortante d'abord.
    const both = photoFrameAt(timeline(), 28, display, VIEW).cards;
    assert.deepEqual(both.map((c) => c.photoId), [1, 2]);
    // Étape près du coin haut droit : la carte passe en bas à gauche,
    // gardée dans l'écran.
    [card] = photoFrameAt(timeline(), 90, display, VIEW).cards;
    assert.equal(card.photoId, 3);
    assert.ok(card.x < 900 && card.y > 100);
    assert.ok(card.x + card.cardW / 2 <= 1000 && card.y - card.cardH / 2 >= 0);
    // Côté imposé.
    [card] = photoFrameAt(timeline(), 20, normalizePhotoDisplay({ side: 'bottom-left' }), VIEW).cards;
    assert.ok(card.x < 500 && card.y > 300);
    // Aucun affichage.
    assert.deepEqual(photoFrameAt(timeline(), 20, normalizePhotoDisplay({ layout: 'none' }), VIEW).cards, []);
});

test('côté auto : gardé tant que la pile est montrée, même si la caméra déplace l’étape', () => {
    const tl = timeline();
    const display = normalizePhotoDisplay({ tilt: false });
    const memo = { timeline: null, sides: new Map() };
    let at = [500, 300];
    const view = { ...VIEW, stopPixel: () => at, sideMemo: memo };
    let [card] = photoFrameAt(tl, 20, display, view).cards;
    assert.ok(card.x > 500 && card.y < 300);
    // L'étape glisse au-delà du seuil de droite : la photo suivante de la
    // même étape reste à droite.
    at = [800, 450];
    [card] = photoFrameAt(tl, 30, display, view).cards;
    assert.equal(card.photoId, 2);
    assert.ok(card.x > 800 && card.y < 450);
    // Sans mémoire, elle basculait à gauche.
    [card] = photoFrameAt(tl, 30, display, { ...view, sideMemo: undefined }).cards;
    assert.ok(card.x < 800);
    // Pile terminée : oubliée ; la suivante choisit son côté à son arrivée.
    assert.deepEqual(photoFrameAt(tl, 60, display, view).cards, []);
    assert.equal(memo.sides.size, 0);
    [card] = photoFrameAt(tl, 90, display, view).cards;
    assert.ok(card.x < 800);
    // Nouvelle chronologie : mémoire repartie de zéro.
    const other = timeline();
    at = [500, 300];
    [card] = photoFrameAt(other, 20, display, view).cards;
    assert.equal(memo.timeline, other);
    assert.ok(card.x > 500);
});

test('emplacement fixe : ancre et marge, haute résolution', () => {
    const display = normalizePhotoDisplay({ layout: 'fixed', anchor: 'bottom-center', frame: 'plain', tilt: false });
    let [card] = photoFrameAt(timeline(), 20, display, VIEW).cards;
    assert.equal(card.x, 500);
    assert.ok(Math.abs(card.y + card.cardH / 2 - (600 - 16)) < 1e-9);
    assert.equal(card.leader, null);
    // Capture deux fois plus fine : tout double.
    [card] = photoFrameAt(timeline(), 20, display, { ...VIEW, width: 2000, height: 1200, ratio: 2 }).cards;
    assert.equal(card.w, 440);
    assert.ok(Math.abs(card.y + card.cardH / 2 - (1200 - 32)) < 1e-9);
});

test('effets : glissement depuis le bord, zoom, zoom lent', () => {
    const slide = normalizePhotoDisplay({ layout: 'fixed', anchor: 'top-right', effect: 'slide' });
    let [card] = photoFrameAt(timeline(), 12.5, slide, VIEW).cards;
    assert.ok(card.dx > 0 && card.dy === 0);   // entre par la droite
    [card] = photoFrameAt(timeline(), 20, slide, VIEW).cards;
    assert.equal(card.dx, 0);
    const zoom = normalizePhotoDisplay({ effect: 'zoom', ken_burns: true });
    [card] = photoFrameAt(timeline(), 12.5, zoom, VIEW).cards;
    assert.ok(card.effectScale < 1);
    assert.ok(card.kenBurns > 1 && card.kenBurns < 1.01);
    [card] = photoFrameAt(timeline(), 28, zoom, VIEW).cards;
    assert.ok(card.kenBurns > 1.07);
});

test('bande : la photo entre en grand, rejoint sa case, la bande se vide à la journée suivante', () => {
    const display = normalizePhotoDisplay({ layout: 'strip', tilt: false });
    // Photo 1 en grand, centrée au-dessus de la bande.
    let cards = photoFrameAt(timeline(), 20, display, VIEW).cards;
    assert.equal(cards.length, 1);
    assert.equal(cards[0].x, 500);
    assert.equal(cards[0].scale, 1);
    // Fin de son temps : elle rétrécit vers sa case (à gauche, en bas).
    cards = photoFrameAt(timeline(), 25.5, display, VIEW).cards;
    const landing = cards.find((c) => c.photoId === 1);
    assert.ok(landing.scale < 1 && landing.x < 500 && landing.y > 400);
    // Photo 2 en grand, photo 1 en vignette.
    cards = photoFrameAt(timeline(), 35, display, VIEW).cards;
    assert.deepEqual(cards.map((c) => c.photoId), [1, 2]);
    const thumb = cards[0];
    assert.ok(thumb.scale < 0.5);
    assert.equal(thumb.captionAlpha, 0);
    assert.ok(Math.abs(thumb.x - (16 + (thumb.cardW * thumb.scale) / 2)) < 1e-9);
    // Journée suivante : vignettes de la veille gardées…
    cards = photoFrameAt(timeline(), 90, display, VIEW).cards;
    assert.deepEqual(cards.map((c) => c.photoId), [1, 2, 3]);
    // … sauf avec « vider à chaque journée ».
    cards = photoFrameAt(timeline(), 90, { ...display, strip_reset: true }, VIEW).cards;
    assert.deepEqual(cards.map((c) => c.photoId), [3]);
    // Bande en haut : vignettes en haut, la grande en dessous.
    cards = photoFrameAt(timeline(), 35, { ...display, strip_edge: 'top' }, VIEW).cards;
    assert.ok(cards[0].y < 100 && cards[1].y > cards[0].y);
});

test('bande : défile vers la gauche quand elle déborde', () => {
    const stops = Array.from({ length: 12 }, (_, i) => ({ q: 10 + i * 40, day: 0, photos: [i + 1], photoQ: 15 }));
    const display = normalizePhotoDisplay({ layout: 'strip', size: 400 });
    const cards = photoFrameAt({ stops }, 10000, display, VIEW).cards;
    const last = cards[cards.length - 1];
    assert.ok(Math.abs(last.x + (last.cardW * last.scale) / 2 - (1000 - 16)) < 1e-6);
    assert.ok(cards.length < 12); // les premières sont sorties à gauche
    assert.ok(cards.every((c) => c.alpha > 0));
});

test('dessin : cadres, légende, trait, sans erreur sur un contexte factice', () => {
    const calls = [];
    const ctx = new Proxy({}, {
        get(target, key) {
            if (key in target) return target[key];
            if (key === 'measureText') return (text) => ({ width: text.length * 7 });
            if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
            return (...args) => calls.push([key, ...args]);
        },
        set(target, key, value) {
            target[key] = value;
            return true;
        },
    });
    const img = { naturalWidth: 400, naturalHeight: 300 };
    for (const frame of ['postcard', 'polaroid', 'rounded', 'plain']) {
        const display = normalizePhotoDisplay({ frame, leader: true, ken_burns: true });
        const [card] = photoFrameAt(timeline(), 20, display, VIEW).cards;
        calls.length = 0;
        drawPhotoLeader(ctx, card);
        drawPhotoCard(ctx, card, img, { aspect: '1:1' }, { font: 'Inter' });
        const draw = calls.find((c) => c[0] === 'drawImage');
        assert.ok(draw, frame);
        assert.ok(draw[3] < 300 && draw[4] < 300, frame); // carré, zoom lent : fenêtre réduite
        assert.ok(calls.some((c) => c[0] === 'fillText' && String(c[1]).startsWith('Le lac')), frame);
    }
    // Image pas encore décodée : rien.
    calls.length = 0;
    const [card] = photoFrameAt(timeline(), 20, normalizePhotoDisplay({}), VIEW).cards;
    drawPhotoCard(ctx, card, { naturalWidth: 0, naturalHeight: 0 }, {});
    assert.equal(calls.length, 0);
    assert.ok(card.alpha === 1 && PHOTO_FADE_Q > 0);
});

test('panoramas : fenêtre 16:9 qui parcourt l’image pendant le créneau', () => {
    assert.equal(isPanorama({ width: 4000, height: 1000 }), true);
    assert.equal(isPanorama({ width: 4000, height: 2100 }), false);              // moins de 2:1
    assert.equal(isPanorama({ width: 4000, height: 1000, aspect: '4:3' }), false); // cadrage choisi
    assert.equal(isPanorama({ width: 4000, height: 1000, zoom: 150 }), false);
    assert.equal(isPanorama({}), false);
    assert.deepEqual(round(panoramaRect({ width: 4000, height: 1000 }, 16 / 9, 0)), { x: 0, y: 0, width: 1777.78, height: 1000 });
    assert.ok(Math.abs(panoramaRect({ width: 4000, height: 1000 }, 16 / 9, 1).x - (4000 - 16000 / 9)) < 1e-9);

    // La photo 1 est un panorama : carte 16:9, fenêtre qui avance avec le temps.
    const view = { ...VIEW, panoramaOf: (id) => id === 1 };
    const display = normalizePhotoDisplay({});
    assert.equal(display.pano_pan, true);
    const slot = photoSlots(timeline())[0];
    const at = (q) => photoFrameAt(timeline(), q, display, view).cards.find((c) => c.photoId === 1);
    const start = at(slot.fromQ + 0.01);
    const middle = at((slot.fromQ + slot.toQ) / 2);
    const end = at(slot.toQ);
    assert.ok(Math.abs(start.w / start.h - 16 / 9) < 1e-9);
    assert.ok(start.pan < 0.01 && Math.abs(middle.pan - 0.5) < 1e-9 && end.pan === 1, JSON.stringify([start.pan, middle.pan, end.pan]));
    // Option coupée, ou photo ordinaire : pas de défilement.
    assert.equal(photoFrameAt(timeline(), slot.fromQ + 5, normalizePhotoDisplay({ pano_pan: false }), view).cards[0].pan, null);
    const ordinary = photoFrameAt(timeline(), 40, display, view).cards.find((c) => c.photoId === 2);
    assert.ok(ordinary);
    assert.equal(ordinary.pan, null);

    // Dessin : la fenêtre source a les proportions de la carte, à la position du défilement.
    const calls = [];
    const ctx = new Proxy({}, {
        get(target, key) {
            if (key in target) return target[key];
            if (key === 'measureText') return (text) => ({ width: text.length * 7 });
            if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
            return (...args) => calls.push([key, ...args]);
        },
        set(target, key, value) {
            target[key] = value;
            return true;
        },
    });
    drawPhotoCard(ctx, middle, { naturalWidth: 4000, naturalHeight: 1000 }, { width: 4000, height: 1000 });
    const [, , sx, sy, sw, sh] = calls.find((c) => c[0] === 'drawImage');
    assert.ok(Math.abs(sw / sh - 16 / 9) < 1e-6 && sy === 0, JSON.stringify([sx, sy, sw, sh]));
    assert.ok(Math.abs(sx - (4000 - sw) / 2) < 1e-6);
});

test('pile : les photos d’une étape s’empilent, la pile s’efface d’un bloc', () => {
    const display = normalizePhotoDisplay({ stack: true, leader: true });
    assert.equal(PHOTO_DISPLAY_DEFAULTS.stack, false);
    let cards = photoFrameAt(timeline(), 20, display, VIEW).cards;
    assert.deepEqual(cards.map((c) => c.photoId), [1]);
    // Photo 2 posée sur la 1, qui reste entière, sans sa légende.
    cards = photoFrameAt(timeline(), 35, display, VIEW).cards;
    assert.deepEqual(cards.map((c) => c.photoId), [1, 2]);
    const [under, top] = cards;
    assert.equal(under.alpha, 1);
    assert.equal(under.captionAlpha, 0);
    assert.notEqual(under.rotation, top.rotation);
    assert.ok(under.x !== top.x || under.y !== top.y);
    assert.equal(under.leader, null);
    assert.ok(top.leader);
    // Pile gardée dans l'écran, à l'écart de l'étape (500, 300).
    for (const c of cards) {
        assert.ok(c.x - c.cardW / 2 >= 0 && c.x + c.cardW / 2 <= 1000 && c.y - c.cardH / 2 >= 0);
        assert.ok(!(Math.abs(c.x - 500) < c.cardW / 2 && Math.abs(c.y - 300) < c.cardH / 2));
    }
    // Pendant la photo 1, la pile est déjà à sa place : rien ne bouge à
    // l'arrivée de la 2.
    assert.equal(photoFrameAt(timeline(), 20, display, VIEW).cards[0].x, under.x);
    // Sortie d'un bloc, après la dernière photo.
    cards = photoFrameAt(timeline(), 43, display, VIEW).cards;
    assert.deepEqual(cards.map((c) => c.alpha), [0.5, 0.5]);
    assert.deepEqual(photoFrameAt(timeline(), 44.5, display, VIEW).cards, []);
    // Sans inclinaison : décalées, pas tournées.
    cards = photoFrameAt(timeline(), 35, { ...display, tilt: false }, VIEW).cards;
    assert.deepEqual(cards.map((c) => c.rotation), [0, 0]);
    // Emplacement fixe : même pile ; la bande ignore le réglage.
    cards = photoFrameAt(timeline(), 35, { ...display, layout: 'fixed' }, VIEW).cards;
    assert.deepEqual(cards.map((c) => c.photoId), [1, 2]);
    const strip = normalizePhotoDisplay({ layout: 'strip' });
    assert.deepEqual(photoFrameAt(timeline(), 35, { ...strip, stack: true }, VIEW).cards,
        photoFrameAt(timeline(), 35, strip, VIEW).cards);
});

test('vignettes : côté le moins encombré par le trajet, stable', () => {
    // A au nord-ouest de B, C au nord-est : les deux coins du haut sont pris.
    const stops = [
        { lat: 45.0013, lon: 5.9982 },
        { lat: 45, lon: 6 },
        { lat: 45.0013, lon: 6.0018 },
    ];
    const legs = [{ from: 0, to: 1 }, { from: 1, to: 2 }];
    const tl = { stops, legs };
    assert.deepEqual(pinDirection(tl, 1), [1, 1]);
    assert.equal(pinDirection(tl, 1), pinDirection(tl, 1)); // mémorisé
    // Un chemin réel compte, pas la ligne droite : B → C part d'abord vers
    // le sud, puis remonte à l'est. Le bas-droite est pris.
    const winding = {
        stops,
        legs: [{ from: 0, to: 1 }, { from: 1, to: 2, path: [[6, 45], [6, 44.9985], [6.0018, 44.9985], [6.0018, 45.0013]] }],
    };
    const dir = pinDirection(winding, 1);
    assert.notDeepEqual(dir, [1, 1]);
    assert.notDeepEqual(dir, [-1, -1]);
    // Rien autour : haut-droite. Nuit entre deux journées ignorée.
    assert.deepEqual(pinDirection({ stops, legs: [{ from: 0, to: 1, night: true }] }, 2), [1, -1]);
    // Étape sans position : haut-droite.
    assert.deepEqual(pinDirection({ stops: [{}], legs: [] }, 0), [1, -1]);
});

test('vignettes : la photo descend près de son étape et y reste', () => {
    const display = normalizePhotoDisplay({ pin: true, tilt: false });
    assert.equal(PHOTO_DISPLAY_DEFAULTS.pin, false);
    assert.equal(normalizePhotoDisplay({ pin_size: 5 }).pin_size, 40);
    // Photo 1 finie à 27 : à mi-descente à 29.
    let cards = photoFrameAt(timeline(), 29, display, VIEW).cards;
    const landing = cards.find((c) => c.photoId === 1);
    assert.equal(landing.pinned, false);
    assert.ok(landing.scale < 1 && landing.scale > 72 / landing.cardW);
    // Posée : petite, en haut à droite de l'étape (500, 300), sous la photo 2.
    cards = photoFrameAt(timeline(), 35, display, VIEW).cards;
    assert.deepEqual(cards.map((c) => c.photoId), [1, 2]);
    const [pin] = cards;
    assert.equal(pin.pinned, true);
    assert.ok(Math.abs(pin.cardW * pin.scale - 72) < 1e-9);
    assert.equal(pin.alpha, 1);
    assert.equal(pin.captionAlpha, 0);
    assert.ok(pin.x > 500 && pin.y < 300);
    assert.ok(pin.x - (pin.cardW * pin.scale) / 2 > 500);
    assert.ok(pin.leader && pin.leader.from[0] === 500);
    // Toujours là à l'étape suivante, sous la photo montrée.
    cards = photoFrameAt(timeline(), 90, display, VIEW).cards;
    assert.deepEqual(cards.map((c) => [c.photoId, !!c.pinned]), [[1, true], [2, true], [3, false]]);
    // Près du bord : attachée à décalage fixe — rognée plutôt que ramenée
    // dans l'écran (elle ne glisse pas par rapport à la carte).
    const edge = { ...VIEW, stopPixel: (i) => (i === 0 ? [975, 300] : [900, 100]) };
    const edgePin = photoFrameAt(timeline(), 35, display, edge).cards.find((c) => c.photoId === 1);
    assert.equal(edgePin.pinned, true);
    assert.ok(Math.abs(edgePin.x - 975 - (pin.x - 500)) < 1e-9);
    assert.ok(edgePin.x > 1000);
    // Hors de l'écran : pas dessinée.
    const away = { ...VIEW, stopPixel: (i) => (i === 0 ? [-500, 300] : [900, 100]) };
    assert.deepEqual(photoFrameAt(timeline(), 90, display, away).cards.map((c) => c.photoId), [3]);
    // Avec la pile : la pile entière descend à la fin de la dernière photo.
    cards = photoFrameAt(timeline(), 35, { ...display, stack: true }, VIEW).cards;
    assert.ok(cards.every((c) => !c.pinned));
    cards = photoFrameAt(timeline(), 47, { ...display, stack: true }, VIEW).cards;
    assert.deepEqual(cards.map((c) => [c.photoId, c.pinned]), [[1, true], [2, true]]);
    // La bande ignore le réglage.
    const strip = normalizePhotoDisplay({ layout: 'strip' });
    assert.deepEqual(photoFrameAt(timeline(), 90, { ...strip, pin: true }, VIEW).cards,
        photoFrameAt(timeline(), 90, strip, VIEW).cards);
});
