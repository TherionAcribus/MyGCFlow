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
const EVO_CSV = path.join(HERE, 'fixtures', 'evolution-a.csv');

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
    images: { enabled: true, items: [], evolution_items: [], configs: [] },
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

  // Coins arrondis, hauteur d'après l'image : rayon proposé, ajustement
  // grisé (sans effet) avec son explication.
  await expect(page.locator('#imageRadiusGroup')).toBeVisible();
  await expect(page.locator('#imageFit-cover')).toBeDisabled();
  await expect(page.locator('#imageFitHint')).toBeVisible();

  // Forme ronde : carrée, rayon des coins masqué, ajustement utile.
  await page.locator('label[for="imageShape-circle"]').click();
  await expect.poll(async () => (await savedImages(page)).items[0].style.shape).toBe('circle');
  await expect(page.locator('#imageRadiusGroup')).toBeHidden();
  await expect(page.locator('#imageFit-cover')).toBeEnabled();
  await expect(page.locator('#imageFitHint')).toBeHidden();
  await expect.poll(async () => {
    const b = await boxIn(page, 'canvas.image-panel');
    return Math.round(b.width) === Math.round(b.height);
  }).toBe(true);
  // Vignette du formulaire dessinée avec le style : ronde, donc carrée.
  await expect.poll(() => page.locator('#imageFormPreview').evaluate(
    (c) => c.width > 1 && c.style.width !== '' && c.style.width === c.style.height)).toBe(true);

  // Couleur de fond choisie sur un fond transparent : il devient opaque.
  await page.locator('#inputImageBackground').fill('#ff0000');
  await expect.poll(async () => (await savedImages(page)).items[0].style)
    .toMatchObject({ background: '#ff0000', background_opacity: 100 });
  await expect(page.locator('#valueImageBackgroundOpacity')).toHaveText('100 %');
  // Couleur de bordure : seulement avec une bordure.
  await expect(page.locator('#inputImageBorderColor')).toBeHidden();
  await page.locator('#inputImageBorderWidth').fill('2');
  await expect(page.locator('#inputImageBorderColor')).toBeVisible();

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

test('bibliothèque : un relevé en échec affiche une erreur, « Réessayer » la recharge', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await openImagesTab(page);
  // GET /api/images en échec : erreur explicite plutôt que le message
  // « aucune image », qui serait mensonger. La route ne touche que le
  // relevé, pas les fichiers /api/images/<fichier>.
  const listingUrl = (url) => url.pathname === '/api/images';
  await page.route(listingUrl, (route) => route.abort());
  await page.locator('#btnImagesLibrary').click();
  await expect(page.locator('#imagesLibraryError')).toBeVisible();
  await expect(page.locator('#imagesLibraryEmpty')).toBeHidden();
  // « Réessayer » recharge sans fermer le menu.
  await page.unroute(listingUrl);
  await page.locator('#btnImagesLibraryRetry').click();
  await expect(page.locator('#imagesLibraryError')).toBeHidden();
  await expect(page.locator(`#imagesLibraryList [data-library-file="${logo.file}"]`)).toBeVisible();
});

test('bibliothèque : retrait confirmé, refusé tant qu’un « Annuler » peut ramener l’image', async ({ page }) => {
  const libraryFiles = async () => (await (await page.request.get('/api/images')).json()).files.map((f) => f.file);
  await openImagesTab(page);
  await page.locator('#imagesFileInput').setInputFiles(LOGO);
  await expect.poll(async () => (await savedImages(page)).items[0]?.file).toMatch(/^[0-9a-f]+\.jpg$/);
  const file = (await savedImages(page)).items[0].file;
  const remove = page.locator(`#imagesLibraryList [data-library-delete="${file}"]`);

  // Ligne supprimée, toast « Annuler » affiché : le fichier n'est plus
  // référencé, mais la bibliothèque ne propose pas de le retirer.
  await page.locator('#imagesList li [data-action="delete"]').click();
  const toast = page.locator('.gcm-toast.show').filter({ hasText: 'supprimée' });
  await expect(toast).toBeVisible();
  await page.locator('#btnImagesLibrary').click();
  await expect(page.locator(`#imagesLibraryList [data-library-file="${file}"]`)).toBeVisible();
  await expect(remove).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Toast fermé : le retrait redevient possible, après confirmation.
  await toast.locator('.gcm-toast-close').click();
  await expect(toast).toHaveCount(0);
  await page.locator('#btnImagesLibrary').click();
  await remove.click();
  const modal = page.locator('.gcm-confirm-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('logo-opaque');
  await modal.locator('[data-gcm-role="cancel"]').click();
  await expect(modal).toHaveCount(0);
  expect(await libraryFiles()).toContain(file);

  await page.locator('#btnImagesLibrary').click();
  await remove.click();
  await page.locator('.gcm-confirm-modal [data-gcm-role="confirm"]').click();
  await expect.poll(libraryFiles).not.toContain(file);
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

test('« Dupliquer » une image libre : la copie est décalée, pas posée sur l’original', async ({ page }) => {
  const avatar = await upload(page, AVATAR);
  await putSettings(page, { images: { items: [
    { id: 'babe0050', file: avatar.file, position: { mode: 'free', x: 0.5, y: 0.5, width: 100 } },
  ] } });
  await openImagesTab(page);
  await expect(page.locator('canvas.image-panel')).toHaveCount(1);
  const rectOf = (id) => page.evaluate(async (imageId) =>
    (await import('/static/js/index.js')).getImagePanelRect(imageId), id);
  const original = await rectOf('babe0050');
  expect(original).toBeTruthy();

  await page.locator('#imagesList li[data-image-id="babe0050"] [data-action="duplicate"]').click();
  await expect(page.locator('canvas.image-panel')).toHaveCount(2);
  let copyId = null;
  await expect.poll(async () => {
    const items = (await savedImages(page)).items;
    copyId = items[1]?.id ?? null;
    return items.length;
  }).toBe(2);
  expect((await savedImages(page)).items[1].position.mode).toBe('free');
  const copy = await rectOf(copyId);
  expect(copy.x - original.x).toBeCloseTo(24, 0);
  expect(copy.y - original.y).toBeCloseTo(24, 0);
});

test('touche Suppr : l’image sélectionnée est supprimée (même effet que le bouton)', async ({ page }) => {
  const avatar = await upload(page, AVATAR);
  await putSettings(page, { images: { items: [
    { id: 'babe0070', file: avatar.file, name: 'À supprimer', position: { anchor: 'top-left', width: 100 } },
    { id: 'babe0071', file: avatar.file, name: 'Autre', position: { anchor: 'top-right', width: 80 } },
  ] } });
  await openImagesTab(page);
  await expect(page.locator('canvas.image-panel')).toHaveCount(2);
  await page.evaluate(() => document.activeElement?.blur?.());

  // Sélection dans la liste puis Suppr : l'image part (liste, carte,
  // réglages) et le toast « Annuler » s'affiche — comme le bouton.
  await page.locator('#imagesList li[data-image-id="babe0070"] [data-action="select"]').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('#imagesList li')).toHaveCount(1);
  await expect(page.locator('canvas.image-panel')).toHaveCount(1);
  await expect.poll(async () => (await savedImages(page)).items.map((i) => i.id))
    .toEqual(['babe0071']);
  const undo = page.locator('.gcm-toast.show .gcm-toast-actions button', { hasText: 'Annuler' });
  await expect(undo).toBeVisible();

  // « Annuler » : l'image revient à sa place.
  await undo.click();
  await expect(page.locator('#imagesList li')).toHaveCount(2);
  await expect.poll(async () => (await savedImages(page)).items.map((i) => i.id))
    .toEqual(['babe0070', 'babe0071']);
  await expect(page.locator('canvas.image-panel')).toHaveCount(2);

  // Dans un champ, Suppr garde son rôle natif (pas de suppression).
  await page.locator('#inputImageName').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('#imagesList li')).toHaveCount(2);
  await page.evaluate(() => document.activeElement?.blur?.());

  // Bibliothèque déroulée : le raccourci n'agit pas derrière la surcouche.
  await page.locator('#btnImagesLibrary').click();
  await expect(page.locator('#imagesLibraryMenu')).toHaveClass(/show/);
  await page.keyboard.press('Delete');
  await expect(page.locator('#imagesList li')).toHaveCount(2);
});

// Dépôt de fichiers simulé : dragenter, dragover puis drop sur `selector`, au
// point (x, y) du repère de l'élément (centre par défaut) — l'événement
// remonte jusqu'au gestionnaire de la fenêtre, comme un vrai dépôt.
async function dropFiles(page, selector, files, at = null) {
  const payload = files.map((file) => ({
    name: path.basename(file), b64: fs.readFileSync(file).toString('base64'),
  }));
  await page.evaluate(({ selector, payload, at }) => {
    const dt = new DataTransfer();
    for (const f of payload) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: 'image/png' }));
    }
    const target = document.querySelector(selector);
    const r = target.getBoundingClientRect();
    const clientX = r.left + (at ? at.x : r.width / 2);
    const clientY = r.top + (at ? at.y : r.height / 2);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX, clientY }));
    }
  }, { selector, payload, at });
}

test('dépôt : sur la carte, posée en position libre au point lâché ; sur l’onglet, ajoutée une fois — jamais prise pour un GPX', async ({ page }) => {
  await openWithFixture(page);
  // Onglet Données ouvert : le dépôt d'une image ouvre l'onglet Images.
  await dropFiles(page, '#mapWithFrames', [AVATAR], { x: 200, y: 150 });
  await expect(page.locator('#images')).toHaveClass(/active/);
  await expect(page.locator('#imagesList li')).toHaveCount(1);
  await expect.poll(async () => (await savedImages(page)).items[0]?.position.mode).toBe('free');
  // Centrée sur le point du dépôt (avatar carré, 160 px de large).
  await expect.poll(async () => {
    const b = await boxIn(page, 'canvas.image-panel');
    return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
  }).toEqual([200, 150]);

  // Sur l'onglet : une seule image de plus, ancrée (pas de point sur la carte).
  await dropFiles(page, '#imagesListCard', [LOGO]);
  await expect(page.locator('#imagesList li')).toHaveCount(2);
  await expect.poll(async () => (await savedImages(page)).items.length).toBe(2);
  await page.waitForTimeout(500);
  expect((await savedImages(page)).items).toHaveLength(2);
  expect((await savedImages(page)).items[1].position.mode).toBe('anchor');
  // Le gestionnaire de la fenêtre ne l'a pas traitée comme un fichier GPX.
  await expect(page.locator('.gcm-toast').filter({ hasText: /Fichier invalide|Analyse du fichier GPX/ })).toHaveCount(0);
});

test('bibliothèque : images utilisées signalées ; import en ajout, places comptées', async ({ page }) => {
  const logo = await upload(page, LOGO);
  const avatar = await upload(page, AVATAR);
  await putSettings(page, { images: {
    items: [{ id: 'babe0100', file: logo.file, name: 'Logo' }],
    evolution_items: [{ id: 'babe0101', file: avatar.file, name: 'Avatar' }],
  } });
  await openImagesTab(page);
  await page.locator('#btnImagesLibrary').click();
  const logoCell = page.locator(`#imagesLibraryList [data-library-file="${logo.file}"]`);
  const avatarCell = page.locator(`#imagesLibraryList [data-library-file="${avatar.file}"]`);
  await expect(logoCell).toHaveClass(/is-used-here/);
  await expect(logoCell).toHaveAttribute('aria-label', /Utilisée sur cette page/);
  await expect(avatarCell.locator('.images-library-badge.is-other')).toHaveCount(1);
  await expect(avatarCell).toHaveAttribute('aria-label', /Utilisée dans « Évolution »/);

  // « Importer et ajouter » : la liste garde son image, trois places restent
  // pour les quatre de l'export — la quatrième est écartée et signalée.
  const exported = { format: 'mygcflow-images', version: 1, files: {},
    items: [1, 2, 3, 4].map((n) => ({ file: avatar.file, name: `Importée ${n}` })) };
  // Export et import vivent dans le menu Configurations, comme dans l'onglet Stats.
  await page.keyboard.press('Escape');
  await page.locator('#btnImagesConfigs').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-images-import="append"]').click();
  await (await chooser).setFiles({
    name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)),
  });
  const rows = page.locator('#imagesList li');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('Logo');
  await expect(rows.last()).toContainText('Importée 3');
  await expect(page.locator('.gcm-toast.show').filter({ hasText: '1 image(s) non importée(s)' })).toBeVisible();
  await expect.poll(async () => (await savedImages(page)).items.map((i) => i.name))
    .toEqual(['Logo', 'Importée 1', 'Importée 2', 'Importée 3']);
});

test('préréglages : « Avatar » arrondit et encadre, « Annuler » rend le style d’avant', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0110', file: logo.file, name: 'Logo', position: { height: 90 }, style: { opacity: 50 } },
  ] } });
  await openImagesTab(page);
  await page.locator('#imagesList li [data-action="select"]').click();
  // Cartes des préréglages : l'image dessinée dans chaque style, l'icône de
  // repli masquée. Avatar (rond) : carrée ; « Logo sur fond » garde la
  // hauteur imposée (160 × 90).
  const thumb = (name) => page.locator(`[data-image-preset="${name}"] .image-preset-thumb`);
  for (const name of ['avatar', 'badge', 'discreet', 'photo']) {
    await expect(thumb(name).locator('canvas')).toBeVisible();
    await expect(thumb(name).locator('.ti')).toBeHidden();
  }
  const ratio = (name) => thumb(name).locator('canvas').evaluate(
    (c) => parseFloat(c.style.width) / parseFloat(c.style.height));
  expect(await ratio('avatar')).toBeCloseTo(1, 1);
  expect(await ratio('badge')).toBeCloseTo(160 / 90, 1);
  await page.locator('[data-image-preset="avatar"]').click();
  await expect.poll(async () => (await savedImages(page)).items[0].style)
    .toMatchObject({ shape: 'circle', fit: 'cover', border_width: 3, shadow: true, opacity: 100 });
  // Rond : la hauteur imposée est levée, l'image est carrée.
  expect((await savedImages(page)).items[0].position.height).toBe(null);
  await expect(page.locator('#imageShape-circle')).toBeChecked();
  // Préréglage porté exactement : bouton enfoncé.
  await expect(page.locator('[data-image-preset="avatar"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => {
    const b = await boxIn(page, 'canvas.image-panel');
    return Math.round(b.width) === Math.round(b.height);
  }).toBe(true);

  const toast = page.locator('.gcm-toast.show').filter({ hasText: 'Avatar' });
  await toast.locator('.gcm-toast-action').filter({ hasText: 'Annuler' }).click();
  await expect.poll(async () => (await savedImages(page)).items[0].style)
    .toMatchObject({ shape: 'rounded', opacity: 50, border_width: 0 });
  expect((await savedImages(page)).items[0].position.height).toBe(90);
  await expect(page.locator('#imageShape-rounded')).toBeChecked();
  await expect(page.locator('[data-image-preset="avatar"]')).toHaveAttribute('aria-pressed', 'false');
});

test('sections repliables : ouvertes par défaut, résumé des réglages une fois repliées, état mémorisé', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0130', file: logo.file, name: 'Logo', position: { anchor: 'bottom-left', width: 120 },
      style: { shape: 'circle', fit: 'cover', border_width: 3, border_color: '#ffffff', shadow: true },
      // Fixture animée du 01/01 au 06/01/2026 : jamais visible dans la vidéo.
      schedule: { start: '2026-02-01', end: null, fade: 0 } },
  ] } });
  await openImagesTab(page);
  await page.locator('#imagesList li [data-action="select"]').click();
  const position = page.locator('#imageSectionPosition');
  const appearance = page.locator('#imageSectionAppearance');
  const schedule = page.locator('#imageSectionSchedule');
  for (const section of [position, appearance, schedule]) await expect(section).toHaveJSProperty('open', true);
  // Ouverte : contrôles visibles, résumé masqué.
  await expect(page.locator('#inputImageWidth')).toBeVisible();
  await expect(page.locator('#imagePositionSummary')).toBeHidden();

  // Repliées : contrôles hors de vue, résumé des réglages en cours.
  await position.locator('summary').click();
  await expect(position).toHaveJSProperty('open', false);
  await expect(page.locator('#inputImageWidth')).toBeHidden();
  await expect(page.locator('#imagePositionSummary')).toHaveText('En bas à gauche · 120 px');
  await appearance.locator('summary').click();
  await expect(page.locator('#imageAppearanceSummary')).toHaveText('Avatar');
  await schedule.locator('summary').click();
  await expect(page.locator('#imageScheduleSummary')).toHaveText(/^À partir du /);
  // L'avertissement du planing, masqué avec la section, colore le résumé.
  await expect(page.locator('#imageScheduleSummary')).toHaveClass(/is-warning/);

  // Repliée, le résumé suit un changement fait hors du formulaire : une
  // flèche du clavier rend l'image libre à sa place affichée.
  await page.locator('#imagesList li [data-action="select"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#imagePositionSummary')).toHaveText('Position libre · 120 px');

  // L'état replié/ouvert est mémorisé et restauré au rechargement.
  await appearance.locator('summary').click();
  await expect(appearance).toHaveJSProperty('open', true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('#imageSectionPosition')).toHaveJSProperty('open', false);
  await expect(page.locator('#imageSectionAppearance')).toHaveJSProperty('open', true);
  await expect(page.locator('#imageSectionSchedule')).toHaveJSProperty('open', false);
});

test('planification : avertissement hors période, « Jour affiché » reprend le jour de l’aperçu en pause', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0120', file: logo.file, name: 'Logo', schedule: { start: '2026-02-01', end: null, fade: 0 } },
  ] } });
  await openImagesTab(page);
  await page.locator('#imagesList li [data-action="select"]').click();
  // Fixture : animation du 01/01 au 06/01/2026 — une apparition au 01/02
  // n'a jamais lieu.
  const warning = page.locator('#imageScheduleWarning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("après la fin de l'animation");

  // Au repos, pas de jour affiché : le bouton explique quoi faire.
  await page.locator('#btnImageAppearFromPreview').click();
  await expect(page.locator('.gcm-toast.show').filter({ hasText: "Lancez l'aperçu" })).toBeVisible();
  await expect(page.locator('#inputImageAppearDate')).toHaveValue('2026-02-01');

  // Aperçu en pause au 04/01 : « Jour affiché » le reprend, l'image
  // apparaît aussitôt (planing réappliqué au jour affiché).
  const paused = await page.evaluate(async () =>
    (await import('/static/js/index.js')).startPausedPreview());
  expect(paused).toBe(true);
  expect(await page.evaluate(async () =>
    (await import('/static/js/index.js')).seekAnimationToDate(new Date('2026-01-04T00:00:00')))).toBe(true);
  const canvas = page.locator('canvas.image-panel');
  await expect(canvas).toHaveCSS('opacity', '0');
  await page.locator('#btnImageAppearFromPreview').click();
  await expect(page.locator('#inputImageAppearDate')).toHaveValue('2026-01-04');
  await expect.poll(async () => (await savedImages(page)).items[0].schedule.start).toBe('2026-01-04');
  await expect(warning).toBeHidden();
  await expect(canvas).toHaveCSS('opacity', '1');

  // Même jour pour la disparition : fenêtre vide, signalée, image masquée.
  await page.locator('#btnImageDisappearFromPreview').click();
  await expect(page.locator('#inputImageDisappearDate')).toHaveValue('2026-01-04');
  await expect(warning).toContainText('jamais visible');
  await expect(canvas).toHaveCSS('opacity', '0');

  await page.locator('#btnQuickStop').click();
  await expect.poll(() => page.evaluate(async () =>
    (await import('/static/js/index.js')).previewPlaybackState())).toBe('idle');
});

test('configurations : enregistrée sur « Mes Géocaches », appliquée sur Évolution, annulable', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0130', file: logo.file, name: 'Logo du club', position: { anchor: 'top-left' } },
  ] } });
  await openImagesTab(page);
  await page.locator('#btnImagesConfigs').click();
  await page.locator('[data-images-config-save]').click();
  await page.locator('#inputImagesConfigName').fill('Club');
  await page.locator('#inputImagesConfigName').press('Enter');
  await expect.poll(async () => (await savedImages(page)).configs.map((c) => [c.name, c.items.length]))
    .toEqual([['Club', 1]]);

  // Page Évolution : sa liste est vide, la configuration y est applicable.
  await page.goto('/evolution#images', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#images"]').click();
  await expect(page.locator('#imagesList li')).toHaveCount(0);
  await page.locator('#btnImagesConfigs').click();
  const entry = page.locator('#imagesConfigMenu [data-config-apply="Club"]');
  await expect(entry).toContainText('(1)');
  await entry.click();
  await expect(page.locator('#imagesList li')).toHaveCount(1);
  await expect(page.locator('#imagesList li')).toContainText('Logo du club');
  await expect.poll(async () => (await savedImages(page)).evolution_items.map((i) => i.position.anchor))
    .toEqual(['top-left']);
  // La liste de « Mes Géocaches » n'est pas touchée.
  expect((await savedImages(page)).items).toHaveLength(1);

  const toast = page.locator('.gcm-toast.show').filter({ hasText: 'Club' });
  await toast.locator('.gcm-toast-action').filter({ hasText: 'Annuler' }).click();
  await expect(page.locator('#imagesList li')).toHaveCount(0);
  await expect.poll(async () => (await savedImages(page)).evolution_items).toEqual([]);
});

test('planification par trouvailles : le jalon devient une date, jamais atteint signalé', async ({ page }) => {
  // Fixture : une trouvaille par jour du 01 au 06/01/2026 — la 3e le 03/01.
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0140', file: logo.file, name: 'Logo', schedule: { fade: 0 } },
  ] } });
  await openImagesTab(page);
  await page.locator('#imagesList li [data-action="select"]').click();
  await page.locator('label[for="imageScheduleBy-find"]').click();
  await expect(page.locator('#imageScheduleFinds')).toBeVisible();
  await expect(page.locator('#imageScheduleDates')).toBeHidden();
  await page.locator('#inputImageAppearFind').fill('3');
  await expect(page.locator('#imageAppearFindDate')).toHaveText('Le 03/01/2026');
  await expect.poll(async () => (await savedImages(page)).items[0].schedule)
    .toMatchObject({ by: 'find', start_find: 3 });
  await expect(page.locator('#imagesList li .ti-calendar-time')).toHaveCount(1);

  const seek = (iso) => page.evaluate(async (value) =>
    (await import('/static/js/index.js')).seekAnimationToDate(new Date(`${value}T00:00:00`)), iso);
  expect(await page.evaluate(async () => (await import('/static/js/index.js')).startPausedPreview())).toBe(true);
  const canvas = page.locator('canvas.image-panel');
  expect(await seek('2026-01-02')).toBe(true);
  await expect(canvas).toHaveCSS('opacity', '0');
  expect(await seek('2026-01-03')).toBe(true);
  await expect(canvas).toHaveCSS('opacity', '1');
  await page.locator('#btnQuickStop').click();

  // Au-delà du total : jamais atteint, signalé.
  await page.locator('#inputImageAppearFind').fill('99');
  await expect(page.locator('#imageAppearFindDate')).toContainText('Jamais atteinte : 6');
  await expect(page.locator('#imageScheduleWarning')).toContainText("n°99 n'est jamais atteinte");

  // Retour aux dates : les jalons sont gardés, le planing ne compte plus.
  await page.locator('label[for="imageScheduleBy-date"]').click();
  await expect(page.locator('#imageScheduleDates')).toBeVisible();
  await expect.poll(async () => (await savedImages(page)).items[0].schedule)
    .toMatchObject({ by: 'date', start_find: 99 });
  await expect(page.locator('#imagesList li .ti-calendar-time')).toHaveCount(0);
});

test('planification par trouvailles : onglet ouvert pendant le chargement, la date du jalon suit les données', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0145', file: logo.file, name: 'Logo', schedule: { by: 'find', start_find: 3 } },
  ] } });
  // Onglet Images ouvert AVANT les données (base vidée : les tests
  // précédents l'ont remplie) : rien à afficher sous le jalon.
  expect((await page.request.post('/clear_database')).ok()).toBe(true);
  await page.goto('/#images', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#images"]').click();
  await page.locator('#imagesList li [data-action="select"]').click();
  await expect(page.locator('#inputImageAppearFind')).toHaveValue('3');
  await expect(page.locator('#imageAppearFindDate')).toHaveText('');
  // Données chargées, onglet toujours ouvert : la date apparaît.
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await expect(page.locator('#imageAppearFindDate')).toHaveText('Le 03/01/2026');
});

test('effet « glissement » : l’image entre par le bord le plus proche, dans l’aperçu et dans la vidéo', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0150', file: logo.file, position: { anchor: 'bottom-right', width: 160 },
      schedule: { start: '2026-01-03', fade: 1000, effect: 'slide' } },
  ] } });
  // Onglet Données : pas de mode édition, l'effet s'applique à l'aperçu.
  await openWithFixture(page);
  await expect(page.locator('canvas.image-panel')).toBeVisible();

  const result = await page.evaluate(async () => {
    const m = await import('/static/js/index.js');
    const canvasEl = document.querySelector('canvas.image-panel');
    const host = document.getElementById('mapWithFrames');
    const w = host.clientWidth;
    const h = host.clientHeight;
    // Colonnes extrêmes des pixels dessinés par la vidéo à l'horloge `now`.
    const columns = (now) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      m.addImagePanelsToCanvas(ctx, w, h, 1, now);
      const data = ctx.getImageData(0, 0, w, h).data;
      let min = w;
      let max = -1;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 0) {
            if (x < min) min = x;
            if (x > max) max = x;
          }
        }
      }
      return { min, max };
    };
    // Veille du départ : cachée, hors du cadre à droite (bord le plus proche).
    m.resetImagesForAnimation(new Date('2026-01-01T00:00:00'));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const hiddenTransform = canvasEl.style.transform;
    // Apparition le 03/01 à l'horloge 1000 ms, transition d'une seconde.
    m.syncImagesToDate(new Date('2026-01-03T00:00:00'), 1000);
    await new Promise(requestAnimationFrame);
    const shownTransform = canvasEl.style.transform;
    const mid = columns(1500);
    const end = columns(2100);
    const motion = m.getImagesSnapshot().items[0].motion;
    m.syncImagesToRest();
    return { hiddenTransform, shownTransform, mid, end, motion, w };
  });
  expect(result.hiddenTransform).toMatch(/^translate\(\d+(\.\d+)?px, 0px\) scale\(1\)$/);
  expect(result.shownTransform).toBe('');
  // Fin de transition : l'image est à sa place (16 px du bord droit).
  expect(result.end.max).toBeGreaterThanOrEqual(result.w - 18);
  expect(result.end.max).toBeLessThan(result.w - 14);
  // À mi-temps : encore décalée vers la droite, déjà presque arrivée
  // (« ease-out »), coupée par le bord du cadre.
  expect(result.mid.min).toBeGreaterThan(result.end.min + 5);
  expect(result.mid.min - result.end.min).toBeLessThan(60);
});

test('export JSON avec les fichiers, réimport sur une machine qui ne les a pas', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0020', file: logo.file, name: 'Logo du club', position: { anchor: 'top-left', width: 120 },
      style: { shape: 'circle' } },
  ], configs: [
    { name: 'Club', items: [{ id: 'babe0021', file: logo.file, name: 'Logo cfg', position: { anchor: 'bottom-left' } }] },
  ] } });
  await openImagesTab(page);
  await expect(page.locator('canvas.image-panel')).toBeVisible();

  // Export : réglages + image embarquée ; la configuration nommée voyage
  // aussi (version 2), avec le fichier qu'elle référence.
  await page.locator('#btnImagesConfigs').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-images-export]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('mygcflow-images.json');
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(exported.format).toBe('mygcflow-images');
  expect(exported.version).toBe(2);
  expect(exported.items).toHaveLength(1);
  expect(exported.configs.map((c) => c.name)).toEqual(['Club']);
  expect(exported.files[logo.file]).toMatch(/^data:image\/jpeg;base64,/);

  // « Autre machine » : liste et configurations vidées, fichier retiré du
  // serveur.
  await putSettings(page, { images: { enabled: true, items: [], configs: [] } });
  expect((await page.request.post('/api/images/delete', { data: { file: logo.file } })).ok()).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#images"]').click();
  await expect(page.locator('#imagesList li')).toHaveCount(0);

  // Import : l'image revient, renvoyée au serveur, avec ses réglages — et
  // la configuration, qui référence le nouveau fichier.
  await page.locator('#imagesImportFile').setInputFiles({
    name: 'mygcflow-images.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(page.locator('#imagesList li')).toHaveCount(1);
  await expect(page.locator('#imagesList li').first()).toContainText('Logo du club');
  await expect(page.locator('.gcm-toast.show')
    .filter({ hasText: '1 image(s) et 1 configuration(s) importée(s)' })).toBeVisible();
  await expect(page.locator('canvas.image-panel')).toBeVisible();
  const savedImages_ = await savedImages(page);
  const saved = savedImages_.items[0];
  expect(saved.style.shape).toBe('circle');
  expect(saved.position.anchor).toBe('top-left');
  expect((await page.request.get(`/api/images/${saved.file}`)).ok()).toBe(true);
  const club = savedImages_.configs.find((c) => c.name === 'Club');
  expect(club).toBeTruthy();
  expect(club.items[0].file).toBe(saved.file);
  expect(club.items[0].position.anchor).toBe('bottom-left');

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

test('chaque mode a sa liste : « Mes Geocaches » et « Évolution » sont indépendants', async ({ page }) => {
  const logo = await upload(page, LOGO);
  await putSettings(page, { images: { items: [
    { id: 'babe0090', file: logo.file, name: 'Principale' },
  ] } });
  await openImagesTab(page);
  await expect(page.locator('#imagesList li')).toHaveCount(1);
  await expect(page.locator('#imagesList li')).toContainText('Principale');
  await expect(page.locator('canvas.image-panel')).toHaveCount(1);

  // Page Évolution, données chargées : même préférence, mais l'autre liste —
  // `items` rempli n'y fait rien apparaître.
  await page.goto('/evolution#images', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
  await dismissFirstUseModal(page);
  const loaded = page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('mygcflow:evolution-loaded', (e) => resolve(e.detail), { once: true });
  }));
  await page.locator('#evolutionCsvInput').setInputFiles(EVO_CSV);
  await loaded;
  await page.locator('a[href="#images"]').click();
  await expect(page.locator('#imagesList li')).toHaveCount(0);
  await expect(page.locator('canvas.image-panel')).toHaveCount(0);

  // Liste Évolution renseignée : l'image apparaît ici seulement.
  await putSettings(page, { images: { evolution_items: [
    { id: 'babe0091', file: logo.file, name: 'Évolution' },
  ] } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
  await page.locator('a[href="#images"]').click();
  await expect(page.locator('#imagesList li')).toHaveCount(1);
  await expect(page.locator('#imagesList li')).toContainText('Évolution');
  await expect(page.locator('canvas.image-panel')).toHaveCount(1);

  // Retour sur « Mes Geocaches » : sa liste est intacte, l'autre non répercutée.
  await page.goto('/#images', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#images"]').click();
  await expect(page.locator('#imagesList li')).toHaveCount(1);
  await expect(page.locator('#imagesList li')).toContainText('Principale');
  const saved = await savedImages(page);
  expect(saved.items.map((i) => i.id)).toEqual(['babe0090']);
  expect(saved.evolution_items.map((i) => i.id)).toEqual(['babe0091']);

  // La base Évolution importée ne survit pas au spec.
  const datasets = (await (await page.request.get('/api/evolution/datasets')).json()).datasets;
  for (const dataset of datasets) {
    await page.request.delete(`/api/evolution/datasets/${dataset.id}`);
  }
});

test('une modification n’envoie au serveur que les clés du bloc changées', async ({ page }) => {
  const logo = await upload(page, LOGO);
  // Une liste posée sur chaque page plus une configuration : si le PUT
  // renvoyait le bloc complet, une page écraserait le travail de l'autre
  // avec sa copie (périmée si deux onglets sont ouverts). Chaque écriture
  // ne doit donc porter que les clés de premier niveau changées.
  await putSettings(page, { images: {
    items: [{ id: 'babe0095', file: logo.file, name: 'Principale' }],
    evolution_items: [{ id: 'e5e50001', file: logo.file, name: 'Évolution' }],
    configs: [{ name: 'Club', items: [{ id: 'c0c00001', file: logo.file }] }],
  } });
  await openImagesTab(page);
  const imagePut = (req) => req.method() === 'PUT' && req.url().endsWith('/api/settings')
    && !!req.postDataJSON()?.images;

  // Interrupteur général : seule « enabled » part.
  const enabledPut = page.waitForRequest(imagePut);
  await page.locator('#switchImages').click();
  const enabledImages = (await enabledPut).postDataJSON().images;
  expect(Object.keys(enabledImages)).toEqual(['enabled']);
  expect(enabledImages.enabled).toBe(false);
  // Écriture confirmée (la clé sort de l'accumulateur) avant le changement
  // suivant : sinon le PUT du renommage pourrait encore porter « enabled ».
  await expect.poll(async () => (await savedImages(page)).enabled).toBe(false);

  // Renommage : seule la liste de la page part — pas l'interrupteur, pas
  // la liste de l'autre page, pas les configurations.
  const itemsPut = page.waitForRequest(imagePut);
  await page.locator('#inputImageName').fill('Nom renommé');
  const itemsImages = (await itemsPut).postDataJSON().images;
  expect(Object.keys(itemsImages)).toEqual(['items']);
  expect(itemsImages.items[0].name).toBe('Nom renommé');

  // Côté serveur, les clés non envoyées ont survécu.
  await expect.poll(async () => (await savedImages(page)).items[0]?.name).toBe('Nom renommé');
  const saved = await savedImages(page);
  expect(saved.enabled).toBe(false);
  expect(saved.evolution_items.map((i) => i.id)).toEqual(['e5e50001']);
  expect(saved.configs.map((c) => c.name)).toEqual(['Club']);
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
