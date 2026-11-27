// Page Parcours : fiche des caches (nom, D/T, propriétaire, PF) à côté des
// étapes ou dans un cartouche, réglée dans l'onglet Style › Fiches (bloc du
// thème points.parcours_info, parcours_info.mjs, docs/parcours.md).
//
// Réglages posés en mémoire par l'interface, thème jamais enregistré : rien à
// remettre en sortie hormis les données et la caméra (cleanUp).
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

async function openReady(page) {
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  return snapshot(page);
}

async function openInfoTab(page) {
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabParcoursInfo"]').click();
  await expect(page.locator('#parcoursInfo')).toBeVisible();
}

const info = async (page) => (await snapshot(page)).info;

async function playUntil(page, predicate) {
  await expect.poll(async () => predicate((await info(page)).play), { timeout: 30_000, intervals: [100] })
    .toBe(true);
}

async function stopPlayback(page) {
  await page.locator('#btnQuickStop').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(false);
}

test('défauts : fiche coupée, sous-onglet Fiches avec ses quatre designs', async ({ page }) => {
  const errors = collectErrors(page);
  const snap = await openReady(page);
  expect(snap.info.settings).toMatchObject({ near: 'none', fixed: 'none', name: true, dt: true, owner: false, favorites: true, design: 'card' });
  expect(snap.info.rest.near).toEqual([]);
  await openInfoTab(page);
  await expect(page.locator('#parcoursInfo [data-info-design]')).toHaveCount(4);
  await expect(page.locator('#parcoursInfo [data-info-design="card"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#parcoursInfoOffHint')).toBeVisible();
  await expect(page.locator('#parcoursInfoEmptyHint')).toBeHidden();
  // Coupée, mais le sous-onglet ouvert épingle une fiche d'exemple.
  await expect.poll(async () => (await info(page)).rest.preview).not.toBeNull();
  const pinned = (await info(page)).rest;
  expect(pinned.near).toEqual([pinned.preview]);
  // Coupée par défaut : l'interrupteur est levé.
  await expect(page.locator('#parcoursInfoOn')).not.toBeChecked();
  // Les vignettes sont dessinées (canevas non vide).
  await expect.poll(() => page.locator('#parcoursInfo [data-info-design="tag"] canvas').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  })).toBe(true);

  await page.locator('#parcoursInfo [data-info-design="banner"]').click();
  await expect.poll(async () => (await info(page)).settings.design).toBe('banner');
  await expect(page.locator('#parcoursInfo [data-info-design="banner"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#parcoursInfo [data-info-design="card"]')).toHaveAttribute('aria-pressed', 'false');
  // Bandeau : le fond prend la couleur d'accent et le texte s'y adapte —
  // les couleurs de texte et de fond sont grisées, pas les autres designs.
  await expect(page.locator('#parcoursInfoTextColor')).toBeDisabled();
  await expect(page.locator('#parcoursInfoBackgroundColor')).toBeDisabled();
  await page.locator('#parcoursInfo [data-info-design="card"]').click();
  await expect(page.locator('#parcoursInfoTextColor')).toBeEnabled();
  await expect(page.locator('#parcoursInfoBackgroundColor')).toBeEnabled();
  // La taille du texte se juge dans la vignette : grande taille, fiche
  // dessinée plus large.
  const drawnSpan = () => page.locator('#parcoursInfo [data-info-design="card"] canvas').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let maxX = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    return maxX - minX;
  });
  await page.locator('#parcoursInfoSize').fill('9');
  await expect.poll(async () => (await info(page)).settings.size).toBe(9);
  const small = await drawnSpan();
  await page.locator('#parcoursInfoSize').fill('28');
  await expect.poll(async () => (await info(page)).settings.size).toBe(28);
  const large = await drawnSpan();
  expect(large).toBeGreaterThan(small * 1.8);
  expect(errors).toEqual([]);
});

test('interrupteur : active en temporaire, restaure la dernière configuration', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  await openInfoTab(page);

  // Enclencher sans configuration passée : temporaire à côté de la cache.
  await page.locator('#parcoursInfoOn').check();
  await expect.poll(async () => (await info(page)).settings).toMatchObject({ near: 'current', fixed: 'none' });
  await expect(page.locator('#parcoursInfoOffHint')).toBeHidden();
  // L'aide suit le mode choisi : temporaire seule, sans le cartouche.
  await expect(page.locator('#helpInfoCurrent')).toBeVisible();
  await expect(page.locator('#helpInfoAll')).toBeHidden();
  await expect(page.locator('#helpInfoFixed')).toBeHidden();
  await expect(page.locator('#helpInfoDuration')).toBeHidden();

  // Permanent sans cartouche : son aide, et celle de la durée grisée.
  await page.locator('#parcoursInfoNear').selectOption('all');
  await expect(page.locator('#helpInfoAll')).toBeVisible();
  await expect(page.locator('#helpInfoCurrent')).toBeHidden();
  await expect(page.locator('#helpInfoDuration')).toBeVisible();
  // Avec un cartouche, la durée vaut pour lui : son aide disparaît.
  await page.locator('#parcoursInfoFixed').selectOption('bottom');
  await expect.poll(async () => (await info(page)).settings).toMatchObject({ near: 'all', fixed: 'bottom' });
  await expect(page.locator('#helpInfoFixed')).toBeVisible();
  await expect(page.locator('#helpInfoDuration')).toBeHidden();
  await page.locator('#parcoursInfoOn').uncheck();
  await expect.poll(async () => (await info(page)).settings).toMatchObject({ near: 'none', fixed: 'none' });
  await expect(page.locator('#parcoursInfoOffHint')).toBeVisible();
  await page.locator('#parcoursInfoOn').check();
  await expect.poll(async () => (await info(page)).settings).toMatchObject({ near: 'all', fixed: 'bottom' });
  expect(errors).toEqual([]);
});

test('au repos : permanent sur les étapes, temporaire sur l’étape survolée, rien sans contenu', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  await openInfoTab(page);

  await page.locator('#parcoursInfoNear').selectOption('all');
  await expect.poll(async () => (await info(page)).rest.near.length).toBeGreaterThan(2);
  const all = (await info(page)).rest.near;
  expect(all.every((key) => key.startsWith('GCPAR'))).toBe(true);

  // Temporaire, sous-onglet ouvert : la fiche d'exemple reste épinglée tant
  // que rien n'est survolé.
  await page.locator('#parcoursInfoNear').selectOption('current');
  await expect.poll(async () => (await info(page)).rest.preview).not.toBeNull();
  // L'onglet Style quitté, l'exemple disparaît ; le survol prend le relais.
  await page.locator('a[href="#data"]').click();
  await expect.poll(async () => (await info(page)).rest).toMatchObject({ preview: null, near: [] });
  const row = page.locator('.parcours-stop[data-stop-key="GCPAR04"]');
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await expect.poll(async () => (await info(page)).rest).toMatchObject({ hover: 'GCPAR04', near: ['GCPAR04'] });

  // Plus rien de coché : aucune fiche, et l'onglet le dit.
  await openInfoTab(page);
  await page.locator('#parcoursInfoNear').selectOption('all');
  for (const id of ['#parcoursInfoName', '#parcoursInfoDt', '#parcoursInfoFavorites']) await page.locator(id).uncheck();
  await expect(page.locator('#parcoursInfoEmptyHint')).toBeVisible();
  await expect.poll(async () => (await info(page)).rest.near).toEqual([]);
  expect(errors).toEqual([]);
});

test('lecture : fiche temporaire à côté de l’étape en cours et cartouche en bas', async ({ page, request }) => {
  expect((await request.put('/api/settings', { data: { parcours_playback: { camera: 'fixed' } } })).ok()).toBeTruthy();
  const errors = collectErrors(page);
  await openReady(page);
  await openInfoTab(page);
  await page.locator('#parcoursInfoNear').selectOption('current');
  await page.locator('#parcoursInfoFixed').selectOption('bottom');
  await page.locator('#parcoursInfoDuration').fill('1');
  await page.locator('#parcoursInfoDuration').blur();
  await expect.poll(async () => (await info(page)).settings).toMatchObject({ near: 'current', fixed: 'bottom', duration: 1 });

  await page.locator('#btnQuickPreview').click();
  // Une seule fiche temporaire à la fois, la même dans le cartouche.
  await playUntil(page, (p) => p.current === 'GCPAR01' && p.near.length === 1 && p.near[0] === 'GCPAR01'
    && p.fixed === 'GCPAR01' && p.size?.[0] > 0);
  await playUntil(page, (p) => p.current === 'GCPAR02' && p.near[0] === 'GCPAR02' && p.fixed === 'GCPAR02');
  await stopPlayback(page);
  expect(errors).toEqual([]);
});

test('lecture : fiches permanentes sur les étapes atteintes, l’étape en cours en premier', async ({ page, request }) => {
  expect((await request.put('/api/settings', { data: { parcours_playback: { camera: 'fixed' } } })).ok()).toBeTruthy();
  const errors = collectErrors(page);
  await openReady(page);
  await openInfoTab(page);
  await page.locator('#parcoursInfoNear').selectOption('all');
  await page.locator('#parcoursInfo [data-info-design="tag"]').click();
  await expect.poll(async () => (await info(page)).settings).toMatchObject({ near: 'all', design: 'tag' });

  await page.locator('#btnQuickPreview').click();
  // Les fiches des étapes déjà vues restent ; celles sans place sont comptées
  // à part (`hidden`), l'étape en cours passe toujours.
  await playUntil(page, (p) => p.current === 'GCPAR02' && p.near[0] === 'GCPAR02'
    && p.near.length + p.hidden >= 3 && p.fixed === null);
  await stopPlayback(page);
  expect(errors).toEqual([]);
});
