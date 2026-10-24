// Helpers partagés des specs « Panneaux Stats » (stats-panels-*.spec.mjs).
//
// Fixture : 6 caches, une par jour du 01 au 06/01/2026, D/T toutes distinctes
// (1/1 → 3,5/3,5), 3 Traditional, 2 Multi, 1 Event. GAP_FIXTURE : 2 caches,
// les 1er et 6/01 — quatre jours vides entre les deux.
//
// `stats` est une préférence globale partagée par tous les specs d'un run :
// chaque spec repart de la liste vide (resetStats en beforeEach) et la remet
// en place en sortant (afterEach).
import { expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
export const GAP_FIXTURE = path.join(HERE, 'fixtures', 'my-finds-gap.gpx');
export const DEFAULT_STATS = { enabled: true, panels: [], evolution_panels: [] };

export async function putStats(page, stats) {
  const response = await page.request.put('/api/settings', { data: { stats } });
  expect(response.ok()).toBe(true);
}

export async function savedStats(page) {
  return (await (await page.request.get('/api/settings')).json()).stats;
}

// Bloc `stats` persisté, une fois `ready(stats)` vrai (écriture debouncée).
export async function savedStatsWhen(page, ready) {
  let stats = null;
  await expect.poll(async () => {
    stats = await savedStats(page);
    return ready(stats);
  }).toBe(true);
  return stats;
}

export async function openWithFixture(page, hash = '', fixture = FIXTURE, expectedCount = '6 / 6') {
  await page.goto(`/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(fixture);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Chargement et affichage des points' }).first())
    .toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#filtersCounter')).toContainText(expectedCount);
  // Les filtres se réappliquent encore un peu après l'import, chacun par une
  // reconstruction de l'index : attendre qu'il ne bouge plus.
  let previous = -1;
  await expect.poll(async () => {
    const revision = await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDateRevision);
    const stable = revision === previous;
    previous = revision;
    return stable;
  }, { intervals: [700], timeout: 15_000 }).toBe(true);
}

export function snapshot(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getStatsSnapshot());
}

export const sum = (counts) => Object.values(counts || {}).reduce((s, n) => s + n, 0);

export async function setRhythm(page, daysPerSecond) {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#animationConfigTab').click();
  await page.locator('#inputDaysPerSecond').fill(String(daysPerSecond));
  await page.locator('#inputExtraEndTime').fill('0');
}

export async function resetStats(page) {
  await putStats(page, DEFAULT_STATS);
}
