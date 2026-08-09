import { expect, test } from '@playwright/test';


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.gcmapReady === true);

  // La base du runtime de test est vide : la modale de première utilisation
  // s'ouvre (de façon asynchrone) et intercepterait les clics sur les onglets.
  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}


async function readMapOptions(page) {
  return page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return JSON.parse(JSON.stringify(app.options.map));
  });
}


test.beforeEach(async ({ page }) => {
  await openReadyApp(page);
  await page.locator('a[href="#style"]').click();
});


test('le fond actif est écrit dans les options, pas seulement dans le DOM', async ({ page }) => {
  await page.locator('#vectorMap').click();
  expect((await readMapOptions(page)).default).toBe('vectorMap');
  await expect(page.locator('#vectorMap')).toHaveClass(/disabled/);

  await page.locator('#OSM').click();
  expect((await readMapOptions(page)).default).toBe('OSM');
});


test('loadCurrentSettings lit les options et ignore l\'état des boutons', async ({ page }) => {
  await page.locator('#stamenToner').click();

  // On désynchronise volontairement le DOM des options : l'ancienne détection
  // (classe 'disabled' des boutons, visibilité des panneaux) aurait renvoyé
  // 'watercolor' ici. La source de vérité doit rester pkg.options.map.
  const detected = await page.evaluate(() => {
    document.getElementById('stamenToner').classList.remove('disabled');
    document.getElementById('watercolor').classList.add('disabled');
    document.getElementById('vectorMapOptions').style.display = 'block';

    window.profileManager.loadCurrentSettings();
    return window.profileManager.currentSettings.map.tile_provider;
  });

  expect(detected).toBe('stamenToner');
});


test('appliquer un profil met à jour carte, options et interface sans délai', async ({ page }) => {
  await page.locator('#OSM').click();

  // Aucun await entre applyProfile() et la lecture : l'application de la carte
  // est synchrone (plus de .click() ni de setTimeout de 100 ms), donc l'état
  // doit être complet immédiatement.
  const applied = await page.evaluate(async () => {
    await window.profileManager.applyProfile({
      name: 'Test',
      map: {
        tile_provider: 'stamenToner',
        default_center: [45.7640, 4.8357],
        default_zoom: 9,
        vector_options: {
          stroke_color: '#123456',
          fill_color: '#654321',
          background_color: '#abcdef',
          stroke_width: 1.5,
        },
        toner_options: { variant: 'dark' },
      },
    });

    const app = await import('/static/js/index.js');
    const view = app.getMap().getView();
    const lonLat = ol.proj.toLonLat(view.getCenter());
    return {
      options: JSON.parse(JSON.stringify(app.options.map)),
      tonerButtonDark: document.getElementById('stamenTonerDark').classList.contains('disabled'),
      mapButton: document.getElementById('stamenToner').classList.contains('disabled'),
      strokeColorField: document.getElementById('fieldVectorMapStrokeColor').value,
      strokeWidthField: document.getElementById('fieldVectorMapStrokeWidth').value,
      lat: lonLat[1],
      lon: lonLat[0],
      zoom: view.getZoom(),
    };
  });

  expect(applied.options.default).toBe('stamenToner');
  expect(applied.options.stamenToner.type).toBe('dark');
  expect(applied.options.vectorMap).toMatchObject({
    strokeColor: '#123456',
    fillColor: '#654321',
    background: '#abcdef',
    strokeWidth: 1.5,
  });

  // L'interface n'est plus qu'un reflet des options.
  expect(applied.mapButton).toBe(true);
  expect(applied.tonerButtonDark).toBe(true);
  expect(applied.strokeColorField).toBe('#123456');
  expect(applied.strokeWidthField).toBe('1.5');

  // Le centre est stocké en [latitude, longitude].
  expect(applied.lat).toBeCloseTo(45.7640, 3);
  expect(applied.lon).toBeCloseTo(4.8357, 3);
  expect(applied.zoom).toBe(9);
});


test('un aller-retour options -> profil -> options est stable', async ({ page }) => {
  await page.locator('#vectorMap').click();
  await page.locator('#fieldVectorMapStrokeColor').fill('#ff0000');
  await page.locator('#fieldVectorMapStrokeColor').dispatchEvent('change');

  const roundTrip = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const pm = window.profileManager;

    pm.loadCurrentSettings();
    const before = pm.currentSettings.map;

    // Même normalisation que saveCurrentAsProfile() puis rechargement.
    await pm.applyProfile({
      name: 'Test',
      map: {
        ...before,
        vector_options: {
          stroke_color: before.vectorOptions.strokeColor,
          fill_color: before.vectorOptions.fillColor,
          background_color: before.vectorOptions.backgroundColor,
          stroke_width: before.vectorOptions.strokeWidth,
        },
        toner_options: { variant: before.tonerOptions.variant },
      },
    });

    pm.loadCurrentSettings();
    return {
      before: JSON.stringify(before),
      after: JSON.stringify(pm.currentSettings.map),
      strokeColor: app.options.map.vectorMap.strokeColor,
    };
  });

  expect(roundTrip.strokeColor).toBe('#ff0000');
  expect(roundTrip.after).toBe(roundTrip.before);
});
