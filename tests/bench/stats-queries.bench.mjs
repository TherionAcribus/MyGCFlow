// Benchmark des requêtes de la page Statistiques, hors navigateur : le temps
// de `runChartQueries` sur des tables synthétiques de taille réaliste.
//
//   node tests/bench/stats-queries.bench.mjs [--rows 50000] [--runs 7]
//
// Mesure le CALCUL seul ; le dessin ECharts se mesure dans le navigateur
// (tests/bench/stats-render.bench.mjs, mesures « stats:compute/draw »).

import { performance } from 'node:perf_hooks';
import { tableFromRecords } from '../../static/js/chart_sources.mjs';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { runChartQueries } from '../../static/js/chart_query.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const arg = (name, fallback) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const ROWS = arg('rows', 50_000);
const RUNS = arg('runs', 7);
const TODAY = dayNumber({ y: 2026, m: 11, d: 10 });

// Générateur déterministe (mulberry32) : les mêmes données à chaque run.
const rng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

const CACHE_TYPES = ['Traditional Cache', 'Multi-cache', 'Unknown Cache', 'Letterbox Hybrid',
    'Earthcache', 'Wherigo Cache', 'Virtual Cache', 'Event Cache', 'Mega-Event Cache',
    'Webcam Cache', 'Project APE Cache'];
const TYPE_WEIGHTS = [55, 14, 12, 4, 4, 3, 3, 2, 1, 1, 1]; // pondération réaliste
const CONTAINERS = ['micro', 'small', 'regular', 'large', 'other'];
const weighted = (rand) => {
    let x = rand() * 100;
    for (let i = 0; i < TYPE_WEIGHTS.length; i++) {
        x -= TYPE_WEIGHTS[i];
        if (x < 0) return CACHE_TYPES[i];
    }
    return CACHE_TYPES[0];
};

function makeRecords(n, { countries = 30, counties = 90, owners = 400, years = 11 } = {}) {
    const rand = rng(42);
    const first = dayNumber({ y: 2026 - years + 1, m: 1, d: 1 });
    const span = TODAY - first;
    const countryNames = Array.from({ length: countries }, (_, i) => `Pays ${i + 1}`);
    const countyNames = Array.from({ length: counties }, (_, i) => `Dpt ${String(i + 1).padStart(2, '0')}`);
    const ownerNames = Array.from({ length: owners }, (_, i) => `Poseur ${i + 1}`);
    const records = [];
    for (let i = 0; i < n; i++) {
        // Trouvailles en légère croissance dans le temps + saisonnalité.
        const t = Math.pow(rand(), 0.8);
        const day = first + Math.floor(t * span);
        const country = pick(rand, countryNames);
        records.push({
            day,
            published: day - Math.floor(rand() * 2500),
            code: 'GC' + (100000 + i).toString(36).toUpperCase(),
            difficulty: (1 + Math.floor(rand() * 9)) * 0.5,
            terrain: (1 + Math.floor(rand() * 9)) * 0.5,
            cache_type: weighted(rand),
            container: pick(rand, CONTAINERS),
            country,
            state: `Région ${Math.floor(rand() * Math.ceil(countries / 3)) + 1}`,
            county: pick(rand, countyNames),
            owner: pick(rand, ownerNames),
        });
    }
    return records;
}

// Tableaux de bord types : la galerie et les tableaux usités, dans l'ordre
// d'un vrai tableau (~20 cartes : chiffres, séries, cartes, défis).
const SPECS = [
    ['chiffre clé', { groupBy: 'none', view: { chart: 'number' } }],
    ['chiffre clé, année', { groupBy: 'none', periods: [{ kind: 'current', unit: 'year' }], view: { chart: 'number' } }],
    ['barres par année', { groupBy: 'year', view: { chart: 'bar' } }],
    ['cumul par mois', { groupBy: 'month', measure: { op: 'cumulative' }, view: { chart: 'line' } }],
    ['cumul multi-années', { groupBy: 'day_of_year', measure: { op: 'cumulative' },
        periods: Array.from({ length: 8 }, (_, i) => ({ kind: 'year', year: 2019 + i })),
        view: { chart: 'line' } }],
    ['mois de l’année × 8 ans', { groupBy: 'month_of_year',
        periods: Array.from({ length: 8 }, (_, i) => ({ kind: 'year', year: 2019 + i })),
        view: { chart: 'line' } }],
    ['types (anneau)', { groupBy: 'cache_type', view: { chart: 'donut' } }],
    ['types × année', { groupBy: 'year', splitBy: 'cache_type', view: { chart: 'bar', stack: true } }],
    ['contenants', { groupBy: 'container', view: { chart: 'bar' } }],
    ['D/T (grille)', { groupBy: 'dt', view: { chart: 'challenge' } }],
    ['calendrier (défi)', { groupBy: 'day_of_year', view: { chart: 'challenge' } }],
    ['jour de l’année (carte thermique)', { groupBy: 'day_of_year', view: { chart: 'heatmap' } }],
    ['jour de semaine', { groupBy: 'weekday', view: { chart: 'bar' } }],
    ['année de publication', { groupBy: 'published_year', view: { chart: 'bar' } }],
    ['âge des caches', { groupBy: 'age', view: { chart: 'bar' } }],
    ['départements (top)', { groupBy: 'county', view: { chart: 'bar', top: 12 } }],
    ['pays (carte)', { groupBy: 'zone_country', view: { chart: 'map' } }],
    ['caches distinctes par mois', { groupBy: 'month', measure: { op: 'distinct_caches' }, view: { chart: 'bar' } }],
    ['comparaison finds + dnf', { source: 'finds', extraSources: ['dnf'], groupBy: 'year', view: { chart: 'bar' } }],
    ['plage personnalisée', { groupBy: 'day', periods: [{ kind: 'range', from: '2024-01-01', to: '2024-12-31' }], view: { chart: 'bar' } }],
];

console.log(`Table : ${ROWS.toLocaleString('fr-FR')} lignes, ${RUNS} passages (médiane)`);
const t0 = performance.now();
const finds = tableFromRecords(makeRecords(ROWS), { source: 'finds' });
const dnf = tableFromRecords(makeRecords(Math.round(ROWS * 0.04)), { source: 'dnf' });
const tables = { finds, dnf };
const tableOf = (source) => tables[source] || finds;
console.log(`Construction : ${(performance.now() - t0).toFixed(0)} ms\n`);

const rows = [];
for (const [name, overrides] of SPECS) {
    const spec = normalizeChartSpec({ id: 'bench', ...overrides });
    runChartQueries(spec, tableOf, { today: TODAY }); // chauffe le JIT
    const times = [];
    for (let r = 0; r < RUNS; r++) {
        const t1 = performance.now();
        runChartQueries(spec, tableOf, { today: TODAY });
        times.push(performance.now() - t1);
    }
    times.sort((a, b) => a - b);
    rows.push({ name, median: times[Math.floor(times.length / 2)], max: times.at(-1) });
}
rows.sort((a, b) => b.median - a.median);
for (const r of rows) {
    console.log(`${r.median.toFixed(1).padStart(8)} ms   (max ${r.max.toFixed(1)})   ${r.name}`);
}
console.log(`\nSomme des médianes ≈ ${rows.reduce((a, r) => a + r.median, 0).toFixed(0)} ms pour ${rows.length} graphiques (calcul seul, même thread que l'UI).`);
