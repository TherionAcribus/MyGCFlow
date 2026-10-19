// Placement du titre et des infos (Style › Titres) : même grille, mêmes
// marges et même glisser-déposer aimanté que les panneaux de stats, et piles
// de stats qui contournent les cartouches où qu'ils soient.
//
// Les réglages du titre et des infos appartiennent au thème : rien n'est
// enregistré ici (le thème reste « modifié » jusqu'au rechargement suivant).
// `stats` est en revanche une préférence globale : remise à vide en sortant.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

async function putStats(page, stats) {
  const response = await page.request.put('/api/settings', { data: { stats } });
  expect(response.ok()).toBe(true);
}

async function openTitles(page) {
  await page.goto('/#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6');
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTitles"]').click();
  await page.locator('#infosModeSimple').click();
  // Titre affiché, assez long pour une boîte bien visible.
  const display = page.locator('#cbDisplayTitle');
  if (!(await display.isChecked())) await display.check();
  await page.locator('#inputTitle').fill('Mes trouvailles');
  await expect(page.locator('#titleFrame')).toBeVisible();
  await page.locator('#gcCssTabPosition').click();
  await expect(page.locator('#mapWithFrames')).toHaveClass(/overlay-editing/);
}

// Rect d'un élément dans le repère de #mapWithFrames.
async function boxIn(page, selector) {
  return page.evaluate((sel) => {
    const host = document.getElementById('mapWithFrames').getBoundingClientRect();
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left - host.left, y: r.top - host.top, width: r.width, height: r.height,
      right: host.right - r.right, bottom: host.bottom - r.bottom, hostWidth: host.width };
  }, selector);
}

test.afterEach(async ({ page }) => {
  await putStats(page, { enabled: true, panels: [], evolution_panels: [] });
});

test('la grille place le titre : coins, centre, marges', async ({ page }) => {
  await openTitles(page);
  const title = '#titleFrame';

  // Feuille par défaut : en haut à gauche, 10 px.
  await expect(page.locator('#overlayAnchor-top-left')).toBeChecked();
  await expect(page.locator('#gcCssMarginX')).toHaveValue('10');

  // En bas à droite : les côtés de la feuille par défaut (top/left) sont
  // neutralisés, la boîte est bien collée au coin.
  await page.locator('label[for="overlayAnchor-bottom-right"]').click();
  await expect.poll(async () => {
    const b = await boxIn(page, title);
    return [Math.round(b.right), Math.round(b.bottom)];
  }).toEqual([10, 10]);
  // Les quatre côtés posés sont sérialisés en `inset` : les champs du mode
  // avancé les relisent dépliés.
  await expect(page.locator('#gcCssBottom')).toHaveValue('10');
  await expect(page.locator('#gcCssTop')).toHaveValue('');

  // En haut au centre : centré, marge horizontale grisée, la verticale
  // reste réglable.
  await page.locator('label[for="overlayAnchor-top-center"]').click();
  await expect.poll(async () => {
    const b = await boxIn(page, title);
    return Math.abs(b.x + b.width / 2 - b.hostWidth / 2) < 1.5;
  }).toBe(true);
  await expect(page.locator('#gcCssMarginX')).toBeDisabled();
  await page.locator('#gcCssMarginY').fill('30');
  await expect.poll(async () => Math.round((await boxIn(page, title)).y)).toBe(30);
  // Un long titre garde toute la largeur de la carte (pas de retour à la
  // ligne à mi-largeur, défaut d'un centrage par left: 50%).
  await page.locator('#inputTitle').fill('Un titre assez long pour dépasser la moitié de la largeur de la carte, vraiment très long');
  const long = await boxIn(page, title);
  expect(long.width).toBeGreaterThan(long.hostWidth / 2);

  // CSS hors grille (mode avancé) : plus aucun emplacement coché.
  await page.locator('#inputTitleCss').evaluate((el) => {
    el.value = 'position: relative; top: 5px;';
  });
  await page.evaluate(() => window.gcCssAssistantSyncFromTextareas());
  await expect(page.locator('input[name="overlayAnchor"]:checked')).toHaveCount(0);
  await expect(page.locator('#gcCssAnchorCustom')).toBeVisible();
  await expect(page.locator('#gcCssMarginY')).toBeDisabled();
});

test('glisser le titre : aimanté près d’un emplacement, libre ailleurs', async ({ page }) => {
  await openTitles(page);
  const frame = page.locator('#titleFrame');
  const ghost = page.locator('#mapWithFrames > .overlay-snap-ghost');
  const host = await page.locator('#mapWithFrames').boundingBox();

  // Vers le coin bas-gauche (à ~20 px de l'emplacement exact).
  let box = await frame.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(host.x + 30 + box.width / 2, host.y + host.height - 10 - box.height - 15 + box.height / 2, { steps: 10 });
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('data-anchor', 'bottom-left');
  await page.mouse.up();
  await expect(ghost).toBeHidden();
  await expect(page.locator('#overlayAnchor-bottom-left')).toBeChecked();
  await expect.poll(async () => {
    const b = await boxIn(page, '#titleFrame');
    return [Math.round(b.x), Math.round(b.bottom)];
  }).toEqual([10, 10]);
  // Le thème est marqué modifié (le dépôt passe par le suivi du formulaire).
  await expect(page.locator('#current-profile-indicator')).toHaveClass(/unsaved/);

  // Au milieu de la carte : position libre (en %), aucun emplacement coché.
  box = await frame.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2, { steps: 10 });
  await expect(ghost).toBeHidden();
  await page.mouse.up();
  await expect(page.locator('input[name="overlayAnchor"]:checked')).toHaveCount(0);
  await expect(page.locator('#gcCssAnchorCustom')).toBeVisible();
  await expect(page.locator('#inputTitleCss')).toHaveValue(/%/);
  const free = await boxIn(page, '#titleFrame');
  expect(Math.abs(free.x + free.width / 2 - host.width / 2)).toBeLessThan(3);

  // Saisir les infos bascule le formulaire sur elles.
  const infos = page.locator('#infosFrame');
  if (await infos.isVisible()) {
    const ib = await infos.boundingBox();
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#gcCssTargetInfos')).toHaveClass(/active/);
  }
});

test('les piles de stats contournent le titre où qu’il soit', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '0e01a001', kind: 'counter', metric: 'summary', position: { anchor: 'bottom-left' } },
    { id: '0e01a002', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-left' } },
  ] });
  await openTitles(page);
  const panelBox = (id) => boxIn(page, `canvas.stats-panel[data-panel-id="${id}"]`);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Titre en haut à gauche : la pile du bas ne bouge pas.
  const before = await panelBox('0e01a001');
  expect(Math.round(before.bottom)).toBe(16);

  // Titre en bas à gauche : la pile repart au-dessus de lui, entière.
  await page.locator('label[for="overlayAnchor-bottom-left"]').click();
  await expect.poll(async () => {
    const t = await boxIn(page, '#titleFrame');
    const first = await panelBox('0e01a001');
    const second = await panelBox('0e01a002');
    return first.y + first.height <= t.y - 7.5 && second.y + second.height <= first.y;
  }).toBe(true);

  // Retour en haut : la pile revient à sa marge.
  await page.locator('label[for="overlayAnchor-top-left"]').click();
  await expect.poll(async () => Math.round((await panelBox('0e01a001')).bottom)).toBe(16);
});
