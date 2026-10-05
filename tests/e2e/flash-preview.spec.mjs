// Aperçu du flash : le bouton à bascule de l'onglet Style > Flash rejoue le
// flash en boucle sur un échantillon de caches visibles, sans lancer
// l'animation — calqué sur l'aperçu du trajet (#btnTrailPreview).
//
// Le dessin lui-même n'est pas comparé au pixel près : on observe l'état
// exposé par getFlashPreviewDebugState() — bascule, calque visible, file de
// flashs, nombre de vagues — comme les autres specs le font pour le trajet.
//
// Fixture : 6 caches à ~150 m d'intervalle (3 types : Traditional, Multi,
// Event), une par jour du 01 au 06/01/2026.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

async function openWithFixture(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Chargement et affichage des points' }).first())
    .toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6');
  // Les filtres se réappliquent encore un peu après, chacun par un addVector()
  // qui fermerait l'aperçu : attendre que l'index des jours soit stable.
  let previous = -1;
  await expect.poll(async () => {
    const revision = await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDateRevision);
    const stable = revision === previous;
    previous = revision;
    return stable;
  }, { intervals: [700], timeout: 15_000 }).toBe(true);
}

async function openFlashPanel(page) {
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabFlash"]').click();
  await expect(page.locator('#btnFlashPreview')).toBeVisible();
}

async function zoomOnCaches(page) {
  // Les vagues n'échantillonnent que la vue courante : centrer sur la zone.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const view = app.olMap.getView();
    view.setCenter(ol.proj.fromLonLat([2.353, 48.853]));
    view.setZoom(15);
  });
}

function previewState(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getFlashPreviewDebugState());
}

function setFlashMode(page, mode) {
  // Le select est un Tom Select : la valeur est posée sur le champ source,
  // puis 'change' est dispatché — le même chemin que le listener de l'UI.
  return page.evaluate((m) => {
    const el = document.getElementById('selectFlashMode');
    el.value = m;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, mode);
}

test("l'aperçu rejoue le flash en boucle sans lancer l'animation", async ({ page }) => {
  await openWithFixture(page);
  await openFlashPanel(page);
  await zoomOnCaches(page);

  const btn = page.locator('#btnFlashPreview');
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');

  // Une première vague part, puis la boucle en enchaîne d'autres — tout en
  // restant hors animation.
  const state = await previewState(page);
  expect(state.preview).toBe(true);
  expect(state.layerVisible).toBe(true);
  await expect.poll(async () => (await previewState(page)).queued, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await previewState(page)).waves, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(async () => (await import('/static/js/index.js')).isAnimationInProgress())).toBe(false);

  // Re-clic : la bascule se ferme et plus aucune vague ne s'enfile.
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await previewState(page)).preview).toBe(false);
  const wavesAtClose = (await previewState(page)).waves;
  await page.waitForTimeout(2000);
  expect((await previewState(page)).waves).toBe(wavesAtClose);
});

test('la forme « aucun » désactive le bouton et ferme l’aperçu', async ({ page }) => {
  await openWithFixture(page);
  await openFlashPanel(page);
  await zoomOnCaches(page);
  const btn = page.locator('#btnFlashPreview');

  // Runtime partagé entre les specs : forcer une forme réelle d'abord.
  await setFlashMode(page, 'circle');
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect.poll(async () => (await previewState(page)).preview).toBe(true);

  await setFlashMode(page, 'none');
  await expect(btn).toBeDisabled();
  await expect.poll(async () => (await previewState(page)).preview, { timeout: 10_000 }).toBe(false);

  await setFlashMode(page, 'circle');
  await expect(btn).toBeEnabled();
});

test("la lecture ferme l'aperçu", async ({ page }) => {
  await openWithFixture(page);
  await openFlashPanel(page);
  await zoomOnCaches(page);

  const btn = page.locator('#btnFlashPreview');
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect.poll(async () => (await previewState(page)).preview).toBe(true);

  await page.locator('a[href="#animation"]').click();
  await page.locator('#btnQuickPreview').click();
  await expect(page.locator('#btnQuickPause')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await previewState(page)).preview).toBe(false);
  await page.locator('#btnQuickStop').click();
});
