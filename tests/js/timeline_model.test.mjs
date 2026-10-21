// Barre de chronologie : calculs purs (static/js/timeline_model.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    bucketDaysFor,
    bucketize,
    clampOffset,
    columnExtremes,
    countDaysUpTo,
    cumulative,
    cursorFraction,
    dateOfOffset,
    dayOffsetOf,
    normalizeTimelineStyle,
    offsetAtFraction,
    offsetForKey,
    seriesExtent,
    spanDays,
    yearLabelOffsets,
    yearStartOffsets,
} from '../../static/js/timeline_model.mjs';

const day = (y, m, d) => new Date(y, m - 1, d);

test('style inconnu → histogramme', () => {
    assert.equal(normalizeTimelineStyle('curve'), 'curve');
    assert.equal(normalizeTimelineStyle('nope'), 'histogram');
    assert.equal(normalizeTimelineStyle(undefined), 'histogram');
});

test('plage : bornes incluses, vide si inversée ou invalide', () => {
    assert.equal(spanDays(day(2026, 1, 1), day(2026, 1, 6)), 6);
    assert.equal(spanDays(day(2026, 1, 1), day(2026, 1, 1)), 1);
    assert.equal(spanDays(day(2026, 1, 6), day(2026, 1, 1)), 0);
    assert.equal(spanDays(new Date(NaN), day(2026, 1, 1)), 0);
    // Changement d'heure (fin mars) : toujours des jours entiers.
    assert.equal(spanDays(day(2026, 3, 28), day(2026, 3, 30)), 3);
});

test('décalage ↔ date, heure ignorée', () => {
    const start = day(2024, 2, 27);
    assert.equal(dayOffsetOf(new Date(2024, 2, 1, 23, 30), start), 3); // 2024 bissextile
    assert.deepEqual(dateOfOffset(start, 3), day(2024, 3, 1));
    assert.deepEqual(dateOfOffset(start, -1), day(2024, 2, 26));
});

test('bornage du décalage', () => {
    assert.equal(clampOffset(-3, 10), 0);
    assert.equal(clampOffset(42, 10), 9);
    assert.equal(clampOffset(4.6, 10), 5);
    assert.equal(clampOffset(NaN, 10), 0);
    assert.equal(clampOffset(3, 0), 0);
});

test('curseur au bord droit du jour, case visée par une abscisse', () => {
    assert.equal(cursorFraction(0, 4), 0.25);
    assert.equal(cursorFraction(3, 4), 1);
    assert.equal(cursorFraction(0, 0), 0);
    assert.equal(offsetAtFraction(0, 4), 0);
    assert.equal(offsetAtFraction(0.249, 4), 0);
    assert.equal(offsetAtFraction(0.25, 4), 1);
    assert.equal(offsetAtFraction(1, 4), 3); // bord droit : dernier jour, pas au-delà
    // Aller-retour : le milieu de chaque case redonne son jour.
    for (let k = 0; k < 7; k++) assert.equal(offsetAtFraction((k + 0.5) / 7, 7), k);
});

test('touches : jour, semaine, mois calendaire, bornes', () => {
    const start = day(2026, 1, 1);
    const span = 365;
    assert.equal(offsetForKey('ArrowRight', {}, 10, start, span), 11);
    assert.equal(offsetForKey('ArrowUp', {}, 10, start, span), 11);
    assert.equal(offsetForKey('ArrowLeft', { shift: true }, 10, start, span), 3);
    assert.equal(offsetForKey('ArrowLeft', {}, 0, start, span), 0);
    assert.equal(offsetForKey('Home', {}, 50, start, span), 0);
    assert.equal(offsetForKey('End', {}, 50, start, span), 364);
    // 31 janvier + 1 mois → 28 février (mois plus court).
    assert.equal(offsetForKey('PageUp', {}, 30, start, span), dayOffsetOf(day(2026, 2, 28), start));
    // 15 mars − 1 mois → 15 février.
    const march15 = dayOffsetOf(day(2026, 3, 15), start);
    assert.equal(offsetForKey('PageDown', {}, march15, start, span), dayOffsetOf(day(2026, 2, 15), start));
    // Bridé à la plage.
    assert.equal(offsetForKey('PageDown', {}, 5, start, span), 0);
    assert.equal(offsetForKey('Enter', {}, 5, start, span), null);
    assert.equal(offsetForKey('ArrowRight', {}, 5, start, 0), null);
});

test('histogramme : tranche la plus fine qui laisse 3 px par barre', () => {
    assert.equal(bucketDaysFor(100, 300), 1);
    assert.equal(bucketDaysFor(101, 300), 2);
    assert.equal(bucketDaysFor(3650, 800), 14);
    // Au-delà de la tranche d'un an : calculée.
    assert.equal(bucketDaysFor(365 * 200, 100), Math.ceil(365 * 200 * 3 / 100));
});

test('sommes par tranche et cumul', () => {
    assert.deepEqual([...bucketize([1, 2, 3, 4, 5], 2)], [3, 7, 5]);
    assert.deepEqual([...bucketize([1, 2], 0)], [1, 2]);
    assert.deepEqual([...cumulative([1, 0, 2], 10)], [11, 11, 13]);
});

test('étendue, série vide comprise', () => {
    assert.deepEqual(seriesExtent([3, -1, 7]), { min: -1, max: 7 });
    assert.deepEqual(seriesExtent([]), { min: 0, max: 0 });
});

test('repères d\'année et étiquettes sans chevauchement', () => {
    const start = day(2023, 12, 30);
    // 30/12/2023 → 02/01/2026 : 1ᵉʳ janvier 2024 (offset 2) et 2025.
    const span = spanDays(start, day(2026, 1, 2));
    const offsets = yearStartOffsets(start, span);
    assert.deepEqual(offsets, [2, 2 + 366, 2 + 366 + 365]);
    assert.deepEqual(yearStartOffsets(start, 0), []);
    // Piste étroite : seul le premier repère garde son étiquette.
    assert.deepEqual(yearLabelOffsets(offsets, span, 40), [2]);
    assert.deepEqual(yearLabelOffsets(offsets, span, 1000), offsets);
    // Un repère écarté ne bloque pas le suivant (mesure sur le retenu).
    assert.deepEqual(yearLabelOffsets([0, 30, 60], 100, 100, 46), [0, 60]);
});

test('jours affichés : nombre d\'entrées ≤ jour (saut incrémental)', () => {
    const days = [10, 12, 12, 20, 31];
    assert.equal(countDaysUpTo(days, 9), 0);
    assert.equal(countDaysUpTo(days, 10), 1);
    assert.equal(countDaysUpTo(days, 12), 3);
    assert.equal(countDaysUpTo(days, 19), 3);
    assert.equal(countDaysUpTo(days, 31), 5);
    assert.equal(countDaysUpTo(days, 1e9), 5);
    assert.equal(countDaysUpTo([], 5), 0);
    assert.equal(countDaysUpTo(days, NaN), 0);
});

test('extrêmes par colonne : les pics survivent au regroupement', () => {
    // Pic isolé au jour 5 : un échantillonnage un jour sur 4 le perdait.
    const values = [1, 1, 1, 1, 1, 9, 1, 1];
    const { lo, hi, first, last } = columnExtremes(values, 2);
    assert.deepEqual([...hi], [1, 9]);
    assert.deepEqual([...lo], [1, 1]);
    assert.deepEqual([...first], [1, 1]);
    assert.deepEqual([...last], [1, 1]);
    // Partage inégal : aucune colonne vide, tous les indices couverts.
    const uneven = columnExtremes([0, 1, 2, 3, 4, 5, 6], 3);
    assert.deepEqual([...uneven.first], [0, 2, 4]);
    assert.deepEqual([...uneven.last], [1, 3, 6]);
    // Plus de colonnes que de valeurs : une par valeur.
    assert.equal(columnExtremes([4, 2], 10).lo.length, 2);
    assert.equal(columnExtremes([], 10).lo.length, 0);
});
