import test from 'node:test';
import assert from 'node:assert/strict';

import {
    automaticEndHoldMs,
    buildImageTimingPlan,
    buildLoadEstimate,
    buildTimingPlan,
    clampPlaybackRate,
    formatDurationHuman,
    formatMmSs,
    framesForDay,
    inclusiveDayCount,
    strictDayCount,
    MAX_BROWSER_PLAYBACK_RATE,
    parseBoundedNumber,
    parseDurationText,
    TIMING_LIMITS,
    serverNormalizationFactor,
} from './static/js/video_timing.mjs';

test('inclusiveDayCount compte les deux bornes', () => {
    assert.equal(inclusiveDayCount(new Date(2026, 0, 1), new Date(2026, 0, 10)), 10);
});

test('inclusiveDayCount est correct autour des changements d\'heure français', () => {
    // Heure d'été : la nuit du 29 mars 2026 dure 23 h en Europe/Paris.
    assert.equal(inclusiveDayCount(new Date(2026, 2, 28), new Date(2026, 2, 30)), 3);
    // Heure d'hiver : la nuit du 25 octobre 2026 dure 25 h.
    assert.equal(inclusiveDayCount(new Date(2026, 9, 24), new Date(2026, 9, 26)), 3);
});

test('inclusiveDayCount gère années bissextiles et plage d\'un jour', () => {
    // 2024 est bissextile : le 29 février compte.
    assert.equal(inclusiveDayCount(new Date(2024, 1, 28), new Date(2024, 2, 1)), 3);
    assert.equal(inclusiveDayCount(new Date(2023, 1, 28), new Date(2023, 2, 1)), 2);
    assert.equal(inclusiveDayCount(new Date(2026, 5, 15), new Date(2026, 5, 15)), 1);
});

test('strictDayCount refuse une fin antérieure au début', () => {
    assert.equal(strictDayCount(new Date(2026, 0, 10), new Date(2026, 0, 1)), null);
    assert.equal(strictDayCount(new Date(NaN), new Date(2026, 0, 1)), null);
    assert.equal(strictDayCount(new Date(2026, 0, 1), new Date(2026, 0, 10)), 10);
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

// ---------- Validation stricte des saisies ----------

test('parseBoundedNumber refuse vide, texte, zéro, négatif, NaN et infini', () => {
    for (const bad of ['', '   ', 'abc', '0', '-2', 'NaN', 'Infinity', null, undefined]) {
        assert.equal(parseBoundedNumber(bad, TIMING_LIMITS.daysPerSecond).ok, false, JSON.stringify(bad));
    }
    for (const bad of ['0', '-1']) {
        assert.equal(parseBoundedNumber(bad, TIMING_LIMITS.extraEndSeconds, { allowZero: true }).ok === (bad === '0'), true);
    }
    assert.equal(parseBoundedNumber('20', TIMING_LIMITS.daysPerSecond).value, 20);
    assert.equal(parseBoundedNumber('0.005', TIMING_LIMITS.daysPerSecond).ok, false); // sous le min
    assert.equal(parseBoundedNumber('2000', TIMING_LIMITS.daysPerSecond).ok, false); // au-delà du max
});

test('parseDurationText accepte mm:ss et refuse le reste', () => {
    assert.equal(parseDurationText('4:55').value, 295000);
    assert.equal(parseDurationText('1:02:00').value, 3720000);
    assert.equal(parseDurationText('83.5').value, 83500);
    for (const bad of ['', 'abc', '4:75', '1:2:3:4', '-5', '0', 12]) {
        assert.equal(parseDurationText(bad).ok, false, JSON.stringify(bad));
    }
});

// ---------- Formatage ----------

test('formatMmSs et formatDurationHuman produisent un affichage lisible', () => {
    assert.equal(formatMmSs(295000), '4:55');
    assert.equal(formatMmSs(3720000), '1:02:00');
    assert.equal(formatMmSs(40000), '0:40');
    assert.equal(formatDurationHuman(295000), '4 min 55 s');
    assert.equal(formatDurationHuman(3000), '3 s');
    assert.equal(formatDurationHuman(3720000), '1 h 2 min');
    assert.equal(formatDurationHuman(0), '0 s');
});

// ---------- Plan de timing partagé ----------

const RANGE = { startDate: new Date(2026, 0, 1), endDate: new Date(2026, 0, 10) }; // 10 jours

test('buildTimingPlan mode rate : durée dérivée du rythme', () => {
    const plan = buildTimingPlan({ ...RANGE, rhythm: { mode: 'rate', daysPerSecond: 20 }, fps: 30 });
    assert.equal(plan.valid, true);
    assert.equal(plan.dayCount, 10);
    assert.equal(plan.timePerDayMs, 50);
    assert.equal(plan.animationMs, 500);
    // total = animation + pause automatique (3000) + extra (0)
    assert.equal(plan.totalDurationMs, 3500);
    assert.equal(plan.daysPerSecond, 20);
});

test('buildTimingPlan mode duration : rythme dérivé de la durée finale', () => {
    const plan = buildTimingPlan({
        ...RANGE,
        rhythm: { mode: 'duration', totalDurationMs: 13000 },
        fps: 30,
        extraEndSeconds: 0,
        tailFreezeMs: 3000,
    });
    assert.equal(plan.valid, true);
    // 13000 - 3000 de pause auto = 10000 d'animation -> 1000 ms/jour -> 1 j/s
    assert.equal(plan.animationMs, 10000);
    assert.equal(plan.timePerDayMs, 1000);
    assert.equal(plan.totalDurationMs, 13000);
});

test('buildTimingPlan mode music : le total suit la durée du fichier', () => {
    const plan = buildTimingPlan({
        ...RANGE,
        rhythm: { mode: 'music', musicDurationMs: 295000 },
        fps: 30,
        tailFreezeMs: 3000,
        extraEndSeconds: 5,
    });
    assert.equal(plan.valid, true);
    assert.equal(plan.totalDurationMs, 295000);
    assert.equal(plan.animationMs, 295000 - 3000 - 5000);
    assert.equal(plan.musicDurationMs, 295000);
});

test('une durée demandée trop courte est bornée au minimum, avec avertissement', () => {
    // 10 jours à 30 fps : minimum = 10 frames = ~334 ms d'animation.
    const plan = buildTimingPlan({
        ...RANGE,
        rhythm: { mode: 'duration', totalDurationMs: 1000 },
        fps: 30,
        tailFreezeMs: 3000,
    });
    assert.equal(plan.valid, true);
    assert.equal(plan.clampedToMinimum, true);
    assert.ok(plan.warnings.some(w => w.type === 'minimum-total'));
    // La durée réellement appliquée = minimum, pas la demande.
    assert.equal(plan.totalDurationMs, plan.minimumTotalDurationMs);
    assert.ok(plan.totalFrameCount >= plan.dayCount); // une frame par jour
});

test('musique plus courte que le minimum : avertissement dédié', () => {
    const plan = buildTimingPlan({
        ...RANGE,
        rhythm: { mode: 'music', musicDurationMs: 500 },
        fps: 30,
        tailFreezeMs: 3000,
    });
    assert.equal(plan.valid, true);
    assert.ok(plan.warnings.some(w => w.type === 'music-shorter-than-minimum'));
    assert.ok(plan.totalDurationMs > 500); // la vidéo est plus longue que la musique
});

test('les entrées invalides produisent des erreurs, pas un plan', () => {
    assert.equal(buildTimingPlan({ ...RANGE, rhythm: { mode: 'rate', daysPerSecond: 0 } }).valid, false);
    assert.equal(buildTimingPlan({ ...RANGE, rhythm: { mode: 'rate', daysPerSecond: NaN } }).valid, false);
    assert.equal(buildTimingPlan({ ...RANGE, rhythm: { mode: 'duration', totalDurationMs: '' } }).valid, false);
    assert.equal(buildTimingPlan({ ...RANGE, rhythm: { mode: 'music', musicDurationMs: NaN } }).valid, false);
    // Fin avant début : refusée.
    const bad = buildTimingPlan({
        startDate: new Date(2026, 0, 10), endDate: new Date(2026, 0, 1),
        rhythm: { mode: 'rate', daysPerSecond: 20 },
    });
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.includes('range'));
});

test('le plan partagé et le plan images produisent les mêmes frames (24/30/60 fps)', () => {
    for (const fps of [24, 30, 60]) {
        const plan = buildTimingPlan({
            ...RANGE,
            rhythm: { mode: 'rate', daysPerSecond: 20 },
            fps,
            tailFreezeMs: 3000,
            extraEndSeconds: 2,
        });
        const imagePlan = buildImageTimingPlan({
            dayCount: plan.dayCount,
            timePerDayMs: plan.timePerDayMs,
            fps,
            extraEndSeconds: 2,
            tailFreezeMs: 3000,
        });
        assert.equal(plan.totalFrameCount, imagePlan.totalFrameCount, `fps=${fps}`);
        // Durée annoncée == durée exportée à une frame près.
        const exportedMs = plan.totalFrameCount * 1000 / fps;
        assert.ok(Math.abs(exportedMs - plan.totalDurationMs) <= 1000 / fps, `fps=${fps}`);
    }
});

test('l\'estimation de charge signale flashs denses et longue vidéo', () => {
    const plan = buildTimingPlan({
        ...RANGE,
        rhythm: { mode: 'rate', daysPerSecond: 100 },
        fps: 30,
    });
    const heavy = buildLoadEstimate({ plan, maxPointsPerDay: 800, flashDurationMs: 5000 });
    assert.ok(heavy.warnings.includes('flashes'));
    const light = buildLoadEstimate({ plan, maxPointsPerDay: 2, flashDurationMs: 1000 });
    assert.deepEqual(light.warnings, []);
});
