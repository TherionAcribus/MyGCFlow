// Page Parcours, lot 3 : ajustements manuels des étapes (ordre, heure
// épinglée, journée, exclusion) et lieux posés sur la carte
// (MyGCFlow_Plan_Parcours.md, docs/parcours.md). Fixture et nettoyage :
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

async function openReady(page) {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
}

const row = (page, key) => page.locator(`.parcours-stop[data-stop-key="${key}"]`);

// Attend la reconstruction qui suit un ajustement enregistré.
async function adjusted(page, revision) {
  await expect.poll(async () => (await snapshot(page)).adjustmentRevision).toBeGreaterThan(revision);
  return snapshot(page);
}

test('ordre manuel : flèches, glisser-déposer, persistance, retour à l’ordre automatique', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);
  expect(state.days[0].keys).toEqual(['GCPAR03', 'GCPAR01', 'GCPAR02']);

  await row(page, 'GCPAR03').locator('.parcours-stop-down').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR01', 'GCPAR03', 'GCPAR02']);
  expect(state.days[0].manual).toBe(true);
  expect(state.days[0].reasons).toEqual(['manual', 'manual', 'manual']);
  await expect(page.locator('.parcours-day-manual')).toHaveCount(1);
  // Le plan et la chronologie suivent : la n° 1 est désormais GCPAR01.
  await expect(row(page, 'GCPAR01').locator('.parcours-stop-index')).toHaveText('1');

  // Glisser GCPAR02 au-dessus de GCPAR01.
  await row(page, 'GCPAR02').dragTo(row(page, 'GCPAR01'), { targetPosition: { x: 20, y: 2 } });
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR02', 'GCPAR01', 'GCPAR03']);

  // Enregistré : rechargement, même ordre.
  await openReady(page);
  expect((await snapshot(page)).days[0].keys).toEqual(['GCPAR02', 'GCPAR01', 'GCPAR03']);

  state = await snapshot(page);
  await page.locator('.parcours-day-auto').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR03', 'GCPAR01', 'GCPAR02']);
  expect(state.days[0].manual).toBe(false);
  expect(state.overrides).toEqual([]);
  expect(errors).toEqual([]);
});

test('épingler une heure, changer de journée, exclure puis réintégrer', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);

  // Heure épinglée : exacte, sans « ≈ ».
  await row(page, 'GCPAR01').locator('.parcours-stop-text').click();
  const panel = page.locator('.parcours-stop-edit[data-edit-key="GCPAR01"]');
  await panel.locator('.parcours-edit-time').fill('14:05');
  await panel.locator('.parcours-edit-pin').click();
  state = await adjusted(page, state.adjustmentRevision);
  const day1 = state.days[0];
  expect(day1.times[day1.keys.indexOf('GCPAR01')]).toBe('14:05');
  expect(day1.reasons[day1.keys.indexOf('GCPAR01')]).toBe('pinned');
  await expect(row(page, 'GCPAR01').locator('.parcours-stop-time')).toHaveText('14:05');

  // Journée corrigée : GCPAR04 (loguée le 13) rejoint le 12.
  await row(page, 'GCPAR04').locator('.parcours-stop-text').click();
  await page.locator('.parcours-stop-edit[data-edit-key="GCPAR04"] .parcours-edit-day').selectOption('2025-07-12');
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toContain('GCPAR04');
  expect(state.days[1].keys).toEqual(['GCPAR05']);
  await expect(row(page, 'GCPAR04')).toContainText('déplacée du');

  // Exclusion : hors du parcours et de la chronologie, réintégrable.
  await row(page, 'GCPAR05').locator('.parcours-stop-text').click();
  await page.locator('.parcours-stop-edit[data-edit-key="GCPAR05"] .parcours-edit-exclude').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[1].keys).toEqual([]);
  expect(state.days[1].excluded).toEqual(['GCPAR05']);
  expect(state.timeline.stopQ).toHaveLength(4);
  await expect(page.locator('#parcoursSummary')).toContainText('4 étapes');
  await row(page, 'GCPAR05').locator('.parcours-stop-restore').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[1].keys).toEqual(['GCPAR05']);

  // Tout annuler (confirmation) : l'ordre et les heures automatiques reviennent.
  await page.locator('#btnParcoursResetAdjustments').click();
  await page.locator('.gcm-confirm-modal.show [data-gcm-role="confirm"]').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.overrides).toEqual([]);
  expect(state.days.map((d) => d.keys)).toEqual([['GCPAR03', 'GCPAR01', 'GCPAR02'], ['GCPAR04', 'GCPAR05']]);
  await expect(page.locator('#btnParcoursResetAdjustments')).toBeHidden();
  expect(errors).toEqual([]);
});

test('poser une base d’un clic sur la carte : départ et retour de chaque journée', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);

  await page.locator('#btnParcoursAddPlace').click();
  await expect(page.locator('#parcoursPlaceHint')).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).picking).toBe(true);
  const map = page.locator('#map');
  const box = await map.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const form = page.locator('#parcoursPlaceForm');
  await expect(form).toBeVisible();
  await form.locator('#parcoursPlaceKind').selectOption('base');
  await expect(form.locator('#parcoursPlaceTimeRow')).toBeHidden();
  await form.locator('#parcoursPlaceName').fill('Hôtel du lac');
  await form.locator('#parcoursPlaceDay').selectOption('');
  await form.locator('#btnParcoursPlaceSave').click();
  state = await adjusted(page, state.adjustmentRevision);
  await expect(form).toBeHidden();

  const [place] = state.places;
  expect(place.kind).toBe('base');
  expect(place.date).toBeNull();
  for (const day of state.days) {
    expect(day.keys[0]).toBe(`place:${place.id}:${day.date}:start`);
    expect(day.keys.at(-1)).toBe(`place:${place.id}:${day.date}:end`);
  }
  // La base ne compte pas parmi les étapes, ni dans les points du moteur.
  await expect(page.locator('#parcoursSummary')).toContainText('5 étapes');
  expect(state.timeline.stopQ).toHaveLength(9);

  // Suppression depuis son panneau.
  await page.locator(`.parcours-stop[data-stop-key="place:${place.id}:2025-07-12:start"]`)
    .locator('.parcours-stop-text').click();
  await page.locator('.parcours-edit-delete-place').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.places).toEqual([]);
  expect(state.days[0].keys).toEqual(['GCPAR03', 'GCPAR01', 'GCPAR02']);
  expect(errors).toEqual([]);
});

test('un lieu posé à son heure devient une étape de sa journée', async ({ page, request }) => {
  const { id } = (await (await request.get('/api/parcours')).json()).parcours[0];
  const created = await request.post(`/api/parcours/${id}/places`, {
    data: { kind: 'place', name: 'Belvédère', lat: 45.903, lon: 6.125, date: '2025-07-12', time: '09:45' },
  });
  expect(created.status()).toBe(201);
  const placeKey = `place:${(await created.json()).place.id}`;
  await openReady(page);
  const state = await snapshot(page);
  const day1 = state.days[0];
  expect(day1.keys).toContain(placeKey);
  expect(day1.times[day1.keys.indexOf(placeKey)]).toBe('09:45');
  expect(day1.reasons[day1.keys.indexOf(placeKey)]).toBe('pinned');
  await expect(row(page, placeKey)).toContainText('Belvédère');
  await expect(page.locator('#parcoursSummary')).toContainText('5 étapes');
});
