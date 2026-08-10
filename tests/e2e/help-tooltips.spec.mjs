import { expect, test } from '@playwright/test';

// Accessibilité clavier des infobulles d'aide.
//
// Les icônes « ? » des réglages d'enregistrement portent l'essentiel de la
// documentation de l'application, mais un <i> n'est pas focusable : leur contenu
// n'existait qu'au survol de la souris. `tabindex="0"` les met dans l'ordre de
// tabulation, et le déclencheur Bootstrap par défaut (« hover focus ») affiche
// alors l'infobulle et pose `aria-describedby`.

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.gcmapReady === true);

  // Même renvoi de la modale de première utilisation que dans les autres specs :
  // son backdrop intercepterait les clics sur les onglets.
  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}

async function openRecordingSettings(page) {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#recordingConfigTab').click();
}


test('toute infobulle est atteignable au clavier', async ({ page }) => {
  // Invariant de gabarit plutôt que liste figée : une infobulle ajoutée plus
  // tard sur un <span> ou un <i> sera signalée ici.
  await openReadyApp(page);

  const unreachable = await page.evaluate(() => {
    const NATIVELY_FOCUSABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
    return [...document.querySelectorAll('[data-bs-toggle="tooltip"]')]
      .filter((el) => !NATIVELY_FOCUSABLE.has(el.tagName) && !el.hasAttribute('tabindex'))
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
  });

  expect(unreachable).toEqual([]);
});


test('le focus clavier révèle l\'aide d\'un réglage d\'enregistrement', async ({ page }) => {
  await openReadyApp(page);
  await openRecordingSettings(page);

  // L'aide du mode d'enregistrement, seule visible sans condition : les blocs
  // `.mediarecorder-only` (dont « Réglages avancés ») restent masqués tant que
  // le serveur n'a pas de réglages vidéo enregistrés.
  const help = page.locator('label[for="selectRecordMode"] .ti-help');
  await help.focus();

  await expect(page.locator('.tooltip')).toBeVisible();
  await expect(page.locator('.tooltip')).toContainText('MediaRecorder');
  // Bootstrap relie l'infobulle à l'icône : sans cela, un lecteur d'écran
  // annoncerait un arrêt de tabulation muet.
  await expect(help).toHaveAttribute('aria-describedby', /.+/);
});


test('l\'icône d\'aide vient bien dans l\'ordre de tabulation, avant son champ', async ({ page }) => {
  await openReadyApp(page);
  await openRecordingSettings(page);

  // Tabulation réelle, pas un focus() programmatique : c'est l'ordre du clavier
  // qui était en cause.
  await page.locator('#recordingConfigTab').focus();
  const reached = [];
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Tab');
    reached.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el.id || `${el.tagName.toLowerCase()}.${(el.className || '').toString().trim()}`;
    }));
  }

  const helpIndex = reached.findIndex((name) => name.includes('ti-help'));
  expect(helpIndex).toBeGreaterThanOrEqual(0);
  expect(reached.indexOf('selectRecordMode')).toBeGreaterThan(helpIndex);
});


test('l\'icône d\'aide n\'entre pas dans le nom accessible de son champ', async ({ page }) => {
  // L'icône est à l'intérieur du <label for=…> : un aria-label posé sur elle
  // serait absorbé par le calcul du nom du champ (« FPS » → « FPS Aide »).
  await openReadyApp(page);
  await openRecordingSettings(page);

  const labelText = await page.evaluate(
    () => document.getElementById('inputRecordFps').labels[0].textContent.trim()
  );

  expect(labelText).toBe('FPS');
});
