// Part des caches trouvées (`found_share`, lot 6 du plan des cartes par
// zones) : calcul pur de zone_model.mjs et mini-cartes de chart_zones.mjs.
// Lancer : npm run test:unit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShareState, foundRowsTable, shareEventsOfTable } from '../../static/js/zone_model.mjs';
import { evolutionTables, findsTable } from '../../static/js/chart_sources.mjs';
import { allowedGroupBy, normalizeChartSpec, normalizeMeasure } from '../../static/js/chart_spec.mjs';
import { foundDaysOf, runZoneQuery } from '../../static/js/chart_zones.mjs';
import { makeLabels, measureKey } from '../../static/js/chart_labels.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const D = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return dayNumber({ y, m, d });
};
const TODAY = D('2030-01-01');

// Jeu : origine 2020-01-01.
//   GCA  FR-29  placée j0,  archivée j100   — trouvée j10
//   GCB  FR-29  placée j5,  active          — trouvée j50
//   GCC  FR-29  placée j20, active
//   GCD  FR-44  placée j0,  active          — trouvée j-30 (avant sa
//               publication dans l'export : comptée à partir de j0)
//   GCE  FR-44  placée j0,  archivée j40    — trouvée j60 (après l'archivage)
//   GCF  hors carte, placée j0
function dataset() {
    return evolutionTables({
        count: 6, origin: '2020-01-01', code: ['GCA', 'GCB', 'GCC', 'GCD', 'GCE', 'GCF'],
        placed: [0, 5, 20, 0, 0, 0], archived: [100, -1, -1, -1, 40, -1], status: [1, 0, 0, 0, 1, 0],
        type: [0, 0, 0, 0, 0, 0], types: ['Traditional Cache'], size: [], sizes: [], difficulty: [], difficulties: [],
        terrain: [], terrains: [], country: [], countries: [], region: [], regions: [], county: [], counties: [],
        zone_country: [0, 0, 0, 0, 0, 1], zone_countries: ['FR', ''],
        zone_region: [0, 0, 0, 1, 1, 2], zone_regions: ['FR-BRE', 'FR-PDL', ''],
        zone_subregion: [0, 0, 0, 1, 1, 2], zone_subregions: ['FR-29', 'FR-44', ''],
    }).placed;
}
const day0 = D('2020-01-01');
const FOUND = new Map([['GCA', day0 + 10], ['GCB', day0 + 50], ['GCD', day0 - 30], ['GCE', day0 + 60]]);

function state(base) {
    const table = dataset();
    const ids = table.dicts.zone_subregion;
    return createShareState({
        ids, base,
        events: shareEventsOfTable(table, { column: table.zone_subregion, foundDay: (c) => FOUND.get(c) }),
    });
}

test('base « actives » : la part monte avec mes trouvailles et suit les archivages', () => {
    const s = state('active');
    s.seek(day0);
    // FR-29 : A seule ; FR-44 : D (trouvée, comptée dès sa publication) et E.
    assert.equal(s.valueOf('FR-29'), 0);
    assert.equal(s.valueOf('FR-44'), 50);
    assert.deepEqual(s.parts('FR-44'), [1, 2]);
    assert.equal(s.outside, 1);
    s.seek(day0 + 10);
    assert.equal(s.valueOf('FR-29'), 50);       // A trouvée, B active
    s.seek(day0 + 45);
    assert.equal(s.valueOf('FR-44'), 100);      // E archivée : D seule, trouvée
    s.seek(day0 + 60);
    // E trouvée après son archivage : jamais comptée au numérateur.
    assert.equal(s.valueOf('FR-44'), 100);
    assert.deepEqual(s.parts('FR-29'), [2, 3]);
    s.seek(day0 + 100);
    assert.deepEqual(s.parts('FR-29'), [1, 2]); // A archivée : sort des deux comptes
    assert.ok(s.values().get('FR-29') === 50);
    assert.deepEqual(s.totals(), [2, 4]);       // B, D trouvées sur B, C, D, F
});

test('base « toutes » : les archivées restent dans les deux comptes', () => {
    const s = state('all');
    s.seek(day0 + 100);
    assert.deepEqual(s.parts('FR-29'), [2, 3]);
    assert.deepEqual(s.parts('FR-44'), [2, 2]); // E trouvée après l'archivage : comptée
    assert.equal(s.valueOf('FR-44'), 100);
});

test('saut en arrière = calcul depuis zéro ; zones changées', () => {
    const a = state('active');
    a.seek(day0 + 100);
    a.drainChanged();
    a.seek(day0 + 5);
    const b = state('active').seek(day0 + 5);
    assert.deepEqual([...a.values()], [...b.values()]);
    assert.ok(a.drainChanged().includes('FR-29'));
    assert.equal(a.seek(day0 - 1).values().size, 0);
    assert.deepEqual(a.extent, { first: day0, last: day0 + 100 });
});

test('trouvailles du jeu datées de leur trouvaille (moments clés)', () => {
    const table = dataset();
    const { table: found, rows } = foundRowsTable(table, { foundDay: (c) => FOUND.get(c) });
    assert.equal(rows.length, 4);
    assert.equal(found.day[0], day0 + 10);
    assert.equal(found.day[3], day0);           // trouvée avant la publication
    assert.equal(table.day[0], day0);           // table d'origine intacte
});

test('jour de première trouvaille par code', () => {
    const finds = findsTable({
        count: 3, date: ['2024-05-01', '2023-01-01', '2024-01-01'], code: ['GCA', 'GCA', null],
    });
    const map = foundDaysOf(finds);
    assert.equal(map.size, 1);
    assert.equal(map.get('GCA'), D('2023-01-01'));
    assert.equal(foundDaysOf(finds), map);      // mémorisé
});

test('description : jeu Évolution seulement, carte seulement', () => {
    assert.deepEqual(normalizeMeasure({ op: 'found_share' }, 'evolution:3'), { op: 'found_share' });
    assert.deepEqual(normalizeMeasure({ op: 'found_share', base: 'all' }, 'evolution:3'), { op: 'found_share', base: 'all' });
    assert.deepEqual(normalizeMeasure({ op: 'found_share' }, 'finds'), { op: 'count' });
    assert.deepEqual(normalizeMeasure({ op: 'found_share' }, 'evolution:3:archived'), { op: 'count' });
    assert.ok(allowedGroupBy({ op: 'found_share' }, 'evolution:3').every((dim) => dim.startsWith('zone_')));
    assert.equal(measureKey({ op: 'found_share', base: 'all' }), 'found_share:all');
    const spec = normalizeChartSpec({ id: 'abcdef01', source: 'evolution:3', measure: { op: 'found_share' }, groupBy: 'zone_subregion' });
    assert.equal(spec.view.chart, 'map');
    assert.deepEqual(spec.measure, { op: 'found_share' });
});

test('mini-carte : part par zone, comptes, moments tirés de mes trouvailles', () => {
    const table = dataset();
    const spec = normalizeChartSpec({
        id: 'abcdef01', source: 'evolution:3', measure: { op: 'found_share' }, groupBy: 'zone_subregion',
        periods: [{ kind: 'moments', rule: 'milestones' }],
    });
    const result = runZoneQuery(spec, table, { today: TODAY, found: FOUND });
    // Une seule vignette : le dernier jour (pas de 100e trouvaille).
    assert.equal(result.series.length, 1);
    const at = (id) => result.series[0].values[result.keys.indexOf(id)];
    const s = result.series[0];
    assert.equal(at('FR-29'), 50);
    assert.equal(at('FR-44'), 100);
    assert.deepEqual(s.parts[result.keys.indexOf('FR-44')], [1, 1]);
    assert.deepEqual(s.totals, [2, 4]);
    assert.equal(result.meta.unknown, 1);

    // Fins d'année : à partir de ma première trouvaille dans le jeu (2019,
    // trouvée avant la publication → comptée en 2020), pas de vignette vide.
    const years = runZoneQuery(normalizeChartSpec({ ...spec, periods: [{ kind: 'moments', rule: 'year_end' }] }),
        table, { today: TODAY, found: FOUND });
    assert.equal(years.series.length, 1);

    // Aucune trouvaille dans le jeu : cartes à 0 %.
    const none = runZoneQuery(spec, table, { today: TODAY, found: new Map() });
    assert.ok(none.series[0].values.every((v) => v === 0));
});

test('libellés : pourcentage, unité de légende, comptes', () => {
    const labels = makeLabels({ locale: 'fr' });
    assert.equal(labels.formatValue(12.345, { op: 'found_share' }).replace(/\s/g, ' '), '12,3 %');
    assert.equal(labels.formatValue(12.345, { op: 'found_share' }, { bare: true }), '12,3');
    assert.equal(labels.valueUnit({ op: 'found_share' }), '%');
    assert.equal(labels.measureName({ op: 'found_share' }, 'evolution:3'), 'Part des actives trouvées');
});
