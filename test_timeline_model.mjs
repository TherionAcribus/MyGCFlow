import test from 'node:test';
import assert from 'node:assert/strict';

import {
    bucketDaysFor,
    bucketize,
    clampOffset,
    cumulative,
    cursorFraction,
    dateOfOffset,
    dayOffsetOf,
    normalizeTimelineStyle,
    offsetAtFraction,
    offsetForKey,
    seriesExtent,
    spanDays,
    yearStartOffsets,
} from './static/js/timeline_model.mjs';

// Petit raccourci pour des dates calendaires lisibles dans les tests.
const d = (y, m, j) => new Date(y, m - 1, j);

test('normalizeTimelineStyle : styles valides inchangés, le reste en histogram', () => {
    assert.equal(normalizeTimelineStyle('simple'), 'simple');
    assert.equal(normalizeTimelineStyle('histogram'), 'histogram');
    assert.equal(normalizeTimelineStyle('curve'), 'curve');
    // Inconnue, casse différente, undefined, null : repli sur le défaut.
    assert.equal(normalizeTimelineStyle('inconnu'), 'histogram');
    assert.equal(normalizeTimelineStyle('HISTOGRAM'), 'histogram');
    assert.equal(normalizeTimelineStyle(undefined), 'histogram');
    assert.equal(normalizeTimelineStyle(null), 'histogram');
});

test('spanDays : même jour 1, plage N, bornes incohérentes ou invalides 0', () => {
    assert.equal(spanDays(d(2024, 3, 10), d(2024, 3, 10)), 1);
    assert.equal(spanDays(d(2024, 1, 1), d(2024, 12, 31)), 366); // bissextile
    assert.equal(spanDays(d(2023, 1, 1), d(2023, 12, 31)), 365);
    // Fin avant le début, ou date invalide : plage nulle.
    assert.equal(spanDays(d(2024, 3, 10), d(2024, 3, 5)), 0);
    assert.equal(spanDays(new Date('pas une date'), d(2024, 3, 5)), 0);
    assert.equal(spanDays(d(2024, 3, 5), null), 0);
});

test('dayOffsetOf / dateOfOffset : aller-retour, changement d\'année compris', () => {
    const start = d(2024, 12, 15);
    assert.equal(dayOffsetOf(start, start), 0);
    // +20 jours depuis le 15 décembre 2024 : le 4 janvier 2025.
    const target = dateOfOffset(start, 20);
    assert.deepEqual([target.getFullYear(), target.getMonth(), target.getDate()], [2025, 0, 4]);
    assert.equal(dayOffsetOf(target, start), 20);
    // Aller-retour depuis une date quelconque.
    const back = dateOfOffset(start, dayOffsetOf(d(2025, 6, 30), start));
    assert.deepEqual([back.getFullYear(), back.getMonth(), back.getDate()], [2025, 5, 30]);
    // Avant le début : décalage négatif, symétrique.
    assert.equal(dayOffsetOf(d(2024, 12, 10), start), -5);
});

test('clampOffset : bornes, non fini, plage vide, arrondi', () => {
    assert.equal(clampOffset(-3, 10), 0);
    assert.equal(clampOffset(12, 10), 9);
    assert.equal(clampOffset(NaN, 10), 0);
    assert.equal(clampOffset(Infinity, 10), 0);
    assert.equal(clampOffset(5, 0), 0);
    assert.equal(clampOffset(5, -4), 0);
    assert.equal(clampOffset(2.6, 10), 3);
    assert.equal(clampOffset(2.4, 10), 2);
});

test('cursorFraction / offsetAtFraction : bornes et position du curseur', () => {
    const span = 10;
    assert.equal(cursorFraction(0, span), 0.1);
    assert.equal(cursorFraction(9, span), 1);
    // Le curseur du jour k est au BORD DROIT de sa case (k+1)/span : la
    // fraction retombe sur la borne gauche du jour k+1, donc sur k+1 à la
    // lecture — bridée à span-1 pour le dernier jour.
    for (const k of [0, 4, 9]) {
        assert.equal(offsetAtFraction(cursorFraction(k, span), span), Math.min(k + 1, span - 1));
    }
    assert.equal(offsetAtFraction(0, span), 0);
    assert.equal(offsetAtFraction(1, span), span - 1);
    // Hors bornes : bridé comme un clic hors piste.
    assert.equal(offsetAtFraction(-0.5, span), 0);
    assert.equal(offsetAtFraction(2, span), span - 1);
    // Plage vide.
    assert.equal(offsetAtFraction(0.5, 0), 0);
    assert.equal(offsetAtFraction(0.5, -3), 0);
    assert.equal(cursorFraction(4, 0), 0);
});

test('offsetForKey : flèches, Maj+flèches, Début/Fin, touche inconnue, plage vide', () => {
    const start = d(2024, 1, 1);
    const span = 366;
    assert.equal(offsetForKey('ArrowLeft', {}, 10, start, span), 9);
    assert.equal(offsetForKey('ArrowRight', {}, 10, start, span), 11);
    // ↑/↓ suivent ←/→ (pattern ARIA slider).
    assert.equal(offsetForKey('ArrowDown', {}, 10, start, span), 9);
    assert.equal(offsetForKey('ArrowUp', {}, 10, start, span), 11);
    // Maj : une semaine.
    assert.equal(offsetForKey('ArrowLeft', { shift: true }, 10, start, span), 3);
    assert.equal(offsetForKey('ArrowRight', { shift: true }, 10, start, span), 17);
    // Bridage aux bornes de la plage.
    assert.equal(offsetForKey('ArrowLeft', {}, 0, start, span), 0);
    assert.equal(offsetForKey('ArrowLeft', { shift: true }, 3, start, span), 0);
    assert.equal(offsetForKey('ArrowRight', { shift: true }, span - 1, start, span), span - 1);
    // Début / Fin.
    assert.equal(offsetForKey('Home', {}, 100, start, span), 0);
    assert.equal(offsetForKey('End', {}, 0, start, span), span - 1);
    // Touche sans effet sur le curseur.
    assert.equal(offsetForKey('a', {}, 10, start, span), null);
    assert.equal(offsetForKey(' ', {}, 10, start, span), null);
    // Plage vide : toujours null.
    assert.equal(offsetForKey('ArrowLeft', {}, 10, start, 0), null);
    assert.equal(offsetForKey('Home', {}, 10, start, -5), null);
});

test('offsetForKey : PageUp/PageDown changent de mois en gardant le quantième', () => {
    const start = d(2024, 1, 1); // année bissextile
    const span = 366;
    // PageUp = mois suivant : 15 janvier (offset 14) -> 15 février (31+14).
    assert.equal(offsetForKey('PageUp', {}, 14, start, span), 45);
    // PageDown = mois précédent : 15 mars (31+29+14) -> 15 février -> 15 janvier.
    assert.equal(offsetForKey('PageDown', {}, 74, start, span), 45);
    assert.equal(offsetForKey('PageDown', {}, 45, start, span), 14);
});

test('offsetForKey : PageUp au 31 janvier s\'arrête au dernier jour de février', () => {
    // Bissextile : 31 janvier 2024 (offset 30) -> 29 février (offset 31+28).
    assert.equal(offsetForKey('PageUp', {}, 30, d(2024, 1, 1), 366), 59);
    // Commune : 31 janvier 2023 -> 28 février (offset 31+27).
    assert.equal(offsetForKey('PageUp', {}, 30, d(2023, 1, 1), 365), 58);
    // Symétrique : 31 mars 2023 (offset 31+28+30) -> 28 février.
    assert.equal(offsetForKey('PageDown', {}, 89, d(2023, 1, 1), 365), 58);
    // Le mois visé hors de la plage : bridé à la borne.
    assert.equal(offsetForKey('PageUp', {}, 30, d(2023, 1, 1), 40), 39);
    assert.equal(offsetForKey('PageDown', {}, 0, d(2023, 1, 1), 365), 0);
});

test('bucketDaysFor : première tranche qui laisse de la place, repli sinon', () => {
    // 6 jours dans 600 px : 1 jour/barre (6 barres × 3 px = 18 ≤ 600).
    assert.equal(bucketDaysFor(6, 600), 1);
    // 90 jours dans 200 px : 1 jour -> 270 px > 200, 2 jours -> 135 px ≤ 200.
    assert.equal(bucketDaysFor(90, 200), 2);
    // 365 jours dans 100 px : jusqu'à 14 jours (27 barres × 3 px = 81 ≤ 100).
    assert.equal(bucketDaysFor(365, 100), 14);
    // Seuil paramétrable : avec 5 px par barre, la même plage passe à 30 jours.
    assert.equal(bucketDaysFor(365, 100, 5), 30);
    // Aucune tranche ne convient : repli calculé (10 000 × 3 / 10).
    assert.equal(bucketDaysFor(10000, 10), 3000);
    // Largeur nulle ramenée à 1 px : même repli (6 × 3 / 1).
    assert.equal(bucketDaysFor(6, 0), 18);
});

test('bucketize : sommes par tranche, dernière tranche partielle', () => {
    const perDay = Float64Array.from([1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...bucketize(perDay, 3)], [6, 15, 7]);
    assert.deepEqual([...bucketize(perDay, 1)], [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...bucketize(perDay, 100)], [28]);
    // Tableau simple accepté ; tranche non finie ramenée à 1.
    assert.deepEqual([...bucketize([1, 2, 3], NaN)], [1, 2, 3]);
});

test('cumulative : cumul avec et sans base', () => {
    assert.deepEqual([...cumulative([1, 2, 3])], [1, 3, 6]);
    assert.deepEqual([...cumulative([1, 2, 3], 10)], [11, 13, 16]);
    assert.deepEqual([...cumulative([])], []);
    assert.ok(cumulative([1, 2]) instanceof Float64Array);
});

test('seriesExtent : min/max, vide, négatifs', () => {
    assert.deepEqual(seriesExtent([3, -1, 7, 2]), { min: -1, max: 7 });
    assert.deepEqual(seriesExtent([]), { min: 0, max: 0 });
    assert.deepEqual(seriesExtent([-5, -2]), { min: -5, max: -2 });
});

test('yearStartOffsets : 1ᵉʳ janvier strictement après le début, dans la plage', () => {
    const start = d(2023, 6, 15);
    const jan = (y) => dayOffsetOf(d(y, 1, 1), start);
    // Plage de 600 jours : 1ᵉʳ janv. 2024 et 2025 ; 2026 est hors plage.
    assert.deepEqual(yearStartOffsets(start, 600), [jan(2024), jan(2025)]);
    // Début un 1ᵉʳ janvier : il n'est pas repris (strictement après).
    assert.deepEqual(yearStartOffsets(d(2023, 1, 1), 400), [365]);
    // Début un 31 décembre : le lendemain compte déjà (offset 1).
    assert.deepEqual(yearStartOffsets(d(2023, 12, 31), 10), [1]);
    // Plage intra-année : aucun repère.
    assert.deepEqual(yearStartOffsets(start, 100), []);
    // Plage vide : rien.
    assert.deepEqual(yearStartOffsets(start, 0), []);
    assert.deepEqual(yearStartOffsets(start, -3), []);
});
