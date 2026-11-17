// Page Parcours, lot 6 : itinéraires réels (MyGCFlow_Plan_Parcours.md § 10,
// docs/parcours.md). Aucun appel réseau : un faux serveur OSRM local (au
// format FOSSGIS, /routed-<profil>/route/v1/driving/...) répond à la place,
// et la préférence `parcours_routing.fossgis_url` pointe dessus. Chaque
// trajet y dure 30 min et passe par un détour au nord.
//
// Le cache des itinéraires (route_leg_cache) est partagé par le runtime :
// les comptes de requêtes sont donc relatifs (rechargement = 0 requête,
// « Recalculer » = une par suite de trajets).
import { expect, test } from '@playwright/test';
import http from 'node:http';
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

let server;
let baseUrl;
const requests = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url);
    const match = /\/routed-(foot|bike|car)\/route\/v1\/driving\/([^?]+)/.exec(req.url);
    const points = match ? decodeURIComponent(match[2]).split(';').map((p) => p.split(',').map(Number)) : [];
    const legs = points.slice(1).map((b, i) => {
      const a = points[i];
      const mid = [(a[0] + b[0]) / 2, Math.max(a[1], b[1]) + 0.003];
      return { distance: 2500, duration: 1800, steps: [{ geometry: { coordinates: [a, mid] } }, { geometry: { coordinates: [mid, b] } }] };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'Ok', routes: [{ legs }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(async ({ page, request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
  await importFixture(page, request);
  await createWeekend(request);
});

test.afterEach(async ({ request }) => {
  await cleanUp(request);
});

async function enableRouting(request, extra = {}) {
  const response = await request.put('/api/settings', {
    data: { parcours_routing: { enabled: true, provider: 'fossgis', fossgis_url: baseUrl, ...extra } },
  });
  expect(response.ok()).toBeTruthy();
}

async function openRouted(page) {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await expect.poll(async () => (await snapshot(page)).routing.state, { timeout: 30_000 }).toBe('ready');
  return snapshot(page);
}

test('itinéraires : chemins et durées réels, cache local, recalcul', async ({ page, request }) => {
  const errors = collectErrors(page);
  await enableRouting(request);
  let state = await openRouted(page);
  await expect(page.locator('#parcoursRoutingCard')).toBeVisible();
  // Samedi : deux trajets à pied d'une même suite ; dimanche : un trajet.
  expect(state.routing.requests).toBe(2);
  expect(state.routing.routed).toBe(3);
  expect(state.routing.modes).toEqual(['walk', 'walk', 'walk']);
  // Durées de l'itinéraire : départ 09:00, visite de 10 min, trajet de 30 min.
  expect(state.days[0].times.slice(0, 2)).toEqual(['09:00', '09:40']);
  await expect(page.locator('#parcoursRoutingStatus')).toContainText('3 trajets sur 3');
  // Crédits du fournisseur : dans l'attribution de la carte (et la vidéo).
  expect(state.routeCredit).toContain('FOSSGIS');
  await expect(page.locator('.ol-attribution')).toContainText('FOSSGIS');

  // Rechargement : servi par le cache du serveur, aucune nouvelle requête.
  const before = requests.length;
  state = await openRouted(page);
  expect(requests.length).toBe(before);
  expect(state.routing.routed).toBe(3);

  // Recalculer : une requête par suite de trajets.
  await page.locator('#btnParcoursRoutesRecompute').click();
  await expect.poll(() => requests.length).toBe(before + 2);
  await expect.poll(async () => (await snapshot(page)).routing.state).toBe('ready');

  // Mode imposé : GCPAR01 → GCPAR02 en voiture (profil car), stationnement compris.
  const revision = state.adjustmentRevision;
  await page.locator('.parcours-stop[data-stop-key="GCPAR01"] .parcours-stop-text').click();
  await page.locator('.parcours-stop-edit[data-edit-key="GCPAR01"] .parcours-edit-leg').selectOption('car');
  await expect.poll(async () => (await snapshot(page)).adjustmentRevision).toBeGreaterThan(revision);
  await expect.poll(() => requests.some((url) => url.includes('/routed-car/'))).toBe(true);
  await expect.poll(async () => (await snapshot(page)).routing.modes).toEqual(['walk', 'car', 'walk']);
  // GCPAR02 : 09:40 + 10 min de visite + 30 min de route + 5 min de stationnement.
  await expect.poll(async () => (await snapshot(page)).days[0].times[2]).toBe('10:25');

  // Désactivé : retour aux lignes droites et aux estimations.
  await page.locator('#parcoursRoutingEnabled').uncheck();
  await expect.poll(async () => (await snapshot(page)).routing.routed).toBe(0);
  expect((await snapshot(page)).days[0].times[1]).not.toBe('09:40');
  expect(errors).toEqual([]);
});

test('fournisseur en échec : lignes droites et message, sans boucle de tentatives', async ({ page, request }) => {
  const errors = collectErrors(page);
  const calls = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/api/parcours/routes')) calls.push(req.url());
  });
  await enableRouting(request, { provider: 'ors', ors_key: '' });
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).routing.state, { timeout: 30_000 }).toBe('error');
  const state = await snapshot(page);
  expect(state.routing.routed).toBe(0);
  // Une seule tentative : l'échec suspend les suivantes (pas de boucle de
  // reconstructions qui relanceraient le fournisseur).
  const afterError = calls.length;
  await page.waitForTimeout(1500);
  expect(calls.length).toBe(afterError);
  expect(afterError).toBe(1);
  await expect(page.locator('#parcoursRoutingStatus')).toContainText('openrouteservice');
  await expect(page.locator('#parcoursOrsKeyRow')).toBeVisible();
  // La clé saisie n'est jamais renvoyée par le serveur.
  await page.locator('#parcoursOrsKey').fill('cle-de-test');
  await page.locator('#btnParcoursOrsKeySave').click();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).parcours_routing.ors_key_set).toBe(true);
  expect(JSON.stringify(await (await request.get('/api/settings')).json())).not.toContain('cle-de-test');
  expect(errors).toEqual([]);
});
