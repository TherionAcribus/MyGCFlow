// Mesure des libellés mémoïsée (course de barres, labelsMaxWidth).
// Le dessin n'est pas testé au pixel près (canvas) : seule la logique pure du
// cache l'est, avec un faux contexte — largeur = 10 px par caractère, appels
// comptés.
import test from 'node:test';
import assert from 'node:assert/strict';

import { drawStatsPanel, gridValueFit, heatLevel, hitStatsPanel, labelsMaxWidth, measureStatsPanel } from './static/js/stats_render.mjs';
import { gridModel } from './static/js/stats_model.mjs';

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

// ---------------------------------------------------------------------------
// Échelle de couleur : heatLevel (logarithmique)
// ---------------------------------------------------------------------------

test('heatLevel : 0 sans compte, 1 au maximum, croissante', () => {
    assert.equal(heatLevel(0, 100), 0);
    assert.equal(heatLevel(5, 0), 0);
    assert.equal(heatLevel(100, 100), 1);
    assert.equal(heatLevel(150, 100), 1);   // compte courant au-delà de la référence
    let previous = 0;
    for (const n of [1, 2, 5, 10, 50, 100, 500, 2000]) {
        const level = heatLevel(n, 2000);
        assert.ok(level > previous, `${n} : ${level} <= ${previous}`);
        previous = level;
    }
});

test('heatLevel : une case énorme n\'écrase plus les autres', () => {
    // Linéaire, 1 et 10 sur 2 000 donnaient 0,0005 et 0,005 — même teinte.
    assert.ok(Math.abs(heatLevel(1, 2000) - Math.log(2) / Math.log(2001)) < 1e-12);
    assert.ok(heatLevel(10, 2000) - heatLevel(1, 2000) > 0.2);
    assert.ok(heatLevel(100, 2000) - heatLevel(10, 2000) > 0.2);
});

// Faux contexte qui relève la couleur de chaque fill() ; toute autre méthode
// est sans effet.
function recordingCtx() {
    const state = {};
    const fills = [];
    const own = {
        fills,
        measureText: (s) => ({ width: String(s).length * 6 }),
        fill() { fills.push(state.fillStyle); },
    };
    return new Proxy(own, {
        get(target, key) {
            if (key in target) return target[key];
            if (key in state) return state[key];
            return () => {};
        },
        set(_target, key, value) { state[key] = value; return true; },
    });
}

test('grille en intensité : cases 1, 10, 100 et 2 000 de teintes distinctes', () => {
    // D1/T1 = 2 000, D1/T1,5 = 10, D1/T2 = 1, D1/T2,5 = 100.
    const acc = { counts: new Map([['dt', new Map([[0, 2000], [1, 10], [2, 1], [3, 100]])]]), excluded: new Map() };
    const labels = Array.from({ length: 9 }, (_, i) => String(1 + i / 2));
    const view = {
        kind: 'grid', metric: 'dt', title: '', footer: [], model: gridModel('dt', acc, acc),
        cellMode: 'heat', rowLabels: labels, colLabels: labels, corner: '', fontFamily: 'x',
        formatNumber: String, formatCompact: String, highlight: null,
    };
    const style = { font_size: 12, background: '#000000', background_opacity: 85,
        text_color: '#ffffff', accent_color: '#29d34e', radius: 8 };
    const ctx = recordingCtx();
    drawStatsPanel(ctx, { x: 0, y: 0, width: 280, height: 320 }, view, style, Number.NaN, 280);
    // Remplissages à la couleur principale, dans l'ordre des cases (ligne D1).
    const alphas = ctx.fills
        .map((fill) => /^rgba\(41,\s*211,\s*78,\s*([\d.]+)\)$/.exec(String(fill))?.[1])
        .filter(Boolean)
        .map(Number);
    assert.equal(alphas.length, 4);
    const [a2000, a10, a1, a100] = alphas;
    assert.equal(a2000, 1);
    assert.ok(a2000 > a100 && a100 > a10 && a10 > a1);
    // Écarts visibles (linéaire : 0,003 entre 1 et 10).
    assert.ok(a10 - a1 > 0.1, `${a1} / ${a10}`);
    assert.ok(a100 - a10 > 0.1, `${a10} / ${a100}`);
});

// ---------------------------------------------------------------------------
// Infobulle de survol : hitStatsPanel(view, style, w, h, x, y)
// Les vues minimales ci-dessous suivent la même géométrie que les tests de
// mesure (style 12 → pad 10) ; les zones sont celles du dessin.
// ---------------------------------------------------------------------------

const hitStyle = { font_size: 12 };

// Grille 9 × 9 (métrique dt : libellés de ligne 2,4 em ≈ 29 px) :
// left = 39, haut des cases = 28, case = 231/9 ≈ 25,7.
function hitGridView() {
    const cells = [];
    for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) cells.push({ key: r * 9 + c, count: r + c, disabled: false });
    }
    return { kind: 'grid', metric: 'dt', title: '', footer: [],
        model: { rows: 9, cols: 9, cells } };
}

test('hit grille : la case sous le pointeur, null hors de la zone', () => {
    const view = hitGridView();
    const cell = 231 / 9;
    const at = (r, c) => hitStatsPanel(view, hitStyle, 280, null, 39 + (c + 0.5) * cell, 28 + (r + 0.5) * cell);
    assert.deepEqual(at(2, 3), { r: 2, c: 3, cell: view.model.cells[21] });
    assert.deepEqual(at(8, 8), { r: 8, c: 8, cell: view.model.cells[80] });
    // Libellés de ligne et de colonnes, marges, dessous de la grille : rien.
    assert.equal(hitStatsPanel(view, hitStyle, 280, null, 20, 28 + 4 * cell), null);
    assert.equal(hitStatsPanel(view, hitStyle, 280, null, 39 + 4 * cell, 15), null);
    assert.equal(hitStatsPanel(view, hitStyle, 280, null, 39 + 4 * cell, 262), null);
    // Case désactivée : pas d'infobulle.
    view.model.cells[40].disabled = true;
    assert.equal(at(4, 4), null);
});

const hitBarView = {
    kind: 'bar', title: 'Types', footer: [], orientation: 'horizontal',
    model: { max: 3, rows: [
        { key: 'a', keys: ['a'], count: 3 },
        { key: 'b', keys: ['b'], count: 1 },
    ] },
};

test('hit histogramme : la ligne sous le pointeur, rangs fractionnaires inclus', () => {
    // Titre → top 31 ; 2 lignes → chartH 42, bande de 21 px.
    const hit = (y) => hitStatsPanel(hitBarView, hitStyle, 280, null, 140, y);
    assert.equal(hit(40).row.key, 'a');
    assert.equal(hit(60).row.key, 'b');
    assert.equal(hit(80), null);   // sous la zone (pied / marge)
    // Course : la ligne a glissé (slot 0,5 → bande [0,5 ; 1,5)).
    const sliding = { ...hitBarView, model: { ...hitBarView.model,
        rows: [hitBarView.model.rows[0], { ...hitBarView.model.rows[1], slot: 0.5 }] } };
    assert.equal(hitStatsPanel(sliding, hitStyle, 280, null, 140, 40).row.key, 'a');
    assert.equal(hitStatsPanel(sliding, hitStyle, 280, null, 140, 60).row.key, 'b');
});

test('hit histogramme vertical : la colonne sous le pointeur', () => {
    const view = { ...hitBarView, orientation: 'vertical' };
    // Deux colonnes de 130 px ; chartH 166 depuis top 31 → y = 100 dedans.
    assert.equal(hitStatsPanel(view, hitStyle, 280, null, 75, 100).row.key, 'a');
    assert.equal(hitStatsPanel(view, hitStyle, 280, null, 205, 100).row.key, 'b');
    assert.equal(hitStatsPanel(view, hitStyle, 280, null, 205, 250), null);
});

const hitDonutRows = [
    { key: 'a', keys: ['a'], count: 1 },
    { key: 'b', keys: ['b'], count: 1 },
    { key: 'c', keys: ['c'], count: 2 },
];

test('hit anneau : la part sous le pointeur, jamais le trou ni l\'extérieur', () => {
    // Sans légende : diamètre 260, centre (140, 140), outer 126, trou 60 %.
    const view = { kind: 'donut', title: '', footer: [], hole: 60, showLegend: false,
        model: { rows: hitDonutRows } };
    const hit = (x, y) => hitStatsPanel(view, hitStyle, 280, null, x, y);
    // Parts depuis midi, sens horaire : a (1/4), b (1/4), c (1/2).
    assert.equal(hit(140, 40).row.key, 'a');    // midi
    assert.equal(hit(240, 140).row.key, 'b');   // 3 h
    assert.equal(hit(40, 140).row.key, 'c');    // 9 h
    assert.equal(hit(140, 140), null);          // le trou
    assert.equal(hit(140, 5), null);            // hors de l'anneau
});

test('hit anneau : la ligne de légende vise sa part', () => {
    const view = { kind: 'donut', title: '', footer: [], hole: 60, showLegend: true,
        model: { rows: hitDonutRows } };
    // Légende : diamètre 120 → x > 130 ; bandes de 19 px depuis 41,5.
    const hit = (y) => hitStatsPanel(view, hitStyle, 280, null, 200, y);
    assert.equal(hit(45).row.key, 'a');
    assert.equal(hit(70).row.key, 'b');
    assert.equal(hit(95).row.key, 'c');
    assert.equal(hit(110), null);
});

const hitLineView = {
    kind: 'line', title: '', footer: [],
    model: { first: 0, last: 9, max: 5, total: 5, headDay: 9, empty: false,
        points: [{ day: 2, total: 2 }, { day: 5, total: 5 }] },
};

test('hit courbe : le jour sous le pointeur porte le total de l\'escalier', () => {
    // Axe [10 ; 270] pour les jours 0..9 ; zone [10 ; 127] en hauteur.
    const hit = (x) => hitStatsPanel(hitLineView, hitStyle, 280, null, x, 60);
    assert.deepEqual(hit(10), { day: 0, total: 0 });            // avant la 1ʳᵉ trouvaille
    assert.deepEqual(hit(10 + (2 / 9) * 260), { day: 2, total: 2 });
    // Jour sans sommet entre deux trouvailles : total du dernier sommet.
    assert.deepEqual(hit(10 + (4 / 9) * 260), { day: 4, total: 2 });
    assert.deepEqual(hit(270), { day: 9, total: 5 });
    // Zone vide ou hors cadre : rien.
    assert.equal(hitStatsPanel(hitLineView, hitStyle, 280, null, 140, 200), null);
    assert.equal(hitStatsPanel(hitLineView, hitStyle, 280, null, 275, 60), null);
    // Courbe vide : rien, même dans la zone.
    const empty = { ...hitLineView, model: { ...hitLineView.model, empty: true } };
    assert.equal(hitStatsPanel(empty, hitStyle, 280, null, 140, 60), null);
});

test('hit compteurs : la tuile sous le pointeur, jamais l\'interstice', () => {
    const tiles = [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }];
    const view = { kind: 'counter', title: '', footer: [], columns: 2, tiles };
    // 2 × 2 : tuiles de 127 × 53, interstices de 6 px depuis (10, 10).
    const hit = (x, y) => hitStatsPanel(view, hitStyle, 280, null, x, y);
    assert.equal(hit(70, 30).tile, tiles[0]);
    assert.equal(hit(200, 30).tile, tiles[1]);
    assert.equal(hit(70, 90).tile, tiles[2]);
    assert.equal(hit(140, 30), null);   // interstice vertical
    assert.equal(hit(70, 66), null);    // interstice horizontal
    assert.equal(hitStatsPanel(view, hitStyle, 280, null, 70, 200), null);
});
