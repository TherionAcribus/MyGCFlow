// Retour visuel à l'import GPX : une toast de chargement doit apparaître
// immédiatement à la sélection/dépôt du fichier (la validation lit l'en-tête
// sur disque, ce qui peut prendre plusieurs secondes), et l'indicateur
// inline de la carte « état vide » reflète la progression là où
// l'utilisateur a déposé le fichier.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

// Les prédicats de waitForFunction doivent rester SYNCHRONES : une fonction
// async retourne une Promise, que Playwright interprète comme une valeur
// truthy — le wait résoudrait immédiatement, sans attendre la condition.
async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
}

// La toast de chargement est créée dans handleGpxFile AVANT l'appel réseau :
// elle doit déjà exister pendant l'upload/polling, pas seulement au succès.
// Le toast de chargement initial (« Chargement de l'application... », posé par
// readBdd au démarrage) porte lui aussi une barre de progression et peut être
// encore affiché quand le fichier est déposé tôt : il est exclu, sinon le
// locator désigne deux toasts.
function loadingToast(page) {
  return page.locator('.gcm-toast', { has: page.locator('.gcm-progress-fill') })
    .filter({ hasNotText: "Chargement de l'application" });
}

test('import via état vide : toast immédiate et indicateur inline pendant le traitement', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dismissFirstUseModal(page);

  const indicator = page.locator('#emptyStateUploadProgress');
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(indicator).toBeHidden();

  // Sonde de régression : entre la fin de l'import serveur et l'apparition
  // des points, l'état vide ne doit pas repasser en « proposition d'import »
  // (affiché + bouton actif + indicateur masqué) — la fenêtre durait ~1-2 s
  // et ressemblait à un bug.
  await page.evaluate(() => {
    window.__watchImport = false;
    window.__importProposalSeen = false;
    const check = () => {
      if (!window.__watchImport) return;
      const es = document.getElementById('emptyState');
      const btn = document.getElementById('btnEmptyStateImport');
      const ind = document.getElementById('emptyStateUploadProgress');
      if (es && getComputedStyle(es).display !== 'none'
          && btn && !btn.disabled
          && ind && ind.hidden) {
        window.__importProposalSeen = true;
      }
    };
    new MutationObserver(check).observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['disabled', 'hidden', 'style'],
    });
  });

  // Sélection directe sur l'input (le bouton de l'état vide lui délègue le
  // clic) : toast + indicateur doivent être visibles pendant l'import.
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(loadingToast(page)).toBeVisible();
  await expect(indicator).toBeVisible();
  await expect(page.locator('#btnEmptyStateImport')).toBeDisabled();

  // L'import est engagé : la sonde surveille la phase d'affichage des points.
  await page.evaluate(() => { window.__watchImport = true; });

  // Fin d'import : indicateur refermé, toast de chargement remplacée par le
  // succès, commandes débloquées — sans que l'état vide ait re-proposé un
  // import entre-temps.
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await expect(page.locator('#emptyState')).toBeHidden();
  await expect(indicator).toBeHidden();
  expect(await page.evaluate(() => window.__importProposalSeen)).toBe(false);
});

test('aide .gpx : la modale première utilisation s\'ouvre depuis l\'état vide, sans import interne', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dismissFirstUseModal(page);

  // La modale est désormais une aide contextuelle : fermée au démarrage,
  // ouverte par le lien de l'état vide, et sans section d'import (le
  // chargement passe par #file-input ou le glisser-déposer).
  const modal = page.locator('#modal_first_use');
  await expect(modal).toBeHidden();

  await page.locator('#btnEmptyStateGpxHelp').click();
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Comment obtenir votre fichier .gpx');
  await expect(modal.locator('#file-input-modal')).toHaveCount(0);

  await modal.getByRole('button', { name: 'Fermer' }).click();
  await expect(modal).toBeHidden();
});
