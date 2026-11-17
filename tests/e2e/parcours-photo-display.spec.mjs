// Page Parcours, lot 9 : affichage des photos dans la lecture ; lot 10 :
// lieux proposés pour les photos hors étapes (MyGCFlow_Plan_Parcours.md
// § 14, docs/parcours.md). Préférence globale `parcours_photo_display`,
// remise par cleanUp (parcours-helpers.mjs). Fixtures de
// tests/e2e/fixtures/parcours-photos/ : telephone.jpg se rattache seule à
// GCPAR01 ; appareil.jpg est rattachée à la main à GCPAR04 (jour 2) ;
// belvedere.jpg et belvedere-2.jpg, à 30 m l'une de l'autre et à ~1,5 km de
// GCPAR02, le 12/07 à 14:30 et 14:35 (photo_bytes de test_parcours_photos.py).
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHOTO_DISPLAY_DEFAULTS,
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

async function savedDisplay(request) {
  return (await (await request.get('/api/settings')).json()).parcours_photo_display;
}

// Deux photos : téléphone sur GCPAR01 (jour 1), appareil sur GCPAR04 (jour 2).
async function withTwoPhotos(page, request) {
  const parcours = await createWeekend(request);
  await openReady(page);
  await page.locator('a[href="#photos"]').click();
  await page.locator('#parcoursPhotoInput').setInputFiles(
    ['telephone.jpg', 'appareil.jpg'].map((name) => path.join(PHOTOS, name)));
  await expect.poll(async () => (await snapshot(page)).photos.length, { timeout: 30_000 }).toBe(2);
  const { photos } = await (await request.get(`/api/parcours/${parcours.id}/inputs`)).json();
  const ids = Object.fromEntries(photos.map((p) => [p.name, p.id]));
  await request.patch(`/api/parcours/${parcours.id}/photos/${ids['appareil.jpg']}`,
    { data: { stopKey: 'GCPAR04', caption: 'Au bord du lac' } });
  await openReady(page);
  await page.locator('a[href="#photos"]').click();
  await expect.poll(async () => (await snapshot(page)).photosLoaded).toBe(2);
  return { parcours, phone: ids['telephone.jpg'], camera: ids['appareil.jpg'] };
}

// Ouvre l'aperçu en pause sur une photo (bouton du détail), puis attend
// qu'elle soit peinte.
async function showPhoto(page, id) {
  await page.locator(`.parcours-photo-thumb[data-photo-id="${id}"]`).click();
  await page.locator('.parcours-photo-preview').click();
  await expect.poll(async () => (await snapshot(page)).photoCards.map((c) => c.photoId))
    .toContain(id);
  return snapshot(page);
}

test('réglages : enregistrés, champs selon le placement, durée et « aucune » dans la chronologie', async ({ page, request }) => {
  const errors = collectErrors(page);
  await withTwoPhotos(page, request);
  const base = (await snapshot(page)).timeline.quanta;
  expect((await snapshot(page)).photoDisplay).toEqual(PHOTO_DISPLAY_DEFAULTS);
  await expect(page.locator('#parcoursPhotoSideRow')).toBeVisible();
  await expect(page.locator('#parcoursPhotoAnchorRow')).toBeHidden();
  await expect(page.locator('#parcoursPhotoStripEdgeRow')).toBeHidden();
  await expect(page.locator('#btnParcoursPhotoPreview')).toBeEnabled();

  await page.locator('#parcoursPhotoLayout').selectOption('fixed');
  await expect(page.locator('#parcoursPhotoAnchorRow')).toBeVisible();
  await expect(page.locator('#parcoursPhotoSideRow')).toBeHidden();
  await page.locator('#parcoursPhotoAnchor').selectOption('bottom-left');
  await page.locator('#parcoursPhotoFrame').selectOption('polaroid');
  await expect.poll(async () => savedDisplay(request))
    .toMatchObject({ layout: 'fixed', anchor: 'bottom-left', frame: 'polaroid' });

  // Durée : 2,5 s au lieu de 1,5 s → 10 quanta de plus par photo.
  await page.locator('#parcoursPhotoDuration').fill('2.5');
  await page.locator('#parcoursPhotoDuration').press('Tab');
  await expect.poll(async () => (await snapshot(page)).timeline.quanta).toBe(base + 20);
  expect((await savedDisplay(request)).duration).toBe(2.5);

  // Aucune photo : plus de temps d'écran pour elles, réglages grisés.
  await page.locator('#parcoursPhotoLayout').selectOption('none');
  await expect.poll(async () => (await snapshot(page)).photoSlots).toEqual([]);
  expect((await snapshot(page)).timeline.quanta).toBe(base - 30);
  await expect(page.locator('#parcoursPhotoFrame')).toBeDisabled();
  await expect(page.locator('#btnParcoursPhotoPreview')).toBeDisabled();

  // Relu au chargement.
  await openReady(page);
  await page.locator('a[href="#photos"]').click();
  await expect(page.locator('#parcoursPhotoLayout')).toHaveValue('none');
  await expect(page.locator('#parcoursPhotoDuration')).toHaveValue('2.5');
  expect(errors).toEqual([]);
});

test('placements : près de l’étape avec trait, emplacement fixe, bande de vignettes, légende', async ({ page, request }) => {
  const errors = collectErrors(page);
  const { phone, camera } = await withTwoPhotos(page, request);

  // Près de l'étape, trait vers l'étape, légende par gabarit.
  await page.locator('#parcoursPhotoLeader').check();
  await page.locator('#parcoursPhotoCaptionTemplate').fill('{etape} · {legende}');
  await page.locator('#parcoursPhotoCaptionTemplate').press('Tab');
  await expect.poll(async () => (await savedDisplay(request)).caption).toBe('{etape} · {legende}');
  let state = await showPhoto(page, phone);
  let [card] = state.photoCards;
  expect(card).toMatchObject({ photoId: phone, frame: 'postcard', leader: true, scale: 1 });
  expect(card.caption).toMatch(/^\S/);
  expect(card.caption).not.toContain('·');   // pas de légende propre : le nom seul

  // Emplacement fixe en bas à gauche, sans inclinaison.
  await page.locator('#parcoursPhotoLayout').selectOption('fixed');
  await page.locator('#parcoursPhotoAnchor').selectOption('bottom-left');
  await page.locator('#parcoursPhotoTilt').uncheck();
  await page.locator('#parcoursPhotoFrame').selectOption('rounded');
  await expect.poll(async () => {
    const [c] = (await snapshot(page)).photoCards;
    return c ? { frame: c.frame, rotation: c.rotation } : null;
  }).toEqual({ frame: 'rounded', rotation: 0 });
  state = await snapshot(page);
  [card] = state.photoCards;
  const view = state.photoView;
  const margin = 16 * view.ratio;
  expect(card.x - card.width / 2).toBeCloseTo(margin, 0);
  expect(card.y + card.height / 2).toBeCloseTo(view.height - margin, 0);
  expect(card.leader).toBe(true);   // le trait vaut aussi pour l'emplacement fixe

  // Bande : sur la photo du jour 2, celle du jour 1 est une vignette.
  await page.locator('#parcoursPhotoLayout').selectOption('strip');
  await page.locator('#parcoursPhotoStripEdge').selectOption('top');
  await expect.poll(async () => (await savedDisplay(request)).strip_edge).toBe('top');
  state = await showPhoto(page, camera);
  await expect.poll(async () => (await snapshot(page)).photoCards.map((c) => c.photoId)).toEqual([phone, camera]);
  state = await snapshot(page);
  const [thumb, big] = state.photoCards;
  expect(thumb.scale).toBeLessThan(0.6);
  expect(thumb.y).toBeLessThan(big.y);           // bande en haut
  expect(big.caption).toContain('Au bord du lac');
  expect(thumb.caption).toBe('');
  // Vider la bande à chaque journée : la vignette du jour 1 disparaît.
  await page.locator('#parcoursPhotoStripReset').check();
  await expect.poll(async () => (await snapshot(page)).photoCards.map((c) => c.photoId)).toEqual([camera]);
  expect(errors).toEqual([]);
});

test('pile : les photos d’une étape se posent les unes sur les autres', async ({ page, request }) => {
  const errors = collectErrors(page);
  const { parcours, phone, camera } = await withTwoPhotos(page, request);
  // Les deux photos sur GCPAR01 : celle de l'appareil passe en second.
  await request.patch(`/api/parcours/${parcours.id}/photos/${camera}`, { data: { stopKey: 'GCPAR01' } });
  await openReady(page);
  await page.locator('a[href="#photos"]').click();
  await expect.poll(async () => (await snapshot(page)).photosLoaded).toBe(2);

  // Sans pile : sur la seconde photo, la première est déjà partie.
  let state = await showPhoto(page, camera);
  expect(state.photoCards.map((c) => c.photoId)).toEqual([camera]);

  await expect(page.locator('#parcoursPhotoStackRow')).toBeVisible();
  await page.locator('#parcoursPhotoStack').check();
  await expect.poll(async () => (await savedDisplay(request)).stack).toBe(true);
  await expect.poll(async () => (await snapshot(page)).photoCards.map((c) => c.photoId)).toEqual([phone, camera]);
  state = await snapshot(page);
  const [under, top] = state.photoCards;
  expect(under.alpha).toBe(1);
  expect(under.rotation).not.toBe(top.rotation);
  // Décalées, mais l'une sur l'autre.
  expect(Math.abs(under.x - top.x)).toBeLessThan(top.width / 2);
  expect(Math.abs(under.y - top.y)).toBeLessThan(top.height / 2);

  // Pas de pile pour la bande.
  await page.locator('#parcoursPhotoLayout').selectOption('strip');
  await expect(page.locator('#parcoursPhotoStackRow')).toBeHidden();
  expect(errors).toEqual([]);
});

test('vignettes sur la carte : la photo d’une étape passée y reste en petit', async ({ page, request }) => {
  const errors = collectErrors(page);
  // Caméra fixe : tout le parcours à l'écran, les deux étapes comprises.
  expect((await request.put('/api/settings', { data: { parcours_playback: { camera: 'fixed' } } })).ok()).toBeTruthy();
  const { phone, camera } = await withTwoPhotos(page, request);
  await expect(page.locator('#parcoursPhotoPinRow')).toBeVisible();
  await expect(page.locator('#parcoursPhotoPinSizeRow')).toBeHidden();
  await page.locator('#parcoursPhotoPin').check();
  await expect(page.locator('#parcoursPhotoPinSizeRow')).toBeVisible();
  await expect.poll(async () => (await savedDisplay(request)).pin).toBe(true);

  // Sur la photo du jour 2, celle du jour 1 est une vignette près de GCPAR01.
  await showPhoto(page, camera);
  const pinOf = async () => (await snapshot(page)).photoCards.find((c) => c.photoId === phone) || null;
  await expect.poll(async () => (await pinOf())?.pinned ?? false).toBe(true);
  let state = await snapshot(page);
  let pin = state.photoCards.find((c) => c.photoId === phone);
  expect(state.photoCards.find((c) => c.photoId === camera).pinned).toBe(false);
  expect(Math.max(pin.width, pin.height)).toBeCloseTo(72 * state.photoView.ratio, 0);
  expect(pin.caption).toBe('');
  expect(pin.leader).toBe(true);

  // Taille des vignettes.
  await page.locator('#parcoursPhotoPinSize').fill('120');
  await expect.poll(async () => (await savedDisplay(request)).pin_size).toBe(120);
  await expect.poll(async () => Math.round(Math.max((await pinOf()).width, (await pinOf()).height)))
    .toBe(Math.round(120 * state.photoView.ratio));

  // Bande : réglage masqué, plus de vignette sur la carte.
  await page.locator('#parcoursPhotoLayout').selectOption('strip');
  await expect(page.locator('#parcoursPhotoPinRow')).toBeHidden();
  await expect.poll(async () => (await snapshot(page)).photoCards.some((c) => c.pinned)).toBe(false);
  expect(errors).toEqual([]);
});

test('photos hors étapes : un lieu proposé, créé d’un clic, et les photos s’y rattachent', async ({ page, request }) => {
  const errors = collectErrors(page);
  await createWeekend(request);
  await openReady(page);
  await page.locator('a[href="#photos"]').click();
  await page.locator('#parcoursPhotoInput').setInputFiles(
    ['telephone.jpg', 'belvedere.jpg', 'belvedere-2.jpg'].map((name) => path.join(PHOTOS, name)));
  await expect.poll(async () => (await snapshot(page)).photos.length, { timeout: 30_000 }).toBe(3);
  // Une seule proposition pour les deux photos du belvédère.
  await expect(page.locator('.parcours-photo-place')).toHaveCount(1);
  await expect(page.locator('#parcoursPhotoPlacesTitle')).toContainText('2');
  await expect(page.locator('.parcours-photo-place')).toContainText('14:30');
  const before = (await snapshot(page)).photoSlots.length;
  expect(before).toBe(1);   // seule la photo du téléphone est montrée

  await page.locator('.parcours-photo-place-name').fill('Belvédère');
  await page.locator('.parcours-photo-place-create').click();
  await expect.poll(async () => (await snapshot(page)).places.length).toBe(1);
  const state = await snapshot(page);
  expect(state.places[0]).toMatchObject({ kind: 'place', name: 'Belvédère', date: '2025-07-12', time: '14:30' });
  const placeKey = state.days[0].keys.find((key) => key.startsWith('place:'));
  expect(placeKey).toBeTruthy();
  const linked = state.photos.filter((p) => p.match?.key === placeKey);
  expect(linked.map((p) => p.match.source)).toEqual(['gps', 'gps']);
  expect(state.photoSlots.length).toBe(3);
  await expect(page.locator('#parcoursPhotoPlaces')).toBeHidden();
  expect(errors).toEqual([]);
});
