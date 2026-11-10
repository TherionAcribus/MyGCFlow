// Couche de zones colorées de la carte (onglet Zones, docs/carte-zones.md ›
// Couche de la carte, lot 4).
//
// Fixture my-finds-zones.gpx : 8 trouvailles du 1ᵉʳ au 8 janvier 2026 —
// Paris 3 (1ᵉʳ, 2, 8), Finistère 3 (4, 5, 6), Loire-Atlantique 1 (3),
// Rhône 1 (7). Échelle par quantiles sur [1, 1, 3, 3] : deux classes, Paris
// et le Finistère dans la plus forte à la fin.
//
// Préférence globale partagée (AGENTS.md) : `zones_display` remise à false
// en sortie, persistance attendue ; la base est rendue à my-finds.gpx.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { importGpx } from './gpx-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds-zones.gpx');
const DEFAULT_FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
// Jeu Évolution : Finistère (GC1A01 01/01/2020 ; GC1A02 03/01, archivée le
// 06/01) et Bas-Rhin (GC1A04 02/01 ; GC1A05 04/01, archivée le 08/01 ;
// GC1A06 07/01) ; GC1A03, archivée sans date, masquée par défaut.
const EVOLUTION_FIXTURE = path.join(HERE, 'fixtures', 'evolution-a.csv');

test.describe.configure({ mode: 'serial' });

async function openMap(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  return errors;
}

const zones = (page) => page.evaluate(async () => (await import('/static/js/index.js')).getZoneLayerDebugState());
const app = (page, fn, arg) => page.evaluate(async ({ body, arg }) => {
  const pkg = await import('/static/js/index.js');
  return new Function('pkg', 'arg', body)(pkg, arg);
}, { body: fn, arg });

async function setDisplay(request, on, key = 'zones_display') {
  expect((await request.put('/api/settings', { data: { [key]: on } })).ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get('/api/settings')).json())[key]).toBe(on);
}

async function deleteAllDatasets(request) {
  const res = await request.get('/api/evolution/datasets');
  for (const dataset of (await res.json()).datasets) await request.delete(`/api/evolution/datasets/${dataset.id}`);
}

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await openMap(page);
  await importGpx(page, FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 45_000 });
  await context.close();
});

test.afterAll(async ({ browser, request }, testInfo) => {
  await setDisplay(request, false);
  await setDisplay(request, false, 'evolution_zones_display');
  await deleteAllDatasets(request);
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await openMap(page);
  await importGpx(page, DEFAULT_FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await context.close();
});

test('onglet Zones : la couche s\'affiche à l\'état final, la préférence est enregistrée', async ({ page, request }) => {
  await setDisplay(request, false);
  const errors = await openMap(page);
  expect((await zones(page)).visible).toBe(false);
  await page.locator('a[href="#zones"]').click();
  await page.locator('#switchZonesDisplay').check();
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');
  const state = await zones(page);
  expect(state.visible).toBe(true);
  expect(state.onMap).toBe(true);
  expect(state.level).toBe('subregion');
  expect(state.countries).toEqual(['FR']);
  expect(state.features).toBe(101);
  expect(state.values).toEqual({ 'FR-75': 3, 'FR-44': 1, 'FR-29': 3, 'FR-69': 1 });
  expect(state.classes).toEqual({ 'FR-75': 1, 'FR-44': 0, 'FR-29': 1, 'FR-69': 0 });
  expect(state.legend.entries.map((e) => e.label)).toEqual(['1–2', '3']);
  await expect(page.locator('#zoneLegend')).toBeVisible();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).zones_display).toBe(true);
  expect(errors).toEqual([]);
});

test('aperçu : les zones suivent les jours, sauts et lecture compris', async ({ page, request }) => {
  await setDisplay(request, true);
  const errors = await openMap(page);
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');
  expect(await app(page, 'return pkg.startPausedPreview();')).toBe(true);
  // Départ : rien avant le 1ᵉʳ janvier.
  await app(page, 'pkg.seekAnimationToDate(new Date(2026, 0, 1));');
  expect((await zones(page)).classes).toEqual({ 'FR-75': 0 });
  await app(page, 'pkg.seekAnimationToDate(new Date(2026, 0, 5));');
  let state = await zones(page);
  expect(state.values).toEqual({ 'FR-75': 2, 'FR-44': 1, 'FR-29': 2 });
  // Échelle de la fin : 2 reste dans la classe basse.
  expect(state.classes).toEqual({ 'FR-75': 0, 'FR-44': 0, 'FR-29': 0 });
  await app(page, 'pkg.seekAnimationToDate(new Date(2026, 0, 8));');
  expect((await zones(page)).classes).toEqual({ 'FR-75': 1, 'FR-44': 0, 'FR-29': 1, 'FR-69': 0 });

  // Retour au début puis lecture jusqu'au bout : les mêmes classes, par
  // fondus (révision qui avance).
  await app(page, 'pkg.seekAnimationToDate(new Date(2026, 0, 1));');
  const before = (await zones(page)).revision;
  await page.locator('#btnQuickPause').click();
  await expect.poll(async () => (await zones(page)).classes, { timeout: 30_000 })
    .toEqual({ 'FR-75': 1, 'FR-44': 0, 'FR-29': 1, 'FR-69': 0 });
  expect((await zones(page)).revision).toBeGreaterThan(before + 3);
  if (await app(page, 'return pkg.previewPlaybackState();') !== 'idle') await page.locator('#btnQuickStop').click();
  await expect.poll(() => app(page, 'return pkg.previewPlaybackState();')).toBe('idle');
  expect((await zones(page)).animating).toBe(false);
  expect(errors).toEqual([]);
});

test('thème : découpage, couleur selon la date, légende ; légende peinte dans la vidéo', async ({ page, request }) => {
  await setDisplay(request, true);
  const errors = await openMap(page);
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');
  await page.locator('a[href="#zones"]').click();

  await page.locator('#zonesLevel').selectOption('region');
  await expect.poll(async () => Object.keys((await zones(page)).classes).sort(), { timeout: 20_000 })
    .toEqual(['FR-ARA', 'FR-BRE', 'FR-IDF', 'FR-PDL']);
  expect((await zones(page)).features).toBe(18);

  // Grille : une case par groupe de trouvailles proches (Paris, Nantes,
  // Brest, Lyon à 25 km), cases calculées.
  await page.locator('#zonesLevel').selectOption('grid');
  await expect(page.locator('#zonesGridSize')).toBeVisible();
  await expect.poll(async () => (await zones(page)).features, { timeout: 20_000 }).toBe(4);
  expect(Object.keys((await zones(page)).classes).every((id) => /^h25\//.test(id))).toBe(true);
  await page.locator('#zonesGridSize').selectOption('100');
  await expect.poll(async () => Object.keys((await zones(page)).classes).every((id) => /^h100\//.test(id))).toBe(true);
  await page.locator('#zonesLevel').selectOption('region');

  await page.locator('#zonesMeasure').selectOption('first_day');
  await expect.poll(async () => (await zones(page)).scale?.mode).toBe('year');
  await expect(page.locator('#zonesScale')).toBeDisabled();

  // Légende dans une image de la vidéo : coin bas-gauche peint.
  const painted = await app(page, `
    const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 600;
    const ctx = canvas.getContext('2d');
    pkg.addZoneLegendToCanvas(ctx, 800, 600, 1);
    const corner = ctx.getImageData(14, 560, 30, 26).data;
    let alpha = 0;
    for (let i = 3; i < corner.length; i += 4) alpha += corner[i];
    return alpha;`);
  expect(painted).toBeGreaterThan(0);

  await page.locator('#zonesLegend').uncheck();
  await expect(page.locator('#zoneLegend')).toBeHidden();
  expect((await zones(page)).legend).toBe(null);
  await expect(page.locator('#zonesLegendPosition')).toBeDisabled();

  // Couche coupée : rien sur la carte, ni dans la vidéo.
  await page.locator('#switchZonesDisplay').uncheck();
  await expect.poll(async () => (await zones(page)).visible).toBe(false);
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).zones_display).toBe(false);
  expect(errors).toEqual([]);
});

test('Évolution : les zones suivent les caches actives, et pâlissent aux archivages', async ({ page, request }) => {
  await deleteAllDatasets(request);
  await request.put('/api/settings', { data: { evolution_undated_archives: 'hide' } });
  await setDisplay(request, true, 'evolution_zones_display');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/evolution', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
  const loaded = page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('mygcflow:evolution-loaded', (e) => resolve(e.detail), { once: true });
  }));
  await page.locator('#evolutionCsvInput').setInputFiles([EVOLUTION_FIXTURE]);
  expect((await loaded).selected).toBe(5);
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');
  // Au repos : 1 cache active dans le Finistère, 2 dans le Bas-Rhin.
  let state = await zones(page);
  expect(state.values).toEqual({ 'FR-29': 1, 'FR-67': 2 });
  expect(state.classes).toEqual({ 'FR-29': 0, 'FR-67': 1 });
  expect(state.legend.title).toBe('Caches actives');

  expect(await app(page, 'return pkg.startPausedPreview();')).toBe(true);
  await app(page, 'pkg.seekAnimationToDate(new Date(2020, 0, 5));');
  expect((await zones(page)).classes).toEqual({ 'FR-29': 1, 'FR-67': 1 });
  // GC1A02 archivée le 6 : le Finistère pâlit.
  await app(page, 'pkg.seekAnimationToDate(new Date(2020, 0, 6));');
  state = await zones(page);
  expect(state.values).toEqual({ 'FR-29': 1, 'FR-67': 2 });
  expect(state.classes).toEqual({ 'FR-29': 0, 'FR-67': 1 });
  await page.locator('#btnQuickStop').click();
  await expect.poll(() => app(page, 'return pkg.previewPlaybackState();')).toBe('idle');

  // L'onglet Zones existe aussi ici, avec la préférence de la page.
  await page.locator('a[href="#zones"]').click();
  await expect(page.locator('#switchZonesDisplay')).toBeChecked();
  await expect(page.locator('#zonesMeasure option[value="count"]')).toHaveText('Le nombre de caches actives');
  expect(errors).toEqual([]);
});

// Part trouvée (lot 6) : jeu evolution-share.csv, dont les codes croisent
// my-finds-zones.gpx. Finistère : GCZON004 (trouvée le 4), GCZON005 (trouvée
// le 5, archivée le 7), GCZS0001 ; Loire-Atlantique : GCZON003 (trouvée le
// 3), GCZS0002, GCZS0003 (publiée le 5). Toutes publiées en 2025 sauf GCZS0003.
const SHARE_FIXTURE = path.join(HERE, 'fixtures', 'evolution-share.csv');

async function createShareDataset(request) {
  const created = await request.post('/api/evolution/datasets', { data: { name: 'Ouest' } });
  expect(created.status()).toBe(201);
  const { dataset } = await created.json();
  const imported = await request.post(`/api/evolution/datasets/${dataset.id}/import`, {
    multipart: { files: { name: 'evolution-share.csv', mimeType: 'text/csv', buffer: fs.readFileSync(SHARE_FIXTURE) } },
  });
  expect(imported.status()).toBe(202);
  const task = (await imported.json()).task_id;
  await expect.poll(async () => (await (await request.get(`/tasks/${task}`)).json()).state, { timeout: 30_000 }).toBe('finished');
  return dataset.id;
}

const rounded = (values) => Object.fromEntries(Object.entries(values).map(([id, v]) => [id, Math.round(v * 10) / 10]));

test('part trouvée : un jeu Évolution croisé avec mes trouvailles, sur la carte et dans Statistiques', async ({ page, request }) => {
  await deleteAllDatasets(request);
  const datasetId = await createShareDataset(request);
  try {
    await setDisplay(request, true);
    const errors = await openMap(page);
    await page.locator('a[href="#zones"]').click();
    await page.locator('#zonesMeasure').selectOption('found_share');
    // Pas encore de jeu choisi : la couche attend, l'onglet le dit.
    await expect(page.locator('#zonesStatus')).toContainText('Choisissez le jeu Évolution');
    await expect(page.locator('#zonesShareDataset option')).toHaveText(['Choisir un jeu…', 'Ouest']);
    await page.locator('#zonesShareDataset').selectOption(String(datasetId));
    await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');
    await expect(page.locator('#zonesStatus')).toBeHidden();

    // Au repos (8 janvier) : Finistère 1 sur 2 (GCZON005 archivée),
    // Loire-Atlantique 1 sur 3.
    let state = await zones(page);
    expect(rounded(state.values)).toEqual({ 'FR-29': 50, 'FR-44': 33.3 });
    expect(state.parts).toEqual({ 'FR-29': [1, 2], 'FR-44': [1, 3] });
    expect(state.legend.title).toBe('Part des caches actives trouvées');
    expect(state.legend.entries.every((e) => e.label.endsWith('%'))).toBe(true);

    // Dans l'aperçu : la part monte avec mes trouvailles, baisse quand une
    // cache est publiée, remonte quand une cache trouvée est archivée.
    expect(await app(page, 'return pkg.startPausedPreview();')).toBe(true);
    await app(page, 'pkg.seekAnimationToDate(new Date(2026, 0, 2));');
    expect(rounded((await zones(page)).values)).toEqual({ 'FR-29': 0, 'FR-44': 0 });
    await app(page, 'pkg.seekAnimationToDate(new Date(2026, 0, 4));');
    expect(rounded((await zones(page)).values)).toEqual({ 'FR-29': 33.3, 'FR-44': 50 });
    await app(page, 'pkg.seekAnimationToDate(new Date(2026, 0, 5));');
    expect(rounded((await zones(page)).values)).toEqual({ 'FR-29': 66.7, 'FR-44': 33.3 });
    await page.locator('#btnQuickStop').click();
    await expect.poll(() => app(page, 'return pkg.previewPlaybackState();')).toBe('idle');

    // Base « toutes les caches publiées » : l'archivée reste comptée.
    await page.locator('#zonesShareBase').selectOption('all');
    await expect.poll(async () => rounded((await zones(page)).values)).toEqual({ 'FR-29': 66.7, 'FR-44': 33.3 });
    expect((await zones(page)).legend.title).toBe('Part des caches publiées trouvées');

    // Statistiques : la même part, calculée dans la page.
    const doc = { v: 1, active: 'e1', dashboards: [{ id: 'e1', name: 'Ouest', kind: 'evolution',
      dataset: datasetId, period: { kind: 'all' }, items: [{ size: 'XL', height: 'L', spec: {
        id: 'abcdef01', source: `evolution:${datasetId}`, measure: { op: 'found_share' },
        groupBy: 'zone_subregion', periods: [{ kind: 'all' }], view: { chart: 'map' } } }] }] };
    expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
    await page.goto('/stats', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mygcflowStatsReady === true);
    await expect.poll(async () => (await page.evaluate(() => window.getStatsPageSnapshot())).cards[0]?.zones?.drawn ?? 0,
      { timeout: 15_000 }).toBeGreaterThan(0);
    const card = (await page.evaluate(() => window.getStatsPageSnapshot())).cards[0];
    const at = (id) => Math.round(card.series[0][card.keys.indexOf(id)] * 10) / 10;
    expect([at('FR-29'), at('FR-44')]).toEqual([50, 33.3]);
    expect(card.zones.legend.at(-1)).toMatch(/%$/);

    // Page Évolution : le jeu ouvert croisé dans la page avec mes trouvailles.
    await setDisplay(request, true, 'evolution_zones_display');
    await page.goto('/evolution', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
    await app(page, `pkg.options.zones = { ...pkg.options.zones, measure: 'found_share', shareBase: 'active' };
      pkg.syncZoneLayerUI(); pkg.refreshZoneLayer();`);
    await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');
    state = await zones(page);
    expect(rounded(state.values)).toEqual({ 'FR-29': 50, 'FR-44': 33.3 });
    await page.locator('a[href="#zones"]').click();
    await expect(page.locator('#zonesShareDataset')).toHaveCount(0);
    await expect(page.locator('#zonesShareBase')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await request.delete('/api/dashboards');
    await deleteAllDatasets(request);
  }
});

test('rapport de rattachement : noms reconnus, noms à signaler, copie', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = await openMap(page);
  const report = () => app(page, 'return pkg.getZoneReportSnapshot();');
  await page.locator('a[href="#zones"]').click();
  // Fixture : 8 trouvailles en France, toutes reconnues par leur nom.
  await expect.poll(async () => (await report()).status).toBe('ready');
  let snap = await report();
  expect(snap.report.total).toBe(8);
  expect(snap.report.unrecognized).toEqual([]);
  await expect(page.locator('#zonesReportSummary')).toContainText('vos 8 trouvailles sont reconnus');
  await expect(page.locator('#zonesReportDetails')).toBeHidden();
  await expect(page.locator('#linkZonesReportIssue')).toHaveAttribute('href', /\/issues\/new\?template=zones\.yml$/);

  // Un nom de région inconnu (réponse simulée) : liste, hors carte, copie.
  await page.route('**/api/zones/report*', (route) => route.fulfill({ json: {
    v: 1, available: true, total: 60, signature: 'abc123', source: 'finds', app_version: '9.9.9',
    unrecognized: [{ level: 'region', country: 'GB', country_name: 'United Kingdom', name: 'London', count: 53,
      zones: [['GB-england', 53]] }],
    outside: { country: 0, region: 0, subregion: 9 },
  } }));
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#zones"]').click();
  await expect(page.locator('#zonesReportSummary')).toContainText('Noms non reconnus : 1 (53 trouvailles)');
  await page.locator('#zonesReportDetails summary').click();
  await expect(page.locator('#zonesReportList li')).toHaveCount(1);
  await expect(page.locator('#zonesReportList li')).toContainText('Région « London »');
  await expect(page.locator('#zonesReportList li')).toContainText('England (GB-england) : 53');
  await expect(page.locator('#zonesReportOutside')).toContainText('sans département ni comté : 9');
  await page.locator('#btnZonesReportCopy').click();
  await expect(page.locator('#btnZonesReportCopy')).toContainText('Rapport copié');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('MyGCFlow 9.9.9');
  expect(copied).toContain('- region « London » [GB / United Kingdom] : 53 → GB-england (53)');
  expect(copied).toContain('sous-région 9');
  expect(errors).toEqual([]);
});
