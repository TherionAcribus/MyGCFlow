// Spec temporaire d'audit UX de la page Parcours (/parcours) : captures
// d'écran dans %TEMP%\parcours-ux-audit + relevé des contrôles et des
// messages console. À supprimer après usage.
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  cleanUp,
  clearLogs,
  collectErrors,
  createWeekend,
  deleteAllParcours,
  importFixture,
  openEnrichSection,
  openParcoursPage,
  openStopsMenu,
  snapshot,
} from './parcours-helpers.mjs';

const OUT = path.join(os.tmpdir(), 'parcours-ux-audit');
mkdirSync(OUT, { recursive: true });

const consoleMessages = [];

function attachConsole(page) {
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) {
      consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`SHOT ${name}.png`);
}

// Compte les contrôles visibles dans un volet (id), direct ou sous-volet.
async function countControls(page, paneId = null) {
  return page.evaluate((id) => {
    const pane = id
      ? document.getElementById(id)
      : document.querySelector('#tabsPanel .tab-content > .tab-pane.active');
    if (!pane) return null;
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const controls = [...pane.querySelectorAll('input,select,button,textarea')].filter(visible);
    return { pane: pane.id, controls: controls.length };
  }, paneId);
}

// Défile un conteneur jusqu'à rendre le sélecteur visible, puis capture.
async function scrollIntoViewShot(page, selector, name) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, name);
}

// Premier ancêtre scrollable du sélecteur, pour les captures « plein panneau »
// (ElementHandle : un nœud DOM ne traverse pas page.evaluate en retour).
async function scrollableAncestor(page, selector) {
  const handle = await page.evaluateHandle((sel) => {
    let node = document.querySelector(sel);
    while (node) {
      if (node.scrollHeight > node.clientHeight + 4
          && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
      node = node.parentElement;
    }
    return null;
  }, selector);
  return (await handle.jsonValue()) === null ? null : handle.asElement();
}

test.beforeEach(async ({ request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
});

test.afterEach(async ({ request }) => {
  await cleanUp(request);
});

test('état vide', async ({ page }) => {
  attachConsole(page);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openParcoursPage(page);
  await expect(page.locator('#parcoursListEmpty')).toBeVisible();
  await shot(page, '01-empty-data');
  console.log(`CONTROLS empty/data ${JSON.stringify(await countControls(page))}`);
  expect(errors).toEqual([]);
});

test.skip('audit complet', async ({ page, request }) => {
  test.setTimeout(300_000);
  attachConsole(page);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await importFixture(page, request);
  await createWeekend(request, 'Week-end à Annecy');
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await page.waitForTimeout(500);

  // --- 2. Onglet Données, parcours ouvert ---------------------------------
  await shot(page, '02-data-top');
  console.log(`CONTROLS data ${JSON.stringify(await countControls(page))}`);

  // Défilement du panneau vers la liste des étapes.
  const steps = await scrollableAncestor(page, '.parcours-area-stops');
  if (steps) {
      await page.evaluate((el) => { el.scrollTop = el.scrollHeight * 0.35; }, steps);
      await page.waitForTimeout(300);
      await shot(page, '03-data-stops-scroll-1');
      await page.evaluate((el) => { el.scrollTop = el.scrollHeight * 0.7; }, steps);
      await page.waitForTimeout(300);
      await shot(page, '04-data-stops-scroll-2');
      await page.evaluate((el) => { el.scrollTop = el.scrollHeight; }, steps);
      await page.waitForTimeout(300);
      await shot(page, '05-data-stops-scroll-3');
      await page.evaluate((el) => { el.scrollTop = 0; }, steps);
  } else {
    await scrollIntoViewShot(page, '.parcours-area-stops', '03-data-stops');
  }

  // --- 3. Sections « Enrichir le parcours » -------------------------------
  for (const key of ['tracks', 'routing', 'collect']) {
    const section = page.locator(`details[data-enrich-key="${key}"]`);
    if (await section.count() === 0 || !(await section.isVisible())) {
      console.log(`SKIP enrich ${key} (masqué)`);
      continue;
    }
    await openEnrichSection(page, key);
    await scrollIntoViewShot(page, `details[data-enrich-key="${key}"]`, `0${['tracks', 'routing', 'collect'].indexOf(key) + 6}-enrich-${key}`);
  }
  // Replier pour la suite.
  for (const key of ['tracks', 'routing', 'collect']) {
    const section = page.locator(`details[data-enrich-key="${key}"]`);
    if (await section.count() && (await section.evaluate((n) => n.open).catch(() => false))) {
      await section.locator('summary').click();
    }
  }

  // --- 4. Étapes : panneau d'ajustement, menu ⋯, pose d'un lieu -----------
  const firstStop = page.locator('.parcours-stop').first();
  if (await firstStop.count()) {
    await firstStop.scrollIntoViewIfNeeded();
    await firstStop.locator('.parcours-stop-text').click();
    await page.waitForTimeout(400);
    await scrollIntoViewShot(page, '.parcours-stop-edit', '09-stop-edit-open');
    // Refermer : nouveau clic sur le texte de la ligne.
    await firstStop.locator('.parcours-stop-text').click();
  }
  await openStopsMenu(page);
  await shot(page, '10-stops-more-menu');
  await page.keyboard.press('Escape');

  // Poser un lieu : bouton, clic carte, formulaire.
  const addPlace = page.locator('#btnParcoursAddPlace');
  if (await addPlace.count() && await addPlace.isVisible()) {
    await addPlace.scrollIntoViewIfNeeded();
    await addPlace.click();
    await expect(page.locator('#parcoursPlaceHint')).toBeVisible();
    await shot(page, '11-place-picking-hint');
    const mapBox = await page.locator('#map').boundingBox();
    await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
    const form = page.locator('#parcoursPlaceForm');
    await expect(form).toBeVisible();
    await shot(page, '12-place-form');
    await form.locator('#btnParcoursPlaceCancel').click();
  }

  // --- 5. Popup d'une étape sur la carte ----------------------------------
  try {
    const pixel = (await snapshot(page)).stopPixels?.GCPAR01;
    if (pixel) {
      const box = await page.locator('.ol-viewport').boundingBox();
      await page.mouse.click(box.x + pixel[0], box.y + pixel[1]);
      await expect(page.locator('#gcPopup.is-visible')).toBeVisible({ timeout: 5_000 });
      await shot(page, '13-map-stop-popup');
      await page.keyboard.press('Escape');
      await page.locator('#gcPopup .btn-close, #gcPopup .parcours-bubble-close').first().click().catch(() => {});
    }
  } catch (err) {
    console.log(`SKIP map popup: ${err.message}`);
  }

  // --- 6. Autres onglets principaux et sous-onglets ------------------------
  const mainTabs = ['style', 'animation', 'photos', 'settings'];
  for (const tab of mainTabs) {
    await page.locator(`#mainTabs a[href="#${tab}"]`).click();
    await page.waitForTimeout(400);
    // Sous-onglets visibles du volet.
    const subTabs = await page.evaluate((tabId) => {
      const pane = document.getElementById(tabId);
      if (!pane) return [];
      const visible = (n) => n.offsetParent !== null;
      return [...pane.querySelectorAll('.nav-link[data-bs-toggle="tab"]')]
        .filter(visible)
        .map((n) => n.getAttribute('href') || n.getAttribute('data-bs-target'))
        .filter(Boolean);
    }, tab);
    if (subTabs.length === 0) {
      await shot(page, `tab-${tab}`);
      console.log(`CONTROLS ${tab} ${JSON.stringify(await countControls(page, tab))}`);
    } else {
      console.log(`CONTROLS ${tab} (volet entier) ${JSON.stringify(await countControls(page, tab))}`);
      for (const href of subTabs) {
        await page.locator(`#${tab} .nav-link[href="${href}"], #${tab} .nav-link[data-bs-target="${href}"]`).first().click();
        await page.waitForTimeout(400);
        const name = `tab-${tab}${href.replace('#', '-')}`;
        await shot(page, name);
        console.log(`CONTROLS ${href} ${JSON.stringify(await countControls(page, href.slice(1)))}`);
      }
      // Revenir au premier sous-onglet pour la suite.
      await page.locator(`#${tab} .nav-link[href="${subTabs[0]}"], #${tab} .nav-link[data-bs-target="${subTabs[0]}"]`).first().click();
    }
  }

  // --- 7. Lecture ----------------------------------------------------------
  await page.locator('#mainTabs a[href="#data"]').click();
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(true);
  await page.waitForTimeout(2000);
  await shot(page, '60-playing');
  const pause = page.locator('#btnQuickPause');
  if (await pause.isVisible()) {
    await pause.click();
    await page.waitForTimeout(500);
    await shot(page, '61-paused');
    // Stop.
    const stop = page.locator('#btnQuickStop');
    if (await stop.isVisible()) await stop.click();
    await expect.poll(async () => (await snapshot(page)).running, { timeout: 15_000 }).toBe(false);
  }

  // --- 8. Petits viewports --------------------------------------------------
  for (const [w, h, tag] of [[1024, 768, '1024x768'], [1280, 720, '1280x720']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
    for (const tab of ['data', ...mainTabs]) {
      await page.locator(`#mainTabs a[href="#${tab}"]`).click();
      await page.waitForTimeout(400);
      await shot(page, `${tag}-tab-${tab}`);
    }
  }

  writeFileSync(path.join(OUT, 'console-messages.json'),
    JSON.stringify({ consoleMessages, pageErrors: errors }, null, 2));
});

test('audit suite : onglets, lecture, petits viewports', async ({ page, request }) => {
  test.setTimeout(300_000);
  attachConsole(page);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await importFixture(page, request);
  await createWeekend(request, 'Week-end à Annecy');
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await page.waitForTimeout(500);

  // --- 6. Autres onglets principaux et sous-onglets ------------------------
  const mainTabs = ['style', 'animation', 'photos', 'settings'];
  for (const tab of mainTabs) {
    await page.locator(`#mainTabs a[href="#${tab}"]`).click();
    await page.waitForTimeout(400);
    // Sous-onglets visibles du volet.
    const subTabs = await page.evaluate((tabId) => {
      const pane = document.getElementById(tabId);
      if (!pane) return [];
      const visible = (n) => n.offsetParent !== null;
      return [...pane.querySelectorAll('.nav-link[data-bs-toggle="tab"]')]
        .filter(visible)
        .map((n) => n.getAttribute('href') || n.getAttribute('data-bs-target'))
        .filter(Boolean);
    }, tab);
    if (subTabs.length === 0) {
      await shot(page, `tab-${tab}`);
      console.log(`CONTROLS ${tab} ${JSON.stringify(await countControls(page, tab))}`);
    } else {
      console.log(`CONTROLS ${tab} (volet entier) ${JSON.stringify(await countControls(page, tab))}`);
      for (const href of subTabs) {
        await page.locator(`#${tab} .nav-link[href="${href}"], #${tab} .nav-link[data-bs-target="${href}"]`).first().click();
        await page.waitForTimeout(400);
        const name = `tab-${tab}${href.replace('#', '-')}`;
        await shot(page, name);
        console.log(`CONTROLS ${href} ${JSON.stringify(await countControls(page, href.slice(1)))}`);
      }
      // Revenir au premier sous-onglet pour la suite.
      await page.locator(`#${tab} .nav-link[href="${subTabs[0]}"], #${tab} .nav-link[data-bs-target="${subTabs[0]}"]`).first().click();
    }
  }

  // --- 7. Lecture ----------------------------------------------------------
  await page.locator('#mainTabs a[href="#data"]').click();
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(true);
  await page.waitForTimeout(2000);
  await shot(page, '60-playing');
  const pause = page.locator('#btnQuickPause');
  if (await pause.isVisible()) {
    await pause.click();
    await page.waitForTimeout(500);
    await shot(page, '61-paused');
    // Stop.
    const stop = page.locator('#btnQuickStop');
    if (await stop.isVisible()) await stop.click();
    await expect.poll(async () => (await snapshot(page)).running, { timeout: 15_000 }).toBe(false);
  }

  // --- 8. Petits viewports --------------------------------------------------
  for (const [w, h, tag] of [[1024, 768, '1024x768'], [1280, 720, '1280x720']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
    for (const tab of ['data', ...mainTabs]) {
      await page.locator(`#mainTabs a[href="#${tab}"]`).click();
      await page.waitForTimeout(400);
      await shot(page, `${tag}-tab-${tab}`);
    }
  }

  writeFileSync(path.join(OUT, 'console-messages.json'),
    JSON.stringify({ consoleMessages, pageErrors: errors }, null, 2));
});
