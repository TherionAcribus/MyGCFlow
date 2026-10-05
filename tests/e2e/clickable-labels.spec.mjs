import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';

// Libellés cliquables des radios et cases des menus Style (fix 1.4).
//
// Les libellés étaient des <span class="form-check-label"> : cliquer sur le
// texte ne sélectionnait rien, il fallait viser le bouton radio lui-même.
// Ce sont désormais de vrais <label for="…"> — l'id du libellé est conservé
// car les inputs portent toujours aria-labelledby="…Label".

async function openStyleTab(page, subTab) {
  // /#style : base vide, l'app forcerait sinon le retour sur l'onglet
  // Données à chaque résolution du statut, en plein milieu des clics.
  await page.goto('/#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);

  await page.locator('a[href="#style"]').click();
  if (subTab) await page.locator(`a[href="#${subTab}"]`).click();
}


test('Points : cliquer sur le texte « Transparent » coche la radio', async ({ page }) => {
  await openStyleTab(page, 'tabPoints');

  await expect(page.locator('#fillColorPointNoneLabel')).toHaveJSProperty('tagName', 'LABEL');
  await page.locator('#fillColorPointNoneLabel').click();

  await expect(page.locator('#fillColorPointNone')).toBeChecked();
});


test('Flash : cliquer sur le texte « Automatique » coche la radio du contour', async ({ page }) => {
  await openStyleTab(page, 'tabFlash');

  // Pré-condition : sélectionner une autre valeur pour que le clic sur le
  // libellé « Automatique » change réellement l'état.
  await page.locator('#flashBorderColorFixLabel').click();
  await expect(page.locator('#flashBorderColorFix')).toBeChecked();

  await page.locator('#flashBorderColorAutoLabel').click();
  await expect(page.locator('#flashBorderColorAuto')).toBeChecked();
});


test('Titres › Ombre : cliquer sur le texte « Activer » bascule la case', async ({ page }) => {
  await openStyleTab(page, 'tabTitles');
  await page.locator('#gcCssTabShadow').click();

  const box = page.locator('#gcCssBoxShadowEnable');
  const before = await box.isChecked();
  await page.locator('#gcCssBoxShadowEnableLabel').click();

  await expect(box).toBeChecked({ checked: !before });
});


test('Flash de disparition : idem quand le panneau existe (mode Évolution)', async ({ page }) => {
  await openStyleTab(page, 'tabFlash');

  // Le panneau n'est rendu qu'en mode Évolution : hors de ce mode, le test
  // n'a rien à vérifier.
  const label = page.locator('#disappearFlashColorGcLabel');
  test.skip((await label.count()) === 0, 'panneau de disparition absent hors mode Évolution');

  await label.click();
  await expect(page.locator('#disappearFlashColorGc')).toBeChecked();
});


test('aucun libellé de case ne reste en <span> sans for', async ({ page }) => {
  await openStyleTab(page);

  await expect(page.locator('span.form-check-label')).toHaveCount(0);
  await expect(page.locator('label.form-check-label:not([for])')).toHaveCount(0);
});
