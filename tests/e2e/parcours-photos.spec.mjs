// Page Parcours, lot 4 : photos (MyGCFlow_Plan_Parcours.md § 8,
// docs/parcours.md) ; lot 8 : onglet Photos, réglages par photo (§ 14). Fixtures tests/e2e/fixtures/parcours-photos/ :
// - telephone.jpg : iPhone, géolocalisée à ~15 m de GCPAR01, 12/07/2025 11:20 ;
// - appareil.jpg  : Canon EOS 80D, sans GPS, 13/07/2025 08:00 (horloge fausse) ;
// - sans-exif.png : rien.
// Le runtime e2e range les photos dans son propre dossier de données ; elles
// partent avec leur parcours (cleanUp, parcours-helpers.mjs).
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanUp,
  clearLogs,
  collectErrors,
  createWeekend,
  deleteAllParcours,
  importFixture,
  openParcoursPage,
  snapshot,
} from './parcours-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS = path.join(HERE, 'fixtures', 'parcours-photos');
const files = ['telephone.jpg', 'appareil.jpg', 'sans-exif.png'].map((name) => path.join(PHOTOS, name));
const RUNTIME = process.env.MYGCFLOW_E2E_RUNTIME;

function mp4Names() {
  try {
    return readdirSync(path.join(RUNTIME, 'video')).filter((name) => name.endsWith('.mp4'));
  } catch (_) {
    return [];
  }
}

test.beforeEach(async ({ page, request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
  await importFixture(page, request);
});

test.afterEach(async ({ request }) => {
  await cleanUp(request);
});

async function openReady(page) {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
}

async function openPhotosTab(page) {
  await page.locator('a[href="#photos"]').click();
  await expect(page.locator('#photos')).toHaveClass(/active/);
}


test('photos : rattachement par position, heure comme ancre, rattachement manuel, recalage', async ({ page, request }) => {
  const errors = collectErrors(page);
  const parcours = await createWeekend(request);
  await openReady(page);
  await openPhotosTab(page);
  await expect(page.locator('#parcoursPhotosCard')).toBeVisible();
  await expect(page.locator('#parcoursPhotosEmpty')).toBeHidden();

  await page.locator('#parcoursPhotoInput').setInputFiles(files);
  await expect.poll(async () => (await snapshot(page)).photos.length, { timeout: 30_000 }).toBe(3);
  await expect(page.locator('.parcours-photo-thumb')).toHaveCount(3);
  let state = await snapshot(page);
  const { photos: listed } = await (await request.get(`/api/parcours/${parcours.id}/inputs`)).json();
  const id = (name) => listed.find((p) => p.name === name).id;

  // Téléphone géolocalisé : rattachée à GCPAR01, son heure cale l'étape.
  const phone = state.photos.find((p) => p.id === id('telephone.jpg'));
  expect(phone.match).toMatchObject({ key: 'GCPAR01', source: 'gps' });
  const day1 = state.days[0];
  expect(day1.times[day1.keys.indexOf('GCPAR01')]).toBe('11:20');
  expect(day1.reasons[day1.keys.indexOf('GCPAR01')]).toBe('photo');
  await expect(page.locator('.parcours-stop[data-stop-key="GCPAR01"]')).toContainText('1 photo');
  // Appareil sans GPS, horloge non recalée : rien ; sans EXIF : rien.
  expect(state.photos.find((p) => p.id === id('appareil.jpg')).match).toEqual({ key: null, source: null });
  expect(state.photos.find((p) => p.id === id('sans-exif.png')).match).toEqual({ key: null, source: null });
  await expect(page.locator('.parcours-camera[data-camera="Canon EOS 80D"]')).toContainText('non recalée');

  // Rattachement manuel de la photo de l'appareil à GCPAR04.
  await page.locator(`.parcours-photo-thumb[data-photo-id="${id('appareil.jpg')}"]`).click();
  await page.locator('#parcoursPhotoStop').selectOption('GCPAR04');
  await expect.poll(async () => (await snapshot(page)).photos.find((p) => p.id === id('appareil.jpg')).match)
    .toEqual({ key: 'GCPAR04', source: 'manual' });

  // GCPAR04 à 10:30 (heure épinglée) : l'horloge de l'appareil se cale dessus
  // (08:00 → 10:30, +150 min).
  await request.patch(`/api/parcours/${parcours.id}/overrides`,
    { data: { overrides: [{ key: 'GCPAR04', pinnedTime: '10:30' }] } });
  await openReady(page);
  await openPhotosTab(page);
  await page.locator(`.parcours-photo-thumb[data-photo-id="${id('appareil.jpg')}"]`).click();
  await expect(page.locator('.parcours-photo-calibrate')).toContainText('+2 h 30');
  await page.locator('.parcours-photo-calibrate').click();
  await expect.poll(async () => (await snapshot(page)).cameras).toEqual([{ camera: 'Canon EOS 80D', offsetMinutes: 150 }]);
  await expect(page.locator('.parcours-camera[data-camera="Canon EOS 80D"]')).toContainText('recalée (+2 h 30)');
  state = await snapshot(page);
  expect(state.photoStops).toEqual({ GCPAR01: [id('telephone.jpg')], GCPAR04: [id('appareil.jpg')] });

  // Supprimer la photo sans EXIF.
  await page.locator(`.parcours-photo-thumb[data-photo-id="${id('sans-exif.png')}"]`).click();
  await page.locator('.parcours-photo-delete').click();
  await expect.poll(async () => (await snapshot(page)).photos.length).toBe(2);
  expect(errors).toEqual([]);
});

test('lecture et vidéo : étapes à photos plus longues, carte postale filmée sans bloquer l’export', async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await createWeekend(request);
  await openReady(page);
  const before = (await snapshot(page)).timeline.quanta;
  await page.locator('#parcoursPhotoInput').setInputFiles(files[0]);
  await expect.poll(async () => (await snapshot(page)).photos.length, { timeout: 30_000 }).toBe(1);
  const state = await snapshot(page);
  // Une photo : 15 quanta de plus à l'écran.
  expect(state.timeline.quanta).toBe(before + 15);
  await expect.poll(async () => (await snapshot(page)).photosLoaded).toBe(1);

  expect((await request.put('/api/settings', { data: { parcours_animation: { rhythm_mode: 'rate', days_per_second: 20 } } })).ok())
    .toBeTruthy();
  await openReady(page);
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(true);
  await expect.poll(async () => (await snapshot(page)).running, { timeout: 30_000 }).toBe(false);

  // Export image par image : la photo dessinée dans le canevas (même
  // origine) ne doit pas le « contaminer » — toBlob échouerait.
  await expect.poll(async () => (await snapshot(page)).photosLoaded).toBe(1);
  await page.locator('a[href="#animation"]').click();
  await page.locator('#recordingConfigTab').click();
  await page.locator('#selectRecordMode').selectOption('images');
  await page.locator('#selectRecordResolution').selectOption('window');
  await page.evaluate(async () => {
    (await import('/static/js/index.js')).options.record.fps = 12;
  });
  const existing = new Set(mp4Names());
  await page.locator('#btnQuickExport').click({ force: true });
  await expect(page.locator('#modal_video_ready')).toBeVisible({ timeout: 120_000 });
  let created = [];
  await expect.poll(() => (created = mp4Names().filter((name) => !existing.has(name))).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  for (const name of created) rmSync(path.join(RUNTIME, 'video', name), { force: true });
  expect(errors).toEqual([]);
});

test('affichage par photo : masquée (reste une ancre), légende, cadrage enregistrés', async ({ page, request }) => {
  const errors = collectErrors(page);
  const parcours = await createWeekend(request);
  await openReady(page);
  const before = (await snapshot(page)).timeline.quanta;
  await openPhotosTab(page);
  await page.locator('#parcoursPhotoInput').setInputFiles(files[0]);
  await expect.poll(async () => (await snapshot(page)).photos.length, { timeout: 30_000 }).toBe(1);
  const [{ id }] = (await snapshot(page)).photos;
  expect((await snapshot(page)).timeline.quanta).toBe(before + 15);
  await page.locator(`.parcours-photo-thumb[data-photo-id="${id}"]`).click();
  await expect(page.locator('#parcoursPhotoDetail')).toBeVisible();
  await expect(page.locator('#parcoursPhotoShown')).toBeChecked();
  await expect(page.locator('#parcoursPhotoCropPicker')).toHaveClass(/is-full/);

  // Masquée : plus de temps d'écran, mais toujours rattachée et ancre.
  await page.locator('#parcoursPhotoShown').uncheck();
  await expect.poll(async () => (await snapshot(page)).photoStops).toEqual({});
  let state = await snapshot(page);
  expect(state.timeline.quanta).toBe(before);
  expect(state.photos[0]).toMatchObject({ hidden: true, match: { key: 'GCPAR01', source: 'gps' } });
  expect(state.days[0].reasons[state.days[0].keys.indexOf('GCPAR01')]).toBe('photo');
  await expect(page.locator('.parcours-photo-thumb.is-hidden')).toHaveCount(1);

  // Légende, cadrage carré, zoom, point focal au clavier.
  await page.locator('#parcoursPhotoCaption').fill('Vue sur le lac');
  await page.locator('#parcoursPhotoCaption').press('Tab');
  await expect.poll(async () => (await snapshot(page)).photos[0].caption).toBe('Vue sur le lac');
  await page.locator('#parcoursPhotoAspect').selectOption('1:1');
  await expect.poll(async () => (await snapshot(page)).photos[0].crop.aspect).toBe('1:1');
  await expect(page.locator('#parcoursPhotoCropPicker')).not.toHaveClass(/is-full/);
  await page.locator('#parcoursPhotoZoom').fill('150');
  await expect.poll(async () => (await snapshot(page)).photos[0].crop.zoom).toBe(150);
  await page.locator('#parcoursPhotoCropPicker').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await snapshot(page)).photos[0].crop.focusX).toBe(60);

  // Enregistré côté serveur : relu après rechargement.
  const { photos } = await (await request.get(`/api/parcours/${parcours.id}/inputs`)).json();
  expect(photos[0]).toMatchObject({ hidden: true, caption: 'Vue sur le lac', aspect: '1:1', zoom: 150, focusX: 60, focusY: 50 });
  await openReady(page);
  await openPhotosTab(page);
  await page.locator(`.parcours-photo-thumb[data-photo-id="${id}"]`).click();
  await expect(page.locator('#parcoursPhotoShown')).not.toBeChecked();
  await expect(page.locator('#parcoursPhotoCaption')).toHaveValue('Vue sur le lac');
  await expect(page.locator('#parcoursPhotoAspect')).toHaveValue('1:1');

  // De nouveau montrée : le temps d'écran revient.
  await page.locator('#parcoursPhotoShown').check();
  await expect.poll(async () => (await snapshot(page)).timeline.quanta).toBe(before + 15);
  expect(errors).toEqual([]);
});

test('envoi de photos : un autre parcours ouvert entre-temps ne détourne pas la suite', async ({ page, request }) => {
  const errors = collectErrors(page);
  const a = await createWeekend(request);
  const created = await request.post('/api/parcours',
    { data: { name: 'Journée', date_start: '2025-07-12', date_end: '2025-07-12' } });
  expect(created.status()).toBe(201);
  const b = (await created.json()).parcours;
  await openReady(page);
  // Le week-end (plage la plus large) est en tête de liste et ouvert.
  await expect.poll(async () => (await snapshot(page)).selectedId).toBe(a.id);

  // Le premier envoi est suspendu dans le navigateur, le temps d'ouvrir
  // l'autre parcours.
  const urls = [];
  let held = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/parcours/*/photos', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    urls.push(route.request().url());
    if (held) await gate;
    await route.continue();
  });
  await openPhotosTab(page);
  await page.locator('#parcoursPhotoInput').setInputFiles([files[0], files[1]]);
  await expect.poll(() => urls.length, { timeout: 15_000 }).toBe(1);
  expect(urls[0]).toContain(`/parcours/${a.id}/photos`);

  // La liste est dans l'onglet Données : retour dessus pour en changer.
  await page.locator('a[href="#data"]').click();
  await page.locator(`.parcours-list-item[data-parcours-id="${b.id}"] .parcours-open`).click();
  await expect.poll(async () => (await snapshot(page)).selectedId).toBe(b.id);

  held = false;
  release();
  await expect.poll(() => urls.length, { timeout: 30_000 }).toBe(2);
  // La suite a continué vers le premier parcours : les deux photos y sont.
  expect(urls.every((url) => url.includes(`/parcours/${a.id}/photos`))).toBe(true);
  await expect.poll(async () => (await request.get(`/api/parcours/${a.id}/inputs`)).json()
    .then((body) => body.photos.length), { timeout: 30_000 }).toBe(2);
  const { photos: photosB } = await (await request.get(`/api/parcours/${b.id}/inputs`)).json();
  expect(photosB.length).toBe(0);
  expect(errors).toEqual([]);
});

// Dépose des fichiers sur la page, comme depuis l'explorateur.
async function dropFiles(page, paths) {
  const list = paths.map((p) => ({ name: path.basename(p), bytes: [...readFileSync(p)] }));
  const dataTransfer = await page.evaluateHandle((items) => {
    const dt = new DataTransfer();
    for (const { name, bytes } of items) dt.items.add(new File([new Uint8Array(bytes)], name));
    return dt;
  }, list);
  await page.dispatchEvent('body', 'dragenter', { dataTransfer });
  await expect(page.locator('#parcoursDropOverlay')).toHaveClass(/is-visible/);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

test('glisser-déposer : photos et traces rejoignent le parcours ouvert, le reste est signalé', async ({ page, request }) => {
  const errors = collectErrors(page);
  await createWeekend(request);
  await openReady(page);
  // Depuis un autre onglet : le dépôt de photos ouvre l'onglet Photos.
  await page.locator('a[href="#style"]').click();
  const notes = path.join(HERE, 'fixtures', 'evolution-share.csv');
  await dropFiles(page, [files[0], files[1], path.join(HERE, 'fixtures', 'parcours-trace.gpx'), notes]);
  await expect(page.locator('#parcoursDropOverlay')).not.toHaveClass(/is-visible/);
  await expect(page.locator('#photos')).toHaveClass(/active/);
  await expect.poll(async () => (await snapshot(page)).photos.length, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => (await snapshot(page)).tracks.length, { timeout: 30_000 }).toBe(1);
  await expect(page.locator('.gcm-toast.show')).toContainText('evolution-share.csv');
  expect(errors).toEqual([]);
});

test('photos refusées : un toast regroupe les fichiers par cause', async ({ page, request }) => {
  const errors = collectErrors(page);
  await createWeekend(request);
  await openReady(page);
  await openPhotosTab(page);
  // Cinq fichiers refusés pour la même raison : trois noms + « et 2 autres ».
  const bad = Buffer.from('pas une image');
  const fake = Array.from({ length: 5 }, (_, i) => ({ name: `faux-${i}.jpg`, mimeType: 'image/jpeg', buffer: bad }));
  await page.locator('#parcoursPhotoInput').setInputFiles(fake);
  const toast = page.locator('.gcm-toast.show').last();
  await expect(toast).toContainText('faux-0.jpg');
  await expect(toast).toContainText('et 2 autres');
  await expect(toast).toContainText('pas une image lisible');
  expect(errors).toEqual([]);
});

test('enregistrement : une photo encore en chargement est attendue', async ({ page, request }) => {
  const errors = collectErrors(page);
  await createWeekend(request);
  await openReady(page);
  await openPhotosTab(page);
  await page.locator('#parcoursPhotoInput').setInputFiles([files[0]]);
  await expect.poll(async () => (await snapshot(page)).photos.length, { timeout: 30_000 }).toBe(1);

  // Rechargée, la page doit refaire ses images : leur réponse est retardée,
  // comme sur une connexion lente.
  await page.route('**/api/parcours/*/photos/*/file', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });
  await page.reload();
  await expect.poll(async () => (await snapshot(page)).status, { timeout: 30_000 }).toBe('ready');

  // parcoursPhotosReady (attendue avant le départ d'un enregistrement) ne
  // résout pas tant que la photo n'est pas décodée.
  const started = Date.now();
  const ready = await page.evaluate(() => window.parcoursPhotosReady());
  expect(ready).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect((await snapshot(page)).photosLoaded).toBe(1);
  expect(errors).toEqual([]);
});
