// Panneaux de statistiques posés sur la carte (onglet Stats).
//
// Le dessin (canvas) n'est pas comparé au pixel près : on observe l'état
// exposé par getStatsSnapshot() — mode, comptes, panneaux visibles, nombre de
// passes vidéo — et la géométrie des <canvas class="stats-panel">.
//
// Fixture : 6 caches, une par jour du 01 au 06/01/2026, D/T toutes distinctes
// (1/1 → 3,5/3,5), 3 Traditional, 2 Multi, 1 Event.
//
// `stats` est une préférence globale partagée par tous les specs d'un run :
// chaque test repart de la liste vide et la remet en place en sortant.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
const DEFAULT_STATS = { enabled: true, panels: [] };

async function putStats(page, stats) {
  const response = await page.request.put('/api/settings', { data: { stats } });
  expect(response.ok()).toBe(true);
}

async function savedStats(page) {
  return (await (await page.request.get('/api/settings')).json()).stats;
}

async function openWithFixture(page, hash = '') {
  await page.goto(`/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Chargement et affichage des points' }).first())
    .toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6');
  // Les filtres se réappliquent encore un peu après l'import, chacun par une
  // reconstruction de l'index : attendre qu'il ne bouge plus.
  let previous = -1;
  await expect.poll(async () => {
    const revision = await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDateRevision);
    const stable = revision === previous;
    previous = revision;
    return stable;
  }, { intervals: [700], timeout: 15_000 }).toBe(true);
}

function snapshot(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getStatsSnapshot());
}

const sum = (counts) => Object.values(counts || {}).reduce((s, n) => s + n, 0);

async function setRhythm(page, daysPerSecond) {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#animationConfigTab').click();
  await page.locator('#inputDaysPerSecond').fill(String(daysPerSecond));
  await page.locator('#inputExtraEndTime').fill('0');
}

test.beforeEach(async ({ page }) => {
  await putStats(page, DEFAULT_STATS);
});

test.afterEach(async ({ page }) => {
  await putStats(page, DEFAULT_STATS);
  await expect.poll(async () => (await savedStats(page)).panels.length).toBe(0);
});

test('un modèle pose la matrice D/T, ancrée, empilée et retrouvée au redémarrage', async ({ page }) => {
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('#statsEmpty')).toBeVisible();

  await page.locator('#btnStatsAdd').click();
  await page.locator('[data-stats-preset="dt"]').click();

  const matrix = page.locator('canvas.stats-panel');
  await expect(matrix).toHaveCount(1);
  await expect(matrix).toBeVisible();
  // Ancre « en bas à gauche » : position exprimée depuis ce coin, convention
  // relue pour la vidéo.
  await expect(matrix).toHaveCSS('left', '16px');
  await expect(matrix).toHaveCSS('bottom', '16px');

  // Au repos : totaux de la sélection, toutes les caches dans la matrice.
  let state = await snapshot(page);
  expect(state.mode).toBe('rest');
  expect(state.total).toBe(6);
  expect(sum(state.counts.dt) + state.excluded.dt).toBe(6);
  expect(Object.keys(state.counts.dt)).toHaveLength(6);

  // Deux histogrammes sur le même coin : empilés, sans chevauchement.
  await page.locator('#btnStatsAdd').click();
  await page.locator('[data-stats-preset="types-sizes"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(3);
  const types = await page.locator('canvas.stats-panel').nth(1).boundingBox();
  const sizes = await page.locator('canvas.stats-panel').nth(2).boundingBox();
  expect(types && sizes).toBeTruthy();
  const [upper, lower] = [types, sizes].sort((a, b) => a.y - b.y);
  expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y);

  state = await snapshot(page);
  expect(state.counts.cache_type['Traditional Cache']).toBe(3);
  expect(state.counts.cache_type['Multi-cache']).toBe(2);

  // Persistance (debounce 500 ms), puis restauration au rechargement.
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.metric))
    .toEqual(['dt', 'cache_type', 'container']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(3, { timeout: 15_000 });
});

test('la lecture remplit les panneaux jour après jour, l\'arrêt rend les totaux', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'aaaaaa01', kind: 'grid', metric: 'dt' },
    { id: 'bbbbbb01', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-right', dy: 64 } },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  await setRhythm(page, 2);

  await page.locator('#btnQuickPreview').click();
  // Au départ, aucune cache n'est antérieure à la date de début : l'état
  // courant repart de zéro puis grandit, il ne montre pas les totaux.
  await expect.poll(async () => {
    const state = await snapshot(page);
    return state.mode === 'animating' && state.total > 0 && state.total < 6;
  }, { intervals: [50], timeout: 10_000 }).toBe(true);

  // Fin naturelle : état final conservé, cohérent avec le compteur.
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(6);
  let state = await snapshot(page);
  expect(state.mode).toBe('animating');
  expect(sum(state.counts.dt) + state.excluded.dt).toBe(6);
  expect(state.counts.cache_type['Traditional Cache']).toBe(3);
  await expect(page.locator('#spanNbCaches')).toHaveText('6');

  // Nouveau filtre après la fin : totaux de la nouvelle sélection.
  await page.evaluate(() => {
    document.querySelector('#selectType').tomselect.setValue(['Traditional Cache']);
  });
  await expect(page.locator('#filtersCounter')).toContainText('3 / 6');
  await expect.poll(async () => {
    const s = await snapshot(page);
    return `${s.mode}:${s.total}`;
  }).toBe('rest:3');
  state = await snapshot(page);
  expect(state.counts.cache_type).toEqual({ 'Traditional Cache': 3 });
});

test('un export repart de zéro, même après un aperçu, et dessine les panneaux dans la vidéo', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await openWithFixture(page);
  await setRhythm(page, 6);

  // Aperçu complet : l'accumulateur finit à 6.
  await page.locator('#btnQuickPreview').click();
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(6);
  const drawsBefore = (await snapshot(page)).videoDrawCount;

  // Capture image par image (réglage en mémoire seulement : pas de
  // préférence globale modifiée pour les specs suivants).
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.record.mode = 'images';
    app.options.record.fps = 12;
    app.options.flash.mode = 'none';
  });
  await page.locator('#btnQuickExport').click({ force: true });
  // Le démarrage de l'enregistrement remet l'accumulateur à l'état initial.
  await expect.poll(async () => {
    const state = await snapshot(page);
    return state.mode === 'animating' && state.total < 6;
  }, { intervals: [50], timeout: 30_000 }).toBe(true);

  const ready = page.locator('#modal_video_ready');
  await expect(ready).toBeVisible({ timeout: 120_000 });
  const state = await snapshot(page);
  expect(state.total).toBe(6);
  expect(state.videoDrawCount).toBeGreaterThan(drawsBefore);
  await ready.locator('.modal-footer [data-bs-dismiss="modal"]').click();
});

test('l\'interrupteur général masque les panneaux sans perdre la liste', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);

  await page.locator('#switchStats').uncheck();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);
  await expect.poll(async () => (await savedStats(page)).enabled).toBe(false);
  expect((await savedStats(page)).panels).toHaveLength(1);

  await page.locator('#switchStats').check();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect.poll(async () => (await savedStats(page)).enabled).toBe(true);
});

test('pas d\'onglet ni de panneau en mode Évolution', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await page.goto('/evolution', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('a[href="#stats"]')).toHaveCount(0);
  await expect(page.locator('#stats')).toHaveCount(0);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);
});
