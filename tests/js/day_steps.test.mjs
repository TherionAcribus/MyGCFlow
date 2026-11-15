import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildDaySteps,
    compactBySteps,
    stepIndexOfDay,
    stepsShownForDays,
} from '../../static/js/day_steps.mjs';

// x = jour de trouvailles, . = jour vide.
const days = (pattern) => [...pattern].map((c) => c === 'x');

// Jours de chaque pas, pour lire les découpages d'un coup d'œil.
function groups(pattern, steps) {
    const out = [];
    let first = 0;
    for (const end of steps.stepEnds) {
        out.push(pattern.slice(first, end + 1));
        first = end + 1;
    }
    return out;
}

test('aucun regroupement quand la plage tient à un pas par jour', () => {
    assert.equal(buildDaySteps(days('x..x'), 4), null);
    assert.equal(buildDaySteps(days('x..x'), 10), null);
    assert.equal(buildDaySteps([], 3), null);
});

test('les longues périodes vides sont raccourcies d’abord, les jours de trouvailles gardent leur pas', () => {
    const pattern = 'x..........x.x';
    const steps = buildDaySteps(days(pattern), 8);
    // 3 jours de trouvailles + la période de 10 jours ramenée à 4 pas + 1 jour
    // vide court gardé tel quel = 8 pas.
    assert.equal(steps.stepCount, 8);
    assert.equal(steps.emptyRunCap, 4);
    assert.equal(steps.fits, true);
    assert.deepEqual(groups(pattern, steps), ['x', '...', '..', '...', '..', 'x', '.', 'x']);
});

test('chaque jour de trouvailles reste seul dans son pas', () => {
    const pattern = '..x.x....xx...';
    for (let max = 4; max < pattern.length; max++) {
        const steps = buildDaySteps(days(pattern), max);
        assert.ok(steps.stepCount <= max, `au plus ${max} pas`);
        for (const group of groups(pattern, steps)) {
            assert.ok([...group].filter((c) => c === 'x').length <= 1, `${group} : un seul jour de trouvailles`);
        }
        assert.equal(steps.stepEnds[steps.stepEnds.length - 1], pattern.length - 1);
    }
});

test('sous le nombre de jours de trouvailles, tous les jours vides fusionnent', () => {
    const pattern = '..x...xx..';
    const steps = buildDaySteps(days(pattern), 2);
    assert.equal(steps.fits, false);
    assert.equal(steps.emptyRunCap, 0);
    // Les jours vides rejoignent le jour de trouvailles suivant ; ceux de la
    // fin, le dernier pas.
    assert.deepEqual(groups(pattern, steps), ['..x', '...x', 'x..']);
    assert.equal(steps.stepCount, steps.eventDays);
});

test('une plage sans trouvaille garde au moins un pas', () => {
    const steps = buildDaySteps(days('.....'), 0);
    assert.equal(steps.stepCount, 1);
    assert.deepEqual(steps.stepEnds, [4]);
    assert.equal(buildDaySteps(days('......'), 3).stepCount, 3);
});

test('du jour au pas, et des jours affichés aux pas affichés', () => {
    const ends = [0, 3, 5, 9];
    assert.deepEqual([0, 1, 3, 4, 5, 6, 9, 42].map((d) => stepIndexOfDay(ends, d)), [0, 1, 1, 2, 2, 3, 3, 3]);
    // Un pas ne compte qu'une fois son dernier jour affiché.
    assert.deepEqual([0, 1, 2, 4, 5, 6, 10, 99].map((n) => stepsShownForDays(ends, n)), [0, 1, 1, 2, 2, 3, 4, 4]);
});

test('les valeurs par jour se ramènent à une valeur par pas', () => {
    const ends = [1, 4, 5];
    assert.deepEqual(compactBySteps([null, 'a', null, 'b', null, null], ends), ['a', 'b', null]);
    assert.deepEqual(compactBySteps([1, 2, 3, 4, 5, 6], ends, (v) => v.reduce((s, x) => s + x, 0)), [3, 12, 6]);
});
