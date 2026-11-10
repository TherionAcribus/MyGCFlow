// Cartes par zones de la page Statistiques (docs/carte-zones.md, lot 3) :
// mini-cartes aux moments clés, chargement des contours, encarts, éditeur,
// lien vers la carte en pause.
//
// Les trouvailles de la page viennent d'un jeu synthétique servi à la place
// de GET /api/stats/finds (page.route) : France (Bretagne, Loire-Atlantique,
// La Réunion en encart), Bavière, Texas, une hors carte. La base reste celle
// de la fixture my-finds.gpx (6 trouvailles à Paris, janvier 2026), utile au
// lien vers la carte.
//
// Préférences globales partagées (AGENTS.md) : tableaux de bord effacés avant
// chaque test et en sortie.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { importGpx } from './gpx-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

test.describe.configure({ mode: 'serial' });

// date, zone_country, zone_region, zone_subregion (ids), D, T, lat, lon
const ROWS = [
  ['2022-03-01', 'FR', 'FR-BRE', 'FR-29', 1.5, 2, 48.3904, -4.4861],
  ['2023-05-05', 'FR', 'FR-BRE', 'FR-29', 2, 2, 48.3950, -4.4900],
  ['2023-06-06', 'FR', 'FR-PDL', 'FR-44', 1, 1, 47.2184, -1.5536],
  ['2024-02-02', 'FR', 'FR-974', 'FR-974', 3, 4, -20.8821, 55.4504],
  ['2024-08-08', 'DE', 'DE-BY', 'DE-09162', 2, 1.5, 48.1374, 11.5755],
  ['2025-01-10', 'US', 'US-TX', 'US-48201', 1.5, 1.5, 29.7604, -95.3698],
  ['2025-02-02', null, null, null, 1, 1, null, null],
];

function syntheticFinds() {
  const dict = (i) => {
    const list = [];
    const column = ROWS.map((row) => {
      if (!row[i]) return -1;
      if (!list.includes(row[i])) list.push(row[i]);
      return list.indexOf(row[i]);
    });
    return { list, column };
  };
  const country = dict(1);
  const region = dict(2);
  const sub = dict(3);
  const n = ROWS.length;
  const none = Array(n).fill(-1);
  return {
    v: 2,
    count: n,
    date: ROWS.map((r) => r[0]),
    published: Array(n).fill(null),
    kind: Array(n).fill(0),
    code: ROWS.map((_, i) => `GCZ${i}`),
    difficulty: ROWS.map((r) => r[4]),
    terrain: ROWS.map((r) => r[5]),
    lat: ROWS.map((r) => r[6] ?? null),
    lon: ROWS.map((r) => r[7] ?? null),
    cache_type: Array(n).fill(0),
    container: none, country: none, state: none, owner: none,
    attributes: Array(n).fill([]),
    zone_country: country.column,
    zone_region: region.column,
    zone_subregion: sub.column,
    dicts: {
      cache_type: ['Traditional Cache'], container: [], country: [], state: [], owner: [], attribute: [],
      zone_country: country.list, zone_region: region.list, zone_subregion: sub.list,
    },
  };
}

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await importGpx(page, FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await context.close();
});

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/dashboards')).ok()).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await request.delete('/api/dashboards');
});

async function openStats(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/stats/finds', (route) => route.fulfill({ json: syntheticFinds() }));
  await page.goto('/stats', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
  return errors;
}

const snapshot = (page) => page.evaluate(() => window.getStatsPageSnapshot());
const savedDoc = async (request) => (await (await request.get('/api/dashboards')).json()).document;

// Remplace les graphiques du tableau par `specs`, puis recharge.
async function seed(page, request, specs) {
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.length ?? 0).toBeGreaterThan(0);
  const doc = await savedDoc(request);
  doc.dashboards[0].period = { kind: 'all' };
  doc.dashboards[0].items = specs.map((spec, i) => ({ size: 'XL', height: 'L', spec: { id: `abcdef0${i}`, ...spec } }));
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  await page.reload();
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
}

async function mapCard(page, index = 0) {
  await expect.poll(async () => (await snapshot(page)).cards[index]?.zones?.drawn ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  return (await snapshot(page)).cards[index];
}

test('carte aux fins d\'année : contours chargés, vignettes, encart de La Réunion', async ({ page, request }) => {
  const errors = await openStats(page);
  await seed(page, request, [{
    groupBy: 'zone_subregion', measure: { op: 'cumulative', from: 'all' },
    periods: [{ kind: 'moments', rule: 'year_end' }], view: { chart: 'map' },
  }]);
  const card = await mapCard(page);
  expect(card.chart).toBe('map');
  expect(card.zones.level).toBe('subregion');
  expect(card.zones.countries).toEqual(['DE', 'FR', 'US']);
  expect(card.periods).toEqual(['2022', '2023', '2024', '2025']);
  expect(card.zones.drawn).toBe(4);
  expect(card.zones.map).toMatch(/^mgz-/);
  expect(card.zones.unknown).toBe(1);
  // Cumul : le Finistère à 1, puis 2 ; Loire-Atlantique apparaît en 2023.
  const k = (id) => card.keys.indexOf(id);
  expect(card.series.map((values) => values[k('FR-29')])).toEqual([1, 2, 2, 2]);
  expect(card.series.map((values) => values[k('FR-44')])).toEqual([null, 1, 1, 1]);
  expect(card.zones.changed[1]).toEqual(expect.arrayContaining(['FR-29', 'FR-44']));
  expect(card.zones.legend.length).toBeGreaterThan(0);
  await expect(page.locator('.stats-card').first().locator('.stats-card-note')).toContainText('Hors carte : 1');

  // La Réunion, avec de la métropole sur la carte : déplacée en encart
  // (au nord de son -21° réel) ; l'Alaska, sans donnée, hors du cadre.
  const placed = await page.evaluate((name) => {
    const features = window.echarts.getMap(name).geoJSON.features;
    const reunion = features.find((f) => f.properties.name === 'FR-974');
    const ys = reunion.geometry.coordinates.flat(3).filter((_, i) => i % 2 === 1);
    return { reunionLat: Math.min(...ys), alaska: features.some((f) => f.properties.name.startsWith('US-02')) };
  }, card.zones.map);
  expect(placed.reunionLat).toBeGreaterThan(0);
  expect(placed.alaska).toBe(false);

  // Noms des zones (contours chargés) dans « Voir les valeurs ».
  expect(await page.evaluate(() => window.getStatsPageSnapshot && document.documentElement.lang)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('éditeur : un regroupement par zones ne propose que la carte', async ({ page }) => {
  const errors = await openStats(page);
  await page.locator('#btnStatsAddChart').click();
  await page.locator('#statsGalleryModal [data-question="custom"]').click();
  await expect(page.locator('#statsEditorModal')).toBeVisible();
  const zoneOptions = await page.locator('#statsEdGroupBy optgroup[label="Sur une carte"] option').evaluateAll((list) => list.map((o) => o.value));
  expect(zoneOptions).toEqual(['zone_country', 'zone_region', 'zone_subregion', 'zone_grid']);
  await page.locator('#statsEdGroupBy').selectOption('zone_region');
  await expect(page.locator('#statsEdChart option')).toHaveText(['carte']);
  // Mesures propres aux cartes proposées, densité possible.
  await page.locator('#statsEdMeasure').selectOption('dt_coverage');
  await expect(page.locator('#statsEdGroupBy')).toHaveValue('zone_region');
  await expect.poll(() => page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('statsEdPreview'));
    return chart?.getOption()?.geo?.length ?? 0;
  }), { timeout: 15_000 }).toBe(1);
  expect(errors).toEqual([]);
});

test('clic sur une zone : la carte s\'ouvre en pause, cadrée sur la zone', async ({ page, request }) => {
  await openStats(page);
  await seed(page, request, [{ groupBy: 'zone_subregion', periods: [{ kind: 'all' }], view: { chart: 'map' } }]);
  const card = await mapCard(page);
  expect(card.linksToMap).toBe(true);
  await page.evaluate((id) => {
    const host = document.querySelector(`.stats-card[data-chart-id="${id}"] .stats-chart`);
    window.echarts.getInstanceByDom(host).trigger('click', { componentType: 'series', seriesType: 'map', name: 'FR-29', seriesIndex: 0 });
  }, card.id);
  const modal = page.locator('.gcm-confirm-modal');
  await expect(modal).toContainText('Finistère');
  await modal.locator('[data-gcm-role="confirm"]').click();
  await page.waitForURL(/\/\?at=2025-02-02&bbox=/);
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await expect.poll(() => page.evaluate(() => window.mygcflowEntryLink?.applied ?? null), { timeout: 30_000 }).toBe(true);
  expect(await page.evaluate(async () => (await import('/static/js/index.js')).previewPlaybackState())).toBe('paused');
  // Paramètres retirés de l'adresse : un rechargement ne rejoue rien.
  expect(new URL(page.url()).search).toBe('');
  await page.locator('#btnQuickStop').click();
  await expect.poll(() => page.evaluate(async () => (await import('/static/js/index.js')).previewPlaybackState())).toBe('idle');
});

test('grille : cases calculées, sans fichier de contours, taille réglable', async ({ page, request }) => {
  const errors = await openStats(page);
  await seed(page, request, [{
    groupBy: 'zone_grid', periods: [{ kind: 'all' }], view: { chart: 'map', map: { gridSize: 50 } },
  }]);
  const card = await mapCard(page);
  expect(card.zones.level).toBe('grid');
  // Brest (2), Nantes, La Réunion, Munich, Houston : 5 cases ; une ligne
  // sans position hors carte.
  expect(card.keys).toHaveLength(5);
  expect(card.keys.every((id) => /^h50\//.test(id))).toBe(true);
  expect(card.series[0][0]).toBe(2);
  expect(card.zones.unknown).toBe(1);
  expect(card.zones.map).toMatch(/^mgz-/);
  expect(errors).toEqual([]);
});
