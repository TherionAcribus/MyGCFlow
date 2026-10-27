// Effets de points de Mes poses (static/js/poses_point_style.mjs) : les
// expressions de style sont évaluées ici par un petit interprète du
// sous-ensemble d'OpenLayers qu'elles utilisent, pour vérifier les valeurs
// que le shader calculera.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ACTIVITY_RADIUS,
    ARCHIVED_OPACITY,
    FRESHNESS_FADE,
    FRESHNESS_MAX_MIX,
    FRESHNESS_PALE,
    GHOST_STROKE_WIDTH,
    POSES_ACTIVITY_FILTER,
    activityLevelExpression,
    applyDisabledPulse,
    applyPosesFreshness,
    applyPosesGhost,
    applyPosesPopularity,
    archivedOpacityFor,
    buildPosesActivityStyle,
    freshnessAmountExpression,
    popularityScaleExpression,
} from '../../static/js/poses_point_style.mjs';
import { normalizePosesEffects, withPosesEffectsPreset } from '../../static/js/poses_effects.mjs';
import { POP_LEVEL_PACK } from '../../static/js/poses_timeline.mjs';
import { EVO_NEVER_DAY, EVO_STATIC_FROM } from '../../static/js/evolution_style.mjs';

// Interprète minimal : nombres, couleurs (renvoyées telles quelles) et les
// opérateurs utilisés par les effets.
function evaluate(expr, ctx) {
    // Littéraux : nombres, chaînes, couleurs [r, g, b, a].
    if (!Array.isArray(expr) || typeof expr[0] !== 'string') return expr;
    const [op, ...args] = expr;
    const ev = (e) => evaluate(e, ctx);
    switch (op) {
    case 'get': return ctx.props[args[0]];
    case 'var': return ctx.vars[args[0]];
    case '+': return args.reduce((s, a) => s + ev(a), 0);
    case '*': return args.reduce((s, a) => s * ev(a), 1);
    case '-': return ev(args[0]) - ev(args[1]);
    case '/': return ev(args[0]) / ev(args[1]);
    case '%': return ev(args[0]) % ev(args[1]);
    case '^': return ev(args[0]) ** ev(args[1]);
    case 'sin': return Math.sin(ev(args[0]));
    case 'clamp': return Math.min(ev(args[2]), Math.max(ev(args[1]), ev(args[0])));
    case '==': return ev(args[0]) === ev(args[1]);
    case '<': return ev(args[0]) < ev(args[1]);
    case '>': return ev(args[0]) > ev(args[1]);
    case '<=': return ev(args[0]) <= ev(args[1]);
    case 'all': return args.every((a) => ev(a));
    case 'case': {
        for (let i = 0; i + 1 < args.length; i += 2) if (ev(args[i])) return ev(args[i + 1]);
        return ev(args[args.length - 1]);
    }
    case 'interpolate': {
        // ['interpolate', ['linear'], input, s0, o0, s1, o1] : nombres seulement,
        // sinon renvoie la sortie la plus proche (couleurs).
        const input = ev(args[1]);
        const stops = args.slice(2);
        if (input <= stops[0]) return ev(stops[1]);
        if (input >= stops[stops.length - 2]) return ev(stops[stops.length - 1]);
        for (let i = 2; i < stops.length; i += 2) {
            if (input <= stops[i]) {
                const a = ev(stops[i - 1]);
                const b = ev(stops[i + 1]);
                if (typeof a !== 'number' || typeof b !== 'number') return { mix: input, from: a, to: b };
                const t = (input - stops[i - 2]) / (stops[i] - stops[i - 2]);
                return a + (b - a) * t;
            }
        }
        return ev(stops[stops.length - 1]);
    }
    default: throw new Error(`opérateur non géré : ${op}`);
    }
}

const ANIM = { evoDay: 10, evoIntraMs: 0, evoMsPerDay: 1000, evoFrom: 0, evoStagger: 0, now: 0 };
const REST = { evoDay: 10, evoIntraMs: 0, evoMsPerDay: 1, evoFrom: EVO_STATIC_FROM, evoStagger: 0, now: 0 };
const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≠ ${expected}`);

test('taille : transition depuis le niveau précédent, terminée au repos', () => {
    const scale = popularityScaleExpression(2);
    const props = { popLevels: 32 * POP_LEVEL_PACK + 16, popDay: 10 };
    close(evaluate(scale, { props, vars: { ...ANIM, evoIntraMs: 0 } }), 1.5);
    close(evaluate(scale, { props, vars: { ...ANIM, evoIntraMs: 250 } }), 1.75);
    close(evaluate(scale, { props, vars: { ...ANIM, evoIntraMs: 900 } }), 2);
    close(evaluate(scale, { props, vars: REST }), 2);
    // Sans trouvaille : taille du thème.
    close(evaluate(scale, { props: { popLevels: 0, popDay: -1e6 }, vars: ANIM }), 1);
});

test('fraîcheur : pâlit après le délai, pleine au double, seulement active', () => {
    const amount = freshnessAmountExpression(100, 70);
    const at = (day, pstate = 0) => evaluate(amount, { props: { lastFind: 0, pstate }, vars: { ...REST, evoDay: day } });
    close(at(90), 0);
    close(at(150), 0.35);
    close(at(400), 0.7);
    close(at(400, 1), 0);
});

test('lueur : une trouvaille = 0,5, divisée par la demi-vie', () => {
    const level = activityLevelExpression(10);
    close(evaluate(level, { props: { heatVal: 1, lastFind: 10 }, vars: REST }), 0.5);
    close(evaluate(level, { props: { heatVal: 1, lastFind: 0 }, vars: REST }), 1 / 3);
    close(evaluate(level, { props: { heatVal: 3, lastFind: 10 }, vars: REST }), 0.75);
});

test('décorateurs inactifs quand l’effet est décoché', () => {
    const sober = normalizePosesEffects({});
    const style = { 'circle-radius': 5, 'circle-fill-color': '#ff0000', 'circle-opacity': 1 };
    const before = JSON.stringify(style);
    applyPosesPopularity(style, sober);
    applyPosesFreshness(style, sober);
    applyDisabledPulse(style, sober);
    applyPosesGhost(style, sober);
    assert.equal(JSON.stringify(style), before);
    assert.equal(buildPosesActivityStyle({ mode: 'vectoriel', center: { size: 4 } }, sober), null);
});

test('popularité : toutes les tailles du symbole sont multipliées', () => {
    const fx = normalizePosesEffects({ popularity: { enabled: true, max_scale: 3 } });
    const style = { 'circle-radius': 4, 'circle-stroke-width': 2, 'circle-fill-color': '#ff0000' };
    applyPosesPopularity(style, fx);
    const ctx = { props: { popLevels: 32 * POP_LEVEL_PACK + 32, popDay: 0 }, vars: REST };
    close(evaluate(style['circle-radius'], ctx), 12);
    close(evaluate(style['circle-stroke-width'], ctx), 6);
});

test('fantôme : centre transparent et contour grisé pour les archivées seulement', () => {
    const fx = normalizePosesEffects({ archived_style: 'ghost' });
    const style = { 'circle-radius': 4, 'circle-fill-color': '#ff0000', 'circle-opacity': 1 };
    applyPosesGhost(style, fx);
    const at = (pstate) => ({ props: { pstate }, vars: REST });
    assert.deepEqual(evaluate(style['circle-fill-color'], at(2)), [0, 0, 0, 0]);
    assert.equal(evaluate(style['circle-stroke-color'], at(2)), '#ff0000');
    assert.equal(evaluate(style['circle-stroke-width'], at(2)), GHOST_STROKE_WIDTH);
    assert.equal(evaluate(style['circle-fill-color'], at(0)), '#ff0000');
    assert.equal(evaluate(style['circle-stroke-width'], at(0)), 0);
    // Contour du thème plus épais : gardé.
    const thick = { 'circle-fill-color': '#ff0000', 'circle-stroke-color': '#000000', 'circle-stroke-width': 3 };
    applyPosesGhost(thick, fx);
    assert.equal(evaluate(thick['circle-stroke-width'], at(2)), 3);
    assert.equal(evaluate(thick['circle-stroke-color'], at(2)), '#000000');
    assert.equal(archivedOpacityFor(fx, false), ARCHIVED_OPACITY.ghostVector);
    assert.equal(archivedOpacityFor(fx, true), ARCHIVED_OPACITY.ghostIcon);
    assert.equal(archivedOpacityFor(normalizePosesEffects({}), true), ARCHIVED_OPACITY.grey);
});

test('fraîcheur : couleur vers le pâle en vectoriel, opacité seule en icônes', () => {
    const fx = normalizePosesEffects({ freshness: { enabled: true, after_days: 10, strength: 100 } });
    const vector = { 'circle-radius': 4, 'circle-fill-color': '#ff0000', 'circle-opacity': 1 };
    applyPosesFreshness(vector, fx);
    const old = { props: { lastFind: -100, pstate: 0 }, vars: REST };
    // Pâleur plafonnée : jamais tout à fait la couleur pâle.
    assert.deepEqual(evaluate(vector['circle-fill-color'], old), { mix: FRESHNESS_MAX_MIX, from: '#ff0000', to: FRESHNESS_PALE });
    close(evaluate(vector['circle-opacity'], old), 1 - FRESHNESS_FADE.vector);
    const icon = { 'icon-src': 'x.png', 'icon-scale': 1, 'icon-opacity': 1 };
    applyPosesFreshness(icon, fx);
    close(evaluate(icon['icon-opacity'], old), 1 - FRESHNESS_FADE.icon);
});

test('pulsation : seulement les désactivées, seulement en animation', () => {
    const fx = normalizePosesEffects({ disabled_pulse: true });
    const style = { 'circle-radius': 4, 'circle-fill-color': '#ff0000', 'circle-opacity': 1 };
    applyDisabledPulse(style, fx);
    const opacity = (pstate, vars) => evaluate(style['circle-opacity'], { props: { pstate }, vars });
    close(opacity(1, REST), 1);
    close(opacity(0, ANIM), 1);
    // now = 0 → sin 0 → milieu de la vague.
    close(opacity(1, ANIM), 0.45 + 0.55 * 0.5);
});

test('couche de lueur : rayon et opacité suivent la chaleur, rien pour une archivée', () => {
    const fx = withPosesEffectsPreset(normalizePosesEffects({ activity: { intensity: 80 } }), 'rich');
    const style = buildPosesActivityStyle({ mode: 'vectoriel', center: { size: 4 } }, fx);
    const props = { heatVal: 1, lastFind: 10, pstate: 0, archivedDay: EVO_NEVER_DAY, popLevels: 0, popDay: -1e6 };
    close(evaluate(style['circle-opacity'], { props, vars: REST }), 0.8 * 0.5);
    close(evaluate(style['circle-radius'], { props, vars: REST }), 4 * (ACTIVITY_RADIUS.base + ACTIVITY_RADIUS.gain * 0.5));
    close(evaluate(style['circle-opacity'], { props: { ...props, pstate: 2 }, vars: REST }), 0);
    assert.equal(style['circle-fill-color'], fx.activity.color);
    assert.equal(POSES_ACTIVITY_FILTER[0], 'all');
});
