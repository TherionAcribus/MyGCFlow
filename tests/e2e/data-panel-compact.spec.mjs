// Onglet Données compact : sans base, la zone d'import détaillée guide le
// premier chargement ; une fois une base chargée (#data.has-data posé par
// updateDataAvailabilityUI), elle cède la place à une commande secondaire
// « Importer un autre fichier… » et le bloc « prochaine étape » tient sur
// une ligne — les filtres remontent dans le champ visible.
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

test('base vide : import détaillé visible, commande compacte masquée', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);

  await expect(page.locator('#data')).not.toHaveClass(/has-data/);
  await expect(page.locator('#data .data-empty-only')).toBeVisible();
  await expect(page.locator('#file-input-btn-compact')).toBeHidden();
  await expect(page.locator('#dataNextStep')).toBeHidden();
});


test('base chargée : import compact, étape suivante sur une ligne, retour après vidage', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  // La zone d'import détaillée disparaît, la commande compacte la remplace
  // et reste fonctionnelle (délégation au même #file-input).
  await expect(page.locator('#data')).toHaveClass(/has-data/);
  await expect(page.locator('#data .data-empty-only')).toBeHidden();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#file-input-btn-compact').click();
  await chooserPromise;

  // Le bloc « prochaine étape » reste visible mais compact.
  await expect(page.locator('#dataNextStep')).toBeVisible();
  await expect(page.locator('#btnGoStyleTab')).toBeVisible();
  await expect(page.locator('#btnGoPreview')).toBeVisible();

  // Après vidage via l'UI (le bouton reste visible en mode compact) :
  // retour à l'import détaillé.
  await page.locator('#clearDatabaseBtn').click();
  await page.getByRole('dialog', { name: 'Confirmation de suppression' })
    .getByRole('button', { name: 'Supprimer mes trouvailles' })
    .click();
  await expect(page.locator('#filtersCounter')).toContainText('0 / 0', { timeout: 30_000 });
  await expect(page.locator('#data')).not.toHaveClass(/has-data/);
  await expect(page.locator('#data .data-empty-only')).toBeVisible();
  await expect(page.locator('#file-input-btn-compact')).toBeHidden();
});
