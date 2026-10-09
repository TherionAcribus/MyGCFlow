import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds-locationless.gpx');

// Caches « locationless » (type "Locationless (Reverse) Cache", ex. GC9FAVE) :
// leur position dans le GPX est fictive. Par défaut (« hidden ») elles restent
// comptées — compteurs et « n / total » — mais n'affichent aucun point,
// n'étendent pas l'emprise de cadrage et n'entrent pas dans le trajet ni le
// suivi de caméra. « shown » les réaffiche comme les autres caches.


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  await dismissFirstUseModal(page);
}


// 4 trouvailles dont GC9FAVE (locationless aux États-Unis, trouvée le 3 janv.).
// Par défaut elle est comptée mais hors des index d'affichage : pointsByDate
// garde les 3 jours parisiens, hiddenPointsByDate retient la locationless.
async function importFixture(page) {
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4', { timeout: 45_000 });
  await page.waitForFunction(async () => {
    const app = await import('/static/js/index.js');
    return app.metadata?.numberOfCaches === 4 && app.pointsByDate?.size === 3;
  });
}


async function visiblePoints(page) {
  return page.evaluate(() => window.vectorSource?.getFeatures()?.length ?? -1);
}


async function readServerSettings(page) {
  return page.evaluate(async () => (await fetch('/api/settings')).json());
}


// La préférence est serveur (settings.json) et partagée par le runtime de
// test : toujours la ramener à « hidden » pour ne pas influencer les autres
// specs (et vider la base importée ici).
test.afterEach(async ({ page, request }) => {
  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationless_display: 'hidden' }),
  })).catch(() => {});
  await request.post('/clear_database').catch(() => {});
});


test('par défaut, une locationless est comptée sans point sur la carte', async ({ page }) => {
  await openReadyApp(page);
  await importFixture(page);

  // Comptée dans la sélection…
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4');
  // …mais absente des points affichés : seules les 3 caches parisiennes.
  expect(await visiblePoints(page)).toBe(3);

  // Index des jours : la locationless est rangée à part, pas supprimée.
  const index = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const count = (map) => [...(map?.values() ?? [])].reduce((n, day) => n + day.length, 0);
    return { shown: count(app.pointsByDate), hidden: count(app.hiddenPointsByDate) };
  });
  expect(index).toEqual({ shown: 3, hidden: 1 });

  // Sa position fictive ne doit pas étendre l'emprise de cadrage : -98.6° E
  // resterait dehors, l'ouest mesuré reste parisien (~2.3° E).
  const extent = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return app.dataExtentLonLat();
  });
  expect(extent).not.toBeNull();
  expect(extent[0]).toBeGreaterThan(0);

  // Le réglage exposé dans l'onglet Données reflète le défaut « hidden ».
  await page.locator('a[href="#data"]').click();
  await expect(page.locator('#selectLocationlessDisplay')).toHaveValue('hidden');
});


test('« affichées » rend le point et l\'emprise, en gardant le comptage', async ({ page }) => {
  await openReadyApp(page);
  await importFixture(page);

  await page.locator('a[href="#data"]').click();
  await page.locator('#selectLocationlessDisplay').selectOption('shown');

  // La préférence est persistée côté serveur…
  await expect.poll(async () => (await readServerSettings(page)).locationless_display).toBe('shown');
  // …et répercutée à la volée : le point rejoint la carte et l'index des jours.
  await expect.poll(() => visiblePoints(page)).toBe(4);
  await page.waitForFunction(async () => {
    const app = await import('/static/js/index.js');
    return app.pointsByDate?.size === 4 && (app.hiddenPointsByDate?.size ?? 0) === 0;
  });
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4');

  // L'emprise intègre désormais le point fictif aux États-Unis.
  const extent = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return app.dataExtentLonLat();
  });
  expect(extent[0]).toBeLessThan(-90);
});
