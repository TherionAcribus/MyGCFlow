// Page Parcours : agir depuis la carte (docs/parcours.md) — bulle d'actions
// d'une étape (clic), glisser un lieu ou une base, clic droit « Poser un lieu
// / une base ici » et point provisoire déplaçable. Fixture et nettoyage :
// parcours-helpers.mjs — journée 1 : GCPAR03, GCPAR01, GCPAR02 ; journée 2 :
// GCPAR04, GCPAR05.
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

// Deux clics rapprochés au même pixel feraient un double-clic (zoom) :
// coupé, comme dans zone-layer.spec.mjs.
async function openReady(page) {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    map.getInteractions().forEach((i) => {
      if (i instanceof ol.interaction.DoubleClickZoom) i.setActive(false);
    });
    // Le cadrage serre les étapes jusqu'aux bords : un cartouche (titre
    // affiché par un spec précédent) couvrait l'étape n° 3 et prenait ses
    // clics. Un cran de zoom arrière les ramène vers le centre.
    const view = map.getView();
    await new Promise((resolve) => {
      map.once('moveend', resolve);
      view.setZoom(view.getZoom() - 1);
    });
    map.renderSync();
  });
}

async function adjusted(page, revision) {
  await expect.poll(async () => (await snapshot(page)).adjustmentRevision).toBeGreaterThan(revision);
  return snapshot(page);
}

// Position écran d'une étape du plan.
async function stopPoint(page, key) {
  const pixel = (await snapshot(page)).stopPixels[key];
  const box = await page.locator('.ol-viewport').boundingBox();
  return { x: box.x + pixel[0], y: box.y + pixel[1] };
}

async function clickStop(page, key, options = {}) {
  const { x, y } = await stopPoint(page, key);
  await page.mouse.click(x, y, options);
  const bubble = page.locator(`#gcPopup.is-visible .parcours-bubble[data-stop-key="${key}"]`);
  await expect(bubble).toBeVisible();
  return bubble;
}

async function drag(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

test('bulle d’une étape : épingler l’heure, la retirer, exclure, ouvrir les détails', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);

  let bubble = await clickStop(page, 'GCPAR01');
  // Numéro du plan, nom, puis heure et raison de sa place.
  await expect(bubble.locator('.gc-popup-title')).toHaveText(/^2 · /);
  await expect(bubble.locator('.gc-popup-note').first()).toContainText(':');
  // La ligne de la liste est amenée en vue (et surlignée au survol).
  await expect(page.locator('.parcours-stop[data-stop-key="GCPAR01"]')).toBeInViewport();

  await bubble.locator('.parcours-bubble-time').fill('10:30');
  await bubble.locator('.parcours-bubble-pin').click();
  await expect(page.locator('#gcPopup')).toBeHidden();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.overrides.find((o) => o.key === 'GCPAR01')?.pinnedTime).toBe('10:30');

  bubble = await clickStop(page, 'GCPAR01');
  await expect(bubble.locator('.parcours-bubble-time')).toHaveValue('10:30');
  await bubble.locator('.parcours-bubble-unpin').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.overrides.find((o) => o.key === 'GCPAR01')?.pinnedTime ?? null).toBe(null);

  bubble = await clickStop(page, 'GCPAR02');
  await bubble.locator('.parcours-bubble-exclude').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].excluded).toContain('GCPAR02');
  expect(state.days[0].keys).not.toContain('GCPAR02');

  bubble = await clickStop(page, 'GCPAR03');
  await bubble.locator('.parcours-bubble-details').click();
  await expect(page.locator('.parcours-stop-edit[data-edit-key="GCPAR03"]')).toBeVisible();
  await expect(page.locator('#gcPopup')).toBeHidden();

  // Un clic ailleurs sur la carte referme la bulle.
  await clickStop(page, 'GCPAR03');
  // Même étape : son panneau d'ajustement reste ouvert.
  await expect(page.locator('.parcours-stop-edit[data-edit-key="GCPAR03"]')).toBeVisible();
  const box = await page.locator('.ol-viewport').boundingBox();
  await page.mouse.click(box.x + 30, box.y + box.height - 30);
  await expect(page.locator('#gcPopup')).toBeHidden();

  // Autre étape cliquée : le panneau de la précédente se referme.
  await clickStop(page, 'GCPAR01');
  await expect(page.locator('.parcours-stop-edit[data-edit-key="GCPAR03"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('glisser un lieu le déplace ; sa bulle propose de le supprimer', async ({ page, request }) => {
  const { id } = (await (await request.get('/api/parcours')).json()).parcours[0];
  const created = await request.post(`/api/parcours/${id}/places`, {
    data: { kind: 'place', name: 'Belvédère', lat: 45.903, lon: 6.125, date: '2025-07-12' },
  });
  expect(created.status()).toBe(201);
  const placeId = (await created.json()).place.id;
  const placeKey = `place:${placeId}`;
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);
  const view = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return app.getMap().getView().getCenter().join(',');
  });

  // Survol : curseur « attraper » sur un repère déplaçable.
  const start = await stopPoint(page, placeKey);
  await page.mouse.move(start.x, start.y);
  await expect.poll(() => page.evaluate(() => document.getElementById('map').style.cursor)).toBe('grab');

  await drag(page, start, 90, 60);
  state = await adjusted(page, state.adjustmentRevision);
  const moved = state.places.find((p) => p.id === placeId);
  expect(moved.lon).toBeGreaterThan(6.125);
  expect(moved.lat).toBeLessThan(45.903);
  // La carte n'a pas suivi le geste (pas de déplacement de la vue).
  expect(await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return app.getMap().getView().getCenter().join(',');
  })).toBe(view);

  // Le déplacement s'annule et se rétablit comme un ajustement.
  const undo = page.locator('#btnParcoursUndo');
  await expect(undo).toBeEnabled();
  await page.keyboard.press('Control+z');
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.places.find((p) => p.id === placeId)).toMatchObject({ lat: 45.903, lon: 6.125 });
  await expect(undo).toBeDisabled();
  await page.keyboard.press('Control+y');
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.places.find((p) => p.id === placeId)).toMatchObject({ lat: moved.lat, lon: moved.lon });
  await expect(undo).toBeEnabled();

  const bubble = await clickStop(page, placeKey);
  await expect(bubble).toContainText('Glissez le repère');
  await expect(bubble.locator('.parcours-bubble-exclude')).toHaveCount(0);
  await bubble.locator('.parcours-bubble-delete').click();
  await page.locator('.gcm-confirm-modal.show [data-gcm-role="confirm"]').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.places.find((p) => p.id === placeId)).toBeUndefined();
  // La suppression reste annulable ; les déplacements du lieu, eux, sont
  // retirés de l'historique — il ne reste que la suppression.
  await expect(undo).toBeEnabled();
  expect(state.undoDepth).toBe(1);
  await page.keyboard.press('Control+z');
  state = await adjusted(page, state.adjustmentRevision);
  const recreated = state.places.find((p) => p.name === 'Belvédère');
  // SQLite peut réattribuer le même id à la recréation : on ne teste pas
  // l'id, seulement que le lieu revient avec ses données.
  expect(recreated).toBeTruthy();
  expect(recreated).toMatchObject({ lat: moved.lat, lon: moved.lon });
  expect(state.undoDepth).toBe(0);
  await expect(undo).toBeDisabled();
  expect(errors).toEqual([]);
});

// Lot 15 : une mystery jamais corrigée sur le site se replace à la main.
test('glisser une étape corrige sa position ; annulable, et la bulle la remet', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);
  const start = await stopPoint(page, 'GCPAR02');
  await page.mouse.move(start.x, start.y);
  await expect.poll(() => page.evaluate(() => document.getElementById('map').style.cursor)).toBe('grab');

  await drag(page, start, 80, -50);
  state = await adjusted(page, state.adjustmentRevision);
  const position = state.overrides.find((o) => o.key === 'GCPAR02')?.position;
  expect(position).toBeTruthy();
  const row = page.locator('.parcours-stop[data-stop-key="GCPAR02"]');
  await expect(row).toHaveAttribute('data-pos-source', 'manual');
  await expect(row.locator('.parcours-stop-text')).toContainText('position déplacée sur la carte');
  // L'étape est dessinée là où elle a été lâchée.
  const moved = (await snapshot(page)).stopPixels.GCPAR02;
  const box = await page.locator('.ol-viewport').boundingBox();
  expect(Math.abs(box.x + moved[0] - (start.x + 80))).toBeLessThan(3);
  expect(Math.abs(box.y + moved[1] - (start.y - 50))).toBeLessThan(3);

  // Annuler / Rétablir, comme les autres ajustements.
  await page.locator('#btnParcoursUndo').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.overrides.find((o) => o.key === 'GCPAR02')).toBeUndefined();
  await expect(row).not.toHaveAttribute('data-pos-source', /./);
  await page.locator('#btnParcoursRedo').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.overrides.find((o) => o.key === 'GCPAR02')?.position).toEqual(position);

  // Bulle : « Position d'origine » retire l'ajustement.
  const bubble = await clickStop(page, 'GCPAR02');
  await expect(bubble).toContainText('Glissez l’étape');
  await bubble.locator('.parcours-bubble-position').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.overrides.find((o) => o.key === 'GCPAR02')).toBeUndefined();
  expect(errors).toEqual([]);
});

test('clic droit : poser une base ici, point provisoire déplaçable avant validation', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);
  const box = await page.locator('.ol-viewport').boundingBox();
  const spot = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // Sur une étape : sa bulle.
  const stop = await stopPoint(page, 'GCPAR04');
  await page.mouse.click(stop.x, stop.y, { button: 'right' });
  await expect(page.locator('#gcPopup.is-visible .parcours-bubble[data-stop-key="GCPAR04"]')).toBeVisible();

  // Ailleurs : le menu de pose.
  await page.mouse.click(spot.x, spot.y, { button: 'right' });
  const menu = page.locator('#gcPopup.is-visible .parcours-bubble-menu');
  await expect(menu).toBeVisible();
  await menu.locator('.parcours-bubble-add-base').click();
  await expect(page.locator('#gcPopup')).toBeHidden();
  const form = page.locator('#parcoursPlaceForm');
  await expect(form).toBeVisible();
  await expect(form.locator('#parcoursPlaceKind')).toHaveValue('base');
  await expect(form.locator('#parcoursPlaceRoleRow')).toBeVisible();
  const coords = form.locator('#parcoursPlaceCoords');
  const before = await coords.textContent();
  expect((await snapshot(page)).layer.draft).toBe(1);

  // Le point provisoire se glisse : les coordonnées du formulaire suivent.
  await drag(page, spot, 70, -50);
  await expect(coords).not.toHaveText(before);
  const [lat, lon] = (await coords.textContent()).split(',').map(Number);
  const [lat0, lon0] = before.split(',').map(Number);
  expect(lon).toBeGreaterThan(lon0);
  expect(lat).toBeGreaterThan(lat0);

  await form.locator('#parcoursPlaceName').fill('Gîte');
  await page.locator('#btnParcoursPlaceSave').click();
  state = await adjusted(page, state.adjustmentRevision);
  const base = state.places.find((p) => p.name === 'Gîte');
  expect(base.kind).toBe('base');
  expect(base.lat).toBeCloseTo(lat, 4);
  expect(base.lon).toBeCloseTo(lon, 4);
  await expect(form).toBeHidden();
  expect(errors).toEqual([]);
});

test('pendant la lecture : ni bulle d’actions, ni menu de pose', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  const box = await page.locator('.ol-viewport').boundingBox();
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(true);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('#gcPopup .parcours-bubble')).toHaveCount(0);
  await page.locator('#btnQuickStop').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(false);
  expect(errors).toEqual([]);
});
