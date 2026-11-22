// Page Parcours, lot 7 : finitions de la lecture (MyGCFlow_Plan_Parcours.md,
// docs/parcours.md) — caméra qui suit le géocacheur, nuit et carton entre
// deux journées, pictogramme du déplacement, réglages, parcours suggérés.
//
// Fixture my-finds-parcours.gpx : deux journées autour d'Annecy, donc un
// carton « Jour 2 » pendant la nuit. Rythme lent (10 quanta par seconde)
// pour observer la nuit (20 quanta = 2 s).
import { expect, test } from '@playwright/test';
import {
  cleanUp,
  clearLogs,
  collectErrors,
  createWeekend,
  deleteAllParcours,
  importFixture,
  openParcoursPage,
  snapshot,
} from './parcours-helpers.mjs';

test.beforeEach(async ({ page, request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
  await importFixture(page, request);
  await createWeekend(request);
});

test.afterEach(async ({ request }) => {
  await cleanUp(request);
});

async function openReady(page) {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  return snapshot(page);
}

// Position du géocacheur à l'écran (px CSS dans la carte) et taille de la carte.
function headOnScreen(page) {
  return page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    const { head } = window.getParcoursSnapshot();
    const px = map.getPixelFromCoordinate(ol.proj.fromLonLat([head.lon, head.lat]));
    return { x: px[0], y: px[1], size: map.getSize() };
  });
}

const FAST = { intervals: [100], timeout: 20_000 };

test('lecture : caméra qui suit, nuit et carton du jour, pictogramme, vue rendue à la fin', async ({ page }) => {
  const errors = collectErrors(page);
  const rest = await openReady(page);
  expect(rest.playback).toMatchObject({ camera: 'follow', day_cards: true, head: 'mode', estimated_dashed: false });
  expect(rest.camera.following).toBe(false);

  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).camera.following).toBe(true);
  // Premier carton dès le début : un parcours de deux journées.
  await expect.poll(async () => (await snapshot(page)).scene.cardText?.title ?? null, FAST).toBe('Jour 1');
  // Serrée sur le géocacheur : plus près que la vue d'ensemble du repos.
  await expect.poll(async () => (await snapshot(page)).camera.zoom, FAST).toBeGreaterThan(rest.camera.zoom + 0.5);
  const onScreen = await headOnScreen(page);
  expect(onScreen.x).toBeGreaterThan(0);
  expect(onScreen.x).toBeLessThan(onScreen.size[0]);
  expect(onScreen.y).toBeGreaterThan(0);
  expect(onScreen.y).toBeLessThan(onScreen.size[1]);
  const walking = await snapshot(page);
  expect(walking.scene.headGlyph).toBe(true);
  expect(['walk', 'bike', 'car']).toContain(walking.scene.headMode);

  // La nuit : assombrie, pictogramme de nuit, carton « Jour 2 · dimanche 13 juillet 2025 ».
  await expect.poll(async () => (await snapshot(page)).scene.night, FAST).toBeGreaterThan(0.5);
  const night = await snapshot(page);
  expect(night.scene.headMode).toBe('night');
  await expect.poll(async () => (await snapshot(page)).scene.cardText?.title ?? null, FAST).toBe('Jour 2');
  expect((await snapshot(page)).scene.cardText.subtitle).toMatch(/dimanche 13 juillet 2025/);

  // Fin : vue d'avant la lecture rendue.
  await expect.poll(async () => (await snapshot(page)).running, { timeout: 40_000 }).toBe(false);
  const after = await snapshot(page);
  expect(after.camera.zoom).toBeCloseTo(rest.camera.zoom, 5);
  expect(after.camera.center[0]).toBeCloseTo(rest.camera.center[0], 6);
  expect(after.camera.center[1]).toBeCloseTo(rest.camera.center[1], 6);
  expect(errors).toEqual([]);
});

test('carte déplacée pendant la lecture : la caméra la laisse, même à la fin', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).camera.following).toBe(true);
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).camera.suspended).toBe(true);
  // Inertie du glisser (animation de la vue d'OpenLayers) : attendre une vue
  // immobile entre deux relevés.
  let last = null;
  await expect.poll(async () => {
    const center = (await snapshot(page)).camera.center.join(',');
    const still = center === last;
    last = center;
    return still;
  }, { intervals: [300], timeout: 10_000 }).toBe(true);
  const moved = await snapshot(page);
  expect(moved.camera.following).toBe(false);
  await page.locator('#btnQuickStop').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(false);
  const after = await snapshot(page);
  expect(after.camera.center[0]).toBeCloseTo(moved.camera.center[0], 6);
  expect(after.camera.zoom).toBeCloseTo(moved.camera.zoom, 5);
  expect(errors).toEqual([]);
});

test('réglages : caméra fixe, simple point, sans nuit ni carton, enregistrés', async ({ page, request }) => {
  const errors = collectErrors(page);
  const rest = await openReady(page);
  // Réglages de lecture dans l'onglet Animation : caméra et géocacheur dans
  // son sous-onglet « Caméra », le reste sous « Dates & rythme ».
  await page.locator('a[href="#animation"]').click();
  await page.locator('#cameraConfigTab').click();
  await page.locator('#parcoursCamera').selectOption('fixed');
  await page.locator('#parcoursHead').selectOption('dot');
  await page.locator('#animationConfigTab').click();
  await page.locator('#parcoursDayCards').uncheck();
  await page.locator('#parcoursEstimatedDashed').check();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).parcours_playback).toEqual({
    pace: 'regular', hours: 'approx', camera: 'fixed', day_cards: false, head: 'dot', estimated_dashed: true,
  });
  // Rechargement : les réglages reviennent dans les contrôles.
  await openReady(page);
  await expect(page.locator('#parcoursCamera')).toHaveValue('fixed');
  await expect(page.locator('#parcoursHead')).toHaveValue('dot');
  await expect(page.locator('#parcoursDayCards')).not.toBeChecked();
  await expect(page.locator('#parcoursEstimatedDashed')).toBeChecked();

  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(true);
  // Toute la lecture : vue immobile, jamais de nuit ni de carton, simple point.
  const seen = { night: 0, card: false, glyph: false, moved: false };
  await expect.poll(async () => {
    const state = await snapshot(page);
    if (state.scene) {
      seen.night = Math.max(seen.night, state.scene.night);
      seen.card ||= !!state.scene.card;
      seen.glyph ||= state.scene.headGlyph;
    }
    seen.moved ||= state.running && Math.abs(state.camera.zoom - rest.camera.zoom) > 1e-6;
    return state.running;
  }, { intervals: [100], timeout: 40_000 }).toBe(false);
  expect(seen).toEqual({ night: 0, card: false, glyph: false, moved: false });
  expect(errors).toEqual([]);
});

test('parcours suggérés : liste masquée sans séjour, un clic remplit le formulaire', async ({ page }) => {
  const errors = collectErrors(page);
  // Fixture : deux journées chez soi, trop petites pour une suggestion.
  await openReady(page);
  await expect(page.locator('#parcoursSuggestions')).toBeHidden();
  expect((await snapshot(page)).suggestions).toEqual([]);

  await page.route('**/api/parcours/suggestions', (route) => route.fulfill({
    json: {
      suggestions: [{
        kind: 'trip', start: '2025-07-12', end: '2025-07-13', days: 2, findDays: 2, finds: 5, place: 'Haute-Savoie',
      }],
    },
  }));
  await openReady(page);
  const chip = page.locator('#parcoursSuggestionList .parcours-suggestion');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('Haute-Savoie');
  await expect(chip).toContainText('5 trouvailles');
  await chip.click();
  await expect(page.locator('#parcoursName')).toHaveValue(/^Haute-Savoie, 12 juil\. 2025 → 13 juil\. 2025$/);
  await expect(page.locator('#parcoursStart')).toHaveValue('2025-07-12');
  await expect(page.locator('#parcoursEnd')).toHaveValue('2025-07-13');
  await expect(page.locator('#parcoursRangeHint')).toContainText('2 jours');
  expect(errors).toEqual([]);
});
