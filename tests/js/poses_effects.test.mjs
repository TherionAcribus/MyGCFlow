// Animation des points de Mes poses : la copie JS (static/js/poses_effects.mjs)
// doit rester celle du serveur (poses_effects.py), écrite dans
// tests/fixtures/poses/poses_effects.json par tests/test_poses_effects.py.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    ARCHIVED_STYLES,
    POPULARITY_SCALES,
    POSES_EFFECT_LEVELS,
    POSES_EFFECT_PRESETS,
    POSES_EFFECT_RANGES,
    normalizePosesEffects,
    posesEffectsAnimate,
    posesEffectsDefaults,
    posesEffectsLevel,
    withPosesEffectsPreset,
} from '../../static/js/poses_effects.mjs';

const table = JSON.parse(readFileSync(new URL('../fixtures/poses/poses_effects.json', import.meta.url), 'utf8'));

test('mêmes défauts, préréglages et bornes que le serveur', () => {
    assert.deepEqual(posesEffectsDefaults(), table.defaults);
    assert.deepEqual(JSON.parse(JSON.stringify(POSES_EFFECT_PRESETS)), table.presets);
    assert.deepEqual([...POSES_EFFECT_LEVELS], table.levels);
    assert.deepEqual([...POPULARITY_SCALES], table.scales);
    assert.deepEqual([...ARCHIVED_STYLES], table.archived_styles);
    assert.deepEqual(JSON.parse(JSON.stringify(POSES_EFFECT_RANGES)), table.ranges);
});

test('normalisation : bornes, choix, valeurs refusées', () => {
    const fx = normalizePosesEffects({
        popularity: { enabled: true, scale: 'bogus', max_scale: 99 },
        activity: { color: 'rouge', half_life_days: 0, intensity: '50' },
        freshness: { after_days: 1, strength: true },
        archived_style: 'ghost',
        disabled_pulse: 'oui',
    });
    assert.equal(fx.popularity.enabled, true);
    assert.equal(fx.popularity.scale, 'relative');
    assert.equal(fx.popularity.max_scale, 4);
    assert.equal(fx.activity.color, '#ffb300');
    assert.equal(fx.activity.half_life_days, 1);
    assert.equal(fx.activity.intensity, 50);
    assert.equal(fx.freshness.after_days, 7);
    assert.equal(fx.freshness.strength, 70);
    assert.equal(fx.archived_style, 'ghost');
    assert.equal(fx.disabled_pulse, false);
});

test('le niveau suit les cases, jamais la valeur servie', () => {
    const fx = normalizePosesEffects({
        level: 'rich', popularity: { enabled: true }, freshness: { enabled: true }, milestone_flash: true,
    });
    assert.equal(fx.level, 'balanced');
    assert.equal(normalizePosesEffects({ activity: { enabled: true } }).level, 'custom');
});

test('un préréglage ne change que les cases', () => {
    const tuned = normalizePosesEffects({ activity: { half_life_days: 40, color: '#00ff00' }, archived_style: 'ghost' });
    const rich = withPosesEffectsPreset(tuned, 'rich');
    assert.equal(rich.level, 'rich');
    assert.equal(rich.activity.enabled, true);
    assert.equal(rich.activity.half_life_days, 40);
    assert.equal(rich.activity.color, '#00ff00');
    assert.equal(rich.archived_style, 'ghost');
    const sober = withPosesEffectsPreset(rich, 'sober');
    assert.equal(posesEffectsLevel(sober), 'sober');
    assert.equal(posesEffectsAnimate(sober), false);
    assert.equal(posesEffectsAnimate(rich), true);
    // « custom » : rien ne change.
    assert.deepEqual(withPosesEffectsPreset(rich, 'custom'), rich);
});
