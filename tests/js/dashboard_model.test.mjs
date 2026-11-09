// Tableaux de bord de la page Statistiques (static/js/dashboard_model.mjs)
// et libellés (static/js/chart_labels.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DASHBOARDS_VERSION,
    DEFAULT_QUESTIONS,
    MAX_ITEMS,
    QUESTIONS,
    defaultDocument,
    effectiveQueryOptions,
    hasOwnPeriod,
    itemFromQuestion,
    normalizeDashboard,
    normalizeDocument,
    normalizeItem,
    QUESTION_GROUPS,
    chartPeriodChoices,
    comparePeriodChoices,
    periodChoices,
    periodOfValue,
    periodValue,
} from '../../static/js/dashboard_model.mjs';
import { CHART_SPEC_VERSION, allowedCharts } from '../../static/js/chart_spec.mjs';
import { GROUP_CHOICES, MEASURE_CHOICES, makeLabels, measureKey, measureOfKey } from '../../static/js/chart_labels.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

let counter = 0;
const seqId = () => `abc${String(counter++).padStart(4, '0')}`;
const day = (y, m, d) => dayNumber({ y, m, d });

test('document par défaut : un tableau, les questions de départ, titres posés', () => {
    const doc = defaultDocument({ newId: seqId, name: 'Mon tableau', titleOf: (id) => `Q ${id}` });
    assert.equal(doc.v, DASHBOARDS_VERSION);
    assert.equal(doc.dashboards.length, 1);
    assert.equal(doc.active, doc.dashboards[0].id);
    const dashboard = doc.dashboards[0];
    assert.equal(dashboard.name, 'Mon tableau');
    assert.deepEqual(dashboard.period, { kind: 'all' });
    assert.deepEqual(dashboard.items.map((item) => item.spec.title), DEFAULT_QUESTIONS.map((id) => `Q ${id}`));
    // Le document par défaut est déjà normalisé.
    assert.deepEqual(normalizeDocument(JSON.parse(JSON.stringify(doc))), doc);
});

test('chaque question donne un graphique valide, dessinable au lot 1', () => {
    const ids = new Set();
    for (const question of QUESTIONS) {
        assert.ok(!ids.has(question.id), question.id);
        ids.add(question.id);
        const item = itemFromQuestion(question.id, { newId: seqId, dataset: 7 });
        assert.equal(item.size, question.size);
        assert.equal(item.spec.v, CHART_SPEC_VERSION);
        assert.ok(allowedCharts(item.spec).includes(item.spec.view.chart), question.id);
        assert.ok(['bar', 'line', 'area', 'donut', 'number', 'heatmap', 'challenge'].includes(item.spec.view.chart), question.id);
        // La question garde sa source (et son jeu, pour Évolution).
        assert.equal(item.spec.source, (question.spec.source || 'finds').replace('evolution:1', 'evolution:7'), question.id);
        assert.match(question.icon, /^ti-[a-z0-9-]+$/);
    }
    assert.equal(itemFromQuestion('bogus'), null);
    for (const id of DEFAULT_QUESTIONS) assert.ok(ids.has(id), id);
    for (const question of QUESTIONS) assert.ok(QUESTION_GROUPS.includes(question.group), question.id);
});

test('questions de comparaison : périodes relatives gardées telles quelles', () => {
    const ahead = itemFromQuestion('ahead', { newId: seqId }).spec;
    assert.deepEqual(ahead.periods, [{ kind: 'current', unit: 'year' }, { kind: 'previous' }]);
    assert.equal(ahead.compare.toDate, false);
    const delta = itemFromQuestion('year_delta', { newId: seqId }).spec;
    assert.equal(delta.compare.layout, 'delta');
    // Le mois en cours contre le même nombre de jours l'an dernier.
    assert.equal(delta.compare.toDate, true);
    assert.equal(itemFromQuestion('types_vs_last', { newId: seqId }).spec.compare.layout, 'side');
    assert.deepEqual(itemFromQuestion('all_years', { newId: seqId }).spec.periods, [{ kind: 'each', unit: 'year' }]);
});

test('période du tableau de bord comparée : remplacée au calcul, pas de pastille', () => {
    const spec = { periods: [{ kind: 'dashboard' }, { kind: 'previous' }], filters: null };
    const dashboard = { period: { kind: 'year', year: 2024 }, filters: {} };
    assert.deepEqual(effectiveQueryOptions(spec, dashboard).periods, [{ kind: 'year', year: 2024 }, { kind: 'previous' }]);
    assert.equal(hasOwnPeriod(spec), false);
    assert.equal(hasOwnPeriod({ periods: [{ kind: 'year', year: 2024 }, { kind: 'previous' }] }), true);
});

test('élément : taille inconnue → M, description future écartée', () => {
    assert.equal(normalizeItem({ size: 'XXL', spec: {} }, seqId).size, 'M');
    assert.equal(normalizeItem({ size: 'S', spec: { v: CHART_SPEC_VERSION + 1 } }), null);
    assert.equal(normalizeItem('x'), null);
});

test('tableau : nom aplati, période par défaut, identifiants de graphiques uniques, plafond', () => {
    const items = Array.from({ length: MAX_ITEMS + 3 }, () => ({ spec: { id: 'deadbeef' } }));
    const dashboard = normalizeDashboard({ id: 'bad id', name: '  Mes\nstats ', period: { kind: 'week' }, items },
        { newId: seqId, defaultName: 'Défaut' });
    assert.match(dashboard.id, /^abc/);
    assert.equal(dashboard.name, 'Mes stats');
    assert.deepEqual(dashboard.period, { kind: 'all' });
    assert.deepEqual(dashboard.filters, {});
    assert.equal(dashboard.items.length, MAX_ITEMS);
    assert.equal(new Set(dashboard.items.map((item) => item.spec.id)).size, MAX_ITEMS);
    assert.equal(normalizeDashboard({ name: '' }, { newId: seqId, defaultName: 'Défaut' }).name, 'Défaut');
});

test('document : version inconnue ou vide → null, tableau actif retrouvé ou le premier', () => {
    assert.equal(normalizeDocument(null), null);
    assert.equal(normalizeDocument({ v: 2, dashboards: [{}] }), null);
    assert.equal(normalizeDocument({ v: 1, dashboards: [] }), null);
    const doc = normalizeDocument({ v: 1, active: 'nope', dashboards: [{ id: 'aaaaaa' }, { id: 'bbbbbb' }] });
    assert.equal(doc.active, 'aaaaaa');
    const dup = normalizeDocument({ v: 1, active: 'bbbbbb', dashboards: [{ id: 'bbbbbb' }, { id: 'bbbbbb' }] }, { newId: seqId });
    assert.equal(dup.active, 'bbbbbb');
    assert.notEqual(dup.dashboards[1].id, 'bbbbbb');
});

test('héritage : périodes et filtres du graphique, sinon du tableau de bord', () => {
    const dashboard = { period: { kind: 'year', year: 2024 }, filters: { country: ['France'] } };
    const inherited = itemFromQuestion('months', { newId: seqId }).spec;
    assert.equal(hasOwnPeriod(inherited), false);
    assert.deepEqual(effectiveQueryOptions(inherited, dashboard), {
        periods: [{ kind: 'year', year: 2024 }],
        filters: { country: ['France'] },
    });
    const own = itemFromQuestion('by_year', { newId: seqId }).spec;
    assert.equal(hasOwnPeriod(own), true);
    assert.deepEqual(effectiveQueryOptions(own, dashboard).periods, [{ kind: 'all' }]);
    assert.deepEqual(effectiveQueryOptions(inherited, null), { periods: [{ kind: 'all' }], filters: {} });
});

test('périodes proposées : tout, 12 mois, année et mois en cours, puis les années passées', () => {
    const choices = periodChoices({ first: day(2021, 5, 1), last: day(2026, 1, 6) }, day(2026, 11, 8));
    assert.deepEqual(choices, [
        { kind: 'all' },
        { kind: 'rolling', unit: 'month', count: 12 },
        { kind: 'current', unit: 'year' },
        { kind: 'current', unit: 'month' },
        { kind: 'year', year: 2025 },
        { kind: 'year', year: 2024 },
        { kind: 'year', year: 2023 },
        { kind: 'year', year: 2022 },
        { kind: 'year', year: 2021 },
    ]);
    assert.equal(periodChoices(null, day(2026, 11, 8)).length, 4);
    const chart = chartPeriodChoices(null, day(2026, 11, 8));
    assert.deepEqual(chart.slice(-2), [{ kind: 'each', unit: 'year' }, { kind: 'each', unit: 'month' }]);
    assert.deepEqual(comparePeriodChoices(null, day(2026, 11, 8))[0], { kind: 'previous' });
    for (const period of choices) assert.deepEqual(periodOfValue(periodValue(period)), period);
    assert.equal(periodValue(null), '');
    assert.equal(periodOfValue(''), null);
    assert.equal(periodOfValue('{pas du json'), null);
});

test('libellés : mesures et regroupements du menu, clés aller-retour', () => {
    for (const choice of MEASURE_CHOICES) {
        assert.equal(measureKey(choice.measure), choice.key);
        assert.deepEqual(measureOfKey(choice.key), choice.measure);
    }
    assert.deepEqual(measureOfKey('bogus'), { op: 'count' });
    const labels = makeLabels({ locale: 'fr' });
    for (const choice of MEASURE_CHOICES) {
        assert.notEqual(labels.measurePhrase(choice.key), choice.key, choice.key);
        assert.ok(labels.measureName(choice.measure));
    }
    for (const { family, dims } of GROUP_CHOICES) {
        assert.notEqual(labels.groupFamily(family), family);
        for (const dim of dims) {
            assert.notEqual(labels.groupPhrase(dim), dim, dim);
            assert.notEqual(labels.dimension(dim), dim, dim);
        }
    }
    for (const question of QUESTIONS) assert.notEqual(labels.question(question.id).title, question.id);
});

test('libellés : clés d\'axe, périodes et valeurs en français', () => {
    const labels = makeLabels({ locale: 'fr' });
    assert.equal(labels.axisLabel('year', 2024), '2024');
    assert.equal(labels.axisLabel('quarter', 20242), 'T2 2024');
    assert.equal(labels.axisLabel('month_of_year', 3, { long: true }), 'mars');
    assert.equal(labels.axisLabel('weekday', 1, { long: true }), 'lundi');
    assert.equal(labels.axisLabel('weekday', 7, { long: true }), 'dimanche');
    assert.equal(labels.axisLabel('day_of_year', 60), '29 févr.');
    assert.equal(labels.axisLabel('week_of_year', 12), 'S12');
    assert.equal(labels.axisLabel('dt', '1.5|2'), 'D1,5 / T2');
    assert.equal(labels.axisLabel('age', 0), 'Le jour même');
    assert.equal(labels.axisLabel('cache_type', '__others__'), 'Autres');
    assert.equal(labels.axisLabel('owner', 'unknown'), 'Inconnu');
    assert.equal(labels.axisLabel('attribute', '6', { attributeName: () => 'Kids' }), 'Kids');
    assert.equal(labels.periodLabel({ period: { kind: 'all' } }), 'Toute la période');
    assert.equal(labels.periodLabel({ period: { kind: 'year', year: 2024 }, year: 2024 }), '2024');
    assert.equal(labels.periodLabel({ period: { kind: 'rolling', unit: 'month', count: 12 } }), 'Les 12 derniers mois');
    assert.equal(labels.periodLabel({ period: { kind: 'year', year: 2024, label: 'Mon année' }, year: 2024 }), 'Mon année');
    assert.equal(labels.periodChoiceLabel(null), 'Période du tableau de bord');
    assert.equal(labels.formatValue(2.345, { op: 'mean', field: 'difficulty' }), '2,3');
    assert.equal(labels.formatValue(410.4, { op: 'mean', field: 'age' }), '410 j');
    assert.equal(labels.formatValue(null, { op: 'count' }), '—');
    assert.equal(labels.defaultTitle({ measure: { op: 'count' }, groupBy: 'year' }), 'Trouvailles par année');
    assert.equal(labels.defaultTitle({ measure: { op: 'count' }, groupBy: 'none' }), 'Trouvailles');
});

test('libellés de comparaison : en cours, coupée, rang depuis le début', () => {
    const labels = makeLabels({ locale: 'fr' });
    const entry = { period: { kind: 'current', unit: 'year' }, as: { kind: 'year', year: 2026 }, ongoing: true };
    assert.equal(labels.seriesPeriodLabel(entry), '2026 (en cours)');
    const cut = { period: { kind: 'previous' }, as: { kind: 'year', year: 2025 }, cut: true, to: dayNumber({ y: 2025, m: 11, d: 8 }) };
    assert.equal(labels.seriesPeriodLabel(cut), '2025 (au 8 nov.)');
    assert.equal(labels.periodLabel(cut), '2025');
    assert.equal(labels.elapsedLabel('month', 0), 'Mois 1');
    const before = { period: { kind: 'previous' }, as: { kind: 'previous_rolling', unit: 'month', count: 12 } };
    assert.equal(labels.periodLabel(before), 'Les 12 mois précédents');
    assert.equal(labels.comparedTo(before), 'par rapport aux 12 mois précédents');
    assert.equal(labels.comparedTo({ period: { kind: 'year', year: 2025 }, as: { kind: 'year', year: 2025 } }), 'par rapport à 2025');
    assert.equal(labels.elapsedLabel('day', 9), 'Jour 10');
    assert.equal(labels.periodChoiceLabel({ kind: 'previous' }), 'La période précédente');
    assert.equal(labels.periodChoiceLabel({ kind: 'current', unit: 'month' }), 'Ce mois-ci');
    assert.equal(labels.formatValue(12.345, { op: 'count' }, { normalize: 'percent' }), '12,3 %');
    assert.equal(labels.formatValue(0.4567, { op: 'count' }, { normalize: 'per_day' }), '0,46 / jour');
    assert.equal(labels.formatDelta(-3, { op: 'count' }), '−3');
    assert.equal(labels.formatDelta(5, { op: 'count' }), '+5');
    assert.match(labels.formatRatio(0.18), /\+18\s?%/);
    assert.equal(labels.formatRatio(null), '');
});

// ---------------------------------------------------------------------------
// Familles de tableaux (lot 4)
// ---------------------------------------------------------------------------

import {
    DEFAULT_EVOLUTION_QUESTIONS,
    dashboardSources,
    defaultDashboard,
    rebindEvolution,
    specFitsDashboard,
} from '../../static/js/dashboard_model.mjs';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';

test('barrière : un tableau personnel écarte Évolution, un tableau Évolution écarte le reste', () => {
    const items = [
        { spec: { id: 'aaaaa1', source: 'finds' } },
        { spec: { id: 'aaaaa2', source: 'poses.received' } },
        { spec: { id: 'aaaaa3', source: 'evolution:4' } },
        { spec: { id: 'aaaaa4', source: 'evolution:9:archived', extraSources: ['evolution:9'] } },
    ];
    const personal = normalizeDashboard({ id: 'bbbbbb', items }, { newId: seqId });
    assert.equal(personal.kind, 'personal');
    assert.deepEqual(personal.items.map((i) => i.spec.source), ['finds', 'poses.received']);
    const evolution = normalizeDashboard({ id: 'cccccc', kind: 'evolution', dataset: 4, items }, { newId: seqId });
    assert.equal(evolution.kind, 'evolution');
    assert.equal(evolution.dataset, 4);
    // Un graphique d'un autre jeu est rattaché à celui du tableau.
    assert.deepEqual(evolution.items.map((i) => [i.spec.source, i.spec.extraSources]),
        [['evolution:4', []], ['evolution:4:archived', ['evolution:4']]]);
    // Sans jeu, un tableau Évolution redevient personnel.
    assert.equal(normalizeDashboard({ id: 'dddddd', kind: 'evolution' }).kind, 'personal');
});

test('sources proposées et respect de la famille', () => {
    const evo = { kind: 'evolution', dataset: 3 };
    assert.deepEqual(dashboardSources(evo), ['evolution:3', 'evolution:3:archived']);
    assert.ok(dashboardSources({ kind: 'personal' }).includes('poses.favorites'));
    assert.ok(specFitsDashboard(normalizeChartSpec({ source: 'evolution:3' }), evo));
    assert.ok(!specFitsDashboard(normalizeChartSpec({ source: 'evolution:2' }), evo));
    assert.ok(!specFitsDashboard(normalizeChartSpec({ source: 'finds' }), evo));
    assert.equal(rebindEvolution(normalizeChartSpec({ source: 'evolution:2:archived' }), 5).source, 'evolution:5:archived');
});

test('nouveau tableau Évolution : questions de la zone, sur son jeu', () => {
    const dashboard = defaultDashboard({ newId: seqId, kind: 'evolution', dataset: 6, name: 'Zone' });
    assert.equal(dashboard.kind, 'evolution');
    assert.equal(dashboard.items.length, DEFAULT_EVOLUTION_QUESTIONS.length);
    assert.ok(dashboard.items.every((i) => i.spec.source.startsWith('evolution:6')));
    assert.equal(defaultDashboard({ newId: seqId, withCharts: false }).items.length, 0);
    // Pas de question Évolution sans jeu.
    assert.equal(itemFromQuestion('evo_active', { newId: seqId }), null);
});

// ---------------------------------------------------------------------------
// Organisation (lot 5)
// ---------------------------------------------------------------------------

import {
    DASHBOARD_FILE_FORMAT,
    duplicateDashboard,
    exportDashboard,
    importDashboard,
} from '../../static/js/dashboard_model.mjs';

test('hauteur d\'une carte : normale par défaut, grande possible', () => {
    assert.equal(normalizeItem({ spec: {} }, seqId).height, 'M');
    assert.equal(normalizeItem({ height: 'L', spec: {} }, seqId).height, 'L');
    assert.equal(normalizeItem({ height: 'XXL', spec: {} }, seqId).height, 'M');
});

test('export puis import : même tableau, identifiants neufs', () => {
    const original = defaultDashboard({ newId: seqId, name: 'Mes stats', titleOf: (id) => id });
    original.items[0].height = 'L';
    const file = exportDashboard(original);
    assert.equal(file.format, DASHBOARD_FILE_FORMAT);
    assert.equal(file.dashboard.items[0].spec.id, undefined);
    assert.equal(file.dashboard.id, undefined);
    const { dashboard, warning } = importDashboard(JSON.parse(JSON.stringify(file)), { newId: seqId });
    assert.equal(warning, null);
    assert.equal(dashboard.name, 'Mes stats');
    assert.notEqual(dashboard.id, original.id);
    assert.equal(dashboard.items.length, original.items.length);
    assert.equal(dashboard.items[0].height, 'L');
    assert.deepEqual(dashboard.items.map((i) => i.spec.groupBy), original.items.map((i) => i.spec.groupBy));
    assert.ok(dashboard.items.every((item, i) => item.spec.id !== original.items[i].spec.id));
});

test('import Évolution : jeu retrouvé par son nom, sinon le premier, refusé sans jeu', () => {
    const zone = defaultDashboard({ newId: seqId, kind: 'evolution', dataset: 3, name: 'Zone' });
    const file = JSON.parse(JSON.stringify(exportDashboard(zone, { datasetName: 'Bretagne' })));
    assert.equal(file.dashboard.datasetName, 'Bretagne');
    const found = importDashboard(file, { newId: seqId, datasets: [{ id: 8, name: 'Alsace' }, { id: 9, name: 'Bretagne' }] });
    assert.equal(found.dashboard.dataset, 9);
    assert.ok(found.dashboard.items.every((i) => i.spec.source.startsWith('evolution:9')));
    const guessed = importDashboard(file, { newId: seqId, datasets: [{ id: 8, name: 'Alsace' }] });
    assert.equal(guessed.dashboard.dataset, 8);
    assert.equal(guessed.warning, 'dataset-guessed');
    assert.deepEqual(importDashboard(file, { newId: seqId, datasets: [] }), { error: 'no-dataset' });
});

test('import refusé : autre format, version future', () => {
    assert.deepEqual(importDashboard({ v: 1, dashboard: {} }), { error: 'not-a-dashboard' });
    assert.deepEqual(importDashboard([1, 2]), { error: 'not-a-dashboard' });
    assert.deepEqual(importDashboard({ format: DASHBOARD_FILE_FORMAT, v: 9, dashboard: {} }), { error: 'unknown-version' });
});

test('dupliquer : identifiants neufs, nom donné', () => {
    const original = defaultDashboard({ newId: seqId, name: 'A' });
    const copy = duplicateDashboard(original, { newId: seqId, name: 'A (copie)' });
    assert.equal(copy.name, 'A (copie)');
    assert.notEqual(copy.id, original.id);
    assert.equal(copy.items.length, original.items.length);
    assert.ok(copy.items.every((item, i) => item.spec.id !== original.items[i].spec.id));
});
