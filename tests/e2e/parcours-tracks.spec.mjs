// Page Parcours, lot 5 : traces GPS (MyGCFlow_Plan_Parcours.md § 9,
// docs/parcours.md). Fixture tests/e2e/fixtures/parcours-trace.gpx (ignorée
// par *.gpx : git add -f) : samedi 12/07/2025, départ 07:30 UTC, pauses près
// de GCPAR03 (08:10 UTC, 10 min), GCPAR01 (09:05, 12 min) et GCPAR02 (10:40,
// 15 min), un point toutes les 30 s. Nettoyage : parcours-helpers.mjs.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACE = path.join(HERE, 'fixtures', 'parcours-trace.gpx');

test.beforeEach(async ({ page, request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
  await importFixture(page, request);
});

test.afterEach(async ({ request }) => {
  await cleanUp(request);
});

async function openReady(page) {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await openEnrichSection(page, 'tracks');
}

test('trace : heures de passage comme ancres, vrai chemin, fuseau réglable', async ({ page, request }) => {
  const errors = collectErrors(page);
  await createWeekend(request);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  // Section « Traces GPS » repliée par défaut, son état lisible en en-tête.
  const section = page.locator('#parcoursTracksCard');
  await expect(section).toBeVisible();
  await expect(section).not.toHaveAttribute('open', '');
  await expect(page.locator('#parcoursTracksHint')).toBeVisible();
  await expect(page.locator('#parcoursTracksHint')).toHaveText('Aucune trace pour ce parcours.');
  await expect(page.locator('#btnParcoursAddTracks')).toBeHidden();

  // Un envoi (ici sans passer par le bouton, comme un fichier glissé sur la
  // page) ouvre la section pour montrer sa progression.
  await page.locator('#parcoursTrackInput').setInputFiles(TRACE);
  await expect(section).toHaveAttribute('open', '');
  await expect.poll(async () => (await snapshot(page)).tracks.length, { timeout: 30_000 }).toBe(1);
  await expect(page.locator('#parcoursTracksHint')).toHaveText('1 trace, 3 étapes calées sur une trace');
  let state = await snapshot(page);
  // Simplifiée à l'import, mais gardée telle quelle en heure.
  expect(state.tracks[0].pointCount).toBeLessThan(461);
  expect(Object.keys(state.trackTimes).sort()).toEqual(['GCPAR01', 'GCPAR02', 'GCPAR03']);
  await expect(page.locator('#parcoursTracks .parcours-track')).toContainText('3 étapes calées');

  // Heure locale fixée à UTC+2 : les heures de passage, exactes.
  await page.locator('#parcoursUtcOffset').selectOption('120');
  await expect.poll(async () => (await snapshot(page)).utcOffset).toEqual({ minutes: 120, source: 'manual' });
  state = await snapshot(page);
  // GCPAR03 : la trace d'approche passe à moins de 30 m une minute avant la
  // pause — l'arrivée est le premier instant à cette distance.
  expect(state.trackTimes.GCPAR03).toMatch(/^10:(09|10)$/);
  expect(state.trackTimes.GCPAR01).toBe('11:05');
  expect(state.trackTimes.GCPAR02).toBe('12:40');
  const day1 = state.days[0];
  expect(day1.keys).toEqual(['GCPAR03', 'GCPAR01', 'GCPAR02']);
  expect(day1.times).toEqual([state.trackTimes.GCPAR03, '11:05', '12:40']);
  expect(day1.reasons).toEqual(['track', 'track', 'track']);
  await expect(page.locator('.parcours-stop[data-stop-key="GCPAR01"] .parcours-stop-time')).toHaveText('11:05');
  // Les deux trajets du samedi suivent la trace.
  expect(state.trackLegs).toBe(2);

  // Retour à l'automatique ; puis suppression : les heures estimées reviennent.
  await page.locator('#parcoursUtcOffset').selectOption('');
  await expect.poll(async () => (await snapshot(page)).utcOffset.source).toBe('computer');
  await page.locator('.parcours-track-delete').click();
  await expect.poll(async () => (await snapshot(page)).tracks.length).toBe(0);
  state = await snapshot(page);
  expect(state.trackTimes).toEqual({});
  expect(state.days[0].reasons).toEqual(['log-order', 'log-order', 'log-order']);
  expect(errors).toEqual([]);
});

test('fuseau « ordinateur » : un parcours loin de chez soi avertit', async ({ page, request }) => {
  const errors = collectErrors(page);
  const parcours = await createWeekend(request);
  // Un lieu en Australie (Annecy ≈ 6°E : le centre habituel est loin) rend
  // le fuseau de l'ordinateur suspect.
  const place = await request.post(`/api/parcours/${parcours.id}/places`,
    { data: { name: 'Étape lointaine', kind: 'place', date: '2025-07-13', lat: -33.87, lon: 151.2 } });
  expect(place.status()).toBe(201);
  await openReady(page);
  // Sans trace, le décalage ne sert à rien : pas d'avertissement.
  await expect(page.locator('#parcoursUtcOffsetWarn')).toBeHidden();

  await page.locator('#parcoursTrackInput').setInputFiles(TRACE);
  await expect.poll(async () => (await snapshot(page)).tracks.length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await snapshot(page)).utcOffset.source).toBe('computer');
  await expect(page.locator('#parcoursUtcOffsetWarn')).toBeVisible();
  expect((await snapshot(page)).utcOffsetSuspect).toBe(true);

  // Un décalage réglé à la main fait taire l'avertissement.
  await page.locator('#parcoursUtcOffset').selectOption('120');
  await expect(page.locator('#parcoursUtcOffsetWarn')).toBeHidden();
  expect(errors).toEqual([]);
});

test('lecture : le géocacheur suit la trace jusqu’au bout', async ({ page, request }) => {
  const errors = collectErrors(page);
  const parcours = await createWeekend(request);
  expect((await request.patch(`/api/parcours/${parcours.id}`, { data: { utc_offset_minutes: 120 } })).ok()).toBeTruthy();
  expect((await request.put('/api/settings', { data: { parcours_animation: { rhythm_mode: 'rate', days_per_second: 20 } } })).ok())
    .toBeTruthy();
  await openReady(page);
  await page.locator('#parcoursTrackInput').setInputFiles(TRACE);
  await expect.poll(async () => (await snapshot(page)).trackLegs, { timeout: 30_000 }).toBe(2);
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(true);
  await expect.poll(async () => (await snapshot(page)).running, { timeout: 30_000 }).toBe(false);
  expect(errors).toEqual([]);
});
