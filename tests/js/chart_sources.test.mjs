// Sources de la page Statistiques autres que les trouvailles
// (static/js/chart_sources.mjs) et graphiques sur plusieurs sources
// (chart_query.mjs › runChartQueries, mesure « actives »).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import {
    dnfTable, evolutionTables, findsTable, ownedTable, posesTables, tableFromRecords,
} from '../../static/js/chart_sources.mjs';
import { OTHERS_KEY, activeAt, runChartQueries, runChartQuery } from '../../static/js/chart_query.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const day = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return dayNumber({ y, m, d });
};
const TODAY = day('2026-11-08');
const feature = (props) => ({ type: 'Feature', geometry: null, properties: props });

test('table générique : jours, publication, fin, dictionnaires, lignes sans date écartées', () => {
    const table = tableFromRecords([
        { day: day('2024-03-01'), published: day('2024-03-01'), endDay: day('2025-01-01'), cache_type: 'Traditional Cache', county: 'Finistère' },
        { day: day('2024-03-05'), cache_type: 'Traditional Cache', finder: 'Alice', difficulty: '1.5' },
        { day: NaN, cache_type: 'Mystery' },
    ], { source: 'test' });
    assert.equal(table.n, 2);
    assert.equal(table.undated, 1);
    assert.equal(table.endDay[0], day('2025-01-01'));
    assert.ok(Number.isNaN(table.endDay[1]));
    assert.equal(table.age[0], 0);
    assert.deepEqual(table.dicts.cache_type, ['Traditional Cache']);
    assert.deepEqual(table.dicts.county, ['Finistère']);
    assert.equal(table.county[1], -1);
    assert.equal(table.dicts.finder[table.finder[1]], 'Alice');
    assert.equal(table.difficulty[1], 1.5);
    // L'étendue court jusqu'au dernier archivage.
    assert.deepEqual(table.extent, { first: day('2024-03-01'), last: day('2025-01-01') });
    assert.ok(Number.isNaN(findsTable({ count: 1, date: ['2024-01-01'] }).endDay[0]));
});

test('DNF : un enregistrement par DNF, propriétés de la cache', () => {
    const table = dnfTable({
        features: [
            feature({ gc_code: 'GC1', cache_type: 'Unknown Cache', difficulty: 4, owner: 'Bob', date_find: '2024-01-01', dnf_dates: ['2024-01-01', '2024-06-01'] }),
            feature({ gc_code: 'GC2', cache_type: 'Traditional Cache', date_find: '2025-02-02' }),
        ],
    });
    assert.equal(table.n, 3);
    assert.deepEqual([...table.y], [2024, 2024, 2025]);
    assert.equal(table.dicts.owner[table.owner[0]], 'Bob');
    assert.equal(dnfTable(null).n, 0);
});

test('caches posées : une par pose, active jusqu\'à son dernier archivage', () => {
    const table = ownedTable({
        features: [
            feature({ gc_code: 'GC1', date_find: '2020-01-01', owner: 'Moi', owner_states: [['2020-01-01', 0], ['2022-05-01', 2]] }),
            feature({ gc_code: 'GC2', date_find: '2021-01-01', owner_states: [['2021-01-01', 0], ['2021-06-01', 2], ['2021-07-01', 0]] }),
            feature({ gc_code: 'GC3', date_find: '2023-01-01', owner_states: [] }),
        ],
    });
    assert.equal(table.n, 3);
    assert.equal(table.endDay[0], day('2022-05-01'));
    // Désarchivée ensuite : toujours active.
    assert.ok(Number.isNaN(table.endDay[1]));
    assert.deepEqual(table.dicts.owner, []);
});

function posesPayload() {
    return {
        origin: '2020-01-01',
        count: 2,
        code: ['GCA', 'GCB'],
        name: ['Cache A', ''],
        placed: [0, 100],
        type: [0, 1], types: ['Traditional Cache', 'Multi-cache'],
        size: [0, 0], sizes: ['Small'],
        difficulty: [0, 1], difficulties: ['1.5', '3'],
        terrain: [0, 0], terrains: ['2'],
        country: [0, 0], countries: ['France'],
        region: [0, 0], regions: ['Bretagne'],
        logKinds: ['publish', 'find', 'dnf', 'note'],
        authors: ['Alice', 'Bob'],
        ev: {
            cache: [0, 0, 1, 1, 0],
            day: [0, 10, 120, 130, 400],
            kind: [0, 1, 1, 2, 1],
            fav: [0, 1, 0, 0, 0],
            folded: [0, 0, 0, 0, 0],
            author: [-1, 0, 1, 0, 0],
        },
    };
}

test('Mes poses : trouvailles, DNF et favoris reçus, avec la cache et le visiteur', () => {
    const { received, dnf, favorites } = posesTables(posesPayload());
    assert.equal(received.n, 3);
    assert.equal(dnf.n, 1);
    assert.equal(favorites.n, 1);
    assert.equal(received.dicts.cache[received.cache[0]], 'Cache A');
    // Sans nom : le code.
    assert.equal(received.dicts.cache[received.cache[1]], 'GCB');
    assert.equal(received.dicts.finder[received.finder[1]], 'Bob');
    assert.equal(received.difficulty[1], 3);
    assert.equal(received.age[0], 2);    // 10 jours après la publication
    assert.equal(posesTables({ count: 0 }).received.n, 0);
});

function evolutionPayload() {
    return {
        origin: '2020-01-01',
        count: 4,
        code: ['GC1', 'GC2', 'GC3', 'GC4'],
        placed: [0, 31, 366, 400],
        archived: [366, -1, -1, -1],
        status: [1, 0, 2, 0],
        type: [0, 0, 1, 0], types: ['Traditional Cache', 'Earthcache'],
        size: [0, 0, 0, 0], sizes: ['Micro'],
        difficulty: [0, 0, 0, 0], difficulties: ['1'],
        terrain: [0, 0, 0, 0], terrains: ['1'],
        country: [0, 0, 0, 0], countries: ['France'],
        region: [0, 0, 0, 0], regions: ['Bretagne'],
        county: [0, 1, 0, 0], counties: ['Finistère', 'Morbihan'],
    };
}

test('Évolution : publiées (actives jusqu\'à l\'archivage), archivages datés seulement', () => {
    const { placed, archived } = evolutionTables(evolutionPayload());
    assert.equal(placed.n, 4);
    assert.equal(archived.n, 1);
    assert.equal(archived.day[0], day('2021-01-01'));
    // Archivée sans date : jamais active (fin = publication).
    assert.equal(placed.endDay[2], placed.day[2]);
    assert.equal(placed.dicts.county[placed.county[1]], 'Morbihan');
});

// Ancienne conversion (un enregistrement par cache, puis tableFromRecords) :
// la conversion directe en colonnes doit rendre exactement la même table.
function evolutionTablesByRecords(payload) {
    const placed = [];
    const archived = [];
    if (payload && Number.isInteger(payload.count)) {
        const origin = dayNumber({ y: +payload.origin.slice(0, 4), m: +payload.origin.slice(5, 7), d: +payload.origin.slice(8, 10) });
        const dict = (list, i) => (Array.isArray(list) && i >= 0 ? list[i] : '');
        for (let k = 0; k < payload.count; k++) {
            const d = origin + payload.placed[k];
            const archivedOn = payload.archived[k] >= 0 ? origin + payload.archived[k] : NaN;
            const base = {
                code: payload.code?.[k] || null,
                cache_type: dict(payload.types, payload.type?.[k]),
                container: dict(payload.sizes, payload.size?.[k]),
                difficulty: dict(payload.difficulties, payload.difficulty?.[k]),
                terrain: dict(payload.terrains, payload.terrain?.[k]),
                country: dict(payload.countries, payload.country?.[k]),
                state: dict(payload.regions, payload.region?.[k]),
                county: dict(payload.counties, payload.county?.[k]),
            };
            placed.push({ ...base, day: d, endDay: payload.status?.[k] === 2 ? d : archivedOn });
            if (Number.isFinite(archivedOn)) archived.push({ ...base, day: archivedOn });
        }
    }
    return {
        placed: tableFromRecords(placed, { source: 'evolution' }),
        archived: tableFromRecords(archived, { source: 'evolution:archived' }),
    };
}

// Les listes d'attributs (toujours vides ici) comparées par contenu.
const plain = (table) => ({ ...table, attributes: table.attributes.map((a) => [...a]) });

test('Évolution : la conversion en colonnes rend la même table que par enregistrements', () => {
    const payload = {
        origin: '2019-12-30',
        count: 7,
        code: ['GC1', '', 'GC3', 'GC4', 'GC5', 'GC6', 'GC7'],
        placed: [0, 31, 366, 400, 2, 3, 790],
        archived: [366, -1, -1, 800, -1, 10, -1],
        status: [1, 0, 2, 1, 0, 1, 0],
        // Ordre du serveur ≠ ordre d'apparition ; libellé vide ; doublon
        // après nettoyage (« Earthcache » / « Earthcache  ») ; index hors liste.
        type: [2, 1, 3, 0, 9, -1, 1], types: ['', 'Earthcache', 'Traditional Cache', 'Earthcache  '],
        size: [0, 0, 1, 0, 0, 0, 0], sizes: ['Micro', 'Small'],
        difficulty: [0, 1, 2, 3, -1, 0, 0], difficulties: ['1', '1.5', '', 'x'],
        terrain: [1, 1, 0, 0, 0, 5, 0], terrains: ['2', '4.5'],
        country: [0, 0, 0, 0, 0, 0, 0], countries: ['France'],
        region: [0, 0, 0, 0, 1, 0, 0], regions: ['Bretagne', ' Normandie '],
        county: [0, 1, 0, 0, 1, 0, 1], counties: ['Finistère', 'Morbihan'],
    };
    const fast = evolutionTables(payload);
    const reference = evolutionTablesByRecords(payload);
    assert.deepStrictEqual(plain(fast.placed), plain(reference.placed));
    assert.deepStrictEqual(plain(fast.archived), plain(reference.archived));
    // Sans données valides : tables vides, comme avant.
    assert.deepStrictEqual(plain(evolutionTables(null).placed), plain(tableFromRecords([], { source: 'evolution' })));
    assert.equal(evolutionTables({ count: 'x' }).archived.n, 0);
});

test('Évolution : actives par catégorie et 2ᵉ dimension = décompte ligne à ligne', () => {
    const { placed } = evolutionTables(evolutionPayload());
    const spec = normalizeChartSpec({ source: 'evolution:1', measure: { op: 'active' }, groupBy: 'county', splitBy: 'cache_type' });
    const result = runChartQuery(spec, placed, { today: TODAY });
    const end = Math.min(placed.extent.last, TODAY);
    for (const series of result.series) {
        result.keys.forEach((county, i) => {
            let expected = 0;
            for (let r = 0; r < placed.n; r++) {
                if (placed.dicts.county[placed.county[r]] !== county) continue;
                if (placed.dicts.cache_type[placed.cache_type[r]] !== series.split) continue;
                if (placed.day[r] <= end && !(placed.endDay[r] <= end)) expected++;
            }
            assert.equal(series.values[i], expected, `${series.split} / ${county}`);
        });
    }
});

test('actives : commencées et pas encore finies au jour donné', () => {
    const group = { starts: [1, 5, 10], ends: [5, 20] };
    assert.equal(activeAt(group, 0), 0);
    assert.equal(activeAt(group, 4), 1);
    assert.equal(activeAt(group, 5), 1);   // une fin le jour même retire
    assert.equal(activeAt(group, 10), 2);
    assert.equal(activeAt(group, 25), 1);
});

test('Évolution : caches actives par année, au total, par type', () => {
    const { placed } = evolutionTables(evolutionPayload());
    const run = (raw) => runChartQuery(normalizeChartSpec({ source: 'evolution:1', ...raw }), placed, { today: TODAY });
    const byYear = run({ measure: { op: 'active' }, groupBy: 'year' });
    // Fin 2020 : GC1, GC2 ; fin 2021 : GC1 archivée le 1/1/2021, GC3 sans
    // date jamais active, GC4 publiée en 2021 → GC2, GC4.
    assert.deepEqual(byYear.keys, [2020, 2021]);
    assert.deepEqual(byYear.series[0].values, [2, 2]);
    const total = run({ measure: { op: 'active' }, groupBy: 'none' });
    assert.deepEqual(total.series[0].values, [2]);
    assert.equal(total.meta.rows, 4);
    const byType = run({ measure: { op: 'active' }, groupBy: 'cache_type' });
    assert.deepEqual(byType.keys, ['Traditional Cache', 'Earthcache']);
    assert.deepEqual(byType.series[0].values, [2, 0]);
    // Actives fin 2020 seulement.
    const in2020 = run({ measure: { op: 'active' }, groupBy: 'none', periods: [{ kind: 'year', year: 2020 }] });
    assert.deepEqual(in2020.series[0].values, [2]);
});

test('plusieurs sources : un axe commun, une série par source, écart', () => {
    const finds = findsTable({ count: 3, date: ['2020-01-05', '2021-03-01', '2021-04-01'], dicts: {} });
    const { received } = posesTables(posesPayload());
    const tables = { finds, 'poses.received': received };
    const spec = normalizeChartSpec({ source: 'finds', extraSources: ['poses.received'], groupBy: 'year' });
    const result = runChartQueries(spec, (s) => tables[s], { today: TODAY });
    assert.deepEqual(result.sources, ['finds', 'poses.received']);
    assert.deepEqual(result.keys, [2020, 2021]);
    assert.deepEqual(result.series.map((s) => s.source), ['finds', 'poses.received']);
    assert.deepEqual(result.series.map((s) => s.values), [[1, 2], [2, 1]]);
    const delta = runChartQueries({ ...spec, compare: { ...spec.compare, layout: 'delta' } }, (s) => tables[s], { today: TODAY });
    assert.deepEqual(delta.delta.values, [-1, 1]);
    // Catégories : union des clés des deux sources.
    const types = runChartQueries(normalizeChartSpec({ source: 'finds', extraSources: ['poses.received'], groupBy: 'cache_type' }),
        (s) => tables[s], { today: TODAY });
    assert.deepEqual(types.keys, ['Traditional Cache', 'Multi-cache', 'unknown']);
    assert.deepEqual(types.series[0].values, [0, 0, 3]);
    assert.deepEqual(types.series[1].values, [2, 1, 0]);
    // Une seule source : même résultat que runChartQuery, avec la source.
    const one = runChartQueries(normalizeChartSpec({ groupBy: 'year' }), () => finds, { today: TODAY });
    assert.equal(one.series[0].source, 'finds');
});

test('plusieurs sources : top N commun — pas de valeur « Autres » affichée à zéro', () => {
    // Trouvailles {A 5, B 4, C 3, D 1}, DNF {D 5, B 4, C 3, A 1} : un top 3
    // choisi par source mettait D « Autres » pour les trouvailles et en tête
    // des DNF — elle s'affichait à 0 pour les trouvailles. Le top est choisi
    // sur les comptages réunis (B 8, puis A / C / D à 6, ordre des libellés).
    const rows = (counts) => Object.entries(counts).flatMap(([country, n]) =>
        Array.from({ length: n }, () => ({ day: day('2024-06-01'), country })));
    const tables = {
        finds: tableFromRecords(rows({ A: 5, B: 4, C: 3, D: 1 }), { source: 'finds' }),
        dnf: tableFromRecords(rows({ D: 5, B: 4, C: 3, A: 1 }), { source: 'dnf' }),
    };
    const spec = normalizeChartSpec({
        source: 'finds', extraSources: ['dnf'], groupBy: 'country',
        periods: [{ kind: 'all' }], view: { chart: 'bar', top: 3 },
    });
    const result = runChartQueries(spec, (s) => tables[s], { today: TODAY });
    assert.deepEqual(result.keys, ['B', 'A', 'C', OTHERS_KEY]);
    assert.deepEqual(result.series.map((s) => s.values), [[4, 5, 3, 1], [4, 1, 3, 5]]);
});

test('plusieurs sources : la 2ᵉ dimension est aussi plafonnée sur les comptes réunis', () => {
    // Chaque source plafonnait ses valeurs de découpage : une valeur « Autres »
    // pour l'une n'avait pas de série pour l'autre. Série à zéro explicite.
    const rows = (types) => types.flatMap(([type, n]) =>
        Array.from({ length: n }, () => ({ day: day('2024-06-01'), cache_type: type })));
    const tables = {
        finds: tableFromRecords(rows([['A', 2], ['B', 1]]), { source: 'finds' }),
        dnf: tableFromRecords(rows([['B', 1], ['C', 2]]), { source: 'dnf' }),
    };
    const spec = normalizeChartSpec({
        source: 'finds', extraSources: ['dnf'], groupBy: 'year', splitBy: 'cache_type',
        periods: [{ kind: 'all' }],
    });
    const result = runChartQueries(spec, (s) => tables[s], { today: TODAY });
    assert.deepEqual(result.series.map((s) => [s.source, s.split]), [
        ['finds', 'A'], ['finds', 'B'], ['finds', 'C'],
        ['dnf', 'A'], ['dnf', 'B'], ['dnf', 'C'],
    ]);
    assert.deepEqual(result.series[2].values, [0]);  // pas de C dans les trouvailles
    assert.deepEqual(result.series[3].values, [0]);  // pas de A dans les DNF
});

test('plusieurs sources : années de publication sur une étendue commune ordonnée', () => {
    // Chaque source fixait sa propre étendue (2020-2022 vs 2019 et 2023) :
    // l'union n'était pas triée ([2020, 2021, 2022, 2019, 2023]).
    const finds = tableFromRecords([
        { day: day('2024-01-05'), published: day('2020-01-01') },
        { day: day('2024-01-06'), published: day('2022-01-01') },
    ], { source: 'finds' });
    const dnf = tableFromRecords([
        { day: day('2024-01-07'), published: day('2019-01-01') },
        { day: day('2024-01-08'), published: day('2023-01-01') },
    ], { source: 'dnf' });
    const spec = normalizeChartSpec({
        source: 'finds', extraSources: ['dnf'], groupBy: 'published_year',
        periods: [{ kind: 'all' }],
    });
    const result = runChartQueries(spec, (s) => ({ finds, dnf })[s], { today: TODAY });
    assert.deepEqual(result.keys, [2019, 2020, 2021, 2022, 2023]);
    assert.deepEqual(result.series.map((s) => s.values), [[0, 1, 0, 1, 0], [1, 0, 0, 0, 1]]);
});
