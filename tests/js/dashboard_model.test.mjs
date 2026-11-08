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
        const item = itemFromQuestion(question.id, { newId: seqId });
        assert.equal(item.size, question.size);
        assert.equal(item.spec.v, CHART_SPEC_VERSION);
        assert.ok(allowedCharts(item.spec).includes(item.spec.view.chart), question.id);
        assert.ok(['bar', 'line', 'area', 'donut', 'number'].includes(item.spec.view.chart), question.id);
        assert.match(question.icon, /^ti-[a-z0-9-]+$/);
    }
    assert.equal(itemFromQuestion('bogus'), null);
    for (const id of DEFAULT_QUESTIONS) assert.ok(ids.has(id), id);
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

test('périodes proposées : tout, 12 mois, année en cours, puis les années des données', () => {
    const choices = periodChoices({ first: day(2021, 5, 1), last: day(2026, 1, 6) }, day(2026, 11, 8));
    assert.deepEqual(choices, [
        { kind: 'all' },
        { kind: 'rolling', unit: 'month', count: 12 },
        { kind: 'year', year: 2026 },
        { kind: 'year', year: 2025 },
        { kind: 'year', year: 2024 },
        { kind: 'year', year: 2023 },
        { kind: 'year', year: 2022 },
        { kind: 'year', year: 2021 },
    ]);
    assert.equal(periodChoices(null, day(2026, 11, 8)).length, 3);
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
    assert.equal(labels.periodLabel({ period: { kind: 'all' } }), 'Toutes mes trouvailles');
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
