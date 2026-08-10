import { expect, test } from '@playwright/test';

// Préférences globales : thème et réglages d'enregistrement vivaient dans le
// seul localStorage, donc étaient perdus au changement de navigateur ou au
// vidage du cache, alors que la langue survivait. Ces tests vérifient qu'ils
// sont désormais dans settings.json côté serveur, et que chaque écriture donne
// à l'utilisateur le même retour visuel (« Enregistré ✓ » inline).
//
// Le serveur de test écrit sa configuration dans le runtime jetable
// (GCMAP_CONFIG_DIR, cf. tests/e2e/run_server.py) : rien ne touche
// %APPDATA%\GCMap.

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.gcmapReady === true);

  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}

async function readServerSettings(page) {
  return page.evaluate(async () => (await fetch('/api/settings')).json());
}

// Remet les préférences partagées entre tests à leur valeur de départ : le
// runtime Playwright est unique pour toute la série de tests.
// `check_updates` reste à false comme dans le seed du runtime : la
// vérification de version ouvre une modale de changelog qui intercepte les
// clics (cf. tests/e2e/run_server.py).
test.afterEach(async ({ page }) => {
  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      theme: 'system',
      check_updates: false,
      recording: { fps: 30, bitrate_mbps: 6, slowdown_factor: 1, download_local: true },
    }),
  })).catch(() => {});
});


test('le thème choisi est enregistré côté serveur, pas seulement dans le navigateur', async ({ page }) => {
  await openReadyApp(page);
  await page.locator('a[href="#settings"]').click();

  await page.locator('#selectTheme').selectOption('dark');

  await expect.poll(async () => (await readServerSettings(page)).theme).toBe('dark');
  // Le miroir local reste écrit : c'est lui que lit le script anti-FOUC du
  // <head>, avant tout aller-retour réseau.
  expect(await page.evaluate(() => localStorage.getItem('gcmap_theme'))).toBe('dark');
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
});


test('un navigateur sans miroir local reprend le thème enregistré au démarrage', async ({ page }) => {
  // Le scénario que l'ancien stockage perdait : réglé ici, retrouvé ailleurs.
  await openReadyApp(page);
  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'dark' }),
  }));

  await page.evaluate(() => localStorage.removeItem('gcmap_theme'));
  await openReadyApp(page);

  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('gcmap_theme'))).toBe('dark');
});


test('les réglages d\'enregistrement partent vers le serveur et confirment le champ modifié', async ({ page }) => {
  await openReadyApp(page);
  await page.locator('a[href="#animation"]').click();
  await page.locator('#recordingConfigTab').click();
  await page.locator('#recordAdvancedSettings summary').click();

  const fps = page.locator('#inputRecordFps');
  await fps.fill('24');
  await fps.blur();

  await expect.poll(async () => (await readServerSettings(page)).recording.fps).toBe(24);
  await expect.poll(async () => (await readServerSettings(page)).recording_configured).toBe(true);

  // L'indicateur se pose dans le <label> du champ modifié, et seulement celui-là.
  await expect(page.locator('label[for="inputRecordFps"] .gc-saved-indicator.is-saved.is-visible')).toBeVisible();
  await expect(page.locator('label[for="inputRecordBitrate"] .gc-saved-indicator.is-visible')).toHaveCount(0);

  // Cases à cocher et champs numériques annexes : leurs écouteurs enveloppent
  // changeRecordValues() au lieu de la passer nue, sinon l'objet Event
  // atterrirait dans le paramètre `field` et l'indicateur ne s'afficherait pas.
  await page.locator('#cbRecordDownload').uncheck();
  await expect(page.locator('label[for="cbRecordDownload"] .gc-saved-indicator.is-saved.is-visible')).toBeVisible();
  await expect.poll(async () => (await readServerSettings(page)).recording.download_local).toBe(false);

  await page.locator('#inputRecordSlowdown').fill('2');
  await expect(page.locator('label[for="inputRecordSlowdown"] .gc-saved-indicator.is-saved.is-visible')).toBeVisible();
  await expect.poll(async () => (await readServerSettings(page)).recording.slowdown_factor).toBe(2);
});


test('les réglages d\'enregistrement survivent à un rechargement sans localStorage', async ({ page }) => {
  await openReadyApp(page);
  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recording: { fps: 24, bitrate_mbps: 12 } }),
  }));

  await page.evaluate(() => localStorage.clear());
  await openReadyApp(page);
  await page.locator('a[href="#animation"]').click();
  await page.locator('#recordingConfigTab').click();
  await page.locator('#recordAdvancedSettings summary').click();

  await expect(page.locator('#inputRecordFps')).toHaveValue('24');
  await expect(page.locator('#inputRecordBitrate')).toHaveValue('12');
});


test('les anciens réglages restés en localStorage sont repris une seule fois', async ({ page }) => {
  await openReadyApp(page);
  // Remettre le serveur dans l'état « jamais configuré » qu'aurait un
  // settings.json antérieur à la migration. Le reset remet aussi
  // check_updates à true : on le redésactive sans toucher au bloc `recording`,
  // qui doit rester non configuré pour que la reprise se déclenche.
  await page.evaluate(async () => {
    await fetch('/api/settings/reset', { method: 'POST' });
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check_updates: false }),
    });
  });
  await page.evaluate(() => localStorage.setItem('recordSettings', JSON.stringify({
    mode: 'mediarecorder',
    fps: 48,
    mediaRecorder: { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 9_000_000 },
    audio: { enabled: false, volume: 1 },
  })));

  await openReadyApp(page);

  await expect.poll(async () => (await readServerSettings(page)).recording.fps).toBe(48);
  await expect.poll(async () => (await readServerSettings(page)).recording.bitrate_mbps).toBe(9);
  // La clé locale disparaît : la reprise ne doit pas se rejouer à chaque
  // démarrage et écraser une valeur choisie depuis un autre navigateur.
  expect(await page.evaluate(() => localStorage.getItem('recordSettings'))).toBeNull();
});


test('le ralentissement suggéré par le suivi de performance est persisté', async ({ page }) => {
  // recording_perf.js applique ce réglage depuis un toast, hors de tout
  // événement de formulaire, via pkg.saveRecordSettings(). Tant que cette
  // fonction n'était pas exportée, l'appel était un no-op silencieux et le
  // ralentissement disparaissait au rechargement.
  await openReadyApp(page);

  const exported = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    if (typeof app.saveRecordSettings !== 'function') return false;
    app.options.record.mediaRecorder.slowdownFactor = 3;
    app.saveRecordSettings('inputRecordSlowdown');
    return true;
  });
  expect(exported).toBe(true);

  await expect.poll(async () => (await readServerSettings(page)).recording.slowdown_factor).toBe(3);

  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recording: { slowdown_factor: 1 } }),
  }));
});


test('le centre de carte par défaut confirme dans le champ au lieu d\'un toast', async ({ page }) => {
  await openReadyApp(page);
  await page.locator('a[href="#settings"]').click();

  const combined = page.locator('#inputMapCenterCombined');
  await combined.fill('45.5, 4.5');
  await combined.blur();

  await expect(page.locator('label[for="inputMapCenterCombined"] .gc-saved-indicator.is-saved.is-visible')).toBeVisible();
  await expect.poll(async () => (await readServerSettings(page)).map_default_center)
    .toEqual([4.5, 45.5]);

  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ map_default_center: null, map_default_zoom: null }),
  }));
});


test('chaque section indique où son réglage est enregistré', async ({ page }) => {
  await openReadyApp(page);

  await page.locator('a[href="#style"]').click();
  // Sous-onglet actif par défaut de l'onglet Style.
  await expect(page.locator('#tabMapOverlay .gc-scope-badge.gc-scope-profile').first()).toBeVisible();
  await page.locator('a[href="#tabPointsFlash"]').click();
  await expect(page.locator('#points .gc-scope-badge.gc-scope-profile')).toBeVisible();
  await expect(page.locator('#flash .gc-scope-badge.gc-scope-profile')).toBeVisible();
  // Rien de global ne se cache dans l'onglet Style : la distinction ne vaut que
  // si elle est exclusive.
  await expect(page.locator('#style .gc-scope-badge.gc-scope-global')).toHaveCount(0);

  await page.locator('a[href="#settings"]').click();
  await expect(page.locator('#settings .gc-scope-badge.gc-scope-global')).toBeVisible();
  await expect(page.locator('#settings .gc-scope-badge.gc-scope-profile')).toHaveCount(0);
});
