// Page Parcours : étapes empilées (parcours_stack.mjs, docs/parcours.md) —
// au zoom courant, les étapes d'une même journée qui se recouvrent forment
// une pile « 1–3 », qui s'écarte en éventail au clic ; la lecture forme les
// mêmes piles. Fixture et nettoyage : parcours-helpers.mjs — journée 1 :
// GCPAR03, GCPAR01, GCPAR02 (à ~1,4 km) ; journée 2 : GCPAR04, GCPAR05.
import { expect, test } from '@playwright/test';
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

test.beforeEach(async ({ page, request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
  await importFixture(page, request);
  await createWeekend(request);
});

test.afterEach(async ({ request }) => {
  await cleanUp(request);
});

// Zoom 10 : chaque journée tient dans quelques pixels — une pile par
// journée (deux journées ne s'empilent jamais). Double-clic coupé : deux
// clics rapprochés au même pixel zoomeraient (zone-layer.spec.mjs).
async function openZoomedOut(page) {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await setZoom(page, 10, [6.14, 45.88]);
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.getMap().getInteractions().forEach((i) => {
      if (i instanceof ol.interaction.DoubleClickZoom) i.setActive(false);
    });
  });
}

async function setZoom(page, zoom, center) {
  await page.evaluate(async ([z, c]) => {
    const app = await import('/static/js/index.js');
    const view = app.getMap().getView();
    if (c) view.setCenter(ol.proj.fromLonLat(c));
    view.setZoom(z);
  }, [zoom, center]);
}

const PILES = [
  { key: 'GCPAR04', keys: ['GCPAR04', 'GCPAR05'], label: '4–5' },
  { key: 'GCPAR03', keys: ['GCPAR03', 'GCPAR01', 'GCPAR02'], label: '1–3' },
];

async function at(page, pixel) {
  const box = await page.locator('.ol-viewport').boundingBox();
  return { x: box.x + pixel[0], y: box.y + pixel[1] };
}

test('piles au repos : une par journée, éventail au clic, bulle, fermeture', async ({ page }) => {
  const errors = collectErrors(page);
  await openZoomedOut(page);
  await expect.poll(async () => (await snapshot(page)).stacks).toEqual(PILES);
  let snap = await snapshot(page);
  expect(snap.stacked.sort()).toEqual(['GCPAR01', 'GCPAR02', 'GCPAR05']);
  expect(snap.stopStyles.GCPAR03).toMatchObject({ label: '1–3', radius: 13 });

  // Liste → carte : l'étape cachée met sa pile en évidence.
  await page.locator('.parcours-stop[data-stop-key="GCPAR01"]').hover();
  await expect.poll(async () => (await snapshot(page)).hovered).toBe('GCPAR03');
  // Carte → liste : la pile surligne toutes ses lignes.
  const pile = await at(page, snap.stopPixels.GCPAR03);
  await page.mouse.move(pile.x, pile.y);
  await expect.poll(async () => (await snapshot(page)).mapHover.sort()).toEqual(['GCPAR01', 'GCPAR02', 'GCPAR03']);

  // Clic : l'éventail, sans bulle.
  await page.mouse.click(pile.x, pile.y);
  await expect.poll(async () => (await snapshot(page)).fan?.keys).toEqual(['GCPAR03', 'GCPAR01', 'GCPAR02']);
  await expect(page.locator('#gcPopup')).toBeHidden();
  snap = await snapshot(page);
  // Pastilles de l'éventail à distance du centre et entre elles.
  const pixels = ['GCPAR03', 'GCPAR01', 'GCPAR02'].map((key) => snap.fanPixels[key]);
  for (const [x, y] of pixels) expect(Math.hypot(x - snap.stopPixels.GCPAR03[0], y - snap.stopPixels.GCPAR03[1])).toBeGreaterThan(22);

  // Une étape de l'éventail ouvre sa bulle ; l'éventail reste ouvert.
  const item = await at(page, snap.fanPixels.GCPAR01);
  await page.mouse.click(item.x, item.y);
  await expect(page.locator('#gcPopup.is-visible .parcours-bubble[data-stop-key="GCPAR01"]')).toBeVisible();
  expect((await snapshot(page)).fan).not.toBeNull();

  // Échap referme l'éventail (et la bulle).
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await snapshot(page)).fan).toBe(null);
  await expect(page.locator('#gcPopup')).toBeHidden();

  // Clic ailleurs : refermé aussi.
  await page.mouse.click(pile.x, pile.y);
  await expect.poll(async () => (await snapshot(page)).fan).not.toBe(null);
  const box = await page.locator('.ol-viewport').boundingBox();
  await page.mouse.click(box.x + 30, box.y + box.height - 30);
  await expect.poll(async () => (await snapshot(page)).fan).toBe(null);

  // Sans numéros : « ×3 ».
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabPoints"]').click();
  await page.locator('#parcoursStyleNumbers').selectOption('none');
  await expect.poll(async () => (await snapshot(page)).stacks.map((s) => s.label)).toEqual(['×2', '×3']);

  // Zoom avant : plus de pile.
  await setZoom(page, 15, [6.122, 45.902]);
  await expect.poll(async () => (await snapshot(page)).stacks).toEqual([]);
  expect((await snapshot(page)).stacked).toEqual([]);
  expect(errors).toEqual([]);
});

test('lecture : les piles se forment comme au repos (« 1–2 » puis « 1–3 »)', async ({ page, request }) => {
  // Caméra fixe : la vue garde le zoom arrière pendant la lecture.
  const response = await request.put('/api/settings', { data: { parcours_playback: { camera: 'fixed' } } });
  expect(response.ok()).toBeTruthy();
  const errors = collectErrors(page);
  await openZoomedOut(page);
  await expect.poll(async () => (await snapshot(page)).stacks).toEqual(PILES);
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    window.__piles = new Set();
    window.__pilesTimer = setInterval(() => {
      for (const label of app.getParcoursSnapshot().playStops.piles) window.__piles.add(label);
    }, 20);
  });
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(true);
  await expect.poll(async () => (await snapshot(page)).running, { timeout: 60_000 }).toBe(false);
  const seen = await page.evaluate(() => {
    clearInterval(window.__pilesTimer);
    return [...window.__piles].sort();
  });
  expect(seen).toEqual(['1–2', '1–3', '4–5']);
  // Dernière image : les piles du repos.
  expect((await snapshot(page)).playStops.piles.sort()).toEqual(['1–3', '4–5']);
  expect(errors).toEqual([]);
});
