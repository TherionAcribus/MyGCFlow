// Cohérence du vocabulaire (audit 3.A) : sous-onglet « Cartes » aligné sur
// le titre de section, noms de fonds en français dans les cartes de choix,
// icône palette (et non personne) sur le label « Thème ».
import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#style"]').click();
});

test('sous-onglet « Cartes » et noms de fonds traduits', async ({ page }) => {
  const styleTabs = page.locator('#style .nav-tabs .nav-link');
  await expect(styleTabs.first()).toHaveText('Cartes');

  // Cartes de choix de fond : les noms techniques anglais ne doivent plus
  // apparaître en libellé visible (les aria-labels étaient déjà français).
  await expect(page.locator('#vectorMap .map-card-label')).toHaveText('Vectorielle');
  await expect(page.locator('#watercolor .map-card-label')).toHaveText('Aquarelle');
});

test('le label « Thème » porte l\'icône palette', async ({ page }) => {
  const icon = page.locator('#profile-bar i.ti').first();
  await expect(icon).toHaveClass(/ti-palette/);
});
