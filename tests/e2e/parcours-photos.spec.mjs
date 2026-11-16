// Page Parcours, lot 4 : photos (MyGCFlow_Plan_Parcours.md § 8,
// docs/parcours.md). Fixtures tests/e2e/fixtures/parcours-photos/ :
// - telephone.jpg : iPhone, géolocalisée à ~15 m de GCPAR01, 12/07/2025 11:20 ;
// - appareil.jpg  : Canon EOS 80D, sans GPS, 13/07/2025 08:00 (horloge fausse) ;
// - sans-exif.png : rien.
// Le runtime e2e range les photos dans son propre dossier de données ; elles
// partent avec leur parcours (cleanUp, parcours-helpers.mjs).
import { expect, test } from '@playwright/test';
import { readdirSync, rmSync } from 'node:fs';
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


test('photos : rattachement par position, heure comme ancre, rattachement manuel, recalage', async ({ page, request }) => {
  const errors = collectErrors(page);
  const parcours = await createWeekend(request);
  await openReady(page);
  await expect(page.locator('#parcoursPhotosCard')).toBeVisible();

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
