import test from 'node:test';
import assert from 'node:assert/strict';

import {
    automaticEndHoldMs,
    buildImageTimingPlan,
    clampPlaybackRate,
    framesForDay,
    inclusiveDayCount,
    MAX_BROWSER_PLAYBACK_RATE,
    serverNormalizationFactor,
} from './static/js/video_timing.mjs';

test('inclusiveDayCount compte les deux bornes', () => {
    assert.equal(inclusiveDayCount(new Date(2026, 0, 1), new Date(2026, 0, 10)), 10);
});

test('la fin automatique laisse terminer le flash le plus long', () => {
    assert.equal(automaticEndHoldMs({ tailFreezeMs: 3000, flashMode: 'circle', flashDurationMs: 5000 }), 5000);
    assert.equal(automaticEndHoldMs({ tailFreezeMs: 3000, flashMode: 'none', flashDurationMs: 5000 }), 3000);
    // Le flash impulsion peut partir jusqu'à 120 ms après le dernier jour.
    assert.equal(automaticEndHoldMs({ tailFreezeMs: 3000, flashMode: 'impulse', flashDurationMs: 5000 }), 5120);
});

test('les fractions de frame sont réparties sans dérive cumulée', () => {
    const plan = buildImageTimingPlan({
        dayCount: 3650,
        // Cible finale de 180 s, dont 3 s de fin automatique.
        timePerDayMs: 177000 / 3650,
        fps: 24,
        tailFreezeMs: 3000,
    });

    const perDay = Array.from(
        { length: plan.dayCount },
        (_, index) => framesForDay(index, plan.dayCount, plan.baseFrameCount),
    );

    assert.equal(perDay.reduce((sum, count) => sum + count, 0), 4248);
    assert.ok(perDay.every((count) => count === 1 || count === 2));
    assert.equal(plan.totalFrameCount, 4320);
    assert.equal(plan.actualDurationMs, 180000);
});

test('une date garde au minimum une frame', () => {
    const plan = buildImageTimingPlan({ dayCount: 100, timePerDayMs: 1, fps: 24 });
    assert.equal(plan.baseFrameCount, 100);
    assert.equal(plan.minimumDurationMs, plan.actualDurationMs);
});

test('le temps additionnel et la fin automatique font partie du total', () => {
    const plan = buildImageTimingPlan({
        dayCount: 10,
        timePerDayMs: 100,
        fps: 30,
        extraEndSeconds: 2,
        tailFreezeMs: 3000,
        flashMode: 'circle',
        flashDurationMs: 2000,
    });
    assert.equal(plan.baseFrameCount, 30);
    assert.equal(plan.tailFrameCount, 150);
    assert.equal(plan.actualDurationMs, 6000);
});

test('le serveur ne normalise que lorsque l option est activée', () => {
    assert.equal(serverNormalizationFactor(4, true), 4);
    assert.equal(serverNormalizationFactor(4, false), 1);
    assert.equal(serverNormalizationFactor(1, true), 1);
});

test('le taux de lecture est borné au plafond navigateur', () => {
    assert.equal(MAX_BROWSER_PLAYBACK_RATE, 16);
    assert.deepEqual(clampPlaybackRate(4), { requested: 4, rate: 4, clamped: false });
    assert.deepEqual(clampPlaybackRate(16), { requested: 16, rate: 16, clamped: false });
    assert.deepEqual(clampPlaybackRate(20), { requested: 20, rate: 16, clamped: true });
});

test('un facteur invalide ou inférieur à 1 retombe sur une lecture normale', () => {
    assert.deepEqual(clampPlaybackRate(0), { requested: 1, rate: 1, clamped: false });
    assert.deepEqual(clampPlaybackRate(-5), { requested: 1, rate: 1, clamped: false });
    assert.deepEqual(clampPlaybackRate(undefined), { requested: 1, rate: 1, clamped: false });
    assert.deepEqual(clampPlaybackRate(NaN), { requested: 1, rate: 1, clamped: false });
});
