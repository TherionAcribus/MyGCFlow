import test from 'node:test';
import assert from 'node:assert/strict';

import {
    appearOpacityExpression,
    appearScaleExpression,
    createAppearClock,
    POINT_APPEAR_MS,
    STATIC_APPEAR,
    withAppearScale,
} from './static/js/point_appear.mjs';

// Évalue les expressions produites, pour une variable 'now' et un attribut
// 'appear' donnés (sous-ensemble du format flat style utilisé ici).
function evaluate(expr, env) {
    if (typeof expr === 'number') return expr;
    const [op, ...args] = expr;
    switch (op) {
        case 'var': return env.vars[args[0]];
        case 'get': return env.props[args[0]];
        case '-': return evaluate(args[0], env) - evaluate(args[1], env);
        case '*': return evaluate(args[0], env) * evaluate(args[1], env);
        case 'interpolate': {
            const input = evaluate(args[1], env);
            const stops = args.slice(2);
            if (input <= stops[0]) return stops[1];
            for (let i = 2; i < stops.length; i += 2) {
                if (input <= stops[i]) {
                    const t = (input - stops[i - 2]) / (stops[i] - stops[i - 2]);
                    return stops[i - 1] + t * (stops[i + 1] - stops[i - 1]);
                }
            }
            return stops[stops.length - 1];
        }
        default: throw new Error(`opérateur non géré : ${op}`);
    }
}

const at = (now, appear) => ({ vars: { now }, props: { appear } });

test('un point surgit petit, dépasse sa taille puis se pose', () => {
    const scale = appearScaleExpression();
    assert.equal(evaluate(scale, at(1000, 1000)), 0.4);
    const peak = evaluate(scale, at(1000 + 0.55 * POINT_APPEAR_MS, 1000));
    assert.ok(peak > 1.3);
    assert.equal(evaluate(scale, at(1000 + POINT_APPEAR_MS, 1000)), 1);
    assert.equal(evaluate(scale, at(1e6, 1000)), 1);
});

test('un point dont le tour n\'est pas venu est invisible', () => {
    const opacity = appearOpacityExpression();
    assert.equal(evaluate(opacity, at(1000, 1050)), 0);
    assert.ok(evaluate(opacity, at(1000, 1000)) > 0);
    assert.equal(evaluate(opacity, at(1000 + POINT_APPEAR_MS, 1000)), 1);
});

test('un point statique est toujours à sa taille et opacité normales', () => {
    for (const now of [0, 5, 1e7]) {
        assert.equal(evaluate(appearScaleExpression(), at(now, STATIC_APPEAR)), 1);
        assert.equal(evaluate(appearOpacityExpression(), at(now, STATIC_APPEAR)), 1);
    }
});

test('withAppearScale multiplie une taille existante', () => {
    assert.equal(evaluate(withAppearScale(8), at(5000, STATIC_APPEAR)), 8);
    assert.equal(evaluate(withAppearScale(8), at(5000, 5000)), 8 * 0.4);
});

test('l\'horloge suit sa source', () => {
    const clock = createAppearClock();
    assert.equal(clock.sample('live', 100), 0);   // première valeur raccordée à 0
    assert.equal(clock.sample('live', 150), 50);
    assert.equal(clock.sample('live', 400), 300);
});

test('changer de source ne fait jamais reculer l\'horloge', () => {
    const clock = createAppearClock();
    clock.sample('live', 10_000);
    clock.sample('live', 12_000);                   // 2000
    // Début d'une capture image par image : le temps vidéo repart de 0.
    assert.equal(clock.sample('frames', 0), 2000);
    assert.equal(clock.sample('frames', 500), 2500);
    // Retour en lecture live, performance.now() bien plus grand.
    assert.equal(clock.sample('live', 90_000), 2500);
    assert.equal(clock.sample('live', 90_100), 2600);
});

test('une valeur qui recule ou invalide ne fait pas reculer l\'horloge', () => {
    const clock = createAppearClock();
    clock.sample('live', 0);
    clock.sample('live', 100);
    assert.equal(clock.sample('live', 50), 100);
    assert.equal(clock.sample('live', NaN), 100);
    assert.equal(clock.last, 100);
});
