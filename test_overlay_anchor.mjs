// node --test test_overlay_anchor.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    OVERLAY_ANCHORS,
    detectOverlayAnchor,
    overlayAnchorPatch,
    overlayAnchorRect,
    overlayFreePatch,
} from './static/js/overlay_anchor.mjs';

// Applique un patch à un objet de déclarations, comme le fait
// infos_editor.js sur un CSSStyleDeclaration.
function applyPatch(decl, patch) {
    const out = { ...decl };
    for (const prop of patch.remove) delete out[prop];
    Object.assign(out, patch.set);
    return out;
}

const TITLE_SHEET = { top: 10, left: 10 };
const INFOS_SHEET = { top: 10, right: 10 };

test('détection : côtés de la feuille par défaut, puis CSS du thème', () => {
    assert.deepEqual(detectOverlayAnchor({}, TITLE_SHEET), { anchor: 'top-left', dx: 10, dy: 10 });
    assert.deepEqual(detectOverlayAnchor({}, INFOS_SHEET), { anchor: 'top-right', dx: 10, dy: 10 });
    assert.deepEqual(detectOverlayAnchor({ top: '24px', left: '30px' }, TITLE_SHEET),
        { anchor: 'top-left', dx: 30, dy: 24 });
    // Les côtés de la feuille neutralisés par `auto`.
    assert.deepEqual(detectOverlayAnchor({ top: 'auto', left: 'auto', bottom: '12px', right: '8px' }, TITLE_SHEET),
        { anchor: 'bottom-right', dx: 8, dy: 12 });
});

test('détection : CSS hors grille → null (personnalisé)', () => {
    assert.equal(detectOverlayAnchor({ position: 'relative' }, TITLE_SHEET), null);
    // Haut et bas à la fois.
    assert.equal(detectOverlayAnchor({ bottom: '10px' }, TITLE_SHEET), null);
    // Unité non gérée.
    assert.equal(detectOverlayAnchor({ top: '5%' }, TITLE_SHEET), null);
    // Gauche et droite sans centrage.
    assert.equal(detectOverlayAnchor({ right: '10px' }, TITLE_SHEET), null);
});

test('chaque emplacement se relit à l’identique, quelle que soit la feuille', () => {
    for (const sheet of [TITLE_SHEET, INFOS_SHEET]) {
        for (const anchor of OVERLAY_ANCHORS) {
            const decl = applyPatch({ color: 'red' }, overlayAnchorPatch(anchor, { dx: 22, dy: 14 }));
            const found = detectOverlayAnchor(decl, sheet);
            assert.equal(found.anchor, anchor, `${anchor} (feuille ${Object.keys(sheet)})`);
            assert.equal(found.dy, 14);
            if (!anchor.endsWith('-center')) assert.equal(found.dx, 22);
            assert.equal(decl.color, 'red');
        }
    }
});

test('centré : left/right à 0, marges auto, largeur fit-content sauf largeur fixe', () => {
    const centered = overlayAnchorPatch('bottom-center', { dy: 20 });
    assert.deepEqual(centered.set, {
        position: 'absolute', top: 'auto', bottom: '20px', left: '0px', right: '0px',
        'margin-left': 'auto', 'margin-right': 'auto', width: 'fit-content',
    });
    const fixed = overlayAnchorPatch('top-center', {}, { width: '300px' });
    assert.equal(fixed.set.width, undefined);
    // Retour dans un coin : le centrage est défait, la largeur fixe reste.
    const back = overlayAnchorPatch('top-left', {}, { width: 'fit-content' });
    assert.deepEqual(back.remove, ['margin-left', 'margin-right', 'width']);
    assert.ok(!overlayAnchorPatch('top-left', {}, { width: '300px' }).remove.includes('width'));
});

test('rect cible : coins, centre, boîte plus large que le cadre', () => {
    const box = { width: 1000, height: 600 };
    const size = { width: 200, height: 40 };
    assert.deepEqual(overlayAnchorRect('top-left', { dx: 10, dy: 12 }, size, box),
        { anchor: 'top-left', x: 10, y: 12, width: 200, height: 40 });
    assert.deepEqual(overlayAnchorRect('bottom-right', { dx: 10, dy: 12 }, size, box),
        { anchor: 'bottom-right', x: 790, y: 548, width: 200, height: 40 });
    assert.equal(overlayAnchorRect('top-center', {}, size, box).x, 400);
    assert.equal(overlayAnchorRect('top-center', {}, { width: 1200, height: 40 }, box).width, 1000);
});

test('position libre : en % du cadre, bornée, jamais lue comme un emplacement', () => {
    const box = { width: 1000, height: 600 };
    const patch = overlayFreePatch(-30, 590, { width: 200, height: 40 }, box, { width: 'fit-content' });
    assert.deepEqual(patch.set, { position: 'absolute', left: '0%', top: '93.3%', right: 'auto', bottom: 'auto' });
    assert.ok(patch.remove.includes('width'));
    const middle = applyPatch({}, overlayFreePatch(400, 280, { width: 200, height: 40 }, box));
    assert.equal(middle.left, '40%');
    assert.equal(detectOverlayAnchor(middle, TITLE_SHEET), null);
});
