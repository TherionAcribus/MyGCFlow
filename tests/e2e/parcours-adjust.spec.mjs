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

test('glisser-déposer une étape vers la journée suivante', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);
  expect(state.days).toHaveLength(2);

  // GCPAR03 lâchée au-dessus de GCPAR04 : elle ouvre le dimanche.
  await row(page, 'GCPAR03').dragTo(row(page, 'GCPAR04'), { targetPosition: { x: 20, y: 2 } });
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR01', 'GCPAR02']);
  expect(state.days[1].keys).toEqual(['GCPAR03', 'GCPAR04', 'GCPAR05']);
  expect(state.days[1].manual).toBe(true);
  expect(state.overrides.find((o) => o.key === 'GCPAR03')?.day).toBe('2025-07-13');

  // Enregistré : rechargement, même répartition.
  await openReady(page);
  expect((await snapshot(page)).days.map((d) => d.keys))
    .toEqual([['GCPAR01', 'GCPAR02'], ['GCPAR03', 'GCPAR04', 'GCPAR05']]);
  expect(errors).toEqual([]);
});

test('journées repliables : chevron, tout plier, dépôt qui déplie', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  const sat = page.locator('.parcours-day[data-date="2025-07-12"]');
  const sun = page.locator('.parcours-day[data-date="2025-07-13"]');

  // Chevron : la journée se replie, son nombre d'étapes reste lisible.
  await sat.locator('.parcours-day-toggle').click();
  await expect(sat.locator('.parcours-day-body')).toBeHidden();
  await expect(sat.locator('.parcours-day-count')).toContainText('3 étapes');
  await expect(sat.locator('.parcours-day-toggle')).toHaveAttribute('aria-expanded', 'false');
  await sat.locator('.parcours-day-toggle').click();
  await expect(sat.locator('.parcours-day-body')).toBeVisible();

  // Tout plier / tout déplier.
  await page.locator('#btnParcoursCollapseDays').click();
  await expect(sat.locator('.parcours-day-body')).toBeHidden();
  await expect(sun.locator('.parcours-day-body')).toBeHidden();
  await expect(page.locator('#btnParcoursCollapseDays')).toContainText('Tout déplier');
  await page.locator('#btnParcoursCollapseDays').click();
  await expect(sun.locator('.parcours-day-body')).toBeVisible();

  // Déposer sur une journée repliée la déplie : le résultat reste visible.
  await sun.locator('.parcours-day-toggle').click();
  const before = (await snapshot(page)).adjustmentRevision;
  await row(page, 'GCPAR03').dragTo(sun);
  const state = await adjusted(page, before);
  expect(state.days[1].keys).toEqual(['GCPAR04', 'GCPAR05', 'GCPAR03']);
  await expect(sun.locator('.parcours-day-body')).toBeVisible();
  expect(errors).toEqual([]);
});

test('annuler / rétablir : boutons, Ctrl+Z, et remise à zéro annulable', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);
  const undo = page.locator('#btnParcoursUndo');
  const redo = page.locator('#btnParcoursRedo');
  await expect(undo).toBeDisabled();

  // Un déplacement : le bouton Annuler s'active, l'annulation le défait.
  await row(page, 'GCPAR03').locator('.parcours-stop-down').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR01', 'GCPAR03', 'GCPAR02']);
  await expect(undo).toBeEnabled();

  await undo.click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR03', 'GCPAR01', 'GCPAR02']);
  expect(state.overrides).toEqual([]);
  await expect(redo).toBeEnabled();

  await redo.click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR01', 'GCPAR03', 'GCPAR02']);

  // Les raccourcis font la même chose que les boutons.
  await page.keyboard.press('Control+z');
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR03', 'GCPAR01', 'GCPAR02']);
  await page.keyboard.press('Control+Shift+z');
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR01', 'GCPAR03', 'GCPAR02']);

  // « Annuler les ajustements » est lui-même annulable.
  await page.locator('#btnParcoursResetAdjustments').click();
  await page.locator('.gcm-confirm-modal.show [data-gcm-role="confirm"]').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.overrides).toEqual([]);
  await undo.click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.days[0].keys).toEqual(['GCPAR01', 'GCPAR03', 'GCPAR02']);
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

test('ajustement en vol : la réponse d’un autre parcours n’écrase pas celui ouvert', async ({ page, request }) => {
  const errors = collectErrors(page);
  // Deuxième parcours, une journée : il partage GCPAR01 avec le premier.
  const created = await request.post('/api/parcours',
    { data: { name: 'Journée', date_start: '2025-07-12', date_end: '2025-07-12' } });
  expect(created.status()).toBe(201);
  const b = (await created.json()).parcours;
  await openReady(page);
  const a = (await snapshot(page)).selectedId;
  const before = (await snapshot(page)).days[0];
  const gcpaTime = before.times[before.keys.indexOf('GCPAR01')];

  // L'écriture de l'heure épinglée est suspendue le temps de changer de parcours.
  const urls = [];
  let held = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/parcours/*/overrides', async (route) => {
    urls.push(route.request().url());
    if (held) await gate;
    await route.continue();
  });
  await row(page, 'GCPAR01').locator('.parcours-stop-text').click();
  const panel = page.locator('.parcours-stop-edit[data-edit-key="GCPAR01"]');
  await panel.locator('.parcours-edit-time').fill('14:05');
  await panel.locator('.parcours-edit-pin').click();
  await expect.poll(() => urls.length, { timeout: 15_000 }).toBe(1);
  expect(urls[0]).toContain(`/parcours/${a}/overrides`);

  await page.locator(`.parcours-list-item[data-parcours-id="${b.id}"] .parcours-open`).click();
  await expect.poll(async () => (await snapshot(page)).selectedId).toBe(b.id);

  held = false;
  release();
  // L'écriture a abouti côté serveur, sur le premier parcours.
  await expect.poll(async () => (await request.get(`/api/parcours/${a}/inputs`)).json()
    .then((body) => body.overrides.length), { timeout: 30_000 }).toBe(1);
  // Le parcours ouvert n'a rien reçu : ni ajustement, ni heure de l'autre.
  const state = await snapshot(page);
  expect(state.overrides).toEqual([]);
  const day = state.days[0];
  expect(day.times[day.keys.indexOf('GCPAR01')]).toBe(gcpaTime);
  expect(day.reasons[day.keys.indexOf('GCPAR01')]).not.toBe('pinned');
  expect(errors).toEqual([]);
});

test('le focus clavier survit au déplacement d’une étape', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  const down = row(page, 'GCPAR03').locator('.parcours-stop-down');
  await down.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await snapshot(page)).days[0].keys)
    .toEqual(['GCPAR01', 'GCPAR03', 'GCPAR02']);
  // Le bouton « Descendre » de GCPAR03, re-rendu à sa nouvelle place, garde
  // le focus : un second appui descend encore.
  await expect(row(page, 'GCPAR03').locator('.parcours-stop-down')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await snapshot(page)).days[0].keys)
    .toEqual(['GCPAR01', 'GCPAR02', 'GCPAR03']);
  expect(errors).toEqual([]);
});

test('clics rapides sur « descendre » : les deux déplacements composent', async ({ page }) => {
  const errors = collectErrors(page);
  // Chaque écriture d'ajustement attend 300 ms : le second clic est donc
  // calculé avant le retour du premier envoi.
  const urls = [];
  await page.route('**/api/parcours/*/overrides', async (route) => {
    urls.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await openReady(page);
  const rev = (await snapshot(page)).adjustmentRevision;
  expect((await snapshot(page)).days[0].keys).toEqual(['GCPAR03', 'GCPAR01', 'GCPAR02']);

  await row(page, 'GCPAR03').locator('.parcours-stop-down').click();
  // La ligne est déjà re-rendue à sa nouvelle place : le second clic repart
  // de cet état pendant que le premier envoi est encore en vol.
  await row(page, 'GCPAR03').locator('.parcours-stop-down').click();

  const state = await adjusted(page, rev);
  expect(urls.length).toBe(2);
  expect(state.days[0].keys).toEqual(['GCPAR01', 'GCPAR02', 'GCPAR03']);
  // Persisté : rechargement, même ordre.
  await openReady(page);
  expect((await snapshot(page)).days[0].keys).toEqual(['GCPAR01', 'GCPAR02', 'GCPAR03']);
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

test('poser un lieu : le point provisoire reste affiché jusqu’à la validation', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);
  const stops = state.layer.stops;
  expect(state.placeDraft).toBeNull();
  expect(state.layer.draft).toBe(0);

  // Clic sur la carte : le point provisoire paraît tant que le formulaire
  // est ouvert — le clic n'est pas resté sans effet.
  await page.locator('#btnParcoursAddPlace').click();
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const form = page.locator('#parcoursPlaceForm');
  await expect(form).toBeVisible();
  state = await snapshot(page);
  expect(state.placeDraft).not.toBeNull();
  expect(state.layer.draft).toBe(1);

  // Annulation : le point provisoire disparaît, rien n'est posé.
  await page.locator('#btnParcoursPlaceCancel').click();
  state = await snapshot(page);
  expect(state.placeDraft).toBeNull();
  expect(state.layer.draft).toBe(0);
  expect(state.places).toEqual([]);

  // Validation : le provisoire laisse la place au vrai point.
  await page.locator('#btnParcoursAddPlace').click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(form).toBeVisible();
  await form.locator('#parcoursPlaceName').fill('Point de vue');
  await form.locator('#btnParcoursPlaceSave').click();
  state = await adjusted(page, state.adjustmentRevision);
  await expect(form).toBeHidden();
  expect(state.layer.draft).toBe(0);
  expect(state.places.map((p) => p.name)).toEqual(['Point de vue']);
  expect(state.layer.stops).toBe(stops + 1);
  expect(errors).toEqual([]);
});

test('catégories de lieux : icône choisie, icône libre pour « personnalisée »', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);

  // Pose d'un lieu « parking » par le formulaire : la ligne prend l'icône
  // et le détail de la catégorie.
  await page.locator('#btnParcoursAddPlace').click();
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const form = page.locator('#parcoursPlaceForm');
  await expect(form).toBeVisible();
  await form.locator('#parcoursPlaceCategory').selectOption('parking');
  await expect(form.locator('#parcoursPlaceIconRow')).toBeHidden();
  await form.locator('#parcoursPlaceName').fill('Parking du col');
  await form.locator('#btnParcoursPlaceSave').click();
  state = await adjusted(page, state.adjustmentRevision);
  const parking = state.places.find((p) => p.name === 'Parking du col');
  expect(parking.category).toBe('parking');
  const parkingKey = `place:${parking.id}`;
  await expect(row(page, parkingKey)).toContainText('parking');
  await expect(row(page, parkingKey).locator('i.ti-parking').first()).toBeVisible();

  // « Personnalisée » : la grille d'icônes apparaît dans le panneau, le
  // choix s'enregistre et s'affiche.
  await row(page, parkingKey).locator('.parcours-stop-text').click();
  const panel = page.locator(`.parcours-stop-edit[data-edit-key="${parkingKey}"]`);
  await panel.locator('.parcours-edit-place-category').selectOption('custom');
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.places.find((p) => p.id === parking.id).category).toBe('custom');
  const picker = panel.locator('.parcours-icon-picker');
  await expect(picker).toBeVisible();
  await picker.locator('.parcours-icon-choice:has(i.ti-tent)').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.places.find((p) => p.id === parking.id).icon).toBe('ti-tent');
  await expect(row(page, parkingKey).locator('i.ti-tent').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('bases à rôles : partir d’un hôtel, dormir au camping', async ({ page, request }) => {
  const { id } = (await (await request.get('/api/parcours')).json()).parcours[0];
  const depart = await request.post(`/api/parcours/${id}/places`, {
    data: { kind: 'base', name: 'Hôtel', lat: 45.91, lon: 6.13, role: 'start' },
  });
  const retour = await request.post(`/api/parcours/${id}/places`, {
    data: { kind: 'base', name: 'Camping', lat: 45.89, lon: 6.11, role: 'end' },
  });
  expect(depart.status()).toBe(201);
  expect(retour.status()).toBe(201);
  const startId = (await depart.json()).place.id;
  const endId = (await retour.json()).place.id;
  const errors = collectErrors(page);
  await openReady(page);
  const state = await snapshot(page);
  // Chaque journée part de l'hôtel et finit au camping.
  for (const day of state.days) {
    expect(day.keys[0]).toBe(`place:${startId}:${day.date}:start`);
    expect(day.keys.at(-1)).toBe(`place:${endId}:${day.date}:end`);
  }

  // Le formulaire de pose propose le rôle pour une base seulement.
  await page.locator('#btnParcoursAddPlace').click();
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const form = page.locator('#parcoursPlaceForm');
  await expect(form.locator('#parcoursPlaceRoleRow')).toBeHidden();
  await form.locator('#parcoursPlaceKind').selectOption('base');
  await expect(form.locator('#parcoursPlaceRoleRow')).toBeVisible();
  await page.locator('#btnParcoursPlaceCancel').click();

  // Le panneau d'une base change son rôle : l'hôtel ne sert plus que le
  // retour — mais le camping, posé après, garde l'arrivée ; plus de départ.
  await page.locator(`.parcours-stop[data-stop-key="place:${startId}:2025-07-12:start"]`)
    .locator('.parcours-stop-text').click();
  await page.locator('.parcours-edit-place-role').selectOption('end');
  const next = await adjusted(page, state.adjustmentRevision);
  expect(next.days[0].keys[0]).not.toContain(':start');
  expect(next.days[0].keys.at(-1)).toBe(`place:${endId}:2025-07-12:end`);
  expect(next.places.find((p) => p.id === startId)?.role).toBe('end');
  expect(errors).toEqual([]);
});

test('éditer un lieu : nom, journée, type et déplacement sur la carte', async ({ page, request }) => {
  const { id } = (await (await request.get('/api/parcours')).json()).parcours[0];
  const created = await request.post(`/api/parcours/${id}/places`, {
    data: { kind: 'place', name: 'Belvédère', lat: 45.903, lon: 6.125, date: '2025-07-12', time: '09:45' },
  });
  expect(created.status()).toBe(201);
  const placeId = (await created.json()).place.id;
  const placeKey = `place:${placeId}`;
  const errors = collectErrors(page);
  await openReady(page);
  let state = await snapshot(page);

  // Renommer depuis le panneau de l'étape.
  await row(page, placeKey).locator('.parcours-stop-text').click();
  const panel = page.locator(`.parcours-stop-edit[data-edit-key="${placeKey}"]`);
  await panel.locator('.parcours-edit-place-name').fill('Mont Veyrier');
  await panel.locator('.parcours-edit-place-rename').click();
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.places.find((p) => p.id === placeId).name).toBe('Mont Veyrier');
  await expect(row(page, placeKey)).toContainText('Mont Veyrier');

  // Changer de journée : le lieu rejoint le 13.
  await panel.locator('.parcours-edit-place-day').selectOption('2025-07-13');
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.places.find((p) => p.id === placeId).date).toBe('2025-07-13');
  expect(state.days[1].keys).toContain(placeKey);
  expect(state.days[0].keys).not.toContain(placeKey);

  // Type : le lieu devient une base de sa journée (départ et retour).
  await panel.locator('.parcours-edit-place-kind').selectOption('base');
  state = await adjusted(page, state.adjustmentRevision);
  expect(state.places.find((p) => p.id === placeId).kind).toBe('base');
  expect(state.days[1].keys[0]).toBe(`place:${placeId}:2025-07-13:start`);
  expect(state.days[1].keys.at(-1)).toBe(`place:${placeId}:2025-07-13:end`);

  // Déplacer sur la carte : un clic envoie les nouvelles coordonnées.
  await page.locator(`.parcours-stop[data-stop-key="place:${placeId}:2025-07-13:start"]`)
    .locator('.parcours-stop-text').click();
  await page.locator('.parcours-stop-edit[data-edit-key] .parcours-edit-place-move').click();
  await expect.poll(async () => (await snapshot(page)).picking).toBe(true);
  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.click(mapBox.x + mapBox.width / 4, mapBox.y + mapBox.height / 4);
  state = await adjusted(page, state.adjustmentRevision);
  const moved = state.places.find((p) => p.id === placeId);
  expect(Math.abs(moved.lat - 45.903) + Math.abs(moved.lon - 6.125)).toBeGreaterThan(0.01);
  expect(errors).toEqual([]);
});

test('durée de visite réglable : les heures suivantes se décalent', async ({ page }) => {
  const errors = collectErrors(page);
  const toMin = (text) => {
    const m = text.match(/(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  await openReady(page);
  const timeOf = (key) => row(page, key).locator('.parcours-stop-time').textContent().then(toMin);
  const before = await timeOf('GCPAR02');

  // Panneau de GCPAR01 : durée imposée à 120 min au lieu des ~10 estimées.
  await row(page, 'GCPAR01').locator('.parcours-stop-text').click();
  const visit = page.locator('#parcoursEditVisit-GCPAR01');
  await expect(visit).toBeVisible();
  const before0 = (await snapshot(page)).adjustmentRevision;
  await visit.fill('120');
  await visit.dispatchEvent('change');
  const state = await adjusted(page, before0);
  expect(state.overrides.find((o) => o.key === 'GCPAR01')?.visitMin).toBe(120);
  // GCPAR02 arrive 110 min plus tard (120 imposées − 10 par défaut).
  expect(await timeOf('GCPAR02') - before).toBe(110);

  // Enregistré : rechargement, la durée est conservée.
  await openReady(page);
  expect((await snapshot(page)).overrides.find((o) => o.key === 'GCPAR01')?.visitMin).toBe(120);
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
