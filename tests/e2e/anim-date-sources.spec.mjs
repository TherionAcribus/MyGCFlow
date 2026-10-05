// Sources des dates d'animation (onglet Animation) : chaque champ montre
// sous lui les puces « Données », « Filtre » (si un filtre de dates actif
// diffère des données) et « Personnalisée » — cette dernière uniquement
// quand la valeur saisie ne correspond à aucune des deux sources, pour
// que l'état « date à la main » ne passe pas pour un état neutre.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
}

async function importFixture(page) {
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
}

// Une date affichée différente de celle du champ, sans supposer le format
// localisé : on reprend la valeur courante en changeant l'année.
async function otherDisplayedDate(page, selector, year = 2019) {
  const current = await page.locator(selector).inputValue();
  const other = current.replace(/\d{4}/, String(year));
  expect(other).not.toBe(current);
  return other;
}

async function setFieldDate(page, selector, value) {
  await page.locator(selector).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test.beforeEach(async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();
  await openReadyApp(page);
  await importFixture(page);
  await page.locator('a[href="#animation"]').click();
});

test('date à la main : puce « Personnalisée » visible, retour par « Données »', async ({ page }) => {
  const dataChip = page.locator('#btnResetAnimStartDate');
  const customChip = page.locator('#animCustomStartInfo');

  // Pré-remplie sur les données : « Données » cochée, pas de Personnalisée.
  await expect(dataChip).toHaveClass(/is-active/);
  await expect(customChip).toBeHidden();

  // Saisie d'une date hors bornes : « Personnalisée » prend le relais.
  const custom = await otherDisplayedDate(page, '#animDateStart');
  await setFieldDate(page, '#animDateStart', custom);
  await expect(dataChip).not.toHaveClass(/is-active/);
  await expect(customChip).toBeVisible();
  await expect(customChip).toContainText('Personnalisée');

  // « Données » réapplique la borne : les deux états repassent à la normale.
  await dataChip.click();
  await expect(page.locator('#animDateStart')).not.toHaveValue(custom);
  await expect(dataChip).toHaveClass(/is-active/);
  await expect(customChip).toBeHidden();
});

test('filtre de dates actif : puce « Filtre » proposée puis cochée au clic', async ({ page }) => {
  // Un filtre de dates différent des données fait apparaître la puce Filtre.
  const filterDate = await otherDisplayedDate(page, '#datePickerStart');
  await setFieldDate(page, '#datePickerStart', filterDate);
  await expect(page.locator('#animFilterStartInfo')).toBeVisible();
  const filterChip = page.locator('#animFilterStartValue');
  await expect(filterChip).toContainText(filterDate);
  await expect(filterChip).not.toHaveClass(/is-active/);

  // Copier la valeur du filtre coche sa puce — et masque « Personnalisée ».
  await filterChip.click();
  await expect(filterChip).toHaveClass(/is-active/);
  await expect(page.locator('#animCustomStartInfo')).toBeHidden();
  await expect(page.locator('#btnResetAnimStartDate')).not.toHaveClass(/is-active/);
});

test('les puces sont mutuellement exclusives sur les deux champs', async ({ page }) => {
  const custom = await otherDisplayedDate(page, '#animDateEnd', 2018);
  await setFieldDate(page, '#animDateEnd', custom);
  await expect(page.locator('#animCustomEndInfo')).toBeVisible();
  await expect(page.locator('#btnResetAnimEndDate')).not.toHaveClass(/is-active/);

  // L'état personnalisé est indépendant par champ : le début reste « Données ».
  await expect(page.locator('#animCustomStartInfo')).toBeHidden();
  await expect(page.locator('#btnResetAnimStartDate')).toHaveClass(/is-active/);
});
