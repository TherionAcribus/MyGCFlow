import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';

// Accessibilité clavier des onglets Texte / Boîte / Ombre / Position de
// l'assistant CSS (Style → Titres).
//
// Ces onglets étaient des <a> sans href ni tabindex : Tab les sautait
// entièrement et aria-selected n'était jamais resynchronisé au clic. Ils
// suivent désormais le pattern d'onglets WAI-ARIA : <button role="tab">,
// roving tabindex (seul l'onglet actif est tabulable), flèches/Home/End qui
// déplacent le focus ET activent l'onglet — le même schéma que les onglets de
// cible Titre/Infos juste au-dessus (cf. initCssAssistant dans ui.js).

async function openReadyApp(page) {
  // /#style : base vide, l'app forcerait sinon le retour sur l'onglet
  // Données à chaque résolution du statut, en plein milieu des clics.
  await page.goto('/#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);

  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTitles"]').click();
}

// Etat ARIA complet d'un onglet : classe active, aria-selected et tabindex.
function tabState(locator) {
  return locator.evaluate((el) => ({
    active: el.classList.contains('active'),
    selected: el.getAttribute('aria-selected'),
    tabIndex: el.tabIndex,
  }));
}


test('les sous-onglets CSS sont des onglets tabulables et étiquetés', async ({ page }) => {
  await openReadyApp(page);

  for (const tab of ['#gcCssTabText', '#gcCssTabBox', '#gcCssTabShadow', '#gcCssTabPosition']) {
    await expect(page.locator(tab)).toHaveJSProperty('tagName', 'BUTTON');
    await expect(page.locator(tab)).toHaveAttribute('role', 'tab');
    await expect(page.locator(tab)).toHaveAttribute('aria-controls', /.+/);
  }
  for (const pane of ['#gcCssPaneText', '#gcCssPaneBox', '#gcCssPaneShadow', '#gcCssPanePosition']) {
    await expect(page.locator(pane)).toHaveAttribute('role', 'tabpanel');
    await expect(page.locator(pane)).toHaveAttribute('aria-labelledby', /.+/);
  }

  // Roving tabindex : seul l'onglet actif est dans l'ordre de tabulation.
  expect(await tabState(page.locator('#gcCssTabText'))).toEqual({ active: true, selected: 'true', tabIndex: 0 });
  for (const tab of ['#gcCssTabBox', '#gcCssTabShadow', '#gcCssTabPosition']) {
    expect(await tabState(page.locator(tab))).toEqual({ active: false, selected: 'false', tabIndex: -1 });
  }

  // Tabulation réelle depuis le champ Titre : avant le correctif, les <a>
  // sans href étaient sautés et le focus atterrissait sur #gcCssTextColor.
  await page.locator('#inputTitle').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('gcCssTabText');
});


test('les flèches déplacent le focus et activent l\'onglet ciblé', async ({ page }) => {
  await openReadyApp(page);

  await page.locator('#gcCssTabText').focus();
  await page.keyboard.press('ArrowRight');

  expect(await page.evaluate(() => document.activeElement.id)).toBe('gcCssTabBox');
  expect(await tabState(page.locator('#gcCssTabText'))).toEqual({ active: false, selected: 'false', tabIndex: -1 });
  expect(await tabState(page.locator('#gcCssTabBox'))).toEqual({ active: true, selected: 'true', tabIndex: 0 });
  await expect(page.locator('#gcCssPaneBox')).toHaveClass(/active/);
  await expect(page.locator('#gcCssPaneText')).not.toHaveClass(/active/);

  // Navigation circulaire et raccourcis Home/End, comme les onglets Titre/Infos.
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('gcCssTabText');
  await page.keyboard.press('ArrowUp');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('gcCssTabPosition');
  await page.keyboard.press('Home');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('gcCssTabText');
  await page.keyboard.press('End');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('gcCssTabPosition');
  await expect(page.locator('#gcCssPanePosition')).toHaveClass(/active/);
});


test('le clic resynchronise aria-selected, tabindex et le panneau', async ({ page }) => {
  await openReadyApp(page);

  await page.locator('#gcCssTabShadow').click();

  expect(await tabState(page.locator('#gcCssTabText'))).toEqual({ active: false, selected: 'false', tabIndex: -1 });
  expect(await tabState(page.locator('#gcCssTabShadow'))).toEqual({ active: true, selected: 'true', tabIndex: 0 });
  await expect(page.locator('#gcCssPaneShadow')).toHaveClass(/active/);
  await expect(page.locator('#gcCssPaneText')).not.toHaveClass(/active/);

  // Et la tabulation atteint désormais l'onglet nouvellement actif.
  await page.locator('#inputTitle').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('gcCssTabShadow');
});
