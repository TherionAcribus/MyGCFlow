import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'labs');
const HISTORY = path.join(FIXTURES, 'lab-finds-valid.json');
const COORDS = path.join(FIXTURES, 'lab2gpx-stages.gpx');
const GPX_FINDS = path.join(HERE, 'fixtures', 'my-finds.gpx');

// Sélecteur « Découvertes affichées » + panneau « Mes Lab Caches » (mode
// Normal) : la fixture couvre 12 découvertes dont 8 résolues par UUID — soit
// 8 étapes affichables et 4 en attente après l'import du lot complet.


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  await dismissFirstUseModal(page);
}


async function importLabs(page) {
  await page.locator('#labs-file-input').setInputFiles([HISTORY, COORDS]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  // Import terminé quand le statut affiche les compteurs (8 affichables /
  // 4 en attente) — l'appli bascule alors aussi le sélecteur sur « labs ».
  await expect(page.locator('#labsStatus')).toContainText('8', { timeout: 60_000 });
}


async function readServerSettings(page) {
  return page.evaluate(async () => (await fetch('/api/settings')).json());
}


// Le placement automatique des étapes est activé par défaut et interroge le
// service public lab2gpx : aucun test ne doit le laisser partir sur le réseau
// avec les UUID de la fixture.
test.beforeEach(async ({ request }) => {
  await request.put('/api/settings', { data: { labs_auto_fetch_coords: false } });
});


// Le sélecteur est une préférence serveur partagée par le runtime de test :
// toujours revenir à « geocaches » et vider la collection Labs pour ne pas
// influencer les autres specs.
test.afterEach(async ({ page, request }) => {
  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ main_discovery_sources: 'geocaches',
                           labs_auto_fetch_coords: false }),
  })).catch(() => {});
  await request.post('/api/labs/clear').catch(() => {});
  await request.post('/clear_database').catch(() => {});
});


test('le sélecteur de sources existe avec les trois choix et le défaut géocaches', async ({ page }) => {
  await openReadyApp(page);

  const select = page.locator('#selectDiscoverySources');
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('geocaches');
  await expect(select.locator('option')).toHaveCount(3);
});


test('l\'import Labs met à jour le statut et bascule l\'affichage sur les Labs', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // Statut : 12 étapes, 8 affichables, 4 en attente.
  await expect(page.locator('#labsStatus')).toContainText('12');
  await expect(page.locator('#labsPendingAlert')).toBeVisible();

  // Sans géocaches, l'appli a basculé sur « labs » pour rendre l'import visible.
  const select = page.locator('#selectDiscoverySources');
  await expect(select).toHaveValue('labs');
  expect((await readServerSettings(page)).main_discovery_sources).toBe('labs');

  // Les 8 étapes résolues sont affichées.
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });
});


test('le mode « labs » désactive les filtres non applicables', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  await expect(page.locator('#selectDiscoverySources')).toHaveValue('labs');

  // D/T/taille désactivés, « Adventure Lab » resté sélectionné dans les types.
  await expect(page.locator('#filterPanel')).toHaveAttribute('data-labs-only', '');
  // La période de pose reste utilisable : les Labs portent leur publication.
  await expect(page.locator('#publishedDatePickerStart')).toBeEnabled();
  await expect(page.locator('#publishedDatePickerEnd')).toBeEnabled();
  const adventureSelected = await page.evaluate(() =>
    Array.from(document.getElementById('selectType').selectedOptions)
      .some(o => o.value === 'Adventure Lab'));
  expect(adventureSelected).toBe(true);
});


test('« géocaches » masque les Labs ; « both » les réaffiche', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  const select = page.locator('#selectDiscoverySources');
  await select.selectOption('geocaches');
  await expect(page.locator('#filtersCounter')).toContainText('0 / 8', { timeout: 20_000 });
  expect((await readServerSettings(page)).main_discovery_sources).toBe('geocaches');

  await select.selectOption('both');
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 20_000 });
});


test('« Supprimer mes Lab Caches » vide la collection Labs uniquement', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // La confirmation passe par la modale applicative (showConfirmation,
  // .gcm-confirm-modal) : cliquer son bouton danger.
  await page.locator('#clearLabsBtn').click();
  await page.locator('.gcm-confirm-modal.show [data-gcm-role="confirm"]').click();

  await expect(page.locator('#labsStatus')).toContainText('Aucun Lab Cache importé', { timeout: 30_000 });
});


test('les étapes Labs alimentent l\'index d\'animation et la lecture les joue', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // L'index par jour (aliment de l'animation, du trajet et de la vidéo)
  // contient les 8 étapes résolues, réparties sur 3 jours. La recharge
  // post-import est asynchrone : le compteur « 8 / 8 » est posé en fin de
  // séquence, quand json_data et pointsByDate sont reconstruits.
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });
  const index = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    let labPoints = 0;
    let timed = 0;
    for (const features of app.pointsByDate.values()) {
      const labs = features.filter(f => f.properties?.source_kind === 'lab');
      labPoints += labs.length;
      // Heure de validation, qui ordonne la journée dans le trajet.
      timed += labs.filter(f => /^\d{2}:\d{2}:\d{2}$/.test(f.properties.found_local_time || '')).length;
    }
    return {
      days: app.pointsByDate.size,
      labPoints,
      timed,
      revision: app.pointsByDateRevision,
      total: app.metadata?.numberOfCaches,
    };
  });
  expect(index).toMatchObject({ days: 3, labPoints: 8, timed: 8, total: 8 });
  expect(index.revision).toBeGreaterThan(0);

  // Lecture complète : le compteur atteint le total de la sélection et la
  // date affichée rejoint le dernier jour Labs (2024-06-09).
  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill('20');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#btnQuickPreview').click();
  await expect(page.locator('#spanNbCaches')).toHaveText('8', { timeout: 30_000 });
  await expect(page.locator('#spanCurrentDate')).toContainText('09/06/2024');
});


test('le popup d\'une étape Labs affiche étape, Adventure, lien et date', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // La recharge post-import est asynchrone : le compteur « 8 / 8 » est posé
  // en fin de séquence, quand json_data et pointsByDate sont reconstruits.
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  const point = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    const labs = app.json_data.features.filter(f => f.properties?.source_kind === 'lab');
    const feature = labs[0];
    const [lon, lat] = feature.geometry.coordinates;
    const px = map.getPixelFromCoordinate(ol.proj.fromLonLat([lon, lat]));
    const rect = map.getTargetElement().getBoundingClientRect();
    return {
      x: px[0] + rect.x, y: px[1] + rect.y,
      // Des étapes proches peuvent se recouvrir : le clic peut retourner
      // n'importe quelle étape au premier plan sous le pixel.
      stages: labs.map(f => f.properties.name),
      adventures: labs.map(f => f.properties.adventure_title),
    };
  });

  await page.mouse.click(point.x, point.y);
  const popup = page.locator('#gcPopup.is-visible');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup.locator('.gc-popup-title')).toHaveText(new RegExp(`^(${point.stages.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`));
  await expect(popup).toContainText('Trouvé');
  // Propriétaire et publication lus dans le GPX.
  await expect(popup).toContainText('Testeur_Fictif');
  await expect(popup).toContainText('Publié le');
  // Pas de ligne D/T/taille ni de code GC ; le lien de l'Adventure vient de
  // l'URL importée (hôte labs.geocaching.com uniquement).
  await expect(popup).not.toContainText('-/-');
  const link = popup.locator('a.gc-popup-link');
  await expect(link).toHaveCount(1);
  expect(await link.getAttribute('href')).toMatch(/^https:\/\/labs\.geocaching\.com\//);
  const linkText = await link.textContent();
  expect(point.adventures).toContain(linkText.trim());
});


// Critère final du plan : en mixte, chaque choix de source affiche et
// compte son propre jeu (ici 6 géocaches + 8 étapes Labs).
test('en mixte, chaque source affiche et compte son propre jeu', async ({ page }) => {
  await openReadyApp(page);

  await page.locator('#file-input').setInputFiles(GPX_FINDS);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  await importLabs(page);
  // Des géocaches existent : l'import bascule sur « both ».
  const select = page.locator('#selectDiscoverySources');
  await expect(select).toHaveValue('both');
  await expect(page.locator('#filtersCounter')).toContainText('14 / 14', { timeout: 60_000 });

  // Les deux sources sont dans l'index d'animation.
  const counts = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    let labs = 0, geocaches = 0;
    for (const features of app.pointsByDate.values()) {
      for (const f of features) {
        (f.properties?.source_kind === 'lab' ? labs++ : geocaches++);
      }
    }
    return { labs, geocaches };
  });
  expect(counts).toEqual({ labs: 8, geocaches: 6 });

  await select.selectOption('geocaches');
  await expect(page.locator('#filtersCounter')).toContainText('6 / 14', { timeout: 20_000 });
  await select.selectOption('labs');
  await expect(page.locator('#filtersCounter')).toContainText('8 / 14', { timeout: 20_000 });
  await select.selectOption('both');
  await expect(page.locator('#filtersCounter')).toContainText('14 / 14', { timeout: 20_000 });
});


test('le favori « Envoyer vers MyGCFlow » porte origine locale et jeton', async ({ page }) => {
  await openReadyApp(page);

  const link = page.locator('#labsBookmarkletLink');
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^javascript:/);
  // Le lien généré embarque l'endpoint de réception et un jeton local.
  expect(href).toContain('/api/labs/receive');
  expect(href).toContain('X-MyGCFlow-Token');
});


test('la case de récupération automatique persiste le réglage serveur', async ({ page }) => {
  await openReadyApp(page);

  // Réglage rangé dans les options avancées, repliées par défaut.
  const box = page.locator('#labsAutoFetch');
  await expect(box).toBeHidden();
  await page.locator('#labsAdvanced > summary').click();
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();

  await box.check();
  await expect.poll(async () =>
    (await readServerSettings(page)).labs_auto_fetch_coords,
  ).toBe(true);

  // Décocher revient au défaut — l'opt-in n'est pas collant.
  await box.uncheck();
  await expect.poll(async () =>
    (await readServerSettings(page)).labs_auto_fetch_coords,
  ).toBe(false);
});


test('le bouton de récupération est visible quand des étapes sont en attente', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // 4 étapes restent en attente : les deux issues de résolution coexistent.
  await expect(page.locator('#labsPendingAlert')).toBeVisible();
  await expect(page.locator('#labsFetchBtn')).toBeVisible();
  await expect(page.locator('#labsPendingBtn')).toBeVisible();
});


const STAGE_MOULIN = '57a9e000-0000-4000-8000-000000000101';
const STAGE_PORTE_NORD = '57a9e000-0000-4000-8000-000000000401';
// Adventure archivée de la fixture : absente du GPX, ses 2 étapes attendent.
const ADVENTURE_ARCHIVED = 'fa1e0000-0000-4000-8000-000000000003';
const ARCHIVED_STAGES = ['57a9e000-0000-4000-8000-000000000301',
                         '57a9e000-0000-4000-8000-000000000302'];

// GPX de la fixture avec une substitution unique (échec si le motif bouge).
function patchedCoords(search, replacement) {
  const text = readFileSync(COORDS, 'utf-8');
  expect(text.split(search).length - 1).toBe(1);
  return { name: 'lab2gpx-patched.gpx', mimeType: 'application/gpx+xml',
           buffer: Buffer.from(text.replace(search, replacement), 'utf-8') };
}

async function exportedStage(page, stageId) {
  return page.evaluate(async (id) => {
    const payload = await (await fetch('/api/labs/export')).json();
    return payload.discoveries.find(d => d.stage_id === id) || null;
  }, stageId);
}


test('un conflit de coordonnées se tranche dans l\'aperçu : garder par défaut, remplacer sur choix', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // Même étape, position déplacée dans le GPX : conflit avec l'existant.
  const moved = patchedCoords('lat="47.21510"', 'lat="47.30000"');
  await page.locator('#labs-file-input').setInputFiles(moved);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });

  const conflicts = page.locator('#labsPreviewConflicts');
  await expect(conflicts).toBeVisible();
  await expect(conflicts).toContainText('Le Moulin Rouge');
  await expect(conflicts).toContainText('47.30000');
  await expect(conflicts.locator('input[value="keep"]')).toBeChecked();

  await conflicts.locator('input[value="replace"]').check();
  await page.locator('#labsPreviewConfirmBtn').click();

  await expect.poll(async () => (await exportedStage(page, STAGE_MOULIN))?.latitude,
                    { timeout: 30_000 }).toBeCloseTo(47.3, 5);
});


test('une étape remaniée reçoit une suggestion à valider dans « Étapes en attente »', async ({ page }) => {
  await openReadyApp(page);

  // L'étape du GPX porte le titre de l'étape trouvée, sous un autre UUID :
  // proposition mémorisée, jamais appliquée seule.
  const renamed = patchedCoords('<desc>Point 1</desc>', '<desc>La Porte Nord</desc>');
  await page.locator('#labs-file-input').setInputFiles([HISTORY]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  await expect(page.locator('#labsStatus')).toContainText('12', { timeout: 60_000 });

  await page.locator('#labs-file-input').setInputFiles(renamed);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  await expect(page.locator('#labsStatus')).toContainText('8', { timeout: 60_000 });
  expect((await exportedStage(page, STAGE_PORTE_NORD)).latitude).toBeNull();

  await page.locator('#labsPendingBtn').click();
  const row = page.locator(`#labsPendingList [data-local-uid="${STAGE_PORTE_NORD}"]`);
  await expect(row).toContainText('47.23010');

  await row.locator('[data-action="use-suggestion"]').click();
  await expect(row.locator('input[data-field="coords"]')).toHaveValue('47.2301, -1.5702');
  await row.getByRole('button', { name: 'Enregistrer' }).click();

  await expect.poll(async () => (await exportedStage(page, STAGE_PORTE_NORD))?.latitude,
                    { timeout: 30_000 }).toBeCloseTo(47.2301, 5);
});


test('« Étapes en attente » groupe par Adventure et place toutes ses étapes en une saisie', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  await page.locator('#labsPendingBtn').click();
  // 4 étapes en attente dans 3 Adventures ; l'archivée en compte 2.
  await expect(page.locator('#labsPendingList [data-adventure-key]')).toHaveCount(3);
  const card = page.locator(`#labsPendingList [data-adventure-key="${ADVENTURE_ARCHIVED}"]`);
  await expect(card).toContainText('Labyrinthe du Port');

  // Saisie au format geocaching.com, lue et confirmée en décimal.
  await card.locator('input[data-field="adventure-coords"]').fill('N 47° 12.000 W 001° 33.000');
  await card.locator('[data-action="place-adventure"]').click();
  await expect(card).toContainText('47.20000, -1.55000');
  await expect(page.locator('#labsStatus')).toContainText('10 sur la carte');

  // Les deux étapes sont placées à la même position, signalée approximative.
  for (const stageId of ARCHIVED_STAGES) {
    const stage = await exportedStage(page, stageId);
    expect(stage.latitude).toBeCloseTo(47.2, 5);
    expect(stage.longitude).toBeCloseTo(-1.55, 5);
    expect(stage.coordinate_scope).toBe('adventure');
  }

  // Une saisie illisible est refusée avec un message, sans rien placer.
  const single = page.locator(`#labsPendingList [data-local-uid="${STAGE_PORTE_NORD}"]`);
  await single.locator('input[data-field="coords"]').fill('48,85,2,29');
  await single.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(single).toContainText('format de coordonnées non reconnu');
  expect((await exportedStage(page, STAGE_PORTE_NORD)).latitude).toBeNull();
});


test('la période de pose filtre les Labs sur leur date de publication', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  // Fixture : 5 des 8 étapes affichables sont d'Adventures publiées en 2020,
  // les 3 autres plus tard. « 01/01/2021 » se lit pareil en jj/mm et mm/jj.
  await page.evaluate(() => {
    const start = document.getElementById('publishedDatePickerStart');
    start.value = '01/01/2021';
    start.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#filtersCounter')).toContainText('3 / 8', { timeout: 30_000 });
});


// Dépôt de fichiers sur la fenêtre, comme un glisser-déposer depuis le bureau.
async function dropFiles(page, files) {
  await page.evaluate((items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      transfer.items.add(new File([item.text], item.name, { type: item.type || '' }));
    }
    window.dispatchEvent(new DragEvent('drop', {
      dataTransfer: transfer, bubbles: true, cancelable: true,
    }));
  }, files);
}


test('un export Lab Caches déposé sur la fenêtre part vers l\'import Labs', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // Le parcours signalé : exporter, vider, puis redéposer le fichier.
  const exported = await page.evaluate(async () => (await fetch('/api/labs/export')).text());
  await page.evaluate(() => fetch('/api/labs/clear', { method: 'POST' }));
  await page.evaluate(async () => (await import('/static/js/index.js')).refreshLabsStatus());
  await expect(page.locator('#labsStatus')).not.toContainText('12');

  await dropFiles(page, [{ name: 'mygcflow-lab-finds-export.json', text: exported,
                           type: 'application/json' }]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#labsPreviewFiles')).toContainText('mygcflow-lab-finds-export.json');
  await page.locator('#labsPreviewConfirmBtn').click();

  // L'export porte les coordonnées : les 8 étapes sont de nouveau affichables.
  await expect(page.locator('#labsStatus')).toContainText('12', { timeout: 60_000 });
  await expect(page.locator('#labsStatus')).toContainText('8');
});


test('historique et GPX Lab2Gpx déposés ensemble forment un seul lot Labs', async ({ page }) => {
  await openReadyApp(page);

  await dropFiles(page, [
    { name: 'lab2gpx.gpx', text: readFileSync(COORDS, 'utf-8') },
    { name: 'historique.json', text: readFileSync(HISTORY, 'utf-8') },
  ]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#labsPreviewFiles')).toContainText('lab2gpx.gpx');
  await expect(page.locator('#labsPreviewFiles')).toContainText('historique.json');
  await page.locator('#labsPreviewConfirmBtn').click();
  await expect(page.locator('#labsStatus')).toContainText('8', { timeout: 60_000 });
});


test('un GPX Lab2Gpx choisi par le sélecteur des géocaches part vers l\'import Labs', async ({ page }) => {
  await openReadyApp(page);

  await page.locator('#file-input').setInputFiles(COORDS);
  // Plus de « Fichier invalide » : l'aperçu Labs s'ouvre (le GPX seul ne
  // crée aucune découverte, ses étapes sont comptées « ignorées »).
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#labsPreviewFiles')).toContainText('lab2gpx-stages.gpx');
});


test('la carte montre le parcours du favori, puis le replie une fois des Labs importés', async ({ page }) => {
  await openReadyApp(page);

  // Rien d'importé : état en clair, parcours en deux étapes, pas d'options
  // avancées dépliées.
  await expect(page.locator('#labsStatus')).toHaveText('Aucun Lab Cache importé');
  await expect(page.locator('#labsGuide')).toBeVisible();
  await expect(page.locator('#labsBookmarkletLink')).toBeVisible();
  await expect(page.locator('#labs-file-btn')).toBeHidden();
  await expect(page.locator('#labsUpdateBtn')).toBeHidden();

  await importLabs(page);

  await expect(page.locator('#labsStatus')).toHaveText('12 étapes · 8 sur la carte · 4 à compléter');
  await expect(page.locator('#labsGuide')).toBeHidden();
  const update = page.locator('#labsUpdateBtn');
  await expect(update).toBeVisible();
  await update.click();
  await expect(page.locator('#labsGuide')).toBeVisible();
  await expect(update).toHaveAttribute('aria-expanded', 'true');
});


test('import puis placement des étapes s\'affichent comme une seule activité suivie', async ({ page }) => {
  await openReadyApp(page);

  // Tâches serveur simulées : seule la séquence d'affichage est testée, sans
  // import réel ni appel au service lab2gpx.
  let importPolls = 0;
  let fetchPolls = 0;
  let releaseFetch = false;
  await page.route('**/api/labs/import/commit', route => route.fulfill({
    status: 202, json: { success: true, task_id: 'fake-import' } }));
  await page.route('**/tasks/fake-import*', route => {
    importPolls += 1;
    route.fulfill({ json: importPolls < 3
      ? { task_id: 'fake-import', type: 'lab_import', state: 'running', progress: 40,
          message: 'Import Labs : historique.json' }
      : { task_id: 'fake-import', type: 'lab_import', state: 'finished', progress: 100,
          result: { success: true, added: 12, updated: 0, total: 12, ready_total: 0,
                    unresolved: 12, fetch_task_id: 'fake-fetch' } } });
  });
  await page.route('**/tasks/fake-fetch*', route => {
    fetchPolls += 1;
    route.fulfill({ json: !releaseFetch
      ? { task_id: 'fake-fetch', type: 'lab_fetch_coords', state: 'running', progress: 50,
          message: 'Coordonnées Labs : 2/4 Adventures' }
      : { task_id: 'fake-fetch', type: 'lab_fetch_coords', state: 'finished', progress: 100,
          result: { success: true, resolved: 8, unresolved: 4, failed_uuids: [] } } });
  });

  const activity = page.locator('#labsActivity');
  await expect(activity).toBeHidden();

  await page.locator('#labs-file-input').setInputFiles([HISTORY]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();

  // Étape 1 : import, avec le message de progression du serveur.
  await expect(activity).toBeVisible();
  await expect(activity.locator('.labs-activity-title')).toHaveText('Import de vos Lab Caches…');
  await expect(activity.locator('.labs-activity-detail')).toHaveText('Import Labs : historique.json');

  // Étape 2 : enchaînée sans que le bloc disparaisse.
  await expect(activity.locator('.labs-activity-title'))
    .toHaveText('Placement de vos étapes sur la carte…', { timeout: 15_000 });
  await expect(activity.locator('.labs-activity-detail')).toHaveText('Coordonnées Labs : 2/4 Adventures');
  await expect(activity.locator('.labs-activity-bar')).toHaveAttribute('aria-valuenow', '50');
  await expect(activity).toBeVisible();
  // Pas d'appel à l'action concurrent pendant l'opération.
  await expect(page.locator('#labsPendingAlert')).toBeHidden();

  releaseFetch = true;
  await expect(activity).toBeHidden({ timeout: 15_000 });
  expect(fetchPolls).toBeGreaterThan(0);
});


test('la récupération n\'est plus proposée quand il ne reste que des étapes déjà tentées', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#labsFetchBtn')).toBeVisible();

  // Statut tel que le serveur le rend après une récupération restée sans
  // résultat pour les 4 étapes restantes.
  await page.route('**/api/labs/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, fetchable_adventures: 0 } });
  });
  await page.evaluate(async () => (await import('/static/js/index.js')).refreshLabsStatus());

  await expect(page.locator('#labsPendingAlert')).toBeVisible();
  await expect(page.locator('#labsPendingText')).toContainText('introuvable');
  await expect(page.locator('#labsFetchBtn')).toBeHidden();
  await expect(page.locator('#labsPendingBtn')).toBeVisible();

  // La relance reste possible, mais rangée dans les options avancées.
  const retry = page.locator('#labsRetryFetchBtn');
  await expect(retry).toBeHidden();
  await page.locator('#labsAdvanced > summary').click();
  await expect(retry).toBeVisible();
});


test('couleur et icône dédiées Adventure Lab sont déclarées', async ({ page }) => {
  await openReadyApp(page);

  const style = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.setPointIconSet('geocaching');
    return {
      color: app.defaultGcColors?.['Adventure Lab'],
      flat: app.gcColorsFlat || [],
      sprite: app.options?.point?.sprite?.map?.adventurelab || null,
    };
  });

  expect(style.color).toBe('#00C5A1');
  const idx = style.flat.indexOf('Adventure Lab');
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(style.flat[idx + 1]).toBe('#00C5A1');
  expect(style.sprite).toMatchObject({ x: 1800, y: 0, w: 50, h: 50 });
});
