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
