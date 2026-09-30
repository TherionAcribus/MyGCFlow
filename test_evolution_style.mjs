import test from 'node:test';
import assert from 'node:assert/strict';

import {
    disappearOpacityExpression,
    disappearScaleExpression,
    EVO_AGE,
    EVO_FILTER,
    EVO_GONE,
    EVO_NEVER_DAY,
    EVO_STATIC_MS,
    EVO_STYLE_VARIABLES,
    POINT_DISAPPEAR_MS,
    staticEvolutionVariables,
} from './static/js/evolution_style.mjs';
import { appearOpacityExpression, appearScaleExpression, POINT_APPEAR_MS } from './static/js/point_appear.mjs';

// Sous-ensemble du format « flat style » d'OpenLayers utilisé par le mode
// Évolution, évalué comme le ferait le shader.
function evaluate(expr, env) {
    if (typeof expr === 'number') return expr;
    const [op, ...args] = expr;
    const ev = (a) => evaluate(a, env);
    switch (op) {
        case 'var':
            if (!(args[0] in env.vars)) throw new Error(`variable non déclarée : ${args[0]}`);
            return env.vars[args[0]];
        case 'get': return env.props[args[0]];
        case '-': return ev(args[0]) - ev(args[1]);
        case '+': return ev(args[0]) + ev(args[1]);
        case '*': return ev(args[0]) * ev(args[1]);
        case '<': return ev(args[0]) < ev(args[1]);
        case '<=': return ev(args[0]) <= ev(args[1]);
        case '>': return ev(args[0]) > ev(args[1]);
        case 'all': return args.every((a) => ev(a));
        case 'case': {
            for (let i = 0; i + 1 < args.length; i += 2) {
                if (ev(args[i])) return ev(args[i + 1]);
            }
            return ev(args[args.length - 1]);
        }
        case 'interpolate': {
            const input = ev(args[1]);
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

const running = (evoDay, evoIntraMs, extra = {}) => ({
    evoDay, evoIntraMs, evoFrom: 10, evoMsPerDay: 50, evoStagger: 0, ...extra,
});
const point = (placedDay, archivedDay = EVO_NEVER_DAY, stagger = 0) => ({ placedDay, archivedDay, stagger });
const at = (vars, props) => ({ vars, props });

test('toutes les variables référencées sont déclarées', () => {
    const vars = Object.fromEntries(EVO_STYLE_VARIABLES.map((n) => [n, 0]));
    for (const expr of [EVO_AGE, EVO_GONE, EVO_FILTER, disappearScaleExpression(), disappearOpacityExpression()]) {
        assert.doesNotThrow(() => evaluate(expr, at(vars, point(1, 3))));
    }
    assert.deepEqual(Object.keys(staticEvolutionVariables(3)).sort(), [...EVO_STYLE_VARIABLES].sort());
});

test('un point n\'est dessiné qu\'une fois placé', () => {
    assert.equal(evaluate(EVO_FILTER, at(running(11, 0), point(12))), false);
    assert.equal(evaluate(EVO_FILTER, at(running(12, 0), point(12))), true);
});

test('les points antérieurs au départ sont dessinés sans animation', () => {
    const vars = running(9, 0); // avant le premier pas : evoDay = evoFrom - 1
    assert.equal(evaluate(EVO_AGE, at(vars, point(3))), EVO_STATIC_MS);
    assert.equal(evaluate(appearScaleExpression(POINT_APPEAR_MS, EVO_AGE), at(vars, point(3))), 1);
    // Archivée avant le départ : déjà disparue, sans animation.
    assert.equal(evaluate(EVO_FILTER, at(vars, point(3, 8))), false);
    // Archivée plus tard : encore active.
    assert.equal(evaluate(EVO_FILTER, at(vars, point(3, 15))), true);
});

test('âge d\'apparition : jours écoulés + temps dans le jour - décalage de vague', () => {
    assert.equal(evaluate(EVO_AGE, at(running(12, 20), point(12))), 20);
    assert.equal(evaluate(EVO_AGE, at(running(14, 20), point(12))), 120);
    const staggered = running(12, 20, { evoStagger: 1 });
    assert.equal(evaluate(EVO_AGE, at(staggered, point(12, EVO_NEVER_DAY, 60))), -40);
    // Tant que la vague n'est pas arrivée, le point reste invisible.
    assert.equal(evaluate(appearOpacityExpression(POINT_APPEAR_MS, EVO_AGE), at(staggered, point(12, EVO_NEVER_DAY, 60))), 0);
});

test('disparition : rétrécissement et fondu puis retrait du filtre', () => {
    const p = point(11, 12);
    assert.equal(evaluate(EVO_GONE, at(running(11, 30), p)), -1);
    assert.equal(evaluate(disappearOpacityExpression(), at(running(11, 30), p)), 1);
    assert.equal(evaluate(EVO_GONE, at(running(12, 30), p)), 30);
    const mid = at(running(12, POINT_DISAPPEAR_MS / 2), p);
    assert.ok(evaluate(disappearOpacityExpression(), mid) < 1);
    assert.equal(evaluate(EVO_FILTER, mid), true);
    const done = at(running(12, POINT_DISAPPEAR_MS), p);
    assert.equal(evaluate(disappearScaleExpression(), done), 0);
    assert.equal(evaluate(EVO_FILTER, done), false);
});

test('au repos, l\'état final du jour choisi est dessiné sans animation', () => {
    const rest = staticEvolutionVariables(12);
    assert.equal(evaluate(EVO_FILTER, at(rest, point(3))), true);
    assert.equal(evaluate(EVO_FILTER, at(rest, point(3, 12))), false);
    assert.equal(evaluate(EVO_FILTER, at(rest, point(3, 13))), true);
    assert.equal(evaluate(EVO_FILTER, at(rest, point(13))), false);
    assert.equal(evaluate(appearScaleExpression(POINT_APPEAR_MS, EVO_AGE), at(rest, point(12))), 1);
});
