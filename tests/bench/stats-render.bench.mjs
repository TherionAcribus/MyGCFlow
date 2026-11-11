// Benchmark de rendu de la page Statistiques, dans un vrai navigateur :
// temps jusqu'à « prêt », calcul et dessin par graphique (mesures
// « stats:compute » / « stats:draw » posées dans renderCard).
//
//   node tests/bench/stats-render.bench.mjs [--rows 20000] [--cards 20]
//
// Sert l'application sur un runtime jetable (comme les tests E2E) et
// intercepte /api/stats/finds avec une charge synthétique — pas d'import
// GPX, pas de données réelles.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const ROWS = arg('rows', 20_000);
const CARDS = arg('cards', 20);
const PORT = arg('port', 5017);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');

// --------------------------------------------------------------------------
// Charge /api/stats/finds synthétique : { count, date[], dicts{}, colonnes… }
// --------------------------------------------------------------------------

const rng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const CACHE_TYPES = ['Traditional Cache', 'Multi-cache', 'Unknown Cache', 'Letterbox Hybrid',
    'Earthcache', 'Wherigo Cache', 'Virtual Cache', 'Event Cache', 'Webcam Cache'];
const TYPE_WEIGHTS = [55, 14, 12, 5, 4, 4, 3, 2, 1];

function findsPayload(n) {
    const rand = rng(42);
    const first = Date.UTC(2015, 0, 1), span = Date.UTC(2026, 10, 10) - first;
    const dicts = {
        cache_type: CACHE_TYPES,
        container: ['micro', 'small', 'regular', 'large'],
        country: Array.from({ length: 30 }, (_, i) => `Pays ${i + 1}`),
        county: Array.from({ length: 90 }, (_, i) => `Dpt ${String(i + 1).padStart(2, '0')}`),
        owner: Array.from({ length: 400 }, (_, i) => `Poseur ${i + 1}`),
        zone_country: Array.from({ length: 30 }, (_, i) => `zone-${i}`),
        attribute: [],
    };
    const pick = (list) => Math.floor(rand() * list.length);
    const payload = { count: n, dicts, date: [], published: [], code: [], kind: [],
        difficulty: [], terrain: [], lat: [], lon: [], attributes: [] };
    for (const field of Object.keys(dicts)) if (field !== 'attribute') payload[field] = [];
    for (let i = 0; i < n; i++) {
        const t = Math.pow(rand(), 0.8);
        const ts = first + Math.floor(t * span / 86400000) * 86400000;
        payload.date.push(new Date(ts).toISOString().slice(0, 10));
        payload.published.push(new Date(ts - Math.floor(rand() * 2000) * 86400000).toISOString().slice(0, 10));
        payload.code.push('GC' + (100000 + i).toString(36).toUpperCase());
        payload.kind.push(0);
        payload.difficulty.push((1 + Math.floor(rand() * 9)) * 0.5);
        payload.terrain.push((1 + Math.floor(rand() * 9)) * 0.5);
        payload.lat.push(40 + rand() * 10);
        payload.lon.push(-5 + rand() * 15);
        payload.attributes.push([]);
        for (const field of Object.keys(dicts)) {
            if (field === 'attribute') continue;
            let idx;
            if (field === 'cache_type') {
                let x = rand() * 100;
                for (idx = 0; idx < TYPE_WEIGHTS.length && (x -= TYPE_WEIGHTS[idx]) >= 0; idx++);
                idx = Math.min(idx, CACHE_TYPES.length - 1);
            } else idx = pick(dicts[field]);
            payload[field].push(idx);
        }
    }
    return payload;
}

// --------------------------------------------------------------------------
// Tableau de bord : les graphiques les plus représentatifs d'un usage réel.
// --------------------------------------------------------------------------

let seq = 0;
const item = (spec, size = 'M') => ({ size, spec: { id: `bench${(seq++).toString(16).padStart(2, '0')}`, ...spec } });
const yearPeriods = Array.from({ length: 8 }, (_, i) => ({ kind: 'year', year: 2019 + i }));

function dashboardDoc(n) {
    const catalog = [
        item({ groupBy: 'none', view: { chart: 'number' } }, 'S'),
        item({ groupBy: 'none', periods: [{ kind: 'current', unit: 'year' }], view: { chart: 'number' } }, 'S'),
        item({ groupBy: 'year', view: { chart: 'bar' } }),
        item({ groupBy: 'month', measure: { op: 'cumulative' }, view: { chart: 'line' } }),
        item({ groupBy: 'day_of_year', measure: { op: 'cumulative' }, periods: yearPeriods, view: { chart: 'line' } }),
        item({ groupBy: 'month_of_year', periods: yearPeriods, view: { chart: 'line' } }),
        item({ groupBy: 'cache_type', view: { chart: 'donut' } }),
        item({ groupBy: 'year', splitBy: 'cache_type', view: { chart: 'bar', stack: true } }),
        item({ groupBy: 'container', view: { chart: 'bar' } }),
        item({ groupBy: 'dt', view: { chart: 'challenge' } }, 'L'),
        item({ groupBy: 'day_of_year', view: { chart: 'challenge' } }, 'L'),
        item({ groupBy: 'day_of_year', view: { chart: 'heatmap' } }, 'L'),
        item({ groupBy: 'weekday', view: { chart: 'bar' } }),
        item({ groupBy: 'published_year', view: { chart: 'bar' } }),
        item({ groupBy: 'age', view: { chart: 'bar' } }),
        item({ groupBy: 'county', view: { chart: 'bar', top: 12 } }),
        item({ groupBy: 'zone_country', view: { chart: 'map' } }, 'L'),
        item({ groupBy: 'month', measure: { op: 'distinct_caches' }, view: { chart: 'bar' } }),
        item({ groupBy: 'hour', view: { chart: 'bar' } }),
        item({ groupBy: 'owner', view: { chart: 'bar', top: 12 } }),
        item({ groupBy: 'week', view: { chart: 'line' } }, 'L'),
        item({ groupBy: 'year', periods: [{ kind: 'each', unit: 'month' }], view: { chart: 'heatmap' } }, 'XL'),
    ];
    return { v: 1, active: 'benchdb', dashboards: [
        { id: 'benchdb', name: 'Benchmark', period: { kind: 'all' }, items: catalog.slice(0, n) },
    ] };
}

// --------------------------------------------------------------------------
// Serveur jetable (même mécanisme que playwright.config.mjs › webServer).
// --------------------------------------------------------------------------

const runtime = mkdtempSync(path.join(tmpdir(), 'mygcflow-e2e-'));
const localVenv = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');
const python = existsSync(localVenv) ? localVenv : 'python';
const server = spawn(python, ['tests/e2e/run_server.py'], {
    cwd: ROOT,
    env: { ...process.env, MYGCFLOW_E2E_RUNTIME: runtime, MYGCFLOW_E2E_PORT: String(PORT),
        PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    stdio: 'ignore',
});

const base = `http://127.0.0.1:${PORT}`;
const waitServer = async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${base}/db_status`)).ok) return;
        } catch { /* pas encore levé */ }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('serveur introuvable');
};

// --------------------------------------------------------------------------
// Mesures.
// --------------------------------------------------------------------------

const summary = (entries, name) => {
    const byChart = new Map();
    for (const e of entries.filter((m) => m.name === name)) {
        const key = e.detail?.chart || '?';
        const list = byChart.get(key) || [];
        list.push(e.duration);
        byChart.set(key, list);
    }
    return [...byChart.entries()].map(([chart, d]) => ({
        chart, n: d.length, total: d.reduce((a, b) => a + b, 0), max: Math.max(...d),
    })).sort((a, b) => b.total - a.total);
};

try {
    await waitServer();
    console.log(`Tableau : ${CARDS} cartes · finds : ${ROWS.toLocaleString('fr-FR')} lignes\n`);
    const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // Finds synthétiques ; les autres sources restent vides.
    const payload = findsPayload(ROWS);
    await page.route('**/api/stats/finds', (route) => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(payload),
    }));
    const put = await page.request.put(`${base}/api/dashboards`, { data: dashboardDoc(CARDS) });
    if (!put.ok()) throw new Error(`PUT /api/dashboards : ${put.status()}`);

    const t0 = performance.now();
    await page.goto(`${base}/stats`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mygcflowStatsReady === true);
    const ready = performance.now() - t0;

    // Dessin des cartes différées (impression = force) puis relevé.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.waitForFunction(() =>
        window.getStatsPageSnapshot().cards.every((c) => !c.deferred), null, { timeout: 60_000 });
    const measures = await page.evaluate(() => performance.getEntriesByType('measure')
        .filter((m) => m.name.startsWith('stats:'))
        .map((m) => ({ name: m.name, duration: m.duration, detail: m.detail })));
    const snap = await page.evaluate(() => window.getStatsPageSnapshot());
    await browser.close();

    console.log(`Prêt en ${ready.toFixed(0)} ms (${snap.cards.length} cartes, ${snap.cards.filter((c) => c.rendered).length} dessinées après forçage)`);
    for (const phase of ['stats:compute', 'stats:draw']) {
        const stats = summary(measures, phase);
        const total = stats.reduce((a, s) => a + s.total, 0);
        console.log(`\n${phase} — ${total.toFixed(0)} ms au total :`);
        for (const s of stats) {
            console.log(`  ${s.total.toFixed(1).padStart(8)} ms  ×${String(s.n).padStart(2)}  (max ${s.max.toFixed(1)})   ${s.chart}`);
        }
    }
} finally {
    server.kill();
    try { rmSync(runtime, { recursive: true, force: true }); } catch { /* SQLite reste parfois ouvert */ }
}
