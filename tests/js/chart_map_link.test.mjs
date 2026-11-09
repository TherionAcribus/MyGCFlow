// Retour à la carte (chart_map_link.mjs) : une valeur cliquée → la
// sélection de filtres de la page carte.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { findsTable } from '../../static/js/chart_sources.mjs';
import { OTHERS_KEY, UNKNOWN_KEY, runChartQuery } from '../../static/js/chart_query.mjs';
import {
    UNKNOWN_GEO, chartLinksToMap, discoveryModeFor, filtersFromMapSelection, isoOfDay, mapSelectionFor,
} from '../../static/js/chart_map_link.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const day = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return dayNumber({ y, m, d });
};

function payload() {
    const rows = [
        // date, published, kind, code, D, T, type, container, country, state, owner, attrs
        ['2023-01-15', '2020-01-15', 0, 'GC1', 1.5, 2, 0, 0, 0, 0, 0, [0]],
        ['2023-01-20', '2023-01-20', 0, 'GC2', 2, 1, 0, 1, 0, 0, 1, [0, 1]],
        ['2023-06-03', null, 0, 'GC3', 3, 3.5, 1, 0, 1, -1, 0, []],
        ['2024-01-10', '2010-05-01', 0, 'GC4', 1.5, 1.5, 0, 0, 0, 1, 2, [1]],
        ['2024-02-29', '2024-02-01', 0, 'GC5', 5, 5, 1, -1, 0, 1, 0, []],
        ['2024-02-29', null, 1, 'lab-1', null, null, 2, -1, 1, -1, -1, []],
        ['2024-12-31', '2024-12-25', 0, 'GC6', 1.5, 2, 0, 0, 0, 0, 0, [0]],
    ];
    const column = (i) => rows.map((row) => row[i]);
    return {
        v: 1, count: rows.length, date: column(0), published: column(1), kind: column(2), code: column(3),
        difficulty: column(4), terrain: column(5), cache_type: column(6), container: column(7),
        country: column(8), state: column(9), owner: column(10), attributes: column(11),
        dicts: {
            cache_type: ['Traditional Cache', 'Unknown Cache', 'Adventure Lab'],
            container: ['Small', 'Micro'],
            country: ['France', 'Belgique'],
            state: ['Bretagne', 'Normandie'],
            owner: ['Alice', 'Bob', 'Chloé'],
            attribute: [{ key: '6', name: 'Kids' }, { key: '8', name: 'Scenic' }],
        },
    };
}

const table = findsTable(payload());
const TODAY = day('2026-11-08');
const COUNTRIES = ['France', 'Belgique'];

function link(raw, seriesIndex, key, extra = {}) {
    const spec = normalizeChartSpec(raw);
    const result = runChartQuery(spec, table, { today: TODAY });
    const keyIndex = result.keys.indexOf(key);
    assert.ok(keyIndex >= 0, `clé ${key} absente : ${result.keys}`);
    return mapSelectionFor({ spec, result, seriesIndex, keyIndex, countries: COUNTRIES, filters: extra.filters ?? spec.filters });
}

test('un mois cliqué : les dates de la carte couvrent ce mois', () => {
    const out = link({ groupBy: 'month', periods: [{ kind: 'year', year: 2024 }] }, 0, 202402);
    assert.deepEqual(out.selection.dates, { startDate: '2024-02-01', endDate: '2024-02-29' });
    assert.equal(out.kinds, null);
    assert.equal(out.selection.type, undefined);
});

test('une année cliquée sur « toute la période »', () => {
    const out = link({ groupBy: 'year' }, 0, 2023);
    assert.deepEqual(out.selection.dates, { startDate: '2023-01-01', endDate: '2023-12-31' });
});

test('un type cliqué : liste des types réduite, période du graphique', () => {
    const out = link({ groupBy: 'cache_type', periods: [{ kind: 'year', year: 2023 }] }, 0, 'Unknown Cache');
    assert.deepEqual(out.selection.type, ['Unknown Cache']);
    assert.deepEqual(out.selection.dates, { startDate: '2023-01-01', endDate: '2023-12-31' });
    assert.deepEqual(out.kinds, ['geocache']);
    const lab = link({ groupBy: 'cache_type' }, 0, 'Adventure Lab');
    assert.deepEqual(lab.kinds, ['lab']);
});

test('D/T, pays, propriétaire, attribut, année de publication', () => {
    const dt = link({ groupBy: 'dt' }, 0, '1.5|2');
    assert.deepEqual([dt.selection.difficulty, dt.selection.terrain], [['1.5'], ['2']]);
    const country = link({ groupBy: 'country' }, 0, 'Belgique');
    assert.deepEqual(country.selection.countries, ['Belgique']);
    assert.deepEqual(country.selection.countries_excluded, ['France', '__unknown__']);
    assert.equal(country.kinds, null);
    assert.deepEqual(link({ groupBy: 'owner' }, 0, 'Bob').selection.owners, ['Bob']);
    assert.deepEqual(link({ groupBy: 'attribute' }, 0, '8').selection.attributes, ['8']);
    assert.deepEqual(link({ groupBy: 'published_year' }, 0, 2010).selection.published_dates,
        { startDate: '2010-01-01', endDate: '2010-12-31' });
});

test("mois de l'année : la période d'une année donne le mois exact", () => {
    const out = link({
        groupBy: 'month_of_year', periods: [{ kind: 'year', year: 2024 }, { kind: 'year', year: 2023 }],
        compare: { align: 'calendar' },
    }, 1, 6);
    assert.deepEqual(out.selection.dates, { startDate: '2023-06-01', endDate: '2023-06-30' });
});

test("mois de l'année sur plusieurs années : pas de lien", () => {
    const spec = normalizeChartSpec({ groupBy: 'month_of_year' });
    const result = runChartQuery(spec, table, { today: TODAY });
    assert.equal(mapSelectionFor({ spec, result, seriesIndex: 0, keyIndex: 0 }), null);
});

test('alignement « depuis le début » : la date réelle de la série', () => {
    const out = link({
        groupBy: 'month', periods: [{ kind: 'year', year: 2024 }, { kind: 'year', year: 2023 }],
        compare: { align: 'elapsed' },
    }, 1, 1);
    // 2ᵉ mois écoulé de 2023 : février 2023.
    assert.deepEqual(out.selection.dates, { startDate: '2023-02-01', endDate: '2023-02-28' });
});

test('une série découpée ajoute sa valeur', () => {
    const spec = normalizeChartSpec({ groupBy: 'year', splitBy: 'container' });
    const result = runChartQuery(spec, table, { today: TODAY });
    const s = result.series.findIndex((x) => x.split === 'Micro');
    const out = mapSelectionFor({ spec, result, seriesIndex: s, keyIndex: result.keys.indexOf(2023), countries: COUNTRIES });
    assert.deepEqual(out.selection.container, ['Micro']);
    assert.deepEqual(out.selection.dates, { startDate: '2023-01-01', endDate: '2023-12-31' });
    assert.deepEqual(out.kinds, ['geocache']);
});

test('filtres du graphique reportés, ou pas de lien quand la carte ne sait pas', () => {
    const out = link({ groupBy: 'year' }, 0, 2024, { filters: { container: ['Small', 'Micro'], source_kind: ['geocache'] } });
    assert.deepEqual(out.selection.container, ['Small', 'Micro']);
    assert.deepEqual(out.kinds, ['geocache']);
    // Filtre et valeur cliquée : intersection.
    const both = link({ groupBy: 'container' }, 0, 'Micro', { filters: { container: ['Small', 'Micro'] } });
    assert.deepEqual(both.selection.container, ['Micro']);
    // Pas d'équivalent carte : région, cache précise.
    const spec = normalizeChartSpec({ groupBy: 'year' });
    const result = runChartQuery(spec, table, { today: TODAY });
    assert.equal(mapSelectionFor({ spec, result, seriesIndex: 0, keyIndex: 0, filters: { state: ['Bretagne'] } }), null);
    // Années de publication non contiguës : pas de lien.
    assert.equal(mapSelectionFor({ spec, result, seriesIndex: 0, keyIndex: 0, filters: { published_year: ['2010', '2020'] } }), null);
    const contiguous = mapSelectionFor({ spec, result, seriesIndex: 0, keyIndex: 0, filters: { published_year: ['2021', '2020'] } });
    assert.deepEqual(contiguous.selection.published_dates, { startDate: '2020-01-01', endDate: '2021-12-31' });
});

test('« Autres », « Inconnu », dimension sans équivalent, autre source : pas de lien', () => {
    const base = normalizeChartSpec({ groupBy: 'owner' });
    const spec = { ...base, view: { ...base.view, top: 1 } };
    const result = runChartQuery(spec, table, { today: TODAY });
    for (const key of [OTHERS_KEY, UNKNOWN_KEY]) {
        const keyIndex = result.keys.indexOf(key);
        assert.ok(keyIndex >= 0, `clé ${key} absente : ${result.keys}`);
        assert.equal(mapSelectionFor({ spec, result, seriesIndex: 0, keyIndex }), null);
    }
    const weekday = normalizeChartSpec({ groupBy: 'weekday' });
    assert.equal(mapSelectionFor({ spec: weekday, result: runChartQuery(weekday, table, { today: TODAY }), seriesIndex: 0, keyIndex: 0 }), null);
    assert.equal(chartLinksToMap(weekday), false);
    assert.equal(chartLinksToMap(normalizeChartSpec({ groupBy: 'year' })), true);
    const dnf = normalizeChartSpec({ source: 'dnf', groupBy: 'year' });
    assert.equal(chartLinksToMap(dnf), false);
    assert.equal(mapSelectionFor({ spec: dnf, result: runChartQuery(dnf, table, { today: TODAY }), seriesIndex: 0, keyIndex: 0 }), null);
});

test('mode des sources affichées sur la carte', () => {
    assert.equal(discoveryModeFor(null, ['geocache', 'lab'], 'geocaches'), 'both');
    assert.equal(discoveryModeFor(null, ['geocache', 'lab'], 'both'), null);
    assert.equal(discoveryModeFor(null, ['geocache'], 'geocaches'), null);
    assert.equal(discoveryModeFor(['geocache'], ['geocache', 'lab'], 'both'), 'geocaches');
    assert.equal(discoveryModeFor(['lab'], ['geocache', 'lab'], 'geocaches'), 'labs');
    assert.equal(discoveryModeFor(['lab'], ['geocache'], 'geocaches'), null);
});

test('isoOfDay', () => {
    assert.equal(isoOfDay(day('2024-02-29')), '2024-02-29');
});

// ---------------------------------------------------------------------------
// Sens inverse : « Reprendre les filtres de la carte »
// ---------------------------------------------------------------------------

const fromMap = (selection, discovery = 'both') => filtersFromMapSelection(selection, { table, discovery });

// Ce que la carte enregistre quand rien n'est filtré : tout coché, dates
// sur l'étendue des trouvailles.
const ALL_CHECKED = {
    type: ['Traditional Cache', 'Unknown Cache', 'Adventure Lab', 'Earthcache'],
    container: ['Small', 'Micro', 'Regular'],
    difficulty: ['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5'],
    terrain: ['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5'],
    countries: ['France', 'Belgique', UNKNOWN_GEO], countries_excluded: [],
    states: ['Bretagne', 'Normandie', UNKNOWN_GEO], states_excluded: [],
    owners: [], attributes: [], search: '',
    dates: { startDate: '2023-01-15', endDate: '2024-12-31' },
    published_dates: { startDate: '2010-05-01', endDate: '2024-12-25' },
};

test('carte sans filtre : rien à reprendre (sauf les points cachés par la préférence)', () => {
    for (const selection of [null, {}, ALL_CHECKED]) {
        const out = fromMap(selection);
        assert.deepEqual(out.filters, {});
        assert.equal(out.period, null);
        assert.deepEqual(out.notes, []);
        assert.equal(out.count, 7);
    }
    // La carte ne montre que les géocaches : les Labs sont écartés ici aussi.
    const geocaches = fromMap({}, 'geocaches');
    assert.deepEqual(geocaches.filters, { source_kind: ['geocache'] });
    assert.equal(geocaches.count, 6);
    assert.deepEqual(fromMap({}, 'labs').filters, { source_kind: ['lab'] });
});

test('listes, pays, propriétaires et dates de la carte → filtres et période du tableau', () => {
    const out = fromMap({
        ...ALL_CHECKED,
        type: ['Traditional Cache', 'Earthcache'],
        difficulty: ['1.5', '2.0'],
        countries: ['France'], countries_excluded: ['Belgique'],
        owners: ['Alice', 'Zoé'],
        dates: { startDate: '2023-01-01', endDate: '2023-12-31' },
        published_dates: { startDate: '', endDate: '' },
        search: ' lac ',
    }, 'geocaches');
    assert.deepEqual(out.filters, {
        cache_type: ['Traditional Cache'], difficulty: ['1.5', '2'], country: ['France'],
        owner: ['Alice'], source_kind: ['geocache'],
    });
    assert.deepEqual(out.period, { kind: 'range', from: '2023-01-01', to: '2023-12-31' });
    assert.deepEqual(out.notes, [{ code: 'search', text: 'lac' }]);
    assert.equal(out.count, 1);
});

test('un filtre propre aux géocaches : la carte garde les Labs, la page le signale', () => {
    const out = fromMap({ difficulty: ['1.5'] });
    assert.deepEqual(out.filters, { difficulty: ['1.5'] });
    assert.deepEqual(out.notes, [{ code: 'labs' }]);
    // Carte en géocaches seules : rien à signaler.
    assert.deepEqual(fromMap({ difficulty: ['1.5'] }, 'geocaches').notes, []);
    // « Aucune » difficulté : il ne reste que les Labs.
    const labs = fromMap({ difficulty: [], container: ['Small'] });
    assert.deepEqual(labs.filters, { source_kind: ['lab'] });
    assert.equal(labs.count, 1);
    assert.equal(fromMap({ difficulty: [] }, 'geocaches').empty, true);
    // Propriétaire ou attribut absent des trouvailles : idem.
    assert.deepEqual(fromMap({ owners: ['Zoé'] }).filters, { source_kind: ['lab'] });
    assert.deepEqual(fromMap({ attributes: ['6', '8'] }).filters, { attribute: ['6', '8'] });
    assert.deepEqual(fromMap({ attributes: ['99'] }).filters, { source_kind: ['lab'] });
});

test('« Non renseigné » des pays / régions', () => {
    // Région écartée, « Non renseigné » gardé : pas d'équivalent, signalé.
    const out = fromMap({ states_excluded: ['Normandie'] });
    assert.deepEqual(out.filters, { state: ['Bretagne'] });
    assert.deepEqual(out.notes, [{ code: 'unknown_state' }]);
    // « Non renseigné » seul écarté : toutes les régions nommées.
    assert.deepEqual(fromMap({ states_excluded: [UNKNOWN_GEO] }).filters, { state: ['Bretagne', 'Normandie'] });
    // Ancien format (cochés seulement).
    assert.deepEqual(fromMap({ countries: ['Belgique'] }).filters, { country: ['Belgique'] });
    // Rien de coché : la carte n'affiche rien.
    assert.equal(fromMap({ countries: [] }).empty, true);
});

test('dates de pose : années entières reprises, autres bornes signalées', () => {
    const years = fromMap({ published_dates: { startDate: '2023-01-01', endDate: '2024-12-31' } }, 'geocaches');
    assert.deepEqual(years.filters, { published_year: ['2024', '2023'], source_kind: ['geocache'] });
    assert.equal(years.count, 3);
    const odd = fromMap({ published_dates: { startDate: '2015-03-01', endDate: '2024-12-31' } }, 'geocaches');
    assert.deepEqual(odd.filters, { source_kind: ['geocache'] });
    assert.deepEqual(odd.notes, [{ code: 'published_dates', from: '2015-03-01', to: '2024-12-31' }]);
    // Années sans trouvaille : rien.
    assert.equal(fromMap({ published_dates: { startDate: '2001-01-01', endDate: '2002-12-31' } }).empty, true);
});

test('la carte n’affiche aucune trouvaille : rien n’est repris', () => {
    for (const selection of [
        { type: [] },
        { type: ['Earthcache'] },
        { dates: { startDate: '2025-01-01', endDate: '2025-12-31' } },
        { dates: { startDate: '2024-12-31', endDate: '2023-01-01' } },
        { type: ['Adventure Lab'] },
    ]) {
        const out = fromMap(selection, 'geocaches');
        assert.equal(out.empty, true, JSON.stringify(selection));
        assert.equal(out.filters, null);
        assert.equal(out.count, 0);
    }
});
