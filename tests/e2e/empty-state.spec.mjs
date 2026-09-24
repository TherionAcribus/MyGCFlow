// État vide : sans base chargée, la carte affiche un appel à l'action et les
// commandes liées aux données (filtres, lecture, enregistrement) sont
// verrouillées. L'import débloque tout ; le vidage reverrouille.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

// Les prédicats de waitForFunction doivent rester SYNCHRONES : une fonction
// async retourne une Promise, que Playwright interprète comme une valeur
// truthy — le wait résoudrait immédiatement, sans attendre la condition.
async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
}

async function dismissFirstUseModal(page) {
  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}

test('état vide : verrouillage sans base, déblocage après import, retour après vidage', async ({ page, request }) => {
  // Le runtime est partagé entre les specs : repartir d'une base vide rend ce
  // test indépendant de l'ordre d'exécution.
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dismissFirstUseModal(page);

  // État vide sur la carte : message + bouton d'import, sections verrouillées.
  const emptyState = page.locator('#emptyState');
  const filterPanel = page.locator('#filterPanel');
  const btnStart = page.locator('#btnStartAnimation');
  const btnRecord = page.locator('#btnRecordAnimation');

  await expect(emptyState).toBeVisible();
  await expect(emptyState.locator('.empty-state-text')).toContainText('.gpx');
  await expect(page.locator('#btnEmptyStateImport')).toBeVisible();
  await expect(filterPanel).toHaveClass(/data-disabled/);
  expect(await filterPanel.evaluate(el => el.inert)).toBe(true);
  await expect(btnStart).toBeDisabled();
  await expect(btnRecord).toBeDisabled();

  // Le bouton d'import de l'état vide délègue à l'input fichier de l'onglet
  // Données : le clic ouvre le sélecteur, la sélection lance l'upload existant.
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#btnEmptyStateImport').click();
  await (await chooserPromise).setFiles(FIXTURE);

  // Après import : l'état vide disparaît et les commandes se débloquent.
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await expect(emptyState).toBeHidden();
  await expect(filterPanel).not.toHaveClass(/data-disabled/);
  expect(await filterPanel.evaluate(el => el.inert)).toBe(false);
  await expect(btnStart).toBeEnabled();
  await expect(btnRecord).toBeEnabled();

  // Vidage via le bouton réel (toast de confirmation) : retour à l'état vide.
  await page.locator('#clearDatabaseBtn').click();
  await page.locator('.gcm-toast button', { hasText: 'Confirmer' }).click();
  await expect(page.locator('#filtersCounter')).toContainText('0 / 0', { timeout: 30_000 });
  await expect(emptyState).toBeVisible();
  await expect(filterPanel).toHaveClass(/data-disabled/);
  await expect(btnStart).toBeDisabled();
  await expect(btnRecord).toBeDisabled();
});
