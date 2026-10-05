// État « aucun résultat » de l'onglet Données : quand les filtres excluent
// toutes les caches, la carte Mes trouvailles remplace « Vos trouvailles
// sont prêtes » par un avertissement persistant proposant de réinitialiser
// les filtres — distinct de l'état « aucune donnée importée ».
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

test('sélection vide : avertissement inline, reset fonctionnel, retour à « prêtes »', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await importFixture(page);

  // Sélection complète : « prêtes » visible, aucun avertissement.
  await expect(page.locator('#dataNextStep')).toBeVisible();
  await expect(page.locator('#dataNoResults')).toBeHidden();

  // Vider la sélection via « Aucun » du filtre Type : l'avertissement prend
  // le relais du bloc « prêtes ».
  await page.locator('#selectType').evaluate(el => el.tomselect.open());
  await page.locator('.filter-field:has(#selectType) .ts-dropdown #btnNoneType').click();
  await expect(page.locator('#filtersCounter')).toContainText('0 /', { timeout: 15_000 });
  await expect(page.locator('#dataNextStep')).toBeHidden();
  await expect(page.locator('#dataNoResults')).toBeVisible();
  await expect(page.locator('#dataNoResults')).toContainText(/aucune cache/i);

  // Le bouton de l'avertissement délègue au vrai « Réinitialiser tous les
  // filtres » : la sélection et le bloc « prêtes » reviennent.
  await page.locator('#btnResetFiltersFromData').click();
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 15_000 });
  await expect(page.locator('#dataNoResults')).toBeHidden();
  await expect(page.locator('#dataNextStep')).toBeVisible();
});
