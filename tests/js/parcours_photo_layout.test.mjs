// Mise en page des photos d'un parcours (parcours_photo_layout.mjs) et leur
// dessin (parcours_photo_draw.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    PHOTO_DISPLAY_DEFAULTS,
    PHOTO_FADE_Q,
    isFullFrame,
    normalizePhotoDisplay,
    photoAspect,
    photoCaptionText,
    photoCrop,
    photoCropRect,
    photoFrameAt,
    photoSlots,
    photoTimelineOptions,
} from '../../static/js/parcours_photo_layout.mjs';
import { drawPhotoCard, drawPhotoLeader } from '../../static/js/parcours_photo_draw.mjs';

const round = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 100) / 100]));

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
        caption: '  {etape}\n·  {heure} ', anchor: 'middle-center',
    });
    assert.equal(d.layout, 'strip');
    assert.equal(d.size, 600);
    assert.equal(d.duration, 0.5);
    assert.equal(d.max_per_stop, 1);
    assert.equal(d.frame, 'postcard');
    assert.equal(d.tilt, true);
    assert.equal(d.caption, '{etape} · {heure}');
    assert.equal(d.anchor, 'top-right');
    assert.deepEqual(photoTimelineOptions(normalizePhotoDisplay({ duration: 2.5, max_per_stop: 6 })),
        { photoQ: 25, maxPhotosPerStop: 6 });
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
            { q: 10, departQ: 52, day: 0, photos: [1, 2], photoQ: 15 },
            { q: 80, departQ: 107, day: 1, photos: [3], photoQ: 15 },
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
