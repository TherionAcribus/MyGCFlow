import test from 'node:test';
import assert from 'node:assert/strict';

import {
    appearOpacityExpression,
    appearScaleExpression,
    createAppearClock,
    POINT_APPEAR_MS,
    RECENT_GLOW_EXTRA_SCALE,
    recentGlowFactorExpression,
    STATIC_APPEAR,
    withAppearScale,
    withRecentGlowScale,
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
        case '+': return evaluate(args[0], env) + evaluate(args[1], env);
        case '/': return evaluate(args[0], env) / evaluate(args[1], env);
        case '^': return evaluate(args[0], env) ** evaluate(args[1], env);
        case 'clamp': {
            const [x, lo, hi] = args.map((a) => evaluate(a, env));
            return Math.min(hi, Math.max(lo, x));
        }
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

const at = (now, appear, glowMs = 1000) => ({ vars: { now, glowMs }, props: { appear } });

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

test('la persistance est maximale à l\'apparition puis retombe à zéro', () => {
    const factor = recentGlowFactorExpression();
    const glow = 10_000;   // fenêtre de 10 s d'animation
    const born = 1_000;
    assert.equal(evaluate(factor, at(born + POINT_APPEAR_MS, born, glow)), 1);
    const values = [0.2, 0.5, 0.8].map(
        (p) => evaluate(factor, at(born + POINT_APPEAR_MS + p * glow, born, glow)));
    for (let i = 1; i < values.length; i++) assert.ok(values[i] < values[i - 1]);
    // La décroissance est accélérée : à mi-fenêtre, il reste moins de la moitié.
    assert.ok(values[1] < 0.5);
    assert.equal(evaluate(factor, at(born + POINT_APPEAR_MS + glow, born, glow)), 0);
    assert.equal(evaluate(factor, at(1e9, born, glow)), 0);
});

test('un point statique n\'est jamais mis en avant par la persistance', () => {
    assert.equal(evaluate(recentGlowFactorExpression(), at(5000, STATIC_APPEAR, 10_000)), 0);
    assert.equal(evaluate(withRecentGlowScale(8), at(5000, STATIC_APPEAR, 10_000)), 8);
});

test('un point récent est légèrement plus gros', () => {
    const scale = withRecentGlowScale(8);
    const grown = evaluate(scale, at(1000 + POINT_APPEAR_MS, 1000, 10_000));
    assert.ok(Math.abs(grown - 8 * (1 + RECENT_GLOW_EXTRA_SCALE)) < 1e-9);
});
