// Images posées sur la carte (onglet Images) : envoi, affichage, contournement
// par les piles de stats, rendu vidéo identique à l'aperçu.
//
// `images` et `stats` sont des préférences globales partagées par tous les
// specs d'un run : chaque test les remet à vide en sortant.
//
// Fixtures : logo-opaque.png (240 × 120, opaque → stocké en JPEG),
// avatar-transparent.png (200 × 200, disque sur fond transparent → PNG),
// blason.svg (viewBox 200 × 100, rastérisé en PNG dans le navigateur).
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
const LOGO = path.join(HERE, 'fixtures', 'logo-opaque.png');
const AVATAR = path.join(HERE, 'fixtures', 'avatar-transparent.png');
const BLASON = path.join(HERE, 'fixtures', 'blason.svg');

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
  // « En échec » seulement après les nouvelles tentatives (~2,5 s).
  await expect.poll(async () => (await page.evaluate(async () =>
    (await import('/static/js/index.js')).getImagesSnapshot())).items.find((i) => i.id === 'babe0004').state)
    .toBe('failed');
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
  // Image chargée, ancrée : ni « manquante » ni « position libre » (ces
  // aides restaient affichées quand `d-block` l'emportait sur `hidden`).
  await expect(page.locator('#imageMissingHint')).toBeHidden();
  await expect(page.locator('#imageFreeHint')).toBeHidden();

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

test('onglet : un SVG est rastérisé en PNG à l’envoi', async ({ page }) => {
  await openImagesTab(page);
  await page.locator('#imagesFileInput').setInputFiles(BLASON);
  const rows = page.locator('#imagesList li');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('blason');
  await expect(page.locator('canvas.image-panel')).toBeVisible();
  // Le serveur n'a vu qu'un PNG normalisé : le fichier posé est une empreinte
  // .png, le nom d'origine gardé, les proportions du viewBox (2:1) respectées.
  await expect.poll(async () => (await savedImages(page)).items[0]?.file).toMatch(/^[0-9a-f]+\.png$/);
  await expect.poll(async () => (await savedImages(page)).items[0]?.name).toBe('blason');
  await expect.poll(async () => {
    const b = await boxIn(page, 'canvas.image-panel');
    return Math.round(b.width / b.height);
  }).toBe(2);
});

test('onglet : coller une image depuis le presse-papiers l’ajoute', async ({ page }) => {
  const png = fs.readFileSync(AVATAR);
  const pasteImage = () => page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'colle.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png.toString('base64'));

  await openImagesTab(page);
  // Onglet fermé : un collage n'ajoute rien.
  await page.locator('a[href="#data"]').click();
  await expect(page.locator('#images')).not.toHaveClass(/active/);
  await pasteImage();
  await page.waitForTimeout(500);
  expect((await savedImages(page)).items).toHaveLength(0);
  await expect(page.locator('#imagesList li')).toHaveCount(0);

  // Onglet Images ouvert : l'image collée est envoyée puis ajoutée.
  await page.locator('a[href="#images"]').click();
  await pasteImage();
  const rows = page.locator('#imagesList li');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('colle');
  await expect(page.locator('canvas.image-panel')).toBeVisible();
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
  // La bibliothèque retient le nom d'origine (names.json) : l'image reprise
  // porte le nom du fichier, pas « Image 1 ».
  await expect(page.locator('#imagesList li').first()).toContainText('avatar-transparent');
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

test('flèches du clavier : l’image sélectionnée se déplace (1 px, Maj = 10 px) et devient libre', async ({ page }) => {
  const avatar = await upload(page, AVATAR);
  await putSettings(page, { images: { items: [
    { id: 'babe0040', file: avatar.file, position: { anchor: 'top-left', width: 100 } },
    // Désactivée : dans la liste, sélectionnable, mais sans rect affiché.
    { id: 'babe0041', file: avatar.file, enabled: false, position: { anchor: 'top-right', width: 80 } },
  ] } });
  await openImagesTab(page);
  const canvas = page.locator('canvas.image-panel');
  await expect(canvas).toHaveCount(1);
  await expect(page.locator('#mapWithFrames')).toHaveClass(/images-editing/);
  // Le clic sur l'onglet laisse le focus sur son lien : les flèches y
  // navigueraient entre onglets (navigation clavier des tabs, qui absorbe
  // la touche). Le déplacement du panneau vise le reste de la page.
  await page.evaluate(() => document.activeElement?.blur?.());
  const rectOf = async (id) => page.evaluate(async (imageId) =>
    (await import('/static/js/index.js')).getImagesSnapshot()
      .items.find((i) => i.id === imageId)?.rect || null, id);

  // Ancrée en haut à gauche → ArrowRight : libre à sa place affichée + 1 px.
  const before = await rectOf('babe0040');
  expect(before).toBeTruthy();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await rectOf('babe0040'))?.x).toBeCloseTo(before.x + 1, 0);
  await expect.poll(async () => (await savedImages(page)).items[0].position)
    .toMatchObject({ mode: 'free' });
  await expect(page.locator('#imageFreeHint')).toBeVisible();
  // La fraction persistée correspond au déplacement pixel.
  const rect = await page.evaluate(async () =>
    (await import('/static/js/index.js')).getImagePanelRect('babe0040'));
  const saved = (await savedImages(page)).items[0].position;
  expect(saved.x).toBeCloseTo(rect.x / (rect.container.width - rect.width), 5);

  // Maj+ArrowDown : 10 px.
  const mid = await rectOf('babe0040');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await rectOf('babe0040'))?.y).toBeCloseTo(mid.y + 10, 0);
  // Attendre le PUT du SECOND nudge : « mode: free » seul serait déjà vrai
  // avec le premier. La fraction persistée suit le rect appliqué.
  const rectShift = await page.evaluate(async () =>
    (await import('/static/js/index.js')).getImagePanelRect('babe0040'));
  const expectedY = rectShift.y / (rectShift.container.height - rectShift.height);
  await expect.poll(async () => (await savedImages(page)).items[0].position.y)
    .toBeCloseTo(expectedY, 3);

  // Sélection sans rect affiché (image désactivée) : la flèche ne fait
  // rien — ni pour elle ni pour l'image affichée.
  const positionsAvant = (await savedImages(page)).items.map((i) => i.position);
  await page.locator('#imagesList li[data-image-id="babe0041"] [data-action="select"]').click();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(700);   // debounce écoulé : rien n'est parti
  expect((await savedImages(page)).items.map((i) => i.position)).toEqual(positionsAvant);
});

test('export JSON avec les fichiers, réimport sur une machine qui ne les a pas', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0020', file: logo.file, name: 'Logo du club', position: { anchor: 'top-left', width: 120 },
      style: { shape: 'circle' } },
  ] } });
  await openImagesTab(page);
  await expect(page.locator('canvas.image-panel')).toBeVisible();

  // Export : réglages + image embarquée.
  await page.locator('#btnImagesLibrary').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-images-export]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('mygcflow-images.json');
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(exported.format).toBe('mygcflow-images');
  expect(exported.items).toHaveLength(1);
  expect(exported.files[logo.file]).toMatch(/^data:image\/jpeg;base64,/);

  // « Autre machine » : liste vidée, fichier retiré du serveur.
  await putSettings(page, { images: { enabled: true, items: [] } });
  expect((await page.request.post('/api/images/delete', { data: { file: logo.file } })).ok()).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#images"]').click();
  await expect(page.locator('#imagesList li')).toHaveCount(0);

  // Import : l'image revient, renvoyée au serveur, avec ses réglages.
  await page.locator('#imagesImportFile').setInputFiles({
    name: 'mygcflow-images.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(page.locator('#imagesList li')).toHaveCount(1);
  await expect(page.locator('#imagesList li').first()).toContainText('Logo du club');
  await expect(page.locator('.gcm-toast.show').filter({ hasText: '1 image(s) importée(s)' })).toBeVisible();
  await expect(page.locator('canvas.image-panel')).toBeVisible();
  const saved = (await savedImages(page)).items[0];
  expect(saved.style.shape).toBe('circle');
  expect(saved.position.anchor).toBe('top-left');
  expect((await page.request.get(`/api/images/${saved.file}`)).ok()).toBe(true);

  // Fichier invalide : refusé sans toucher la liste.
  await page.locator('#imagesImportFile').setInputFiles({
    name: 'faux.json', mimeType: 'application/json', buffer: Buffer.from('{"rien": true}'),
  });
  await expect(page.locator('.gcm-toast.show').filter({ hasText: "fichier d'images invalide" })).toBeVisible();
  await expect(page.locator('#imagesList li')).toHaveCount(1);
});

test('un chargement raté une fois est réessayé : l’image n’est pas déclarée manquante', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [{ id: 'babe0030', file: logo.file, name: 'Logo' }] } });
  // Premier chargement de l'image en échec (serveur qui redémarre, par ex.).
  let requests = 0;
  await page.route(`**/api/images/${logo.file}*`, (route) => (requests++ === 0 ? route.abort() : route.continue()));
  await openImagesTab(page);
  await expect(page.locator('canvas.image-panel')).toBeVisible();
  await expect(page.locator('#imagesList li')).toHaveCount(1);
  await expect(page.locator('#imagesList li')).not.toContainText('(manquante)');
  await expect(page.locator('#imageMissingHint')).toBeHidden();
  expect(requests).toBeGreaterThan(1);
});

test('planification : image absente avant sa date, visible après', async ({ page }) => {
  // L'image n'est planifiée que du 03/01 au 05/01 exclu (fixture : une cache
  // par jour du 01 au 06/01/2026). Fondu nul : transitions instantanées.
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0050', file: logo.file, position: { anchor: 'bottom-right', width: 160 },
      schedule: { start: '2026-01-03', end: '2026-01-05', fade: 0 } },
  ] } });
  await openWithFixture(page);
  const canvas = page.locator('canvas.image-panel');
  // Au repos, le planing est ignoré : l'image est pleine.
  await expect(canvas).toBeVisible();
  await expect(canvas).not.toHaveCSS('opacity', '0');

  // Aperçu en pause direct : départ + pause sont synchrones, aucune frame ne
  // joue entre les deux (à 12 j/s le 03/01 serait dépassé avant le clic) —
  // planifiée à partir du 03/01, l'image est masquée dès le départ (état
  // instantané à la veille du premier jour).
  const playback = () => page.evaluate(async () =>
    (await import('/static/js/index.js')).previewPlaybackState());
  const paused = await page.evaluate(async () =>
    (await import('/static/js/index.js')).startPausedPreview());
  expect(paused).toBe(true);
  await expect(canvas).toHaveCSS('opacity', '0');

  // Saut au 02/01 (avant l'apparition) : toujours masquée.
  const seek = (iso) => page.evaluate(async (value) =>
    (await import('/static/js/index.js')).seekAnimationToDate(new Date(`${value}T00:00:00`)), iso);
  expect(await seek('2026-01-02')).toBe(true);
  await expect(canvas).toHaveCSS('opacity', '0');

  // Saut au 04/01 : dedans — pleine opacité, alpha à 1 dans le snapshot.
  expect(await seek('2026-01-04')).toBe(true);
  await expect(canvas).toHaveCSS('opacity', '1');
  const snap = await page.evaluate(async () =>
    (await import('/static/js/index.js')).getImagesSnapshot());
  expect(snap.items.find((i) => i.id === 'babe0050').alpha).toBe(1);

  // Saut au 05/01 (« Disparaît le », borne exclue) : masquée de nouveau.
  expect(await seek('2026-01-05')).toBe(true);
  await expect(canvas).toHaveCSS('opacity', '0');

  // Arrêt : retour au repos, le planing est ignoré.
  await page.locator('#btnQuickStop').click();
  await expect.poll(playback).toBe('idle');
  await expect(canvas).toHaveCSS('opacity', '1');
});

test('planification : le bouton « × » vide la date d\'un clic', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0060', file: logo.file, name: 'Logo',
      schedule: { start: '2026-01-03', end: '2026-01-05', fade: 0 } },
  ] } });
  await openImagesTab(page);
  await expect(page.locator('canvas.image-panel')).toBeVisible();
  await page.locator('#imagesList li[data-image-id="babe0060"] [data-action="select"]').click();

  // Les deux champs remplis : les deux « × » sont actifs.
  await expect(page.locator('#inputImageAppearDate')).toHaveValue('2026-01-03');
  await expect(page.locator('#inputImageDisappearDate')).toHaveValue('2026-01-05');
  await expect(page.locator('#btnImageAppearClear')).toBeEnabled();
  await expect(page.locator('#btnImageDisappearClear')).toBeEnabled();

  // Un clic vide « Disparaît le » : champ et bouton, valeur persistée.
  await page.locator('#btnImageDisappearClear').click();
  await expect(page.locator('#inputImageDisappearDate')).toHaveValue('');
  await expect(page.locator('#btnImageDisappearClear')).toBeDisabled();
  await expect.poll(async () =>
    (await savedImages(page)).items[0].schedule.end).toBe(null);
  // « Apparaît le » inchangé : le planing reste actif (badge présent).
  await expect(page.locator('#inputImageAppearDate')).toHaveValue('2026-01-03');
  await expect(page.locator('#imagesList li[data-image-id="babe0060"] .ti-calendar-time')).toHaveCount(1);

  // Vider la dernière date : plus de planing, badge retiré de la ligne.
  await page.locator('#btnImageAppearClear').click();
  await expect(page.locator('#inputImageAppearDate')).toHaveValue('');
  await expect(page.locator('#btnImageAppearClear')).toBeDisabled();
  await expect.poll(async () =>
    (await savedImages(page)).items[0].schedule.start).toBe(null);
  await expect(page.locator('#imagesList li[data-image-id="babe0060"] .ti-calendar-time')).toHaveCount(0);
});

test('une image restée en échec revient quand on renvoie le même fichier', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [{ id: 'babe0031', file: logo.file, name: 'Logo' }] } });
  // Tous les chargements échouent : l'image finit « manquante ».
  await page.route(`**/api/images/${logo.file}*`, (route) => route.abort());
  await openImagesTab(page);
  await expect(page.locator('#imagesList li')).toContainText('(manquante)');
  await expect(page.locator('#imageMissingHint')).toBeVisible();
  // Le serveur répond de nouveau ; « Remplacer l'image… » avec le même
  // fichier (même contenu, même nom) : l'échec mémorisé est oublié.
  await page.unroute(`**/api/images/${logo.file}*`);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#btnImageReplace').click();
  await (await chooserPromise).setFiles(LOGO);
  await expect(page.locator('#imagesList li')).not.toContainText('(manquante)');
  await expect(page.locator('#imageMissingHint')).toBeHidden();
  await expect(page.locator('canvas.image-panel')).toBeVisible();
  expect((await savedImages(page)).items).toHaveLength(1);
});
