// Page Parcours : étapes empilées (static/js/parcours_stack.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    FAN_CIRCLE_MAX,
    STACK_DISTANCE,
    fanOffsets,
    stackLabel,
    stackStops,
} from '../../static/js/parcours_stack.mjs';

const at = (x, y, group = 0) => ({ x, y, group });

test('piles : étapes proches d’une même journée, première étape en tête', () => {
    const items = [at(0, 0), at(5, 0), at(100, 0), at(3, 4), at(104, 2)];
    assert.deepEqual(stackStops(items, 16), [
        { rep: 0, members: [0, 1, 3] },
        { rep: 2, members: [2, 4] },
    ]);
    // Seuil nul : aucune pile.
    assert.equal(stackStops(items, 0).length, 5);
    assert.deepEqual(stackStops([], 16), []);
});

test('deux journées ne s’empilent jamais', () => {
    assert.deepEqual(stackStops([at(0, 0, 'a'), at(1, 1, 'b')], 16), [
        { rep: 0, members: [0] },
        { rep: 1, members: [1] },
    ]);
});

test('pas de chaîne : une pile reste à portée de sa première étape', () => {
    // Pas de 10 px, seuil 16 : 0 et 10 ensemble, 20 ouvre une nouvelle pile
    // (à 20 px de la tête, même si 10 px de la précédente).
    const items = [at(0, 0), at(10, 0), at(20, 0), at(30, 0)];
    assert.deepEqual(stackStops(items, 16).map((s) => s.members), [[0, 1], [2, 3]]);
});

test('stable par préfixe : la lecture retrouve les piles du repos', () => {
    const items = [at(0, 0), at(30, 0), at(4, 4), at(33, 2), at(2, 9), at(60, 0)];
    const all = stackStops(items, 16);
    for (let n = 1; n <= items.length; n++) {
        const prefix = stackStops(items.slice(0, n), 16);
        const expected = all
            .map((s) => ({ rep: s.rep, members: s.members.filter((m) => m < n) }))
            .filter((s) => s.members.length && s.rep < n);
        assert.deepEqual(prefix, expected, `préfixe ${n}`);
    }
});

test('rayon d’empilement en rayons de pastille', () => {
    assert.equal(STACK_DISTANCE, 1.5);
    // Pastilles de 11 px : centres à 15 px = empilées, à 17 px = non.
    assert.equal(stackStops([at(0, 0), at(15, 0)], 11 * STACK_DISTANCE).length, 1);
    assert.equal(stackStops([at(0, 0), at(17, 0)], 11 * STACK_DISTANCE).length, 2);
});

test('libellé : « 4–7 » si les numéros se suivent, « ×n » sinon', () => {
    assert.equal(stackLabel(['4', '5', '6', '7']), '4–7');
    assert.equal(stackLabel(['4', '6']), '×2');
    assert.equal(stackLabel(['', '']), '×2');
    assert.equal(stackLabel(['9']), '9');
    assert.equal(stackLabel([]), '');
});

test('éventail : cercle puis spirale, pastilles sans contact', () => {
    assert.deepEqual(fanOffsets(0, 11), []);
    const two = fanOffsets(2, 11);
    // Premier en haut (y vers le bas : négatif).
    assert.ok(two[0][1] < 0 && Math.abs(two[0][0]) < 0.1);
    for (const n of [2, 5, FAN_CIRCLE_MAX, FAN_CIRCLE_MAX + 1, 25]) {
        const offsets = fanOffsets(n, 11);
        assert.equal(offsets.length, n);
        for (let i = 0; i < n; i++) {
            // Hors de la pastille centrale.
            assert.ok(Math.hypot(...offsets[i]) >= 22, `${n} : ${offsets[i]}`);
            for (let j = 0; j < i; j++) {
                const d = Math.hypot(offsets[i][0] - offsets[j][0], offsets[i][1] - offsets[j][1]);
                assert.ok(d >= 22, `${n} : ${i} et ${j} à ${d}`);
            }
        }
    }
});
