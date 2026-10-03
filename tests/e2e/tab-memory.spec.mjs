// Mémorisation de l'onglet actif, par page (Lot 7 de l'audit UX).
// La clé localStorage est propre au mode — 'activeTab:main' / 'activeTab:evolution'
// — pour que l'onglet restauré sur une page ne décide pas de l'arrivée sur
// l'autre ; l'ancienne clé globale 'activeTab' est migrée puis supprimée.
// Sans données chargées, l'arrivée est forcée sur l'onglet Données (c'est là
// que se fait l'import) sans écraser le choix mémorisé ; un hash explicite
// dans l'URL garde priorité.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_GPX = path.join(HERE, 'fixtures', 'my-finds.gpx');
const FIXTURE_EVOL = path.join(HERE, 'fixtures', 'evolution-a.csv');

async function openMain(page, url = '/') {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
}

async function openEvolution(page) {
  await page.goto('/evolution', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
}

async function deleteAllDatasets(request) {
  const res = await request.get('/api/evolution/datasets');
  for (const d of (await res.json()).datasets) {
    await request.delete(`/api/evolution/datasets/${d.id}`);
  }
}

const activeTabHref = (page) =>
  page.evaluate(() => document.querySelector('#mainTabs .nav-link.active')?.getAttribute('href'));

test('migration de la clé globale + forçage Données sur base vide', async ({ page, request }) => {
  await request.post('/clear_database');

  // Ancienne clé globale posée avant le chargement : elle doit migrer vers
  // la clé de la page courante puis disparaître.
  await page.addInitScript(() => localStorage.setItem('activeTab', 'animation'));
  await openMain(page);
  await dismissFirstUseModal(page);

  // Base vide : l'arrivée est forcée sur Données...
  await expect.poll(() => activeTabHref(page)).toBe('#data');
  // ...sans écraser le choix mémorisé (conservé pour une visite avec données).
  expect(await page.evaluate(() => localStorage.getItem('activeTab:main'))).toBe('animation');
  expect(await page.evaluate(() => localStorage.getItem('activeTab'))).toBeNull();
});

test('hash explicite dans l\'URL prioritaire même sur base vide', async ({ page, request }) => {
  await request.post('/clear_database');
  await openMain(page, '/#animation');
  await dismissFirstUseModal(page);
  await expect.poll(() => activeTabHref(page)).toBe('#animation');
});

test('avec données : l\'onglet mémorisé est restauré sur la page principale', async ({ page, request }) => {
  await request.post('/clear_database');
  await page.addInitScript(() => localStorage.setItem('activeTab:main', 'settings'));

  await openMain(page);
  await dismissFirstUseModal(page);
  // Base encore vide : forcé sur Données, 'settings' reste mémorisé.
  await expect.poll(() => activeTabHref(page)).toBe('#data');
  expect(await page.evaluate(() => localStorage.getItem('activeTab:main'))).toBe('settings');

  // Après import + rechargement, l'onglet mémorisé est bien restauré.
  await page.locator('#file-input').setInputFiles(FIXTURE_GPX);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await openMain(page);
  await dismissFirstUseModal(page);
  await expect.poll(() => activeTabHref(page)).toBe('#settings');

  await request.post('/clear_database');
});

test('évolution : clé propre, Données forcé sans base, mémorisé restauré avec base', async ({ page, request }) => {
  await deleteAllDatasets(request);
  await page.addInitScript(() => localStorage.setItem('activeTab:evolution', 'animation'));

  await openEvolution(page);
  // Aucune base Évolution : forcé sur Données, mémorisation intacte.
  await expect.poll(() => activeTabHref(page)).toBe('#data');
  expect(await page.evaluate(() => localStorage.getItem('activeTab:evolution'))).toBe('animation');

  // Une base importée puis la page rechargée : l'onglet mémorisé revient.
  const loaded = page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('mygcflow:evolution-loaded', (e) => resolve(e.detail), { once: true });
  }));
  await page.locator('#evolutionCsvInput').setInputFiles(FIXTURE_EVOL);
  await loaded;
  await openEvolution(page);
  await expect.poll(() => activeTabHref(page)).toBe('#animation');

  await deleteAllDatasets(request);
});
