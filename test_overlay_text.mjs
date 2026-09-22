import test from 'node:test';
import assert from 'node:assert/strict';

import { digitAdvance, isTabularNums, layoutTabularText } from './static/js/tabular_text.mjs';
import { COUNTER_ANIMATION_MS, createCountAnimator } from './static/js/overlay_counter.mjs';

// Police simulée : le « 1 » est étroit, les autres chiffres larges, l'espace fin.
// C'est exactement ce qui fait sauter un compteur dessiné sans largeur fixe.
const widths = { '1': 4, ' ': 3, '/': 5 };
const measure = (glyph) => widths[glyph] ?? 10;

test('tabular-nums est reconnu dans la valeur CSS', () => {
    assert.equal(isTabularNums('tabular-nums'), true);
    assert.equal(isTabularNums('lining-nums tabular-nums'), true);
    assert.equal(isTabularNums('normal'), false);
    assert.equal(isTabularNums(undefined), false);
});

test('la largeur commune des chiffres est celle du plus large', () => {
    assert.equal(digitAdvance(measure), 10);
});

test('un nombre garde la même largeur quels que soient ses chiffres', () => {
    const digitWidth = digitAdvance(measure);
    const a = layoutTabularText('111', measure, { digitWidth }).width;
    const b = layoutTabularText('888', measure, { digitWidth }).width;
    assert.equal(a, b);
    assert.equal(a, 30);
    // Sans largeur fixe, les deux nombres n'ont pas la même largeur.
    assert.notEqual(
        layoutTabularText('111', measure).width,
        layoutTabularText('888', measure).width,
    );
});

test('les chiffres étroits sont centrés dans leur case', () => {
    const { positions } = layoutTabularText('18', measure, { digitWidth: 10 });
    assert.deepEqual(positions, [
        { glyph: '1', x: 3 },   // (10 - 4) / 2
        { glyph: '8', x: 10 },
    ]);
});

test('le texte non numérique garde sa largeur naturelle', () => {
    const { positions, width } = layoutTabularText('a b', measure, { digitWidth: 10 });
    assert.deepEqual(positions.map((p) => p.x), [0, 10, 13]);
    assert.equal(width, 23);
});

test('l\'interlettrage ne traîne pas après le dernier glyphe', () => {
    assert.equal(layoutTabularText('ab', measure, { letterSpacing: 2 }).width, 22);
    assert.equal(layoutTabularText('', measure, { letterSpacing: 2 }).width, 0);
});

test('le compteur rejoint sa cible et s\'y arrête exactement', () => {
    const counter = createCountAnimator();
    counter.set(0);
    counter.setTarget(100, 1000);
    assert.equal(counter.valueAt(1000), 0);
    assert.ok(counter.valueAt(1000 + COUNTER_ANIMATION_MS / 2) > 0);
    assert.equal(counter.valueAt(1000 + COUNTER_ANIMATION_MS), 100);
    assert.equal(counter.valueAt(9999), 100);
    assert.equal(counter.isAnimating(1000 + COUNTER_ANIMATION_MS), false);
});

test('le compteur ne dépasse jamais sa cible', () => {
    const counter = createCountAnimator();
    counter.set(0);
    counter.setTarget(7, 0, 100);
    for (let clock = 0; clock <= 100; clock += 1) {
        const value = counter.valueAt(clock);
        assert.ok(value >= 0 && value <= 7, `valeur ${value} à ${clock}`);
    }
});

test('une nouvelle cible repart de la valeur affichée, sans à-coup', () => {
    const counter = createCountAnimator();
    counter.set(0);
    counter.setTarget(100, 0, 100);
    const midway = counter.valueAt(50);
    counter.setTarget(200, 50, 100);
    assert.equal(counter.valueAt(50), midway);
    assert.equal(counter.valueAt(150), 200);
});

test('une durée nulle applique la valeur immédiatement', () => {
    const counter = createCountAnimator();
    counter.set(0);
    counter.setTarget(42, 0, 0);
    assert.equal(counter.valueAt(0), 42);
    assert.equal(counter.isAnimating(0), false);
});

test('set() impose la valeur sans animation', () => {
    const counter = createCountAnimator();
    counter.setTarget(500, 0);
    counter.set(0);
    assert.equal(counter.valueAt(0), 0);
    assert.equal(counter.valueAt(10_000), 0);
});
