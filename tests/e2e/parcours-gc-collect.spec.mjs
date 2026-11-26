// Page Parcours : « Compléter depuis geocaching.com »
// (MyGCFlow_Plan_Parcours.md § 15.3, docs/parcours.md). La page pose une
// demande de collecte limitée aux caches du parcours ; le favori « Mes
// logs » la lit dans /api/logs/receive/state. Son export est simulé ici :
// envoyé à /api/logs/receive/fragment avec l'en-tête de la demande, comme
// le ferait le favori en fin de collecte. La page le propose ensuite à la
// validation, puis recharge les étapes (coordonnées corrigées).
import { expect, test } from '@playwright/test';
import {
  cleanUp,
  clearLogs,
  collectErrors,
  createWeekend,
  deleteAllParcours,
  importFixture,
  openEnrichSection,
  openParcoursPage,
  snapshot,
} from './parcours-helpers.mjs';

let parcours;

test.beforeEach(async ({ page, request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
  await importFixture(page, request);
  parcours = await createWeekend(request);
});

test.afterEach(async ({ request }) => {
  // Une demande restée en place serait servie au favori des specs suivants.
  await request.delete(`/api/parcours/${parcours.id}/collect`);
  await cleanUp(request);
});

async function receiveToken(request) {
  const js = (await (await request.get('/api/logs/bookmarklet')).json()).bookmarklet;
  return /TOKEN\s*=\s*"([^"]+)"/.exec(js)[1];
}

test('demande limitée au parcours, export reçu puis validé dans la page', async ({ page, request }) => {
  const errors = collectErrors(page);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const card = page.locator('#parcoursCollectCard');
  await expect(card).toBeVisible();
  // Section repliée : le compte reste lisible dans son en-tête.
  await expect(page.locator('#parcoursCollectHint')).toHaveText('5 caches dans ce parcours, dont 5 jamais relues.');
  await openEnrichSection(page, 'collect');
  await expect(page.locator('#parcoursCollectSummary')).toContainText('5');
  await expect(page.locator('#parcoursCollectReady')).toBeHidden();

  await page.locator('#btnParcoursCollectPrepare').click();
  await expect(page.locator('#parcoursCollectReady')).toBeVisible();
  await expect(page.locator('#parcoursCollectReadyText')).toContainText('5');
  // Le favori à glisser est prêt dans la carte même.
  await expect(page.locator('#parcoursCollectBookmarklet')).toHaveAttribute('href', /^javascript:/);

  // Ce que le favori lit avant de partir : la demande, ses seules caches.
  const token = await receiveToken(request);
  const state = await (await request.get('/api/logs/receive/state',
    { headers: { 'X-MyGCFlow-Token': token } })).json();
  expect(state.request.label).toBe('Week-end');
  expect(state.request.codes).toEqual(['GCPAR01', 'GCPAR02', 'GCPAR03', 'GCPAR04', 'GCPAR05']);

  // Fin de collecte simulée : GCPAR01 corrigée sur le site, PF donné.
  const doc = {
    format: 'mygcflow-logs',
    schema_version: 1,
    exported_at: new Date().toISOString(),
    account: { user_id: 4242, username: 'e2e-parcours' },
    coverage: [],
    caches: [
      { gc_code: 'GCPAR01', type: 'Unknown Cache', latitude: 45.8800, longitude: 6.1000,
        corrected: { latitude: 45.9020, longitude: 6.1230 }, favorite_points: 12, found_count: 340,
        waypoints: [{ kind: 'parking', name: 'Parking du lac', latitude: 45.9010, longitude: 6.1210 }] },
      { gc_code: 'GCPAR02', type: 'Traditional Cache', latitude: 45.9050, longitude: 6.1300 },
    ],
    logs: [
      { log_id: 9002, gc_code: 'GCPAR01', type_id: 2, date: '2025-07-12',
        author: { id: 4242, name: 'e2e-parcours' }, favorite: true },
    ],
  };
  const sealed = await request.post('/api/logs/receive/fragment', {
    data: doc,
    headers: {
      'X-MyGCFlow-Token': token,
      'X-MyGCFlow-Run-Id': 'run-parcours-e2e',
      'X-MyGCFlow-Final': '1',
      'X-MyGCFlow-Request': state.request.id,
    },
  });
  expect(sealed.status()).toBe(202);

  // La page reconnaît son export au relevé suivant (4 s).
  const pending = page.locator('#parcoursCollectPending');
  await expect(pending).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#parcoursCollectReady')).toBeHidden();
  await expect(page.locator('#parcoursCollectPendingText')).toContainText('1 aux coordonnées corrigées');
  await expect(page.locator('#parcoursCollectPendingText')).toContainText('1 points favoris');
  await expect(page.locator('#parcoursCollectPendingText')).toContainText('1 parkings');
  await expect(page.locator('#parcoursCollectPendingText')).toContainText('compteurs de trouvailles lus sur 1 fiches');

  await page.locator('#btnParcoursCollectApply').click();
  await expect(pending).toBeHidden({ timeout: 15_000 });
  // Étapes rechargées : GCPAR01 à ses coordonnées corrigées.
  const stop = page.locator('.parcours-stop[data-stop-key="GCPAR01"]');
  await expect(stop).toHaveAttribute('data-pos-source', 'corrected');
  await expect(stop.locator('.parcours-stop-text')).toContainText('coordonnées corrigées');
  // PF donné (log de trouvaille) et chiffres de la fiche servis à l'étape.
  await expect(stop.locator('.parcours-stop-text')).toContainText('PF donné');
  const served = (await snapshot(page)).stopStyles;
  expect([served.GCPAR01.favorite, served.GCPAR02.favorite]).toEqual([true, false]);
  await expect(page.locator('.parcours-stop[data-stop-key="GCPAR02"]')).not.toHaveAttribute('data-pos-source', /./);
  // Parking de la fiche : proposé dans sa journée, posé d'un clic comme
  // lieu « parking », puis plus proposé.
  const parkings = page.locator('.parcours-day-parkings');
  await expect(parkings).toHaveCount(1);
  await parkings.locator('summary').click();
  await expect(parkings).toContainText('Parking du lac');
  const revision = (await snapshot(page)).adjustmentRevision;
  await parkings.locator('.parcours-parking-create').click();
  await expect.poll(async () => (await snapshot(page)).adjustmentRevision).toBeGreaterThan(revision);
  const posed = await snapshot(page);
  expect(posed.places).toEqual([expect.objectContaining({
    kind: 'place', name: 'Parking du lac', category: 'parking', date: '2025-07-12' })]);
  expect(posed.parkings).toEqual({});
  await expect(page.locator('.parcours-day-parkings')).toHaveCount(0);

  // Deux fiches lues : trois caches jamais relues.
  await expect(page.locator('#parcoursCollectSummary')).toContainText('dont 3');
  const after = await page.evaluate(() => window.getParcoursCollectSnapshot());
  expect(after.polling).toBe(false);
  expect(errors).toEqual([]);
});

test('annuler la demande', async ({ page, request }) => {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await openEnrichSection(page, 'collect');
  await page.locator('#parcoursCollectAll').check();
  await page.locator('#btnParcoursCollectPrepare').click();
  await expect(page.locator('#parcoursCollectReady')).toBeVisible();
  await page.locator('#btnParcoursCollectCancel').click();
  await expect(page.locator('#parcoursCollectReady')).toBeHidden();
  await expect(page.locator('#btnParcoursCollectPrepare')).toBeVisible();
  const token = await receiveToken(request);
  const state = await (await request.get('/api/logs/receive/state',
    { headers: { 'X-MyGCFlow-Token': token } })).json();
  expect(state.request).toBeNull();
});
