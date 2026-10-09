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
    splitCameraBudget,
    CAMERA_TRAVEL_MAX_SHARE,
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

// --- Plusieurs jours par image (mode Évolution) -----------------------------

test('sans l\'option, framesForDay et les plans gardent une image par jour', () => {
    // Valeurs par défaut inchangées : même résultat avec l'option explicitement à false.
    const base = buildImageTimingPlan({ dayCount: 100, timePerDayMs: 1, fps: 24 });
    const explicit = buildImageTimingPlan({ dayCount: 100, timePerDayMs: 1, fps: 24, allowMultipleDaysPerFrame: false });
    assert.deepEqual(explicit, base);
    assert.equal(framesForDay(5, 100, 10), framesForDay(5, 100, 10, { allowZero: false }));
    assert.equal(framesForDay(5, 100, 10), 1);
});

test('plusieurs jours peuvent partager une image : 9 300 jours en 60 s à 30 fps', () => {
    const plan = buildImageTimingPlan({
        dayCount: 9300,
        timePerDayMs: 60000 / 9300,
        fps: 30,
        tailFreezeMs: 0,
        allowMultipleDaysPerFrame: true,
    });
    assert.equal(plan.baseFrameCount, 1800);
    assert.ok(plan.framesPerDayAverage < 1);

    const perDay = Array.from(
        { length: plan.dayCount },
        (_, index) => framesForDay(index, plan.dayCount, plan.baseFrameCount, { allowZero: true }),
    );
    // La somme télescope exactement au nombre d'images demandé.
    assert.equal(perDay.reduce((sum, count) => sum + count, 0), 1800);
    assert.ok(perDay.every((count) => count === 0 || count === 1));
    assert.ok(perDay.includes(0));
});

test('avec allowZero, la répartition reste exacte quand il y a plus d\'images que de jours', () => {
    const perDay = Array.from({ length: 10 }, (_, i) => framesForDay(i, 10, 25, { allowZero: true }));
    assert.equal(perDay.reduce((sum, count) => sum + count, 0), 25);
    assert.deepEqual(perDay, Array.from({ length: 10 }, (_, i) => framesForDay(i, 10, 25)));
});

test('buildTimingPlan : le minimum ne dépend plus du nombre de jours avec l\'option', () => {
    const range = { startDate: new Date(2001, 0, 1), endDate: new Date(2026, 5, 30) };
    const strict = buildTimingPlan({
        ...range,
        rhythm: { mode: 'duration', totalDurationMs: 30000 },
        fps: 30,
        tailFreezeMs: 0,
    });
    assert.equal(strict.clampedToMinimum, true);

    const relaxed = buildTimingPlan({
        ...range,
        rhythm: { mode: 'duration', totalDurationMs: 30000 },
        fps: 30,
        tailFreezeMs: 0,
        allowMultipleDaysPerFrame: true,
    });
    assert.equal(relaxed.valid, true);
    assert.equal(relaxed.clampedToMinimum, false);
    assert.deepEqual(relaxed.warnings, []);
    assert.equal(relaxed.baseFrameCount, 900);
    assert.equal(relaxed.totalDurationMs, 30000);
});

// ---------- Suivi de caméra ----------

test('durée imposée : les trajets de caméra sont pris sur le temps des dates', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'music', musicDurationMs: 63000 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 20000,
        cameraJourneyCount: 12,
    });
    assert.equal(plan.valid, true);
    assert.deepEqual(plan.warnings, []);
    // La vidéo garde la durée de la musique, trajets compris.
    assert.equal(plan.totalDurationMs, 63000);
    assert.equal(plan.animationMs, 60000);
    assert.equal(plan.cameraTravelMs, 20000);
    assert.equal(plan.cameraTravelScale, 1);
    assert.equal(plan.cameraJourneyCount, 12);
    assert.equal(plan.cameraTimeBudgetMs, 60000);
    // Les dates se partagent ce que les trajets laissent : 40 s pour 100 jours.
    assert.equal(plan.timePerDayMs, 400);
    assert.equal(plan.totalFrameCount, 63 * 30);
    // Les images de raccord sont exposées pour l'UI mais restent dans le
    // budget : 12 trajets × 1 image à 30 fps, sans effet sur animationMs.
    assert.equal(plan.cameraOverheadMs, 12 * 1000 / 30);
});

test('rythme en jours/s : les trajets de caméra s\'ajoutent à la durée annoncée', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'rate', daysPerSecond: 10 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 20000,
    });
    assert.equal(plan.timePerDayMs, 100);
    assert.equal(plan.animationMs, 30000);
    assert.equal(plan.totalDurationMs, 33000);
    assert.ok(Number.isNaN(plan.cameraTimeBudgetMs), 'aucune durée à tenir');
    assert.equal(plan.totalFrameCount, 33 * 30);
});

test('rythme en jours/s : les images de raccord des trajets s\'ajoutent à la durée', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'rate', daysPerSecond: 10 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 20000,
        cameraJourneyCount: 15,
    });
    // 15 trajets × 1 image de raccord à 30 fps = 500 ms de surcoût : la vidéo
    // réelle dure dates + trajets + raccords, le plan doit l'annoncer.
    assert.equal(plan.cameraOverheadMs, 500);
    assert.equal(plan.animationMs, 30500);
    assert.equal(plan.totalDurationMs, 33500);
});

test('sans durée de trajets connue, le surcoût caméra n\'est pas exposé', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'rate', daysPerSecond: 10 },
        fps: 30,
    });
    assert.ok(Number.isNaN(plan.cameraOverheadMs));
});

test('sans durée de trajets fournie, le plan est inchangé', () => {
    const base = { dayCount: 100, rhythm: { mode: 'duration', totalDurationMs: 60000 }, fps: 30 };
    const plan = buildTimingPlan(base);
    assert.ok(Number.isNaN(plan.cameraTravelMs));
    assert.ok(Number.isNaN(plan.cameraTimeBudgetMs));
    assert.equal(plan.timePerDayMs, 570);
    // Suivi actif mais aucun trajet prévu : même rythme, durée à tenir connue.
    const still = buildTimingPlan({ ...base, cameraTravelMs: 0 });
    assert.equal(still.timePerDayMs, 570);
    assert.equal(still.cameraTimeBudgetMs, 57000);
});

test('des trajets trop longs pour la durée demandée sont accélérés et signalés', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'duration', totalDurationMs: 63000 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 90000,
    });
    assert.equal(plan.totalDurationMs, 63000);
    assert.equal(plan.cameraTravelMs, 60000 * CAMERA_TRAVEL_MAX_SHARE);
    assert.equal(plan.cameraTravelRawMs, 90000);
    assert.ok(Math.abs(plan.cameraTravelScale - 0.4) < 1e-9);
    assert.equal(plan.timePerDayMs, 240);
    const warning = plan.warnings.find((w) => w.type === 'camera-travel-compressed');
    assert.ok(warning);
    assert.equal(warning.travelMs, 90000);
    assert.equal(warning.appliedMs, 36000);
});

test('splitCameraBudget garde une image par jour aux dates', () => {
    // 10 s d'animation dont 8 s incompressibles pour les dates.
    const split = splitCameraBudget({ animationMs: 10000, minDatesMs: 8000, travelMs: 5000 });
    assert.equal(split.datesMs, 8000);
    assert.equal(split.travelMs, 2000);
    assert.equal(split.travelScale, 0.4);
    assert.equal(split.compressed, true);

    const large = splitCameraBudget({ animationMs: 10000, minDatesMs: 1000, travelMs: 5000 });
    assert.deepEqual(large, { datesMs: 5000, travelMs: 5000, travelScale: 1, compressed: false });

    const none = splitCameraBudget({ animationMs: 10000, minDatesMs: 1000, travelMs: 0 });
    assert.deepEqual(none, { datesMs: 10000, travelMs: 0, travelScale: 1, compressed: false });
});

test('durée inférieure au minimum : les trajets s\'ajoutent au minimum appliqué', () => {
    const plan = buildTimingPlan({
        dayCount: 300,
        rhythm: { mode: 'duration', totalDurationMs: 5000 },
        fps: 30,
        tailFreezeMs: 0,
        cameraTravelMs: 4000,
    });
    assert.equal(plan.clampedToMinimum, true);
    assert.equal(plan.totalDurationMs, 14000);
    assert.equal(plan.warnings[0].appliedMs, 14000);
    assert.ok(Number.isNaN(plan.cameraTimeBudgetMs));
});

test('buildImageTimingPlan compte les images des trajets de caméra', () => {
    const plan = buildImageTimingPlan({
        dayCount: 10, timePerDayMs: 100, fps: 30, tailFreezeMs: 0, cameraTravelMs: 2000,
    });
    assert.equal(plan.baseFrameCount, 30);
    assert.equal(plan.travelFrameCount, 60);
    assert.equal(plan.totalFrameCount, 90);
    assert.equal(plan.framesPerDayAverage, 3);
});

// ---------- Piste de caméra (cameraOverlap) ----------
//
// Mode par défaut : les trajets se jouent PENDANT l'affichage des dates —
// chacun se termine pile quand son jour s'affiche. Rien n'est ajouté ni
// retranché : tout le budget d'animation va aux dates.

test('cameraOverlap en rythme jours/s : l\'animation est la durée des dates seules', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'rate', daysPerSecond: 10 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 20000,
        cameraJourneyCount: 15,
        cameraOverlap: true,
    });
    assert.equal(plan.valid, true);
    assert.equal(plan.cameraOverlap, true);
    assert.equal(plan.timePerDayMs, 100);
    // Ni trajets ni images de raccord ne s'ajoutent : les frames de trajet
    // SONT des frames de dates.
    assert.equal(plan.animationMs, 10000);
    assert.equal(plan.totalDurationMs, 13000);
    assert.equal(plan.cameraOverheadMs, 0);
    // La durée simulée reste exposée à titre informationnel (résumé UI).
    assert.equal(plan.cameraTravelMs, 20000);
    assert.equal(plan.cameraTravelRawMs, 20000);
    assert.equal(plan.cameraJourneyCount, 15);
    assert.ok(Number.isNaN(plan.cameraTimeBudgetMs), 'aucune durée à tenir');
    // Aucune image supplémentaire : même nombre de frames que sans trajet.
    const sansTrajets = buildTimingPlan({
        dayCount: 100, rhythm: { mode: 'rate', daysPerSecond: 10 }, fps: 30, tailFreezeMs: 3000,
    });
    assert.equal(plan.totalFrameCount, sansTrajets.totalFrameCount);
});

test('cameraOverlap en durée imposée : tout le budget va aux dates', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'duration', totalDurationMs: 63000 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 90000,
        cameraJourneyCount: 3,
        cameraOverlap: true,
    });
    assert.equal(plan.valid, true);
    assert.equal(plan.totalDurationMs, 63000);
    // Pas de partage : timePerDay = animation entière / jours, et le budget
    // exposé au moteur est l'animation complète (désormais entièrement dates).
    assert.equal(plan.animationMs, 60000);
    assert.equal(plan.timePerDayMs, 600);
    assert.equal(plan.cameraTimeBudgetMs, 60000);
    assert.equal(plan.cameraTravelScale, 1);
    // Des trajets qui dépasseraient tout ne produisent pas de compression ni
    // d'avertissement : ils se jouent pendant les dates, au pire en retard sur
    // leur jour (comportement documenté dans camera_follow.mjs).
    assert.ok(!plan.warnings.some((w) => w.type === 'camera-travel-compressed'));
});

test('cameraOverlap ne change rien quand la durée des trajets est inconnue', () => {
    const base = buildTimingPlan({
        dayCount: 100, rhythm: { mode: 'rate', daysPerSecond: 10 }, fps: 30,
    });
    const overlapSansSim = buildTimingPlan({
        dayCount: 100, rhythm: { mode: 'rate', daysPerSecond: 10 }, fps: 30,
        cameraOverlap: true,
    });
    assert.equal(overlapSansSim.cameraOverlap, false);
    assert.deepEqual(overlapSansSim.animationMs, base.animationMs);
    // Sans cameraOverlap, le comportement actuel est strictement conservé.
    const reactif = buildTimingPlan({
        dayCount: 100, rhythm: { mode: 'rate', daysPerSecond: 10 }, fps: 30,
        tailFreezeMs: 3000, cameraTravelMs: 20000, cameraJourneyCount: 15,
    });
    assert.equal(reactif.cameraOverlap, false);
    assert.equal(reactif.animationMs, 30500);
    assert.equal(reactif.cameraOverheadMs, 500);
});

// ---------- Pré-roll de la piste (cameraLeadMs) ----------
//
// Le trajet du jour 0 joue en tête de timeline, avant la première date.
// En mode 'rate' la vidéo s'allonge d'autant ; en 'duration'/'music' le
// pré-roll est pris sur le budget d'animation, qui reste respecté.

test('cameraLeadMs en rythme jours/s : le pré-roll allonge l\'animation', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'rate', daysPerSecond: 10 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 20000,
        cameraJourneyCount: 15,
        cameraOverlap: true,
        cameraLeadMs: 2500,
    });
    assert.equal(plan.valid, true);
    assert.equal(plan.cameraLeadMs, 2500);
    // Le rythme des dates est inchangé ; la vidéo est plus longue du pré-roll.
    assert.equal(plan.timePerDayMs, 100);
    assert.equal(plan.animationMs, 12500);
    assert.equal(plan.totalDurationMs, 15500);
    // Les images de pré-roll s'ajoutent au total sans toucher le quota des
    // jours : 100 jours × 100 ms = 300 frames de dates, +75 frames de pré-roll,
    // +90 frames de pause de fin.
    assert.equal(plan.baseFrameCount, 300);
    assert.equal(plan.totalFrameCount, 465);
});

test('cameraLeadMs en durée imposée : total inchangé, dates réduites du pré-roll', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'duration', totalDurationMs: 63000 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 40000,
        cameraJourneyCount: 3,
        cameraOverlap: true,
        cameraLeadMs: 3000,
    });
    assert.equal(plan.valid, true);
    assert.equal(plan.cameraLeadMs, 3000);
    // La vidéo garde sa durée ; le budget d'animation exposé au moteur inclut
    // le pré-roll (prepareCameraPacing le soustrait à son tour).
    assert.equal(plan.totalDurationMs, 63000);
    assert.equal(plan.animationMs, 60000);
    assert.equal(plan.cameraTimeBudgetMs, 60000);
    // Les dates se partagent 60 s − 3 s d'approche : 570 ms/jour.
    assert.equal(plan.timePerDayMs, 570);
    // Frames : dates (100 × 570 ms → 1710) + pré-roll (90) + fin (90).
    assert.equal(plan.baseFrameCount, 1710);
    assert.equal(plan.totalFrameCount, 1890);
    assert.equal(plan.totalFrameCount, Math.round(plan.totalDurationMs * 30 / 1000));
});

test('cameraLeadMs est ignoré hors mode piste', () => {
    // Sans cameraOverlap (mode réactif) : le trajet du jour 0 se joue pendant
    // l'affichage de sa date comme les autres — pas de pré-roll.
    const reactif = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'rate', daysPerSecond: 10 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 20000,
        cameraLeadMs: 2500,
    });
    assert.equal(reactif.cameraLeadMs, 0);
    assert.equal(reactif.animationMs, 30000);
    // cameraOverlap sans simulation connue : pas d'overlap, pas de pré-roll.
    const sansSim = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'rate', daysPerSecond: 10 },
        fps: 30,
        cameraOverlap: true,
        cameraLeadMs: 2500,
    });
    assert.equal(sansSim.cameraOverlap, false);
    assert.equal(sansSim.cameraLeadMs, 0);
    assert.equal(sansSim.animationMs, 10000);
});

test('buildImageTimingPlan : le pré-roll s\'ajoute au total sans rogner les jours', () => {
    const plan = buildImageTimingPlan({
        dayCount: 10, timePerDayMs: 100, fps: 30, tailFreezeMs: 0, cameraLeadMs: 2000,
    });
    assert.equal(plan.baseFrameCount, 30);   // quota des jours inchangé
    assert.equal(plan.leadFrameCount, 60);
    assert.equal(plan.totalFrameCount, 90);
    // Sans pré-roll : leadFrameCount exposé mais nul, total inchangé.
    const sans = buildImageTimingPlan({ dayCount: 10, timePerDayMs: 100, fps: 30, tailFreezeMs: 0 });
    assert.equal(sans.leadFrameCount, 0);
    assert.equal(sans.totalFrameCount, 30);
});

// ---------- Pauses de dates planifiées (cameraHoldMs) ----------
//
// Même financement que le pré-roll : ajouté à la durée annoncée en 'rate',
// pris sur le budget d'animation en 'duration'/'music'.

test('cameraHoldMs en rythme jours/s : les pauses allongent l\'animation', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'rate', daysPerSecond: 10 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 20000,
        cameraJourneyCount: 15,
        cameraOverlap: true,
        cameraLeadMs: 2500,
        cameraHoldMs: 4000,
    });
    assert.equal(plan.valid, true);
    assert.equal(plan.cameraHoldMs, 4000);
    // Rythme des dates inchangé ; la vidéo s'allonge des pauses (comme du
    // pré-roll) : 10 s de dates + 2,5 s d'approche + 4 s de pauses + 3 s de fin.
    assert.equal(plan.timePerDayMs, 100);
    assert.equal(plan.animationMs, 16500);
    assert.equal(plan.totalDurationMs, 19500);
    // Images : 300 de dates + 75 de pré-roll + 120 de pauses + 90 de fin.
    assert.equal(plan.baseFrameCount, 300);
    assert.equal(plan.holdFrameCount, 120);
    assert.equal(plan.totalFrameCount, 585);
});

test('cameraHoldMs en durée imposée : total inchangé, dates réduites des pauses', () => {
    const plan = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'duration', totalDurationMs: 63000 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 40000,
        cameraJourneyCount: 3,
        cameraOverlap: true,
        cameraLeadMs: 3000,
        cameraHoldMs: 7000,
    });
    assert.equal(plan.valid, true);
    assert.equal(plan.cameraHoldMs, 7000);
    assert.equal(plan.totalDurationMs, 63000);
    // cameraTimeBudgetMs reste le budget animation entier — le moteur refait
    // la soustraction (approche + pauses) dans prepareCameraPacing.
    assert.equal(plan.cameraTimeBudgetMs, 60000);
    // Dates : 60 s − 3 s d'approche − 7 s de pauses = 50 s → 500 ms/jour.
    assert.equal(plan.timePerDayMs, 500);
    // Frames : dates (1500) + pré-roll (90) + pauses (210) + fin (90) = 1890,
    // exactement la durée totale à 30 i/s.
    assert.equal(plan.baseFrameCount, 1500);
    assert.equal(plan.totalFrameCount, 1890);
    assert.equal(plan.totalFrameCount, Math.round(plan.totalDurationMs * 30 / 1000));
});

test('cameraHoldMs est ignoré hors mode piste', () => {
    const reactif = buildTimingPlan({
        dayCount: 100,
        rhythm: { mode: 'rate', daysPerSecond: 10 },
        fps: 30,
        tailFreezeMs: 3000,
        cameraTravelMs: 20000,
        cameraHoldMs: 4000,
    });
    assert.equal(reactif.cameraHoldMs, 0);
    assert.equal(reactif.animationMs, 30000);
});

test('buildImageTimingPlan : les pauses planifiées s\'ajoutent au total', () => {
    const plan = buildImageTimingPlan({
        dayCount: 10, timePerDayMs: 100, fps: 30, tailFreezeMs: 0,
        cameraLeadMs: 2000, cameraHoldMs: 1000,
    });
    assert.equal(plan.baseFrameCount, 30);   // quota des jours inchangé
    assert.equal(plan.leadFrameCount, 60);
    assert.equal(plan.holdFrameCount, 30);
    assert.equal(plan.totalFrameCount, 120);
});
