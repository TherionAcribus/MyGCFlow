import { expect, test } from '@playwright/test';

// MyGCFlow tourne en local et doit rester utilisable sans connexion. Tant que les
// bibliothèques venaient d'un CDN, une coupure réseau vidait l'interface de sa
// substance : plus de Bootstrap, plus de Tom Select, plus de datepicker, plus de
// carte. Elles sont désormais servies depuis static/vendor/ (voir son README).
//
// Ce test coupe tout ce qui n'est pas le serveur local, puis vérifie que
// l'application démarre quand même. Le pendant statique — aucun template ne
// référence un CDN — vit dans tests/test_offline_assets.py.

/** Coupe le réseau sauf le serveur MyGCFlow lui-même. */
async function goOffline(page) {
  const blocked = [];
  await page.route('**/*', (route) => {
    const { hostname } = new URL(route.request().url());
    if (hostname === '127.0.0.1' || hostname === 'localhost') {
      route.continue();
      return;
    }
    blocked.push(route.request().url());
    route.abort();
  });
  return blocked;
}

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  // Même renvoi de la modale de première utilisation que dans les autres specs :
  // son backdrop intercepterait les clics sur les onglets.
  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}


test('l\'application démarre sans accès au réseau externe', async ({ page }) => {
  const blocked = await goOffline(page);

  await openReadyApp(page);

  // Chaque bibliothèque tierce dont dépend l'interface, vérifiée par son point
  // d'entrée global : un fichier vendoré manquant ou mal référencé les fait
  // disparaître une par une.
  const globals = await page.evaluate(() => ({
    // Tabler embarque le bundle Bootstrap 5 mais l'expose sous window.tabler
    // (cf. bs() dans ui_bootstrap.js), pas sous window.bootstrap.
    bootstrapModal: typeof (window.tabler && window.tabler.Modal),
    tomSelect: typeof window.TomSelect,
    popper: typeof window.Popper,
    tempusDominus: typeof window.tempusDominus,
    ol: typeof window.ol,
    htmx: typeof window.htmx,
  }));

  expect(globals).toEqual({
    bootstrapModal: 'function',
    tomSelect: 'function',
    popper: 'object',
    tempusDominus: 'object',
    ol: 'object',
    htmx: 'object',
  });

  // Les tuiles des fonds de carte, elles, restent hors de portée hors ligne :
  // ce test ne prétend pas le contraire, il vérifie seulement que l'interface
  // n'a rien demandé d'autre au réseau (une lib restée sur un CDN apparaîtrait
  // ici).
  const nonTileRequests = blocked.filter((url) => /\.(?:js|mjs|css|woff2?|ttf|eot)(?:\?|$)/i.test(url));
  expect(nonTileRequests).toEqual([]);
});


test('la police d\'icônes est servie en local', async ({ page }) => {
  // Les boutons de la barre de contrôle et la quasi-totalité des libellés sont
  // des icônes Tabler : sans le webfont, l'interface devient illisible.
  await goOffline(page);
  await openReadyApp(page);

  const loaded = await page.evaluate(async () => {
    await document.fonts.load('16px "tabler-icons"');
    return document.fonts.check('16px "tabler-icons"');
  });

  expect(loaded).toBe(true);
});


test('un sélecteur Tom Select et un datepicker restent fonctionnels hors ligne', async ({ page }) => {
  await goOffline(page);
  await openReadyApp(page);

  // Tom Select remplace le <select> natif par sa propre structure : sa présence
  // prouve que le script ET la feuille de style vendorés ont été chargés.
  const enhanced = page.locator('.ts-wrapper').first();
  await expect(enhanced).toBeAttached();

  // Tempus Dominus dépend de Popper : le calendrier ne s'affiche que si les
  // deux scripts sont là. Les datepickers sont instanciés par ui.js sur les
  // champs de filtre (cf. initTempusDominus), sans attribut déclaratif.
  await page.locator('a[href="#data"]').click();
  const opened = await page.evaluate(() => {
    const input = document.querySelector('#datePickerStart');
    if (!input || !input._tdInstance) return false;
    input._tdInstance.show();
    return true;
  });
  expect(opened).toBe(true);
  await expect(page.locator('.tempus-dominus-widget.show').first()).toBeVisible();
});
