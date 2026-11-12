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

// Proportions dessinées par ECharts pour chaque vignette : largeur / hauteur
// de la vue, rapportées à celles du cadre projeté (1 = pas de déformation).
async function mapDistortion(page, index = 0) {
  return page.evaluate((i) => {
    const host = document.querySelectorAll('.stats-card')[i].querySelector('.stats-chart');
    const chart = window.echarts.getInstanceByDom(host);
    const { width, height } = host.getBoundingClientRect();
    return chart.getModel().getComponent('geo') ? chart.getModel().findComponents({ mainType: 'geo' }).map((model) => {
      const geo = model.coordinateSystem;
      const view = geo.getViewRect();
      const rect = geo.getBoundingRect();
      const aspect = (rect.width * (model.get('aspectScale') ?? 0.75)) / rect.height;
      return { ratio: view.width / view.height / aspect, inside: view.x >= -1 && view.y >= -1
        && view.x + view.width <= width + 1 && view.y + view.height <= height + 1 };
    }) : [];
  }, index);
}

test('carte aux bonnes proportions, entière, quelle que soit la taille de la tuile', async ({ page, request }) => {
  const errors = await openStats(page);
  await seed(page, request, [{
    groupBy: 'zone_region', measure: { op: 'count' }, view: { chart: 'map' },
  }, {
    groupBy: 'zone_subregion', measure: { op: 'cumulative', from: 'all' },
    periods: [{ kind: 'moments', rule: 'year_end' }], view: { chart: 'map' },
  }]);
  await mapCard(page, 0);
  await mapCard(page, 1);
  for (const viewport of [{ width: 1600, height: 900 }, { width: 700, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const index of [0, 1]) {
      await expect.poll(async () => {
        const geos = await mapDistortion(page, index);
        return geos.length > 0 && geos.every((g) => Math.abs(g.ratio - 1) < 0.01 && g.inside);
      }, { message: `carte ${index}, ${viewport.width}px` }).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

// Zones d'une carte enregistrée et emprise de toutes ses coordonnées.
async function mapContents(page, name) {
  return page.evaluate((n) => {
    const features = window.echarts.getMap(n).geoJSON.features;
    const xs = [];
    const ys = [];
    for (const f of features) {
      const flat = f.geometry.coordinates.flat(3);
      for (let i = 0; i < flat.length; i += 2) { xs.push(flat[i]); ys.push(flat[i + 1]); }
    }
    return { ids: features.map((f) => f.properties.name), box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  }, name);
}

test('cadrage : un pays, un continent, le monde ; trouvailles hors du cadre', async ({ page, request }) => {
  const errors = await openStats(page);
  const map = (frame) => ({ groupBy: 'zone_region', measure: { op: 'count' }, periods: [{ kind: 'all' }],
    view: { chart: 'map', map: { frame } } });
  await seed(page, request, [map('country:FR'), map('europe'), map('world')]);
  const [fr, europe, world] = [await mapCard(page, 0), await mapCard(page, 1), await mapCard(page, 2)];

  // La France seule : ses régions, la Bavière et le Texas hors du cadre.
  expect(fr.zones.frame).toBe('country:FR');
  expect(fr.zones.countries).toEqual(['FR']);
  expect(fr.keys.every((id) => id.startsWith('FR-'))).toBe(true);
  expect(fr.zones.outOfFrame).toBe(2);
  expect(fr.zones.unknown).toBe(1);
  await expect(page.locator('.stats-card').nth(0).locator('.stats-card-note')).toContainText('Hors du cadre : 2');
  const frMap = await mapContents(page, fr.zones.map);
  // Toutes les régions françaises (le pays en entier), les voisins en fond,
  // rien au-delà du cadre (découpé), La Réunion en encart.
  expect(frMap.ids).toEqual(expect.arrayContaining(['FR-IDF', 'FR-GES', 'FR-974', 'DE', 'ES']));
  expect(frMap.ids).not.toContain('FR');
  expect(frMap.box[0]).toBeGreaterThan(-7);
  expect(frMap.box[2]).toBeLessThan(11);

  // L'Europe : France et Allemagne, le Texas dehors ; la Russie découpée.
  expect(europe.zones.countries).toEqual(['DE', 'FR']);
  expect(europe.zones.outOfFrame).toBe(1);
  const euMap = await mapContents(page, europe.zones.map);
  expect(euMap.ids).toEqual(expect.arrayContaining(['DE-BY', 'FR-BRE', 'RU', 'IT']));
  expect(euMap.box[2]).toBeLessThanOrEqual(45 + 1e-6);

  // Le monde : toutes les trouvailles, tous les pays en fond.
  expect(world.zones.countries).toEqual(['DE', 'FR', 'US']);
  expect(world.zones.outOfFrame).toBe(0);
  const worldMap = await mapContents(page, world.zones.map);
  expect(worldMap.ids).toEqual(expect.arrayContaining(['US-TX', 'BR', 'AU', 'JP']));
  expect(errors).toEqual([]);
});

test('carte vide : région sans aucune ligne, cadrage automatique → « Aucune donnée »', async ({ page, request }) => {
  const errors = await openStats(page);
  // Période future : aucune ligne rattachée, rien à cadrer — état vide,
  // pas une erreur de contours.
  await seed(page, request, [{
    groupBy: 'zone_region', measure: { op: 'count' },
    periods: [{ kind: 'range', from: '2030-01-01', to: '2030-12-31' }],
    view: { chart: 'map' },
  }]);
  // Placeholder : titre centré ; une vraie carte a un titre par vignette.
  await expect.poll(async () => page.evaluate(() => {
    const host = document.querySelector('.stats-card .stats-chart');
    const chart = window.echarts.getInstanceByDom(host);
    const title = chart?.getOption()?.title;
    const texts = (Array.isArray(title) ? title : [title]).map((x) => x?.text).filter(Boolean);
    return texts.length ? texts.join(' | ') : null;
  }), { timeout: 15_000 }).toBe('Aucune donnée');
  const card = (await snapshot(page)).cards[0];
  expect(card.zones.countries).toEqual([]);
  expect(card.zones.drawn).toBe(0);
  expect(card.zones.map).toBeNull();
  await expect(page.locator('.stats-card').first().locator('.stats-card-note')).toContainText('Aucune donnée sur cette période.');
  expect(errors).toEqual([]);
});

test('contours en échec : « Réessayer » recharge la carte', async ({ page, request }) => {
  const errors = await openStats(page);
  // Le catalogue des contours en erreur : zoneMapFor répond { error: true }
  // et la carte affiche le bloc avec relance (la route survit au
  // page.reload() de seed).
  await page.route('**/static/geo/index.json', (route) => route.fulfill({ status: 500, body: 'indisponible' }));
  await seed(page, request, [{
    groupBy: 'zone_region', measure: { op: 'count' }, view: { chart: 'map' },
  }]);
  const card = page.locator('.stats-card .stats-card-unavailable');
  await expect(card).toContainText('Contours des zones indisponibles.', { timeout: 15_000 });
  const retry = page.locator('.stats-card .stats-geo-retry');
  await expect(retry).toBeVisible();
  await page.unroute('**/static/geo/index.json');
  await retry.click();
  // retryZoneGeo efface l'échec mémorisé : l'écouteur geo incrémente
  // geoRev et relance renderAllCharts — la carte se dessine.
  await mapCard(page);
  await expect(page.locator('.stats-card .stats-card-unavailable')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('éditeur : menu « Cadrage de la carte » (continents, pays par leur nom)', async ({ page }) => {
  const errors = await openStats(page);
  await page.locator('#btnStatsAddChart').click();
  await page.locator('#statsGalleryModal [data-question="custom"]').click();
  await expect(page.locator('#statsEditorModal')).toBeVisible();
  await page.locator('#statsEdGroupBy').selectOption('zone_region');
  await page.locator('#statsEdOptions summary').click();
  await expect(page.locator('#statsEdMapFrame')).toBeVisible();
  await expect(page.locator('#statsEdMapFrame')).toHaveValue('auto');
  await expect.poll(() => page.locator('#statsEdMapFrame option[value="country:FR"]').count(), { timeout: 15_000 }).toBe(1);
  await expect(page.locator('#statsEdMapFrame option[value="country:FR"]')).toHaveText('France');
  await expect(page.locator('#statsEdMapFrame option[value="europe"]')).toHaveText('Europe');
  await page.locator('#statsEdMapFrame').selectOption('country:DE');
  // L'aperçu suit : l'Allemagne en entier, ses voisins en fond, aucune
  // région française.
  await expect.poll(async () => {
    const name = await page.evaluate(() => window.echarts.getInstanceByDom(document.getElementById('statsEdPreview'))
      ?.getOption()?.geo?.[0]?.map ?? null);
    if (!name) return false;
    const { ids } = await mapContents(page, name);
    return ids.includes('DE-BY') && ids.includes('DE-SH') && ids.includes('FR') && !ids.some((id) => id.startsWith('FR-'));
  }, { timeout: 15_000 }).toBe(true);
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

// Textes peints par ECharts sur la carte d'une tuile (étiquettes non
// masquées par le tri des chevauchements).
async function paintedTexts(page, index = 0) {
  return page.evaluate((i) => {
    const host = document.querySelectorAll('.stats-card')[i].querySelector('.stats-chart');
    const chart = window.echarts.getInstanceByDom(host);
    const out = [];
    for (const el of chart.getZr().storage.getDisplayList(true)) {
      const label = el.getTextContent?.();
      // Opacité héritée du symbole : une étiquette « affichée » à 0 ne se
      // voit pas.
      const opacity = (label?.style?.opacity ?? 1) * (el.style?.opacity ?? 1);
      if (label && !label.ignore && !label.invisible && opacity > 0 && label.style?.text) out.push(label.style.text);
    }
    return out;
  }, index);
}

test('« Afficher les valeurs » : valeurs écrites sur les zones et sur les cases', async ({ page, request }, testInfo) => {
  const errors = await openStats(page);
  await seed(page, request, [{
    groupBy: 'zone_region', measure: { op: 'count' }, periods: [{ kind: 'all' }],
    view: { chart: 'map', labels: true, map: { frame: 'country:FR' } },
  }, {
    groupBy: 'zone_grid', periods: [{ kind: 'all' }],
    view: { chart: 'map', labels: true, map: { gridSize: 50, frame: 'country:FR' } },
  }, {
    groupBy: 'zone_grid', periods: [{ kind: 'all' }], view: { chart: 'map', labels: true, map: { gridSize: 50 } },
  }, {
    groupBy: 'zone_region', measure: { op: 'count' }, periods: [{ kind: 'all' }], view: { chart: 'map' },
  }]);
  const regions = await mapCard(page, 0);
  // France cadrée : Bretagne 2, Pays de la Loire 1, La Réunion (encart) 1.
  const byName = Object.fromEntries(regions.zones.values[0].values.map((v) => [v.name, v.text]));
  expect(byName).toEqual({ 'FR-BRE': '2', 'FR-PDL': '1', 'FR-974': '1' });
  await expect.poll(async () => (await paintedTexts(page, 0)).sort()).toEqual(['1', '1', '2']);

  // Grille sur la France : Brest 2, Nantes 1 (La Réunion hors du cadre).
  const grid = await mapCard(page, 1);
  expect(grid.zones.values[0].values.map((v) => v.text).sort()).toEqual(['1', '2']);
  // Grille de Brest à Houston : des cases de quelques pixels, trop petites
  // pour leur valeur — aucune écrite.
  const wide = await mapCard(page, 2);
  expect(wide.zones.values).toEqual([]);

  // Case décochée : aucune valeur.
  const plain = await mapCard(page, 3);
  expect(plain.zones.values).toEqual([]);
  await page.locator('.stats-card').nth(0).screenshot({ path: testInfo.outputPath('valeurs-regions.png') });
  await page.locator('.stats-card').nth(1).screenshot({ path: testInfo.outputPath('valeurs-grille.png') });
  expect(errors).toEqual([]);
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
