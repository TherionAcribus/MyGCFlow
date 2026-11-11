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
  expect(state.legend.entries.map((e) => e.label)).toEqual(['≤ 2', '≥ 3']);
  await expect(page.locator('#zoneLegend')).toBeVisible();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).zones_display).toBe(true);
  expect(errors).toEqual([]);
});

test('densité : trouvailles par km², case réservée aux mesures qui se comptent', async ({ page, request }) => {
  await setDisplay(request, true);
  const errors = await openMap(page);
  await page.locator('a[href="#zones"]').click();
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');
  await expect(page.locator('#zonesPerKm2Row')).toBeVisible();
  await page.locator('#zonesPerKm2').check();
  await expect.poll(async () => (await zones(page)).options.perKm2).toBe(true);
  const state = await zones(page);
  // Valeurs relevées pour 1 000 km² (unité des mini-cartes Statistiques) :
  // Paris 3 / 105 km² ≈ 28,6 ; Finistère 3 / 6 762 km² ≈ 0,44.
  expect(state.values['FR-75']).toBeGreaterThan(25);
  expect(state.values['FR-75']).toBeLessThan(32);
  expect(state.values['FR-29']).toBeGreaterThan(0.4);
  expect(state.values['FR-29']).toBeLessThan(0.5);
  expect(state.values['FR-44']).toBeGreaterThan(0.1);
  expect(state.values['FR-69']).toBeGreaterThan(0.28);
  expect(state.legend.title).toContain('km²');
  // Pas de densité pour une date : la case disparaît (et l'option revient
  // en revenant à « nombre de trouvailles », la case étant restée cochée).
  await page.locator('#zonesMeasure').selectOption('first_day');
  await expect(page.locator('#zonesPerKm2Row')).toBeHidden();
  await page.locator('#zonesMeasure').selectOption('count');
  await expect(page.locator('#zonesPerKm2Row')).toBeVisible();
  expect((await zones(page)).options.perKm2).toBe(true);
  await page.locator('#zonesPerKm2').uncheck();
  await expect.poll(async () => (await zones(page)).values['FR-75']).toBe(3);
  expect(errors).toEqual([]);
});

test('comparaison à une date : écarts signés, zones inchangées sans couleur', async ({ page, request }) => {
  await setDisplay(request, true);
  const errors = await openMap(page);
  await page.locator('a[href="#zones"]').click();
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');
  await expect(page.locator('#zonesCompareRow')).toBeVisible();
  await page.locator('#zonesCompareDate').fill('2026-01-04');
  await page.locator('#zonesCompareDate').dispatchEvent('change');
  await expect.poll(async () => (await zones(page)).compareDay).not.toBeNull();
  const state = await zones(page);
  // Depuis le 4 janvier : Finistère +2 (5 et 6), Paris +1 (8), Rhône +1
  // (7) ; la Loire-Atlantique (trouvaille du 3) est inchangée : ni valeur
  // ni classe, donc pas de remplissage.
  expect(state.values).toEqual({ 'FR-75': 1, 'FR-29': 2, 'FR-69': 1 });
  expect(state.classes['FR-29']).toBe(1);
  expect(state.classes['FR-75']).toBe(0);
  expect(state.classes['FR-44']).toBeUndefined();
  expect(state.legend.title).toContain('depuis le');
  expect(state.legend.entries.map((e) => e.label)).toEqual(['< +2', '≥ +2']);
  // La date vidée ramène à l'état du jour.
  await page.locator('#zonesCompareDate').fill('');
  await page.locator('#zonesCompareDate').dispatchEvent('change');
  await expect.poll(async () => (await zones(page)).values['FR-75']).toBe(3);
  expect(errors).toEqual([]);
});

test('objectif D/T : combinaisons manquantes par zone', async ({ page, request }) => {
  await setDisplay(request, true);
  const errors = await openMap(page);
  await page.locator('a[href="#zones"]').click();
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');

  // Préréglage « Objectif : D/T à compléter » → mesure des manquantes.
  await page.locator('#zonesPreset').selectOption('missing');
  await expect.poll(async () => (await zones(page)).options.measure).toBe('dt_missing');
  // La comparaison est sans objet ici : son contrôle se masque.
  await expect(page.locator('#zonesCompareRow')).toBeHidden();
  // Paris et Finistère : 3 combinaisons couvertes → 78 manquantes ;
  // Loire-Atlantique et Rhône : 1 → 80. Zones jamais visitées : non colorées.
  await expect.poll(async () => (await zones(page)).values).toEqual(
    { 'FR-75': 78, 'FR-29': 78, 'FR-44': 80, 'FR-69': 80 });
  expect((await zones(page)).legend.title).toContain('manquantes');

  // La mesure « couverture » affiche le complément dans la fiche de zone.
  await page.locator('#zonesMeasure').selectOption('dt_coverage');
  await expect.poll(async () => (await zones(page)).values['FR-75']).toBe(3);
  await expect(page.locator('#zonesCompareRow')).toBeVisible();
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

  // Un changement de mesure en pause ne ramène pas la couche au jour de fin.
  const pausedDay = state.day;
  await page.locator('a[href="#zones"]').click();
  await page.locator('#zonesMeasure').selectOption('distinct_types');
  await expect.poll(async () => (await zones(page)).options.measure).toBe('distinct_types');
  expect((await zones(page)).day).toBe(pausedDay);
  await page.locator('#zonesMeasure').selectOption('count');
  await expect.poll(async () => (await zones(page)).values).toEqual({ 'FR-75': 2, 'FR-44': 1, 'FR-29': 2 });
  expect((await zones(page)).day).toBe(pausedDay);

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

test('fiche de zone : clic sur la carte, au repos et en pause', async ({ page, request }) => {
  await setDisplay(request, true);
  const errors = await openMap(page);
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');
  const popup = page.locator('#gcPopup .gc-popup-content');
  // Vue sur la France entière : les deux clics de zones restent dans le cadre.
  await app(page, `pkg.getMap().getView().setCenter(ol.proj.fromLonLat([1.8, 46.6]));
    pkg.getMap().getView().setZoom(6);`);
  const clickAt = async (lon, lat) => {
    const p = await app(page, `
      const px = pkg.getMap().getPixelFromCoordinate(ol.proj.fromLonLat(arg));
      const r = document.getElementById('map').getBoundingClientRect();
      return { x: r.left + px[0], y: r.top + px[1] };`, [lon, lat]);
    await page.mouse.click(p.x, p.y);
  };

  // Au repos : le Finistère compte 3 trouvailles au jour de fin (8 janvier).
  await clickAt(-4.0, 48.2);
  await expect(popup).toContainText('Finistère');
  await expect(popup).toContainText('Au 08/01/2026');
  await expect(popup).toContainText('3 trouvailles');

  // En pause au 5 janvier : 2 trouvailles, la date du jour s'affiche.
  expect(await app(page, 'return pkg.startPausedPreview();')).toBe(true);
  await app(page, 'pkg.seekAnimationToDate(new Date(2026, 0, 5));');
  await clickAt(-4.0, 48.2);
  await expect(popup).toContainText('2 trouvailles');
  await expect(popup).toContainText('Au 05/01/2026');

  // Zone sans valeur ce jour-là : la fiche le dit au lieu de rester muette.
  await clickAt(1.85, 45.35);
  await expect(popup).toContainText('Aucune trouvaille à ce jour');

  // Le clic sur une cache garde sa propre fiche : GCZON003 à Nantes, seule
  // de son département — les trois points du Finistère se chevauchent à
  // ce zoom. Trouvée le 3, donc visible en pause au 5. La détection de
  // clic (WebGL) prend un instant après le saut et l'icône est étroite :
  // on cherche le pixel voisin où la couche de points répond « Zone 3 »
  // (même filtre que le gestionnaire de clic), puis on clique ce pixel.
  const hit = await page.waitForFunction(async (arg) => {
    const pkg = await import('/static/js/index.js');
    const c = pkg.getMap().getPixelFromCoordinate(ol.proj.fromLonLat(arg));
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const px = [c[0] + dx, c[1] + dy];
      const name = pkg.getMap().forEachFeatureAtPixel(px,
        (ft, l) => l instanceof ol.layer.WebGLPoints ? ft.get('name') : undefined);
      if (name === 'Zone 3') {
        const r = document.getElementById('map').getBoundingClientRect();
        return { x: r.left + px[0], y: r.top + px[1] };
      }
    }
    return null;
  }, [-1.5536, 47.2184]);
  const hp = await hit.jsonValue();
  await page.mouse.click(hp.x, hp.y);
  await expect(popup).toContainText('Zone 3');

  await page.locator('#btnQuickStop').click();
  await expect.poll(() => app(page, 'return pkg.previewPlaybackState();')).toBe('idle');
  await expect(page.locator('#gcPopup')).not.toHaveClass(/is-visible/);
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

  // Préréglages : un lot de réglages posé d'un coup, le périmètre rappelé
  // sous « Couleur selon » suit la mesure.
  await expect(page.locator('#zonesScopeHint')).toContainText('trouvailles filtrées');
  await page.locator('#zonesPreset').selectOption('conquest');
  await expect.poll(async () => (await zones(page)).options.scale).toBe('log');
  expect((await zones(page)).options.measure).toBe('count');
  await page.locator('#zonesPreset').selectOption('visited');
  await expect.poll(async () => (await zones(page)).options.measure).toBe('first_day');
  await expect(page.locator('#zonesScale')).toBeDisabled();
  // « Sauvegarder le thème » est accessible sans quitter l'onglet.
  await expect(page.locator('#btnZonesSaveTheme')).toBeVisible();
  await page.locator('#zonesPreset').selectOption('conquest');
  await expect.poll(async () => (await zones(page)).options.measure).toBe('count');

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
    // Pas encore de jeu choisi : la couche attend, l'onglet le dit ; le
    // périmètre rappelle que le jeu entier est croisé, filtres ignorés ;
    // l'échelle est fixe (0–100 %), le réglage est grisé.
    await expect(page.locator('#zonesStatus')).toContainText('Choisissez le jeu Évolution');
    await expect(page.locator('#zonesScopeHint')).toContainText('jeu Évolution choisi');
    await expect(page.locator('#zonesScale')).toBeDisabled();
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
    // Échelle fixe 0–100 % : extrêmes ouvertes, seuils ronds.
    expect(state.legend.entries.every((e) => e.label.endsWith('%'))).toBe(true);
    expect(state.legend.entries[0].label).toMatch(/^< /);
    expect(state.legend.entries.at(-1).label).toMatch(/^≥ /);

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
    expect(card.zones.legend.at(-1)).toMatch(/^≥ .*%$/);

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
    unrecognized: [{ level: 'region', country: 'GB', country_name: 'United Kingdom', name: 'Kernow', count: 53,
      zones: [['GB-southwestengland', 53]] }],
    outside: { country: 0, region: 0, subregion: 9 },
  } }));
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#zones"]').click();
  await expect(page.locator('#zonesReportSummary')).toContainText('Noms non reconnus : 1 (53 trouvailles)');
  await page.locator('#zonesReportDetails summary').click();
  await expect(page.locator('#zonesReportList li')).toHaveCount(1);
  await expect(page.locator('#zonesReportList li')).toContainText('Région « Kernow »');
  await expect(page.locator('#zonesReportList li')).toContainText('South West England (GB-southwestengland) : 53');
  await expect(page.locator('#zonesReportOutside')).toContainText('sans département ni comté : 9');
  await page.locator('#btnZonesReportCopy').click();
  await expect(page.locator('#btnZonesReportCopy')).toContainText('Rapport copié');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('MyGCFlow 9.9.9');
  expect(copied).toContain('- region « Kernow » [GB / United Kingdom] : 53 → GB-southwestengland (53)');
  expect(copied).toContain('sous-région 9');
  expect(errors).toEqual([]);
});

// « Zones seules » masque points et trajet pour lire la carte colorée.
test('zones seules : points et trajet masqués, couche de zones intacte', async ({ page, request }) => {
    await setDisplay(request, true);
    const errors = await openMap(page);
    await page.locator('a[href="#zones"]').click();
    await expect.poll(async () => (await zones(page)).status).toBe('ready');
    const visibilities = () => app(page, `
        const layers = pkg.getMap().getLayers().getArray();
        const pts = layers.find((l) => l instanceof ol.layer.WebGLPoints);
        const trail = layers.find((l) => l.getZIndex && l.getZIndex() === 1000);
        return { pts: pts ? pts.getVisible() : null, trail: trail ? trail.getVisible() : null };`);
    expect((await visibilities()).pts).toBe(true);
    // L'aperçu du trajet est affiché puis masqué par le mode solo.
    await app(page, 'pkg.toggleTrailPreview(); return true;');
    expect((await visibilities()).trail).toBe(true);
    await page.locator('#zonesSolo').check();
    await expect.poll(async () => (await zones(page)).solo).toBe(true);
    expect(await visibilities()).toEqual({ pts: false, trail: false });
    await page.locator('#zonesSolo').uncheck();
    await expect.poll(async () => (await zones(page)).solo).toBe(false);
    expect(await visibilities()).toEqual({ pts: true, trail: true });
    await app(page, 'pkg.toggleTrailPreview(); return true;');
    expect(errors).toEqual([]);
});

test('erreurs : « Réessayer » recharge contours et liste des jeux', async ({ page, request }) => {
  await setDisplay(request, true);
  // Catalogue des contours en échec : ligne d'état + bouton.
  await page.route('**/static/geo/index.json', (route) => route.fulfill({ status: 500, body: 'ko' }));
  const errors = await openMap(page);
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('error');
  await page.locator('a[href="#zones"]').click();
  await expect(page.locator('#zonesStatus')).toContainText('Contours des zones indisponibles');
  await expect(page.locator('#btnZonesRetry')).toBeVisible();
  await page.unroute('**/static/geo/index.json');
  await page.locator('#btnZonesRetry').click();
  await expect.poll(async () => (await zones(page)).status, { timeout: 20_000 }).toBe('ready');

  // Liste des jeux en échec : distinguée de « aucun jeu », retentée pareil.
  await page.route('**/api/evolution/datasets', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.locator('#zonesMeasure').selectOption('found_share');
  await expect(page.locator('#zonesStatus')).toContainText('Impossible de charger la liste des jeux');
  await expect(page.locator('#btnZonesRetry')).toBeVisible();
  await expect(page.locator('#zonesShareDataset')).toContainText('Liste des jeux indisponible');
  await page.unroute('**/api/evolution/datasets');
  await page.locator('#btnZonesRetry').click();
  // Plus aucun jeu dans le runtime (la spec « part trouvée » a nettoyé) :
  // la liste relue affiche « Aucun jeu » et la couche attend un choix.
  await expect(page.locator('#zonesShareDataset')).toContainText('Aucun jeu');
  await expect(page.locator('#zonesStatus')).toContainText('Choisissez le jeu Évolution');
  await page.locator('#zonesMeasure').selectOption('count');
  await expect.poll(async () => (await zones(page)).values).toEqual({ 'FR-75': 3, 'FR-44': 1, 'FR-29': 3, 'FR-69': 1 });
  expect(errors).toEqual([]);
});
