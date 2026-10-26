// Caches posées sur la carte principale (« Mes caches posées »,
// docs/logs-geocaching.md) : proposées seulement quand les logs en décrivent,
// masquées par défaut, jamais comptées comme des trouvailles, grisées une
// fois désactivées ou archivées, avec leurs flashs propres et leur place dans
// le trait de déplacement.
//
// Fixtures fictives : my-finds-poses.gpx (2 trouvailles, 01/05/2019 et
// 31/03/2020) et logs-poses.json (compte 1234567, voir poses.spec.mjs) :
// 8 caches posées dont une sans position ; GCP0004 publiée le 01/05/2019,
// désactivée par son poseur du 01/07 au 15/07 puis du 01/09 au 10/09/2019
// (maintenance le 10/09) ; GCP0005 archivée par son poseur le 01/10/2019,
// désarchivée puis réarchivée par un relecteur ; GCP0006 archivée d'après son
// statut à l'export ; GCP0008 publiée le 10/02/2020.
//
// Les logs vivent hors de /clear_database, et owner_display / owner_in_trail
// sont des préférences globales : tout remettre en sortant (AGENTS.md).
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'gc_logs');
const MY_FINDS = path.join(FIXTURES, 'my-finds-poses.gpx');
const POSES = path.join(FIXTURES, 'logs-poses.json');
const PLACED = ['GCP0001', 'GCP0002', 'GCP0003', 'GCP0004', 'GCP0005', 'GCP0006', 'GCP0008'];

async function importLogs(request) {
  const preview = await request.post('/api/logs/import/preview', {
    multipart: {
      file: { name: 'logs-poses.json', mimeType: 'application/json', buffer: fs.readFileSync(POSES) },
    },
  });
  expect(preview.ok()).toBeTruthy();
  const { import_token: token } = await preview.json();
  const commit = await request.post('/api/logs/import/commit', { data: { import_token: token } });
  expect(commit.status()).toBe(202);
  const { task_id: taskId } = await commit.json();
  await expect.poll(async () => (await (await request.get(`/tasks/${taskId}`)).json()).state,
    { timeout: 30_000 }).toBe('finished');
}

async function waitForData(page) {
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 2', { timeout: 30_000 });
}

// My Finds par l'interface, puis les logs ; la page est rechargée pour
// partir d'un démarrage où les caches posées existent déjà.
async function openWithData(page, request, { withLogs = true } = {}) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(MY_FINDS);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#filtersCounter')).toContainText('2 / 2', { timeout: 30_000 });
  if (!withLogs) return;
  await importLogs(request);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForData(page);
  await expect(page.locator('#ownerDisplayField')).toBeVisible({ timeout: 15_000 });
}

function ownerState(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getOwnerDebugState());
}

function mapCodes(page, kind) {
  return page.evaluate((wanted) => {
    const source = wanted === 'owner' ? window.ownerVectorSource : window.vectorSource;
    return (source?.getFeatures() || []).map(f => f.get('gc_code')).sort();
  }, kind);
}

async function showOwner(page) {
  await page.locator('#checkOwnerDisplay').check();
  await expect.poll(() => mapCodes(page, 'owner')).toEqual(PLACED);
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/logs/clear').catch(() => {});
});

test.afterEach(async ({ request }) => {
  await request.put('/api/settings', { data: { owner_display: false, owner_in_trail: true } }).catch(() => {});
  await request.post('/api/logs/clear').catch(() => {});
  await request.post('/clear_database').catch(() => {});
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).owner_display).toBe(false);
});


test('sans cache posée, rien n\'est proposé', async ({ page, request }) => {
  await openWithData(page, request, { withLogs: false });
  await expect(page.locator('#ownerDisplayField')).toBeHidden();
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabPoints"]').click();
  await expect(page.locator('#pointsOwner')).toBeHidden();
  await page.locator('a[href="#tabFlash"]').click();
  await expect(page.locator('#flashOwner')).toBeHidden();
});


test('masquées par défaut, affichées à la demande, grisées et jamais comptées', async ({ page, request }) => {
  await openWithData(page, request);
  await expect(page.locator('#checkOwnerDisplay')).not.toBeChecked();
  await expect(page.locator('#checkOwnerInTrail')).toBeDisabled();
  expect(await mapCodes(page, 'owner')).toEqual([]);

  await showOwner(page);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 2');
  expect(await mapCodes(page, 'find')).toEqual(['GC5AAA1', 'GC5AAA2']);
  await expect(page.locator('#ownerDisplayHint')).toContainText('7 caches posées dans la sélection');
  await expect(page.locator('#ownerDisplayHint')).toContainText('1 cache sans position connue');
  await expect(page.locator('#checkOwnerInTrail')).toBeEnabled();
  // Au repos : état actuel (archivées grisées, les autres actives).
  const { states } = await ownerState(page);
  expect(states).toMatchObject({ GCP0004: 0, GCP0005: 2, GCP0006: 2, GCP0008: 0 });
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).owner_display).toBe(true);

  // Réglages du thème proposés.
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabPoints"]').click();
  await expect(page.locator('#pointsOwner')).toBeVisible();
  await expect(page.locator('#selectOwnerShape')).toHaveValue('star');
  await page.locator('a[href="#data"]').click();

  await page.locator('#checkOwnerDisplay').uncheck();
  await expect.poll(() => mapCodes(page, 'owner')).toEqual([]);
  expect(await mapCodes(page, 'find')).toEqual(['GC5AAA1', 'GC5AAA2']);
});


test('dans le temps : apparition à la publication, désactivation, archivage', async ({ page, request }) => {
  await openWithData(page, request);
  await showOwner(page);
  // Départ avant toutes les publications (la plage par défaut commence à la
  // première trouvaille, le 01/05/2019).
  expect(await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateStart = new Date(2019, 0, 1);
    return app.startPausedPreview();
  })).toBe(true);
  const seek = (y, m, d) => page.evaluate(async ([yy, mm, dd]) =>
    (await import('/static/js/index.js')).seekAnimationToDate(new Date(yy, mm, dd)), [y, m, d]);

  expect(await seek(2019, 4, 1)).toBe(true);          // publication de GCP0004
  expect(await mapCodes(page, 'owner')).toEqual(['GCP0001', 'GCP0002', 'GCP0003', 'GCP0004', 'GCP0005', 'GCP0006']);
  // GCP0006 : archivée d'après son statut à l'export (31/12/2020), active ici.
  expect((await ownerState(page)).states).toMatchObject({ GCP0004: 0, GCP0005: 0, GCP0006: 0 });
  await seek(2019, 8, 5);                             // seconde désactivation
  expect((await ownerState(page)).states.GCP0004).toBe(1);
  await seek(2019, 8, 10);                            // maintenance + réactivation
  expect((await ownerState(page)).states.GCP0004).toBe(0);
  await seek(2019, 9, 5);                             // archivée par son poseur
  expect((await ownerState(page)).states.GCP0005).toBe(2);
  await seek(2019, 9, 25);                            // désarchivée (relecteur)
  expect((await ownerState(page)).states.GCP0005).toBe(0);
  await seek(2020, 2, 1);                             // GCP0008 publiée le 10/02
  expect(await mapCodes(page, 'owner')).toEqual(PLACED);
  await seek(2019, 3, 1);                             // retour avant GCP0004
  expect(await mapCodes(page, 'owner')).not.toContain('GCP0004');
  await page.locator('#btnQuickStop').click();
});


async function previewOwnerFlashes(page) {
  const before = (await ownerState(page)).flashes.length;
  await page.locator('#btnQuickPreview').click();
  const state = () => page.evaluate(async () => (await import('/static/js/index.js')).previewPlaybackState());
  await expect.poll(state, { timeout: 30_000 }).toBe('playing');
  await expect.poll(state, { timeout: 60_000 }).toBe('idle');
  return (await ownerState(page)).flashes.slice(before);
}

async function setRhythm(page, daysPerSecond) {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#animationConfigTab').click();
  await page.locator('#inputDaysPerSecond').fill(String(daysPerSecond));
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('a[href="#data"]').click();
}

test('les étapes du poseur jouent leurs flashs propres, le plus marquant l\'emporte', async ({ page, request }) => {
  await openWithData(page, request);
  await showOwner(page);
  await setRhythm(page, 60);
  const flashes = await previewOwnerFlashes(page);
  // Pose de GCP0004 et GCP0008, désactivations / réactivations de GCP0004,
  // archivage de GCP0005 par son poseur. Le 10/09/2019, la réactivation
  // l'emporte sur la maintenance ; le désarchivage et le réarchivage du
  // relecteur ne flashent pas.
  expect(flashes).toEqual(expect.arrayContaining(['place', 'disable', 'enable', 'archive']));
  expect(flashes).not.toContain('maintenance');
  expect(flashes.filter((kind) => kind === 'archive')).toHaveLength(1);
  expect(flashes.filter((kind) => kind === 'place')).toHaveLength(2);

  // Réactivation sans flash : la maintenance du 10/09 joue à sa place.
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabFlash"]').click();
  const enableMode = page.locator('[data-event-flash-group="owner"][data-event-flash-kind="enable"] [data-event-flash-field="mode"]');
  await expect(enableMode).toBeVisible();
  await enableMode.selectOption('none');
  await page.locator('a[href="#data"]').click();
  const again = await previewOwnerFlashes(page);
  expect(again).toContain('maintenance');
  expect(again).not.toContain('enable');
  // Remise du rythme par défaut des autres specs (préférence globale).
  await setRhythm(page, 20);
});


test('pose et entretien sont des étapes du trait de déplacement, sauf choix contraire', async ({ page, request }) => {
  await openWithData(page, request);
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTrail"]').click();
  await expect(page.locator('#selectTrailRouting')).toBeEnabled();
  await page.locator('#switchTrail').check();
  await page.locator('#selectTrailRouting').evaluate((select) => {
    select.value = 'all';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('a[href="#data"]').click();

  const stops = async () => {
    await page.locator('#btnQuickPreview').click();
    await expect.poll(async () => (await page.evaluate(async () =>
      (await import('/static/js/index.js')).getTravelTrailDebugState())).stops).toBeGreaterThan(0);
    const { stops: count } = await page.evaluate(async () =>
      (await import('/static/js/index.js')).getTravelTrailDebugState());
    await page.locator('#btnQuickStop').click();
    await expect(page.locator('#btnQuickPreview')).toBeVisible();
    return count;
  };
  const findsOnly = await stops();
  await showOwner(page);
  const withOwner = await stops();
  expect(withOwner).toBeGreaterThan(findsOnly);
  await page.locator('#checkOwnerInTrail').uncheck();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).owner_in_trail).toBe(false);
  expect(await stops()).toBe(findsOnly);
});


// Le compte « sans position » du hint ouvre la modale de complétion
// (pendingCoordsLink, gc_logs.js) — même modal que la carte « Mes logs ».
test('le compte sans position du hint ouvre la modale de complétion', async ({ page, request }) => {
  await openWithData(page, request);
  await showOwner(page);
  const link = page.locator('#ownerDisplayHint button');
  await expect(link).toHaveText('1 cache sans position connue');
  await link.click();
  await expect(page.locator('#gcLogsCoordsModal')).toBeVisible();
  await expect(page.locator('#gcLogsCoordsList')).toContainText('GCP0007', { timeout: 15_000 });
  await page.locator('#gcLogsCoordsClose').click();
});


// « Période de découverte » déplacée : une cache posée reste sur la carte
// pour toujours — reculer le début de la fenêtre ne la retire pas
// (aliveInWindow, bdd.js ; avant, le filtre sur date_find la vidait).
test('période de découverte : les poses antérieures au début restent affichées', async ({ page, request }) => {
  await openWithData(page, request);
  await showOwner(page);
  // Toutes les poses sont de 2018-2020 : début de fenêtre reculé en 2021,
  // les 7 caches restent « en vie » dans la fenêtre (aucune fin déplacée).
  await page.locator('#datePickerStart').evaluate((el) => {
    el.value = '01/01/2021';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#ownerDisplayHint')).toContainText('7 caches posées dans la sélection');
  await expect.poll(() => mapCodes(page, 'owner')).toEqual(PLACED);
});


test('en mode icônes, un anneau entoure l\'icône des caches posées', async ({ page, request }) => {
  await openWithData(page, request);
  await showOwner(page);
  expect((await ownerState(page)).ring).toBe(false);
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabPoints"]').click();
  await page.locator('#labelPointModeIcone').click();
  await expect.poll(async () => (await ownerState(page)).ring).toBe(true);
  expect(await mapCodes(page, 'owner')).toEqual(PLACED);
  // Épaisseur nulle : plus d'anneau.
  await page.locator('#inputOwnerBorderWidth').fill('0');
  await page.locator('#inputOwnerBorderWidth').dispatchEvent('change');
  await expect.poll(async () => (await ownerState(page)).ring).toBe(false);
  expect(await mapCodes(page, 'owner')).toEqual(PLACED);
});
