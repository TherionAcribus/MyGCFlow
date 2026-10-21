// node --test test_images_render.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { createImageItem } from './static/js/images_model.mjs';
import {
    IMAGE_EFFECT_EASINGS,
    IMAGE_ZOOM_FROM,
    cubicBezier,
    drawImagePanel,
    effectTimingCss,
    effectTransform,
    fitRect,
    imagePanelHeight,
} from './static/js/images_render.mjs';

const FILE = '0123456789abcdef.png';
const item = (overrides = {}) => createImageItem(FILE, 'logo', overrides, () => 'abcdef01');

// Contexte 2D minimal : enregistre les appels utiles aux assertions.
function fakeContext() {
    const calls = [];
    const record = (name) => (...args) => calls.push([name, ...args]);
    return {
        calls,
        save: record('save'), restore: record('restore'),
        beginPath: record('beginPath'), closePath: record('closePath'),
        rect: record('rect'), ellipse: record('ellipse'),
        moveTo: record('moveTo'), arcTo: record('arcTo'),
        clip: record('clip'), fillRect: record('fillRect'),
        drawImage: record('drawImage'), stroke: record('stroke'),
        set globalAlpha(v) { calls.push(['globalAlpha', v]); },
        set fillStyle(v) { calls.push(['fillStyle', v]); },
        set strokeStyle(v) { calls.push(['strokeStyle', v]); },
        set lineWidth(v) { calls.push(['lineWidth', v]); },
        set imageSmoothingEnabled(_) {}, set imageSmoothingQuality(_) {},
    };
}

test('hauteur : imposée, sinon d’après les proportions (marge comprise)', () => {
    const wide = { width: 400, height: 100 };
    assert.equal(imagePanelHeight(item({ position: { width: 200 } }), wide), 50);
    assert.equal(imagePanelHeight(item({ position: { width: 200 }, style: { padding: 10 } }), wide), 65);
    assert.equal(imagePanelHeight(item({ position: { width: 200, height: 90 } }), wide), 90);
    // Rond : carré, pour un avatar bien circulaire.
    assert.equal(imagePanelHeight(item({ position: { width: 120 }, style: { shape: 'circle' } }), wide), 120);
    // Pas encore décodée : carré provisoire.
    assert.equal(imagePanelHeight(item({ position: { width: 150 } }), null), 150);
    // Largeur bornée au conteneur par l'appelant.
    assert.equal(imagePanelHeight(item({ position: { width: 600 } }), wide, 300), 75);
});

test('ajustement : contain montre tout, cover remplit', () => {
    const natural = { width: 200, height: 100 };
    assert.deepEqual(fitRect('contain', natural, 0, 0, 100, 100), { x: 0, y: 25, width: 100, height: 50 });
    assert.deepEqual(fitRect('cover', natural, 0, 0, 100, 100), { x: -50, y: 0, width: 200, height: 100 });
    assert.deepEqual(fitRect('contain', null, 5, 5, 10, 10), { x: 5, y: 5, width: 10, height: 10 });
});

test('dessin : forme, fond, marge et opacité', () => {
    const source = { naturalWidth: 100, naturalHeight: 100 };
    const ctx = fakeContext();
    drawImagePanel(ctx, 200, 200, item({ style: {
        shape: 'circle', opacity: 50, background: '#102030', background_opacity: 40, padding: 10,
    } }), source, 2);
    const names = ctx.calls.map((c) => c[0]);
    assert.ok(names.includes('ellipse'));
    assert.deepEqual(ctx.calls.find((c) => c[0] === 'globalAlpha'), ['globalAlpha', 0.5]);
    assert.deepEqual(ctx.calls.find((c) => c[0] === 'fillStyle'), ['fillStyle', 'rgba(16, 32, 48, 0.4)']);
    // Marge de 10 px CSS à l'échelle 2 : 20 px réels de chaque côté.
    const draw = ctx.calls.find((c) => c[0] === 'drawImage');
    assert.deepEqual(draw.slice(2), [20, 20, 160, 160]);
    assert.equal(names.filter((n) => n === 'save').length, names.filter((n) => n === 'restore').length);
});

test('dessin : sans fond transparent ni image, seule la forme est tracée', () => {
    const ctx = fakeContext();
    drawImagePanel(ctx, 100, 50, item({ style: { shape: 'rect' } }), null);
    const names = ctx.calls.map((c) => c[0]);
    assert.ok(names.includes('rect'));
    assert.ok(!names.includes('fillRect'));
    assert.ok(!names.includes('drawImage'));
    assert.ok(!names.includes('stroke'));
});

test('bordure : liseré intérieur, trait doublé rogné par le clip de la forme', () => {
    const source = { naturalWidth: 100, naturalHeight: 100 };
    const ctx = fakeContext();
    drawImagePanel(ctx, 200, 200, item({ style: {
        shape: 'circle', fit: 'cover', padding: 10, border_color: '#ff0088', border_width: 6,
    } }), source, 2);
    // Trait doublé : 6 px CSS × 2 × échelle 2 = 24 px réels.
    assert.deepEqual(ctx.calls.find((c) => c[0] === 'strokeStyle'), ['strokeStyle', '#ff0088']);
    assert.deepEqual(ctx.calls.find((c) => c[0] === 'lineWidth'), ['lineWidth', 24]);
    const names = ctx.calls.map((c) => c[0]);
    assert.equal(names.filter((n) => n === 'stroke').length, 1);
    // Le clip « cover » de la zone intérieure est isolé (save/restore) : le
    // stroke reste sous le seul clip de la forme.
    assert.equal(names.filter((n) => n === 'save').length, names.filter((n) => n === 'restore').length);
    // Sans épaisseur : aucun stroke.
    const plain = fakeContext();
    drawImagePanel(plain, 100, 100, item(), null);
    assert.ok(!plain.calls.some((c) => c[0] === 'stroke'));
});

test('cubicBezier : extrémités fixes, linéaire exacte, rebond du zoom', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    for (const x of [0.1, 0.37, 0.8]) assert.ok(Math.abs(linear(x) - x) < 1e-6);
    for (const points of Object.values(IMAGE_EFFECT_EASINGS)) {
        const curve = cubicBezier(...points);
        assert.equal(curve(0), 0);
        assert.equal(curve(1), 1);
    }
    // « ease-out » : en avance sur le temps ; le zoom dépasse 1 puis revient.
    const slide = cubicBezier(...IMAGE_EFFECT_EASINGS.slide);
    assert.ok(slide(0.5) > 0.8);
    const zoom = cubicBezier(...IMAGE_EFFECT_EASINGS.zoom);
    assert.ok(zoom(0.5) > 1);
    assert.equal(effectTimingCss('zoom'), 'cubic-bezier(0.34, 1.56, 0.64, 1)');
    assert.equal(effectTimingCss('fade'), 'linear');
});

test('effectTransform : glisse depuis le bord le plus proche, zoom depuis la moitié', () => {
    const container = { width: 1000, height: 600 };
    // Coin bas-droit : bords droit et bas à 16 px — la droite l'emporte.
    const corner = { x: 824, y: 424, width: 160, height: 160 };
    assert.deepEqual(effectTransform('slide', 0, corner, container), { dx: 176, dy: 0, scale: 1 });
    assert.deepEqual(effectTransform('slide', 1, corner, container), { dx: 0, dy: 0, scale: 1 });
    assert.deepEqual(effectTransform('slide', 0.5, corner, container), { dx: 88, dy: 0, scale: 1 });
    // Haut, centré : sort par le haut, entièrement.
    const top = { x: 420, y: 10, width: 160, height: 80 };
    assert.deepEqual(effectTransform('slide', 0, top, container), { dx: 0, dy: -90, scale: 1 });
    // Gauche, au milieu.
    const left = { x: 16, y: 260, width: 100, height: 80 };
    assert.deepEqual(effectTransform('slide', 0, left, container), { dx: -116, dy: 0, scale: 1 });
    assert.deepEqual(effectTransform('zoom', 0, corner, container), { dx: 0, dy: 0, scale: IMAGE_ZOOM_FROM });
    assert.equal(effectTransform('zoom', 1, corner, container).scale, 1);
    assert.deepEqual(effectTransform('fade', 0, corner, container), { dx: 0, dy: 0, scale: 1 });
});
