// Mesure des libellés mémoïsée (course de barres, labelsMaxWidth).
// Le dessin n'est pas testé au pixel près (canvas) : seule la logique pure du
// cache l'est, avec un faux contexte — largeur = 10 px par caractère, appels
// comptés.
import test from 'node:test';
import assert from 'node:assert/strict';

import { gridValueFit, labelsMaxWidth, measureStatsPanel } from './static/js/stats_render.mjs';

function fakeCtx() {
    return {
        font: '',
        calls: 0,
        measureText(s) { this.calls += 1; return { width: String(s).length * 10 }; },
    };
}

test('labelsMaxWidth : le pool complet dépasse les seuls libellés affichés', () => {
    const ctx = fakeCtx();
    const allLabels = ['Court', 'Un nom de catégorie très long', 'Moyen'];
    const shown = ['Court', 'Moyen'];
    const width = labelsMaxWidth(ctx, allLabels, 'sig');
    assert.equal(width, 'Un nom de catégorie très long'.length * 10);
    assert.ok(width > Math.max(...shown.map((l) => ctx.measureText(l).width)));
});

test('labelsMaxWidth : mémoïsée par tableau, remesurée par signature de police', () => {
    const ctx = fakeCtx();
    const allLabels = ['aa', 'bbbbb'];
    assert.equal(labelsMaxWidth(ctx, allLabels, 'f1'), 50);
    const calls = ctx.calls;
    // Même tableau + même signature : aucun measureText supplémentaire.
    assert.equal(labelsMaxWidth(ctx, allLabels, 'f1'), 50);
    assert.equal(ctx.calls, calls);
    // Autre signature de police → remesurée.
    assert.equal(labelsMaxWidth(ctx, allLabels, 'f2'), 50);
    assert.equal(ctx.calls, calls + 2);
    // Un autre tableau, même contenu : cache distinct (clé = identité).
    assert.equal(labelsMaxWidth(ctx, ['aa', 'bbbbb'], 'f1'), 50);
    assert.equal(ctx.calls, calls + 4);
});

// ---------------------------------------------------------------------------
// Hauteur imposée (position.height) : measureStatsPanel(view, style, w, h)
// ---------------------------------------------------------------------------

// Vues minimales : seuls les champs lus par les layouts sont nécessaires.
const style = { font_size: 12 };
// font_size 12 → pad 10, titre (si présent) 21, pied vide.
const barView = {
    kind: 'bar', title: 'Types', footer: [], orientation: 'horizontal',
    model: { slots: 4, rows: [], max: 1 },
};
const gridView = { kind: 'grid', metric: 'dt', title: '', footer: [], model: { cols: 9, rows: 9 } };
const lineView = { kind: 'line', title: '', footer: [], model: {} };
const counterView = { kind: 'counter', title: '', footer: [], columns: 2, tiles: [{}, {}, {}, {}] };
const donutView = { kind: 'donut', title: '', footer: [], showLegend: true, model: { rows: [{}, {}, {}] } };

test('mesure : l\'histogramme horizontal suit la hauteur imposée jusqu\'au plancher', () => {
    // Chrome : pad 10 + titre 21 en haut, pad 10 en bas (pas de pied) → 41.
    // Naturel : 4 lignes × round(12 × 1,75) = 84.
    assert.equal(measureStatsPanel(barView, style, 280), 41 + 84);
    // Étirement : la hauteur totale rejoint la cible, les lignes s'épaississent.
    assert.equal(measureStatsPanel(barView, style, 280, 400), 400);
    // Compression sous la naturelle : jusqu'au plancher (4 × 12 × 1,3 = 62,4).
    assert.equal(measureStatsPanel(barView, style, 280, 100), Math.ceil(41 + 62.4));
    // Sous le plancher : jamais en dessous.
    assert.equal(measureStatsPanel(barView, style, 280, 60), Math.ceil(41 + 62.4));
});

test('mesure : les grilles ignorent la hauteur imposée (cases carrées)', () => {
    const natural = measureStatsPanel(gridView, style, 280);
    assert.ok(natural > 0);
    assert.equal(measureStatsPanel(gridView, style, 280, 900), natural);
    assert.equal(measureStatsPanel(gridView, style, 280, 60), natural);
});

test('mesure : la courbe suit la hauteur imposée jusqu\'au plancher', () => {
    // Naturel : pad 10, plot = max(72, 260 × 0,38 ≈ 99) = 99, axe 18.
    assert.equal(measureStatsPanel(lineView, style, 280), 10 + 99 + 18 + 10);
    assert.equal(measureStatsPanel(lineView, style, 280, 400), 400);
    // Plancher : 12 × 3,5 = 42 de zone de tracé.
    assert.equal(measureStatsPanel(lineView, style, 280, 60), 10 + 42 + 18 + 10);
});

test('mesure : les compteurs répartissent la hauteur imposée dans les tuiles', () => {
    // Naturel : pad 10 × 2 ; 2×2 tuiles de round(12 × 4,4) = 53 + gap 6 → 112.
    assert.equal(measureStatsPanel(counterView, style, 280), 10 + 112 + 10);
    assert.equal(measureStatsPanel(counterView, style, 280, 400), 400);
    // Plancher : 2 tuiles de 12 × 3,4 = 40,8 + gap 6 → 87,6 de zone.
    assert.equal(measureStatsPanel(counterView, style, 280, 60), Math.ceil(10 + 87.6 + 10));
});

test('mesure : l\'anneau s\'étire au-delà de son plafond quand la largeur le permet', () => {
    // 600 px de large, légende : innerW 580 → diamètre plafonné à 220
    // (la largeur offrirait 580 × 0,46 ≈ 267).
    const natural = measureStatsPanel(donutView, style, 600);
    assert.equal(natural, 10 + 220 + 10);
    // Hauteur imposée : le plafond saute, le diamètre suit la largeur (267).
    assert.equal(measureStatsPanel(donutView, style, 600, 500), 10 + 267 + 10);
    // Sous la naturelle : pas de compression — la taille naturelle est le
    // plancher de l'anneau (légende plus haute : elle commanderait pareil).
    assert.equal(measureStatsPanel(donutView, style, 600, 100), natural);
});

// ---------------------------------------------------------------------------
// Nombres des cases de grille : gridValueFit
// ---------------------------------------------------------------------------

// Faux contexte proportionnel : largeur = caractères × 0,6 × taille de police
// (lue dans ctx.font), comme une police réelle à chiffres de largeur fixe.
function sizedCtx() {
    return {
        font: '',
        measureText(s) {
            const size = Number(/([\d.]+)px/.exec(this.font)?.[1] || 10);
            return { width: String(s).length * 0.6 * size };
        },
    };
}
const full = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const short = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
// Matrice D/T de 280 px, police 12 : case ≈ 25,7 px, intérieur ≈ 24,2.
const dtCell = { cell: 25.7, inner: 24.2, fontSize: 12, family: 'x' };

// Le texte choisi tient dans la case, marge comprise (86 % de l'intérieur).
function assertFits(fit, cell, max) {
    const ctx = sizedCtx();
    ctx.font = `600 ${fit.size}px x`;
    const width = Math.max(ctx.measureText(fit.format(max)).width,
        ctx.measureText(fit.format(10 ** String(max).length - 1)).width);
    assert.ok(width <= cell.inner * 0.86 + 1e-9, `${fit.format(max)} : ${width} > ${cell.inner * 0.86}`);
    assert.ok(fit.size >= 7);
}

test('grille : un petit maximum garde le format complet à la taille de base', () => {
    const fit = gridValueFit(sizedCtx(), dtCell, 99, [full, short]);
    assert.equal(fit.format, full);
    assert.equal(fit.size, 12 * 0.85);
});

test('grille : 4 chiffres rétrécissent pour tenir, sans passer sous le seuil', () => {
    // « 1 234 » à 10,2 px = 30,6 px > 20,8 : il faudrait 6,9 px, sous le
    // seuil — « 1k » (taille de base) est retenu.
    const fit = gridValueFit(sizedCtx(), dtCell, 1234, [full, short]);
    assert.equal(fit.format, short);
    assertFits(fit, dtCell, 1234);
    // Sans format court, rien ne tient : pas de nombres plutôt qu'un débordement.
    assert.equal(gridValueFit(sizedCtx(), dtCell, 1234, [full]), null);
    // Case un peu plus large : le complet, rétréci d'un quart au plus, tient.
    const wider = { cell: 30, inner: 28.5, fontSize: 12, family: 'x' };
    const only = gridValueFit(sizedCtx(), wider, 1234, [full]);
    assert.equal(only.format, full);
    assert.ok(only.size < 12 * 0.85);
    assertFits(only, wider, 1234);
});

test('grille : 3 chiffres sur une case large restent complets', () => {
    const wide = { cell: 40, inner: 38, fontSize: 12, family: 'x' };
    const fit = gridValueFit(sizedCtx(), wide, 999, [full, short]);
    assert.equal(fit.format, full);
    assertFits(fit, wide, 999);
});

test('grille : 5 chiffres trop larges passent au format court', () => {
    const fit = gridValueFit(sizedCtx(), dtCell, 12345, [full, short]);
    assert.equal(fit.format, short);
    assertFits(fit, dtCell, 12345);
});

test('grille : cases trop petites pour un nombre lisible → pas de nombres', () => {
    // Calendrier 366 : case ≈ 12 px, base = 6 px < 7.
    assert.equal(gridValueFit(sizedCtx(), { cell: 12, inner: 11, fontSize: 12, family: 'x' }, 5, [full, short]), null);
    // Case moyenne, nombre immense même en court : rien ne tient au-dessus de 7 px.
    assert.equal(gridValueFit(sizedCtx(), { cell: 16, inner: 15, fontSize: 12, family: 'x' }, 123456789,
        [full, (n) => `${Math.round(n / 1e6)}M`]), null);
});
