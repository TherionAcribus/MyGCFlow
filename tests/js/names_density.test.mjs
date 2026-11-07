// Durée de vie et densité des pseudos de Mes poses (static/js/names_density.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    NAME_READABLE_MS,
    effectiveNameDurationMs,
    nameDensityReport,
    nameDurationPatch,
    peakConcurrentNames,
} from '../../static/js/names_density.mjs';
import { normalizePosesNames } from '../../static/js/poses_names.mjs';

const names = (extra = {}) => normalizePosesNames({ enabled: true, ...extra });
const rhythm = (extra = {}) => names({ duration_mode: 'rhythm', ...extra });

test('durée fixe : celle du réglage, quel que soit le rythme', () => {
    const n = names({ duration_ms: 2200 });
    assert.equal(effectiveNameDurationMs(n, 16), 2200);
    assert.equal(effectiveNameDurationMs(n, 1000), 2200);
});

test('durée selon le rythme : jours d’animation, bornés', () => {
    const n = rhythm({ duration_days: 10, duration_min_ms: 1000, duration_max_ms: 4000 });
    assert.equal(effectiveNameDurationMs(n, 164), 1640);   // 1 an en 60 s
    assert.equal(effectiveNameDurationMs(n, 16), 1000);    // vidéo rapide : plancher
    assert.equal(effectiveNameDurationMs(n, 1000), 4000);  // 1 jour/s : plafond
    // Bornes inversées par la saisie : l'intervalle reste valable.
    assert.equal(effectiveNameDurationMs({ ...n, duration_min_ms: 4000, duration_max_ms: 1000 }, 164), 1640);
    // Rythme inconnu : la durée fixe, dans les bornes.
    assert.equal(effectiveNameDurationMs({ ...n, duration_ms: 9000 }, 0), 4000);
});

test('étiquettes simultanées : fenêtre glissante de la durée de vie', () => {
    const counts = [[0, 3], [1, 2], [5, 4], [6, 1], [30, 2]];
    // Moins d'un jour : le jour le plus chargé seul.
    assert.equal(peakConcurrentNames(counts, 500, 1000), 4);
    assert.equal(peakConcurrentNames(counts, 1000, 1000), 4);
    // Deux jours : 4 + 1 (jours 5-6) ; trois : idem (jours vides).
    assert.equal(peakConcurrentNames(counts, 2000, 1000), 5);
    // Sept jours : 3 + 2 + 4 + 1.
    assert.equal(peakConcurrentNames(counts, 7000, 1000), 10);
    // Tout tient dans la fenêtre.
    assert.equal(peakConcurrentNames(counts, 31000, 1000), 12);
    assert.equal(peakConcurrentNames([], 2000, 1000), 0);
});

test('densité sous le plafond : pas d’avertissement', () => {
    const report = nameDensityReport(names({ max_visible: 12 }), { dayCounts: [[0, 3], [1, 2]], msPerDay: 1000 });
    assert.equal(report.over, false);
    assert.deepEqual(report.fixes, []);
});

test('corrections : logs marquants, raccourcir, monter la limite', () => {
    // 1 trouvaille par jour, dont 1 marquante tous les 10 jours ; 100 ms par
    // jour : un pseudo de 2,2 s couvre 22 jours.
    const dayCounts = Array.from({ length: 200 }, (_, d) => [d, 1]);
    const notableDayCounts = dayCounts.filter(([d]) => d % 10 === 0);
    const n = names({ max_visible: 12, duration_ms: 2200 });
    const report = nameDensityReport(n, { dayCounts, notableDayCounts, msPerDay: 100 });
    assert.equal(report.over, true);
    assert.equal(report.concurrent, 22);
    const byKind = Object.fromEntries(report.fixes.map((f) => [f.kind, f]));
    assert.deepEqual(byKind.notable.patch, { only_notable: true });
    assert.equal(byKind.notable.concurrent, 3);
    // 1,2 s : 12 jours, 12 étiquettes — juste le plafond.
    assert.equal(byKind.shorten.durationMs, 1200);
    assert.deepEqual(byKind.shorten.patch, { duration_ms: 1200 });
    assert.equal(byKind.shorten.concurrent, 12);
    assert.deepEqual(byKind.cap.patch, { max_visible: 22 });
    // Déjà en logs marquants : pas de proposition de ce côté.
    const notable = nameDensityReport({ ...n, only_notable: true }, { dayCounts, notableDayCounts, msPerDay: 100 });
    assert.ok(!notable.fixes.some((f) => f.kind === 'notable'));
});

test('raccourcir : jamais sous le seuil de lecture', () => {
    const dayCounts = Array.from({ length: 400 }, (_, d) => [d, 1]);
    const n = names({ max_visible: 5, duration_ms: 2200 });
    // 16 ms par jour : même à 1 s, ~63 étiquettes.
    const report = nameDensityReport(n, { dayCounts, msPerDay: 16 });
    const shorten = report.fixes.find((f) => f.kind === 'shorten');
    assert.equal(shorten.durationMs, NAME_READABLE_MS);
    assert.ok(shorten.concurrent > 5 && shorten.concurrent < report.concurrent);
    // Déjà au seuil : rien à raccourcir ; limite plafonnée à 60.
    const short = nameDensityReport({ ...n, duration_ms: 1000 }, { dayCounts, msPerDay: 16 });
    assert.ok(!short.fixes.some((f) => f.kind === 'shorten'));
    assert.deepEqual(short.fixes.find((f) => f.kind === 'cap').patch, { max_visible: 60 });
    assert.ok(!nameDensityReport({ ...n, max_visible: 60, duration_ms: 1000 }, { dayCounts, msPerDay: 16 })
        .fixes.some((f) => f.kind === 'cap'));
});

test('raccourcir en mode rythme : moins de jours, ou un plancher plus bas', () => {
    const n = rhythm({ duration_days: 20, duration_min_ms: 1000, duration_max_ms: 4000 });
    // 100 ms/jour : 20 jours = 2 s ; viser 1,2 s → 12 jours.
    const patch = nameDurationPatch(n, 1200, 100);
    assert.deepEqual(patch, { duration_days: 12 });
    assert.equal(effectiveNameDurationMs({ ...n, ...patch }, 100), 1200);
    // 16 ms/jour : le plancher retient la durée — il descend.
    const fast = nameDurationPatch({ ...n, duration_min_ms: 2000 }, 1200, 16);
    assert.equal(fast.duration_min_ms, 1200);
    assert.equal(effectiveNameDurationMs({ ...n, duration_min_ms: 2000, ...fast }, 16), 1200);
    // Bilan complet : la correction proposée tient ce qu'elle annonce.
    const dayCounts = Array.from({ length: 200 }, (_, d) => [d, 1]);
    const report = nameDensityReport({ ...n, max_visible: 12 }, { dayCounts, msPerDay: 100 });
    const shorten = report.fixes.find((f) => f.kind === 'shorten');
    const applied = normalizePosesNames(shorten.patch, { ...n, max_visible: 12 });
    assert.equal(nameDensityReport(applied, { dayCounts, msPerDay: 100 }).over, false);
});
