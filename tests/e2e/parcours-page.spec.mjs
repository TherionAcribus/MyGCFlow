// Page Parcours (/parcours, MyGCFlow_Plan_Parcours.md) : parcours enregistrés
// et étapes dans l'ordre et aux heures reconstruits (lot 1).
//
// Fixture my-finds-parcours.gpx (compte 4242) : deux journées autour d'Annecy.
// 12/07/2025 : GCPAR03 (log 9001), GCPAR01 (9002), GCPAR02 (9003), alignées
// dans cet ordre — l'ordre des logs est retenu ;
// 13/07/2025 : GCPAR05 (9010), puis l'earthcache GCPAR04 (9011), type souvent
// logué après coup — une seule étape à log, ordre géographique depuis la
// veille : GCPAR04, la plus proche de GCPAR02, d'abord.
//
// Les logs du My Finds vivent hors de /clear_database : vidés en entrée et en
// sortie (AGENTS.md), comme les parcours créés.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { importGpx } from './gpx-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds-parcours.gpx');

async function clearLogs(request) {
  const response = await request.post('/api/logs/clear');
  expect(response.ok()).toBeTruthy();
}

async function deleteAllParcours(request) {
  const { parcours } = await (await request.get('/api/parcours')).json();
  for (const item of parcours) {
    expect((await request.delete(`/api/parcours/${item.id}`)).ok()).toBeTruthy();
  }
}

async function importFixture(page, request) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await importGpx(page, FIXTURE);
  // Fin réelle de l'import : trouvailles ET logs du My Finds en base.
  await expect.poll(async () => (await (await request.get('/api/parcours')).json()).finds,
    { timeout: 30_000 }).toEqual({ first: '2025-07-12', last: '2025-07-13' });
  await expect.poll(async () => (await (await request.get('/api/logs/status')).json()).account?.user_id ?? null,
    { timeout: 30_000 }).toBe(4242);
}

async function openParcoursPage(page) {
  await page.goto('/parcours', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.waitForFunction(() => window.mygcflowParcoursLoaded === true, null, { timeout: 30_000 });
}

function snapshot(page) {
  return page.evaluate(() => window.getParcoursSnapshot());
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.beforeEach(async ({ request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
});

test.afterEach(async ({ request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
});

test('page sans parcours : mode actif, onglets du lot 0, aucune erreur', async ({ page }) => {
  const errors = collectErrors(page);
  // La page ne doit pas réécrire le rythme de la page principale (`animation`) :
  // elle y remettait le suivi de caméra à false au chargement.
  const settingsWrites = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().endsWith('/api/settings')) settingsWrites.push(req.postDataJSON());
  });
  await openParcoursPage(page);
  await expect(page.locator('#linkParcoursMode')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#parcoursListEmpty')).toBeVisible();
  await expect(page.locator('#parcoursSummary')).toContainText('Ouvrez ou créez un parcours');
  // Pas encore d'animation : ni onglet Animation, ni lecture rapide.
  await expect(page.locator('#mainTabs a[href="#animation"]')).toHaveCount(0);
  await expect(page.locator('#mainTabs a[href="#style"]')).toBeVisible();
  await expect(page.locator('#btnQuickPreview')).toBeHidden();
  await expect(page.locator('#emptyState')).toBeHidden();
  expect((await snapshot(page)).status).toBe('idle');
  // Au-delà du délai d'écriture différée (500 ms) des réglages d'animation.
  await page.waitForTimeout(1200);
  expect(settingsWrites.filter((patch) => 'animation' in patch)).toEqual([]);
  expect(errors).toEqual([]);
});

test('créer un parcours : étapes reconstruites par jour, heures, sur la carte', async ({ page, request }) => {
  await importFixture(page, request);
  const errors = collectErrors(page);
  await openParcoursPage(page);

  // Dates proposées : le dernier jour de trouvailles.
  await expect(page.locator('#parcoursStart')).toHaveValue('2025-07-13');
  await page.locator('#parcoursName').fill('Week-end à Annecy');
  await page.locator('#parcoursStart').fill('2025-07-12');
  await page.locator('#parcoursStart').dispatchEvent('change');
  await page.locator('#parcoursEnd').fill('2025-07-13');
  await page.locator('#parcoursEnd').dispatchEvent('change');
  await expect(page.locator('#parcoursRangeHint')).toHaveText('2 jours');
  await page.locator('#btnParcoursCreate').click();

  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const state = await snapshot(page);
  expect(state.logsAvailable).toBe(true);
  expect(state.days.map((d) => [d.date, d.keys, d.reasons, d.logOrder])).toEqual([
    ['2025-07-12', ['GCPAR03', 'GCPAR01', 'GCPAR02'], ['log-order', 'log-order', 'log-order'], 'trusted'],
    ['2025-07-13', ['GCPAR04', 'GCPAR05'], ['late-type', 'geo'], 'none'],
  ]);
  // Sans ancre, la journée commence à 9 h ; heures croissantes.
  expect(state.days[0].times[0]).toBe('09:00');
  expect(state.days[0].times).toEqual([...state.days[0].times].sort());
  expect(state.layer).toEqual({ stops: 5, lines: 2, onMap: true });
  await expect(page.locator('.parcours-list-item.active')).toContainText('Week-end à Annecy');
  await expect(page.locator('#parcoursSummary')).toContainText('5 étapes');
  await expect(page.locator('.parcours-stop').first()).toContainText('Départ du sentier');
  await expect(page.locator('.parcours-stop-time').first()).toHaveText('≈ 09:00');
  await expect(page.locator('.parcours-day-diagnostic').first()).toContainText('ordre de saisie des logs retenu');
  await expect(page.locator('.parcours-stop[data-stop-key="GCPAR04"]')).toContainText('souvent loguée après coup');
  await expect(page.locator('.parcours-stop-index').last()).toHaveText('5');

  // Rechargement : le dernier parcours ouvert revient.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowParcoursLoaded === true, null, { timeout: 30_000 });
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  expect((await snapshot(page)).days[1].keys).toEqual(['GCPAR04', 'GCPAR05']);
  expect(errors).toEqual([]);
});

test('une saisie invalide est refusée avec un message', async ({ page, request }) => {
  await importFixture(page, request);
  await openParcoursPage(page);
  await page.locator('#parcoursName').fill('Trop long');
  await page.locator('#parcoursStart').fill('2025-01-01');
  await page.locator('#parcoursEnd').fill('2025-07-13');
  await page.locator('#parcoursEnd').dispatchEvent('change');
  await expect(page.locator('#parcoursRangeHint')).toHaveText('Un parcours couvre 92 jours au plus');
  await page.locator('#btnParcoursCreate').click();
  await expect(page.locator('.gcm-toast.show')).toContainText('92 jours au plus');
  expect((await snapshot(page)).ids).toEqual([]);
});

test('supprimer un parcours après confirmation', async ({ page, request }) => {
  await importFixture(page, request);
  const created = await request.post('/api/parcours',
    { data: { name: 'Journée', date_start: '2025-07-12', date_end: '2025-07-12' } });
  expect(created.status()).toBe(201);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).layer?.stops).toBe(3);

  await page.locator('.parcours-delete').click();
  await page.locator('.gcm-confirm-modal.show [data-gcm-role="confirm"]').click();
  await expect(page.locator('#parcoursListEmpty')).toBeVisible();
  const state = await snapshot(page);
  expect(state.ids).toEqual([]);
  expect(state.layer.stops).toBe(0);
});
