// Onglet Données compact : sans géocaches, la zone d'import détaillée guide
// le premier chargement ; une fois un GPX chargé (#data.has-geocaches posé
// par updateDataAvailabilityUI), elle cède la place à une commande
// secondaire « Importer un autre fichier… » et le bloc « prochaine étape »
// tient sur une ligne — les filtres remontent dans le champ visible.
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

  await expect(page.locator('#data')).not.toHaveClass(/has-geocaches/);
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
  await expect(page.locator('#data')).toHaveClass(/has-geocaches/);
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
    .getByRole('button', { name: 'Supprimer mes géocaches' })
    .click();
  await expect(page.locator('#filtersCounter')).toContainText('0 / 0', { timeout: 30_000 });
  await expect(page.locator('#data')).not.toHaveClass(/has-geocaches/);
  await expect(page.locator('#data .data-empty-only')).toBeVisible();
  await expect(page.locator('#file-input-btn-compact')).toBeHidden();
});


// Un réimport écrase TOUTES les géocaches côté serveur (DELETE complet dans
// uploadBdd, bdd.py) : sur base déjà chargée, une modale de confirmation doit
// s'interposer avant l'envoi. Sur base vide (premier import), rien ne doit
// s'afficher — le test « base chargée » ci-dessus le couvre déjà (une modale
// bloquerait le compteur à « 0 / 0 »), la vérif ci-dessous le rend explicite.
test('réimport sur base chargée : confirmation requise, annulation sans effet', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  // Premier import sur base vide : aucune modale de remplacement.
  await expect(page.getByRole('dialog', { name: 'Remplacer mes géocaches' })).toHaveCount(0);

  // Compter les envois POST /upload AVANT le second dépôt : tant que la
  // confirmation n'est pas validée, aucune requête ne doit partir.
  let uploads = 0;
  await page.route('**/upload', (route) => { uploads += 1; route.continue(); });

  // Réimport du même fichier : la confirmation doit s'interposer.
  await page.locator('#file-input').setInputFiles(FIXTURE);
  const dialog = page.getByRole('dialog', { name: 'Remplacer mes géocaches' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('remplacera les 6 géocaches');
  await expect(dialog.getByRole('button', { name: 'Remplacer' })).toBeVisible();

  // Annulation : aucun envoi réseau, les 6 caches affichées sont intactes.
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toBeHidden();
  expect(uploads).toBe(0);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6');

  // Confirmation cette fois : l'upload part et le compteur revient à « 6 / 6 ».
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Remplacer' }).click();
  await expect.poll(() => uploads, { timeout: 45_000 }).toBe(1);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
});
