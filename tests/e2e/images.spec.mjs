// Images posées sur la carte (onglet Images) : envoi, affichage, contournement
// par les piles de stats, rendu vidéo identique à l'aperçu.
//
// `images` et `stats` sont des préférences globales partagées par tous les
// specs d'un run : chaque test les remet à vide en sortant.
//
// Fixtures : logo-opaque.png (240 × 120, opaque → stocké en JPEG),
// avatar-transparent.png (200 × 200, disque sur fond transparent → PNG).
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
const LOGO = path.join(HERE, 'fixtures', 'logo-opaque.png');
const AVATAR = path.join(HERE, 'fixtures', 'avatar-transparent.png');

async function putSettings(page, data) {
  const response = await page.request.put('/api/settings', { data });
  expect(response.ok()).toBe(true);
}

async function upload(page, file) {
  const response = await page.request.post('/api/images', {
    multipart: { image: { name: path.basename(file), mimeType: 'image/png', buffer: fs.readFileSync(file) } },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function openWithFixture(page, hash = '') {
  await page.goto(`/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6');
}

// Rect d'un élément dans le repère de #mapWithFrames.
async function boxIn(page, selector) {
  return page.evaluate((sel) => {
    const host = document.getElementById('mapWithFrames').getBoundingClientRect();
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left - host.left, y: r.top - host.top, width: r.width, height: r.height,
      right: host.right - r.right, bottom: host.bottom - r.bottom };
  }, selector);
}

test.afterEach(async ({ page }) => {
  await putSettings(page, {
    images: { enabled: true, items: [] },
    stats: { enabled: true, panels: [], evolution_panels: [] },
  });
});

test('l’envoi normalise : PNG transparent gardé, opaque converti en JPEG, même image stockée une fois', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const avatar = await upload(page, AVATAR);
  expect(avatar.file).toMatch(/^[0-9a-f]{16}\.png$/);
  expect([avatar.width, avatar.height]).toEqual([200, 200]);
  const logo = await upload(page, LOGO);
  expect(logo.file).toMatch(/^[0-9a-f]{16}\.jpg$/);
  expect((await upload(page, LOGO)).file).toBe(logo.file);
  const served = await page.request.get(`/api/images/${logo.file}`);
  expect(served.headers()['content-type']).toBe('image/jpeg');
  const refused = await page.request.post('/api/images', {
    multipart: { image: { name: 'faux.png', mimeType: 'image/png', buffer: Buffer.from('pas une image') } },
  });
  expect(refused.status()).toBe(400);
});

test('une image s’affiche à son emplacement, hauteur d’après ses proportions', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0001', file: logo.file, name: 'Logo du club', position: { anchor: 'bottom-right', width: 160 } },
  ] } });
  await openWithFixture(page);
  const canvas = page.locator('canvas.image-panel[data-image-id="babe0001"]');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('aria-label', 'Logo du club');
  await expect.poll(async () => {
    const b = await boxIn(page, 'canvas.image-panel');
    return [Math.round(b.right), Math.round(b.bottom), Math.round(b.width), Math.round(b.height)];
  }).toEqual([16, 16, 160, 80]);
});

test('une pile de stats contourne l’image du même coin', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const logo = await upload(page, LOGO);
  await putSettings(page, {
    images: { items: [{ id: 'babe0002', file: logo.file, position: { anchor: 'bottom-right', width: 200 } }] },
    stats: { enabled: true, panels: [
      { id: 'babe1001', kind: 'counter', metric: 'summary', position: { anchor: 'bottom-right' } },
    ] },
  });
  await openWithFixture(page);
  await expect(page.locator('canvas.image-panel')).toBeVisible();
  await expect(page.locator('canvas.stats-panel')).toBeVisible();
  await expect.poll(async () => {
    const image = await boxIn(page, 'canvas.image-panel');
    const panel = await boxIn(page, 'canvas.stats-panel');
    return panel.y + panel.height <= image.y - 7.5;
  }).toBe(true);
});

test('la vidéo dessine l’image à sa place de l’aperçu', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0003', file: logo.file, position: { anchor: 'top-left', dx: 40, dy: 120, width: 180 },
      style: { shape: 'rect', shadow: false } },
  ] } });
  await openWithFixture(page);
  await expect(page.locator('canvas.image-panel')).toBeVisible();
  const boxes = await page.evaluate(async () => {
    const m = await import('/static/js/index.js');
    await m.imagesReady();
    const host = document.getElementById('mapWithFrames').getBoundingClientRect();
    const r = document.querySelector('canvas.image-panel').getBoundingClientRect();
    const scale = 2;
    const W = Math.round(host.width * scale);
    const H = Math.round(host.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    m.addImagePanelsToCanvas(ctx, W, H, scale);
    const data = ctx.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] <= 150) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    return {
      dom: { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height },
      video: { x: x0 / scale, y: y0 / scale, w: (x1 - x0 + 1) / scale, h: (y1 - y0 + 1) / scale },
    };
  });
  for (const k of ['x', 'y', 'w', 'h']) {
    expect(Math.abs(boxes.dom[k] - boxes.video[k]), `${k} (aperçu ${boxes.dom[k]}, vidéo ${boxes.video[k]})`).toBeLessThan(2);
  }
});

test('un fichier absent ou une image désactivée ne s’affichent pas', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const avatar = await upload(page, AVATAR);
  await putSettings(page, { images: { items: [
    { id: 'babe0004', file: 'ffffffffffffffff.png' },
    { id: 'babe0005', file: avatar.file, enabled: false },
    { id: 'babe0006', file: avatar.file, position: { anchor: 'top-right' }, style: { shape: 'circle' } },
  ] } });
  await openWithFixture(page);
  await expect(page.locator('canvas.image-panel')).toHaveCount(1);
  await expect(page.locator('canvas.image-panel')).toHaveAttribute('data-image-id', 'babe0006');
  const snapshot = await page.evaluate(async () => (await import('/static/js/index.js')).getImagesSnapshot());
  expect(snapshot.items.find((i) => i.id === 'babe0004').state).toBe('failed');
  // Rond : carré.
  const b = await boxIn(page, 'canvas.image-panel');
  expect(Math.round(b.width)).toBe(Math.round(b.height));
});

// ---------------------------------------------------------------------------
// Onglet Images
// ---------------------------------------------------------------------------

async function savedImages(page) {
  return (await (await page.request.get('/api/settings')).json()).images;
}

async function openImagesTab(page) {
  await openWithFixture(page, '#images');
  await page.locator('a[href="#images"]').click();
  await expect(page.locator('#images')).toBeVisible();
}

test('onglet : ajout d’un fichier, réglages, suppression annulable', async ({ page }) => {
  await openImagesTab(page);
  await expect(page.locator('#imagesEmpty')).toBeVisible();
  await page.locator('#imagesFileInput').setInputFiles(LOGO);
  const rows = page.locator('#imagesList li');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('logo-opaque');
  await expect(page.locator('canvas.image-panel')).toBeVisible();
  await expect.poll(async () => (await savedImages(page)).items.length).toBe(1);
  await expect(page.locator('#inputImageName')).toHaveValue('logo-opaque');

  // Emplacement et largeur : appliqués à la carte et enregistrés.
  await page.locator('label[for="imageAnchor-bottom-left"]').click();
  await page.locator('#inputImageWidth').fill('100');
  await page.locator('#inputImageWidth').press('Tab');
  await expect.poll(async () => (await savedImages(page)).items[0].position)
    .toMatchObject({ anchor: 'bottom-left', width: 100 });
  await expect.poll(async () => {
    const b = await boxIn(page, 'canvas.image-panel');
    return [Math.round(b.x), Math.round(b.bottom), Math.round(b.width), Math.round(b.height)];
  }).toEqual([16, 16, 100, 50]);
  // Centre de colonne : marge horizontale grisée.
  await page.locator('label[for="imageAnchor-bottom-center"]').click();
  await expect(page.locator('#inputImageDx')).toBeDisabled();

  // Forme ronde : carrée, rayon des coins sans objet.
  await page.locator('#selectImageShape').selectOption('circle');
  await expect.poll(async () => (await savedImages(page)).items[0].style.shape).toBe('circle');
  await expect(page.locator('#inputImageRadius')).toBeDisabled();
  await expect.poll(async () => {
    const b = await boxIn(page, 'canvas.image-panel');
    return Math.round(b.width) === Math.round(b.height);
  }).toBe(true);

  // Interrupteur de la ligne : masquée sur la carte, gardée dans la liste.
  await rows.first().locator('[data-action="toggle"]').uncheck();
  await expect(page.locator('canvas.image-panel')).toHaveCount(0);
  await rows.first().locator('[data-action="toggle"]').check();
  await expect(page.locator('canvas.image-panel')).toHaveCount(1);

  // Suppression, puis « Annuler ».
  await rows.first().locator('[data-action="delete"]').click();
  await expect(rows).toHaveCount(0);
  await expect.poll(async () => (await savedImages(page)).items.length).toBe(0);
  const toast = page.locator('.gcm-toast.show').filter({ hasText: 'supprimée' });
  await toast.locator('.gcm-toast-action').filter({ hasText: 'Annuler' }).click();
  await expect(rows).toHaveCount(1);
  await expect.poll(async () => (await savedImages(page)).items.length).toBe(1);
});

test('onglet : bibliothèque des images envoyées et limite de quatre', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const avatar = await upload(page, AVATAR);
  await openImagesTab(page);
  for (let n = 1; n <= 4; n++) {
    await page.locator('#btnImagesLibrary').click();
    const pick = page.locator(`#imagesLibraryList [data-library-file="${avatar.file}"]`);
    await expect(pick).toBeVisible();
    await pick.click();
    await expect(page.locator('#imagesList li')).toHaveCount(n);
  }
  await expect(page.locator('#imagesList li').first()).toContainText('Image 1');
  await expect(page.locator('#btnImagesAdd')).toBeDisabled();
  await expect(page.locator('#imagesLimitHint')).toBeVisible();
  await page.locator('#btnImagesLibrary').click();
  await expect(page.locator(`#imagesLibraryList [data-library-file="${avatar.file}"]`)).toBeDisabled();
  // Utilisée : pas de bouton de retrait de la bibliothèque.
  await expect(page.locator(`#imagesLibraryList [data-library-delete="${avatar.file}"]`)).toHaveCount(0);
  await expect.poll(async () => (await savedImages(page)).items.length).toBe(4);
});

test('onglet : un fichier refusé est expliqué, une image manquante signalée', async ({ page }) => {
  await putSettings(page, { images: { items: [{ id: 'babe0007', file: 'ffffffffffffffff.png', name: 'Ancien logo' }] } });
  await openImagesTab(page);
  const row = page.locator('#imagesList li');
  await expect(row).toContainText('Ancien logo');
  await expect(row).toContainText('(manquante)');
  await expect(page.locator('#imageMissingHint')).toBeVisible();

  await page.locator('#imagesFileInput').setInputFiles({
    name: 'faux.png', mimeType: 'image/png', buffer: Buffer.from('pas une image'),
  });
  await expect(page.locator('.gcm-toast.show').filter({ hasText: "n'est pas une image lisible" })).toBeVisible();
  await expect(row).toHaveCount(1);
});

test('glisser une image : aimantée près d’un emplacement, libre ailleurs, poignées sur les bords mobiles', async ({ page }) => {
  // Pas de page ouverte avant openImagesTab : '/' puis '/#images' ne serait
  // qu'un changement d'ancre, sans recharger les réglages posés entre-temps.
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0010', file: logo.file, position: { anchor: 'bottom-right', width: 160 } },
  ] } });
  await openImagesTab(page);
  const canvas = page.locator('canvas.image-panel');
  await expect(canvas).toBeVisible();
  await expect(page.locator('#mapWithFrames')).toHaveClass(/images-editing/);
  await expect(canvas).toHaveClass(/is-selected/);
  const ghost = page.locator('#mapWithFrames > .image-snap-ghost');
  const host = await page.locator('#mapWithFrames').boundingBox();
  const grabAndMove = async (left, top) => {
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(host.x + left + box.width / 2, host.y + top + box.height / 2, { steps: 10 });
  };

  // Vers l'emplacement en bas à gauche (à ~20 px) : repère, puis ancrage.
  const targets = await page.evaluate(async () =>
    (await import('/static/js/index.js')).getImageSnapTargets('babe0010'));
  const target = targets.find((t) => t.anchor === 'bottom-left');
  expect(target).toBeTruthy();
  await grabAndMove(target.x + 15, target.y - 12);
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('data-anchor', 'bottom-left');
  await page.mouse.up();
  await expect(ghost).toBeHidden();
  await expect.poll(async () => (await savedImages(page)).items[0].position)
    .toMatchObject({ mode: 'anchor', anchor: 'bottom-left' });
  await expect(page.locator('#imageAnchor-bottom-left')).toBeChecked();

  // Au milieu de la carte : position libre.
  const box = await canvas.boundingBox();
  await grabAndMove((host.width - box.width) / 2, (host.height - box.height) / 2);
  await expect(ghost).toBeHidden();
  await page.mouse.up();
  await expect.poll(async () => (await savedImages(page)).items[0].position.mode).toBe('free');
  await expect(page.locator('#imageFreeHint')).toBeVisible();

  // Ancrée en bas à droite : la poignée de largeur est le bord GAUCHE, le
  // bord droit ne bouge pas.
  await page.locator('label[for="imageAnchor-bottom-right"]').click();
  await expect.poll(async () => (await savedImages(page)).items[0].position.anchor).toBe('bottom-right');
  const before = await canvas.boundingBox();
  const midY = before.y + before.height / 2;
  await page.mouse.move(before.x + 4, midY);
  await expect(canvas).toHaveCSS('cursor', 'ew-resize');
  await page.mouse.down();
  await page.mouse.move(before.x + 4 - 60, midY, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await savedImages(page)).items[0].position.width).toBeGreaterThanOrEqual(215);
  const after = await canvas.boundingBox();
  expect(Math.abs((after.x + after.width) - (before.x + before.width))).toBeLessThan(2);
});
