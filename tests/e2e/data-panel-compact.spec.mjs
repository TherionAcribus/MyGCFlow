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

  // Bilan d'import : écrit dans la note de la carte (onglet Données
  // visible) — aucun toast de bilan ne recouvre le panneau.
  const bddNote = page.locator('#bddReportNote');
  await expect(bddNote).toBeVisible();
  await expect(bddNote).toContainText('succès');
  await expect(page.locator('.gcm-toast.show').filter({ hasText: 'Fichier chargé' })).toHaveCount(0);

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

  // Le bilan du vidage remplace celui de l'import dans la même note —
  // toujours sans toast de bilan flottant.
  await expect(bddNote).toContainText('supprimées');
  await expect(page.locator('.gcm-toast.show').filter({ hasText: 'supprimées' })).toHaveCount(0);
});


// Un réimport écrase TOUTES les géocaches côté serveur (DELETE complet dans
// uploadBdd, bdd.py) : sur base déjà chargée, le fichier part d'abord vers
// /api/geocaches/import/preview (analyse seule — rien n'est importé), la
// modale #gpxDiffModal affiche le diff, et seul « Remplacer ma base » envoie
// /api/geocaches/import/commit qui lance l'import — même tâche de fond que
// l'upload direct. Sur base vide (premier import), rien ne s'affiche — le
// test « base chargée » ci-dessus le couvre déjà (une modale bloquerait le
// compteur à « 0 / 0 »), la vérif ci-dessous le rend explicite.
test('réimport sur base chargée : aperçu diff requis, annulation sans effet', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  // Premier import sur base vide : aucune modale d'aperçu.
  await expect(page.locator('#gpxDiffModal.show')).toHaveCount(0);

  // Compter les commits AVANT le second dépôt : tant que l'aperçu n'est pas
  // validé, aucun import ne doit partir (le POST preview, lui, est normal :
  // c'est l'analyse qui alimente la modale).
  let commits = 0;
  await page.route('**/api/geocaches/import/commit', (route) => { commits += 1; route.continue(); });

  // Réimport du même fichier : l'aperçu diff doit s'interposer — les 6
  // caches du fichier sont déjà dans la base, donc toutes inchangées.
  await page.locator('#file-input').setInputFiles(FIXTURE);
  const dialog = page.locator('#gpxDiffModal');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Remplacer mes géocaches ?');
  await expect(dialog).toContainText('6 géocaches inchangées');
  await expect(dialog).toContainText('0 nouvelles géocaches');
  await expect(dialog.locator('#gpxDiffRemovals')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Remplacer ma base' })).toBeVisible();

  // Annulation : aucun commit, les 6 caches affichées sont intactes.
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toBeHidden();
  expect(commits).toBe(0);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6');

  // Confirmation cette fois : le commit part et le compteur revient à « 6 / 6 ».
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Remplacer ma base' }).click();
  await expect.poll(() => commits, { timeout: 45_000 }).toBe(1);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
});


// Le diff détaille ce qui va changer : « N nouvelle(s) », « N inchangée(s) »,
// et les retraits avec l'échantillon des codes absents du fichier — un
// My Finds incomplet ne doit pas effacer des trouvailles en silence. Ici la
// base tient deux caches et le fichier déposé en garde une et en ajoute une :
// +1 nouvelle, −1 retirée, =1 inchangée.
const GPX_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="Groundspeak Pocket Query"
     xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
  <name>My Finds Pocket Query - MyGCFlow E2E</name>
  <desc>Groundspeak deterministic browser test fixture</desc>
  <author>Groundspeak</author>`;

const gpxWpt = (code, day) => `<wpt lat="48.86${day}" lon="2.36${day}"><time>2025-01-0${day}T00:00:00Z</time><name>${code}</name><urlname>${code}</urlname><groundspeak:cache><groundspeak:name>${code}</groundspeak:name><groundspeak:type>Traditional Cache</groundspeak:type><groundspeak:container>Micro</groundspeak:container><groundspeak:difficulty>1.5</groundspeak:difficulty><groundspeak:terrain>1.5</groundspeak:terrain><groundspeak:country>France</groundspeak:country><groundspeak:state>Île-de-France</groundspeak:state><groundspeak:logs><groundspeak:log><groundspeak:date>2026-01-0${day}T10:00:00Z</groundspeak:date><groundspeak:type>Found it</groundspeak:type></groundspeak:log></groundspeak:logs></groundspeak:cache></wpt>`;

function myFindsGpx(codes) {
  return GPX_HEAD + codes.map((code, i) => gpxWpt(code, i + 1)).join('') + '</gpx>';
}

function dropGpx(page, name, gpxText) {
  return page.locator('#file-input').setInputFiles({
    name, mimeType: 'application/gpx+xml', buffer: Buffer.from(gpxText, 'utf-8'),
  });
}

test('réimport : le diff détaille nouvelles, retirées et inchangées', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dropGpx(page, 'my-finds-base.gpx', myFindsGpx(['GCDIFF1', 'GCDIFF2']));
  await expect(page.locator('#filtersCounter')).toContainText('2 / 2', { timeout: 45_000 });

  let commits = 0;
  await page.route('**/api/geocaches/import/commit', (route) => { commits += 1; route.continue(); });

  // Aperçu : le fichier garde GCDIFF1, ajoute GCDIFF9 — GCDIFF2, absente du
  // fichier, sera retirée.
  await dropGpx(page, 'my-finds-variant.gpx', myFindsGpx(['GCDIFF1', 'GCDIFF9']));
  const dialog = page.locator('#gpxDiffModal');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('my-finds-variant.gpx');
  await expect(dialog).toContainText('1 nouvelle géocache');
  await expect(dialog).toContainText('1 géocache inchangée');
  await expect(dialog).toContainText('1 géocache sera retirée');
  await expect(dialog.locator('#gpxDiffRemovals')).toContainText('GCDIFF2');

  // Annulation : rien n'est importé, la base reste à deux caches.
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toBeHidden();
  expect(commits).toBe(0);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 2');

  // Confirmation : le remplacement part (2 caches au compteur, mais le jeu a
  // changé) et le bilan de succès est écrit dans la note.
  await dropGpx(page, 'my-finds-variant.gpx', myFindsGpx(['GCDIFF1', 'GCDIFF9']));
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Remplacer ma base' }).click();
  await expect.poll(() => commits, { timeout: 45_000 }).toBe(1);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 2', { timeout: 45_000 });
  await expect(page.locator('#bddReportNote')).toContainText('succès');
});
