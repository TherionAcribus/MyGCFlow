import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';

// Nom accessible des liens de mode « Mes trouvailles » / « Évolution » de
// l'en-tête.
//
// Sous ~768 px les libellés .app-mode-label sont masqués (display:none) et
// les icônes sont aria-hidden : sans aria-label les liens n'avaient plus de
// nom accessible. Ils suivent désormais le même pattern que le lien Guide
// voisin : aria-label sur le <a> + aria-hidden sur le libellé.


test('les liens de mode gardent un nom accessible quand le libellé est masqué', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);

  const mainLink = page.locator('#linkMainMode');
  const evoLink = page.locator('#linkEvolutionMode');

  // Libellés masqués à cette largeur, icônes masquées aux TA.
  await expect(mainLink.locator('.app-mode-label')).toBeHidden();
  await expect(evoLink.locator('.app-mode-label')).toBeHidden();
  await expect(mainLink.locator('i')).toHaveAttribute('aria-hidden', 'true');

  // …mais le nom accessible est porté par aria-label.
  await expect(mainLink).toHaveAttribute('aria-label', 'Mes trouvailles');
  await expect(evoLink).toHaveAttribute('aria-label', 'Évolution');

  // Et le mode courant garde son aria-current.
  await expect(mainLink).toHaveAttribute('aria-current', 'page');
});


test('les libellés de mode restent visibles en fenêtre large', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);

  await expect(page.locator('#linkMainMode .app-mode-label')).toBeVisible();
  await expect(page.locator('#linkEvolutionMode .app-mode-label')).toBeVisible();
});
