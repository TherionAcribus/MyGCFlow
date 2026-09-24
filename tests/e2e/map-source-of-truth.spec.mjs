import { expect, test } from '@playwright/test';


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

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
  await expect(page.locator('#vectorMap')).toHaveClass(/is-selected/);

  await page.locator('#OSM').click();
  expect((await readMapOptions(page)).default).toBe('OSM');
});


test('le menu délègue les clics aux boutons remplacés après le chargement', async ({ page }) => {
  const activeLayer = await page.evaluate(async () => {
    const original = document.getElementById('watercolor');
    original.replaceWith(original.cloneNode(true));
    document.querySelector('#watercolor .map-card-label').dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );

    const app = await import('/static/js/index.js');
    return app.options.map.default;
  });

  expect(activeLayer).toBe('watercolor');
});


test('le menu générique synchronise les quatre boutons et leurs panneaux d\'options', async ({ page }) => {
  const cases = [
    { layerName: 'vectorMap', optionsPanelId: 'vectorMapOptions' },
    { layerName: 'stamenToner', optionsPanelId: 'tonerMapOptions' },
    { layerName: 'watercolor', optionsPanelId: null },
    { layerName: 'OSM', optionsPanelId: null },
  ];

  for (const selected of cases) {
    await page.locator(`#${selected.layerName}`).click();

    for (const candidate of cases) {
      const button = page.locator(`#${candidate.layerName}`);
      if (candidate.layerName === selected.layerName) {
        await expect(button).toHaveClass(/is-selected/);
      } else {
        await expect(button).not.toHaveClass(/is-selected/);
      }

      // L'état actif des fonds de carte n'a qu'une convention. L'ancienne
      // classe `disabled` ne doit plus être réintroduite en parallèle.
      await expect(button).not.toHaveClass(/disabled/);
    }

    for (const panelId of ['vectorMapOptions', 'tonerMapOptions']) {
      const panel = page.locator(`#${panelId}`);
      if (panelId === selected.optionsPanelId) {
        await expect(panel).toBeVisible();
        await expect(panel).toHaveClass(/show/);
      } else {
        await expect(panel).toBeHidden();
        await expect(panel).not.toHaveClass(/show/);
      }
    }
  }
});


test('loadCurrentSettings lit les options et ignore l\'état des boutons', async ({ page }) => {
  await page.locator('#stamenToner').click();

  // On désynchronise volontairement le DOM des options : l'ancienne détection
  // (classe 'is-selected' des boutons, visibilité des panneaux) aurait renvoyé
  // 'watercolor' ici. La source de vérité doit rester pkg.options.map.
  const detected = await page.evaluate(() => {
    document.getElementById('stamenToner').classList.remove('is-selected');
    document.getElementById('watercolor').classList.add('is-selected');
    document.getElementById('vectorMapOptions').style.display = 'block';

    window.profileManager.loadCurrentSettings();
    return window.profileManager.currentSettings.map.tile_provider;
  });

  expect(detected).toBe('stamenToner');
});


test('applyMapDefaults applique les préférences au format longitude latitude', async ({ page }) => {
  const applied = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    window.userSettings = {
      map_default_center: [-4.4860, 48.3905],
      map_default_zoom: 8,
    };

    app.applyMapDefaults(null, undefined);
    const view = app.getMap().getView();
    return {
      center: ol.proj.toLonLat(view.getCenter()),
      zoom: view.getZoom(),
    };
  });

  expect(applied.center[0]).toBeCloseTo(-4.4860, 3);
  expect(applied.center[1]).toBeCloseTo(48.3905, 3);
  expect(applied.zoom).toBe(8);
});


test('appliquer un profil met à jour carte, options et interface sans délai', async ({ page }) => {
  await page.locator('#OSM').click();

  // Aucun await entre applyProfile() et la lecture : l'application de la carte
  // est synchrone (plus de .click() ni de setTimeout de 100 ms), donc l'état
  // doit être complet immédiatement.
  const applied = await page.evaluate(async () => {
    // Une préférence globale distincte ne doit pas écraser la vue explicite du profil.
    window.userSettings = {
      map_default_center: [-4.4860, 48.3905],
      map_default_zoom: 3,
    };
    await window.profileManager.applyProfile({
      name: 'Test',
      map: {
        tile_provider: 'stamenToner',
        default_center: [4.8357, 45.7640],
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
      mapButton: document.getElementById('stamenToner').classList.contains('is-selected'),
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

  // Le centre est stocké en [longitude, latitude].
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
