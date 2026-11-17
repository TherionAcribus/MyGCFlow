// Page Parcours : barre de chronologie (timeline_bar.js, crochet timelineBar
// de parcours_data.js). Un « jour » du moteur y est un quantum de temps écran
// sur des dates fictives : la barre montre les vraies journées et heures,
// saute d'étape en étape et de journée en journée, sans bornes à tirer.
//
// Fixture my-finds-parcours.gpx : deux journées autour d'Annecy (trois étapes
// le 12/07/2025, deux le 13), donc une nuit entre les deux.
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

function bar(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getTimelineBarSnapshot());
}

function playbackState(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).previewPlaybackState());
}

async function axisX(page, axisOffset) {
  const box = await page.locator('#timelineBarTrack').boundingBox();
  const snap = await bar(page);
  return box.x + (axisOffset + 0.5) / snap.axisSpan * box.width;
}

async function trackMidY(page) {
  const box = await page.locator('#timelineBarTrack').boundingBox();
  return box.y + box.height / 2;
}

async function hideToolbarTooltip(page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  await expect(page.locator('.tooltip.show')).toHaveCount(0);
}

async function openWithBar(page) {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await expect(page.locator('#btnTimelineBar')).toBeVisible();
  await page.locator('#btnTimelineBar').click();
  await expect(page.locator('#timelineBar')).toBeVisible();
  await hideToolbarTooltip(page);
  return snapshot(page);
}

test('barre : vraies journées et heures, saut sur une étape, d’étape en étape et de journée en journée', async ({ page }) => {
  const errors = collectErrors(page);
  const rest = await openWithBar(page);
  const { quanta, stopQ, nightLegs } = rest.timeline;
  expect(stopQ).toHaveLength(5);
  expect(nightLegs).toBe(1);

  // Piste = le parcours entier, sans marges ni poignées ; nuit en bande,
  // journées étiquetées ; repères en vraies dates.
  const idle = await bar(page);
  expect(idle.axisSpan).toBe(quanta);
  expect(idle.rangeOffset).toBe(0);
  expect(idle.rangeEditable).toBe(false);
  expect(idle.ticks.bands).toHaveLength(1);
  expect(idle.ticks.labels.map((label) => label.text)).toEqual(['Jour 1', 'Jour 2']);
  expect(idle.ticks.labels[1].offset).toBe(stopQ[3]);
  await expect(page.locator('#timelineBarStart')).toContainText('12 juil.');
  await expect(page.locator('#timelineBarEnd')).toContainText('13 juil.');
  expect(idle.valueText).toMatch(/^dim\. 13 juil\. · .*5 étapes/);

  // Clic sur l'arrivée à la 2e étape : aperçu ouvert en pause, géocacheur
  // sur l'étape, ligne de la barre en vraie date.
  // La piste ne change pas de largeur au survol (étiquette à largeur fixe).
  const before = await page.locator('#timelineBarTrack').boundingBox();
  await page.mouse.move(await axisX(page, stopQ[1]), await trackMidY(page));
  await expect(page.locator('#timelineBarDate')).toContainText('sam. 12 juil.');
  expect((await page.locator('#timelineBarTrack').boundingBox()).width).toBe(before.width);
  await page.mouse.click(await axisX(page, stopQ[1]), await trackMidY(page));
  await expect.poll(() => playbackState(page)).toBe('paused');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(stopQ[1]);
  const atStop = await snapshot(page);
  expect(atStop.head.leg).toBe(-1);
  expect(atStop.infos.jour).toBe('1');
  await expect(page.locator('#timelineBarDate')).toContainText('sam. 12 juil.');
  await expect(page.locator('#timelineBarDate')).toContainText('2 étapes');

  // Ctrl+→ : étape suivante ; Pg.Suiv : journée suivante ; Pg.Préc : retour.
  await page.keyboard.press('Control+ArrowRight');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(stopQ[2]);
  await page.keyboard.press('PageUp');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(stopQ[3]);
  await expect(page.locator('#timelineBarDate')).toContainText('dim. 13 juil.');
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(stopQ[0]);
  expect(await playbackState(page)).toBe('paused');

  // Clic droit : pas de menu de bornes sur cette page.
  await page.mouse.click(await axisX(page, stopQ[2]), await trackMidY(page), { button: 'right' });
  await expect(page.locator('.timeline-bar-menu')).toHaveCount(0);

  await page.locator('#btnQuickStop').click();
  await expect.poll(() => playbackState(page)).toBe('idle');
  expect(errors).toEqual([]);
});

test('bulle : étape, trajet et nuit au survol, sans toucher la carte', async ({ page }) => {
  const errors = collectErrors(page);
  const rest = await openWithBar(page);
  const { stopQ } = rest.timeline;
  const tip = page.locator('.timeline-bar-tip');

  await page.mouse.move(await axisX(page, stopQ[0]), await trackMidY(page));
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Jour 1 · sam. 12 juil.');
  await expect(tip).toContainText('Étape 1 : ');
  await expect(tip).toContainText('Total : 1 étape');

  // Milieu du premier trajet : en route vers la 2e étape.
  await page.mouse.move(await axisX(page, Math.round((stopQ[0] + 12 + stopQ[1]) / 2)), await trackMidY(page));
  await expect(tip).toContainText(/Trajet (à pied|à vélo|en voiture) vers /);

  // Milieu de la nuit : date et heure du lendemain.
  const night = (await bar(page)).ticks.bands[0];
  await page.mouse.move(await axisX(page, Math.round((night.from + night.to) / 2)), await trackMidY(page));
  await expect(tip).toContainText('Nuit');
  await expect(tip).toContainText('Jour 2 · dim. 13 juil.');

  expect(await playbackState(page)).toBe('idle');
  expect(errors).toEqual([]);
});
