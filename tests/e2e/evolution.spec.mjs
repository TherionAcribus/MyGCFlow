// Mode Évolution (/evolution) : bases de caches importées depuis des CSV,
// apparition au placement et disparition à l'archivage, compteur de caches
// actives qui monte et descend. Le mode principal ne doit pas en être affecté.
//
// Fixtures (9 caches distinctes, France) :
//   evolution-a.csv (export du 10/01/2026) : GC1A01..GC1A06, dont GC1A03
//     archivée sans date (reste active) ;
//   evolution-b.csv (export du 10/02/2026) : GC1A01 archivée le 01/02/2026
//     (mise à jour), GC1B01..GC1B03.
// Caches actives : 12/01/2020 -> 6 ; 10/02/2026 -> 5.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_A = path.join(HERE, 'fixtures', 'evolution-a.csv');
const FIXTURE_B = path.join(HERE, 'fixtures', 'evolution-b.csv');

// Le runtime est partagé entre les specs : on repart d'aucune base.
async function deleteAllDatasets(request) {
  const res = await request.get('/api/evolution/datasets');
  expect(res.ok()).toBeTruthy();
  for (const dataset of (await res.json()).datasets) {
    const del = await request.delete(`/api/evolution/datasets/${dataset.id}`);
    expect(del.ok()).toBeTruthy();
  }
}

// Prédicats SYNCHRONES : une fonction async rendrait une Promise, truthy.
async function openEvolution(page) {
  await page.goto('/evolution', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
}

// Attend le prochain chargement de base (import, changement de base).
function nextDatasetLoad(page) {
  return page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('mygcflow:evolution-loaded', (e) => resolve(e.detail), { once: true });
  }));
}

async function importFixtures(page) {
  const loaded = nextDatasetLoad(page);
  await page.locator('#evolutionCsvInput').setInputFiles([FIXTURE_A, FIXTURE_B]);
  const detail = await loaded;
  expect(detail.selected).toBe(9);
}

async function setAnimationEnd(page, text) {
  await page.locator('a[href="#animation"]').click();
  const end = page.locator('#animDateEnd');
  await end.fill(text);
  await end.dispatchEvent('change');
}

test.beforeEach(async ({ request }) => {
  await deleteAllDatasets(request);
});

test('import de deux exports : fusion, compteur au repos et date de fin', async ({ page }) => {
  await openEvolution(page);

  // Pas de modale « chargez votre GPX », état vide propre au mode.
  await expect(page.locator('#modal_first_use')).toHaveCount(0);
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(page.locator('#btnEvolutionEmptyStateImport')).toBeVisible();
  await expect(page.locator('#btnStartAnimation')).toBeDisabled();

  await importFixtures(page);

  // Base créée au nom du premier fichier, fusion par code GC.
  await expect(page.locator('#selectEvolutionDataset option')).toHaveText(['evolution-a (9 caches)']);
  const summary = page.locator('#evolutionImportSummary');
  await expect(summary).toContainText('6 lignes lues : 6 nouvelles, 0 mises à jour, 0 inchangées');
  await expect(summary).toContainText('4 lignes lues : 3 nouvelles, 1 mises à jour, 0 inchangées');
  await expect(summary).toContainText('1 caches archivées depuis le précédent export');
  await expect(summary).toContainText("1 caches archivées sans date d'archivage");

  await expect(page.locator('#emptyState')).toBeHidden();
  await expect(page.locator('#filtersCounter')).toContainText('9 / 9');
  // Carte au repos : caches actives à la date de l'export le plus récent.
  await expect(page.locator('#spanNbCaches')).toHaveText('5');
  await expect(page.locator('#spanCurrentDate')).toHaveText('10/02/2026');
  await expect(page.locator('#btnStartAnimation')).toBeEnabled();

  // La carte au repos suit la date de fin choisie.
  await setAnimationEnd(page, '12/01/2020');
  await expect(page.locator('#spanNbCaches')).toHaveText('6');
  await expect(page.locator('#spanCurrentDate')).toHaveText('12/01/2020');
});

test('la lecture fait monter puis descendre le compteur', async ({ page }) => {
  await openEvolution(page);
  await importFixtures(page);
  await setAnimationEnd(page, '12/01/2020');

  await page.locator('#rhythmModeRate').check({ force: true });
  const rate = page.locator('#inputDaysPerSecond');
  await rate.fill('5');
  await rate.dispatchEvent('input');

  // Relevé du compteur à chaque frame, dans la page (indépendant du rythme
  // des allers-retours Playwright).
  await page.evaluate(() => {
    window.__counterSamples = [];
    const sample = () => {
      const text = document.getElementById('spanNbCaches')?.textContent;
      if (text) window.__counterSamples.push(Number(text));
      window.__counterRaf = requestAnimationFrame(sample);
    };
    sample();
  });
  await page.locator('#btnStartAnimation').click();
  await expect(page.locator('#spanCurrentDate')).toHaveText('12/01/2020', { timeout: 20_000 });
  await expect(page.locator('#btnStartAnimation')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#spanNbCaches')).toHaveText('6');

  const samples = await page.evaluate(() => {
    cancelAnimationFrame(window.__counterRaf);
    return window.__counterSamples;
  });
  // Départ avant le 01/01/2020 : aucune cache.
  expect(samples).toContain(0);
  expect(Math.max(...samples)).toBe(6);
  // Au moins une baisse (archivages du 06/01 et du 08/01).
  const decreased = samples.some((value, i) => i > 0 && value < samples[i - 1]);
  expect(decreased).toBe(true);
});

test('filtre Région, « Aucun », et restauration de la base au rechargement', async ({ page }) => {
  await openEvolution(page);
  await importFixtures(page);

  const selectRegions = async (regions) => {
    await page.evaluate((wanted) => {
      const select = document.getElementById('selectState');
      for (const option of select.options) {
        if (option.value) option.selected = wanted.includes(option.value);
      }
      select.dispatchEvent(new Event('change'));
    }, regions);
  };

  await selectRegions(['Grand-Est']);
  await expect(page.locator('#filtersCounter')).toContainText('4 / 9');
  // Au 10/02/2026 : GC1A04, GC1A06, GC1B03 (GC1A05 archivée).
  await expect(page.locator('#spanNbCaches')).toHaveText('3');

  await selectRegions([]);
  await expect(page.locator('#filtersCounter')).toContainText('0 / 9');
  await expect(page.locator('#btnStartAnimation')).toBeDisabled();

  await page.reload();
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
  await expect(page.locator('#selectEvolutionDataset')).toHaveValue(/\d+/);
  await expect(page.locator('#filtersCounter')).toContainText('9 / 9');
  await expect(page.locator('#spanNbCaches')).toHaveText('5');
});

test('le mode principal reste indépendant du mode Évolution', async ({ page }) => {
  await openEvolution(page);
  await importFixtures(page);
  // Le flash de disparition se règle dans le thème, sur la page Évolution.
  await page.locator('a[href="#style"]').click();
  await expect(page.locator('#selectDisappearFlashMode')).toHaveCount(1);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  // Lien discret vers le mode Évolution, sans ses réglages ni sa base.
  await expect(page.locator('#linkEvolutionMode')).toHaveAttribute('href', '/evolution');
  await expect(page.locator('#selectDisappearFlashMode')).toHaveCount(0);
  await expect(page.locator('#selectEvolutionDataset')).toHaveCount(0);
  // Les filtres du mode Évolution n'écrasent pas la sélection du mode principal.
  const saved = await page.evaluate(() => localStorage.getItem('filtersSelection'));
  expect(saved === null || !saved.includes('Grand-Est')).toBe(true);
});
