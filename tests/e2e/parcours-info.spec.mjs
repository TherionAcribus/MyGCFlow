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

  // Nom sur deux lignes : la case écrit le réglage du thème.
  await expect(page.locator('#parcoursInfoTwoLines')).not.toBeChecked();
  await page.locator('#parcoursInfoTwoLines').check();
  await expect.poll(async () => (await info(page)).settings.two_lines).toBe(true);
  await page.locator('#parcoursInfoTwoLines').uncheck();
  await expect.poll(async () => (await info(page)).settings.two_lines).toBe(false);
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

  // Le code GC seul suffit à une fiche : les étapes en ont un.
  await page.locator('#parcoursInfoCode').check();
  await expect.poll(async () => (await info(page)).settings.code).toBe(true);
  await expect(page.locator('#parcoursInfoEmptyHint')).toBeHidden();
  await expect.poll(async () => (await info(page)).rest.near.length).toBeGreaterThan(2);

  // Le numéro d'étape aussi : toute étape comptée en porte un.
  await page.locator('#parcoursInfoCode').uncheck();
  await page.locator('#parcoursInfoStep').check();
  await expect.poll(async () => (await info(page)).settings.step).toBe(true);
  await expect.poll(async () => (await info(page)).rest.near.length).toBeGreaterThan(2);
  await page.locator('#parcoursInfoStep').uncheck();
  await page.locator('#parcoursInfoName').check();
  expect(errors).toEqual([]);
});

test('filtre du permanent : seuil D/T, contrôles grisés hors permanent', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  await openInfoTab(page);

  // Hors permanent : le filtre est grisé.
  await expect(page.locator('#parcoursInfoFilter')).toBeDisabled();
  await page.locator('#parcoursInfoNear').selectOption('all');
  await expect(page.locator('#parcoursInfoFilter')).toBeEnabled();
  await expect(page.locator('#parcoursInfoFilterDt')).toBeDisabled();
  await expect.poll(async () => (await info(page)).rest.near.length).toBeGreaterThan(2);
  const all = (await info(page)).rest.near.length;

  // Fixture : D 1,5 / T 2 partout — au seuil 3 (le défaut), plus rien.
  await page.locator('#parcoursInfoFilter').selectOption('dt');
  await expect(page.locator('#parcoursInfoFilterDt')).toBeEnabled();
  await expect.poll(async () => (await info(page)).settings).toMatchObject({ filter: 'dt', filter_dt: 3 });
  await expect.poll(async () => (await info(page)).rest.near).toEqual([]);
  // Au seuil 1, tout repasse.
  await page.locator('#parcoursInfoFilterDt').fill('1');
  await expect.poll(async () => (await info(page)).rest.near.length).toBe(all);

  // Retour en temporaire : le filtre réglé est sans effet — grisé et signalé.
  await page.locator('#parcoursInfoNear').selectOption('current');
  await expect(page.locator('#parcoursInfoFilter')).toBeDisabled();
  await expect(page.locator('#helpInfoFilter')).toBeVisible();
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

test('lieux et bases : la case ouvre la fiche du lieu, nom seul', async ({ page, request }) => {
  const { id } = (await (await request.get('/api/parcours')).json()).parcours[0];
  const created = await request.post(`/api/parcours/${id}/places`, {
    data: { kind: 'place', name: 'Belvédère', lat: 45.903, lon: 6.125, date: '2025-07-12', time: '09:45' },
  });
  expect(created.status()).toBe(201);
  const errors = collectErrors(page);
  await openReady(page);
  await openInfoTab(page);

  // Permanent : le lieu n'a pas de fiche tant que la case est décochée.
  await page.locator('#parcoursInfoNear').selectOption('all');
  await expect.poll(async () => (await info(page)).rest.near.length).toBeGreaterThan(2);
  expect((await info(page)).rest.near.some((key) => key.startsWith('place:'))).toBe(false);

  // Cochée : la fiche du lieu apparaît.
  await page.locator('#parcoursInfoPlaces').check();
  await expect.poll(async () => (await info(page)).settings.places).toBe(true);
  await expect.poll(async () => (await info(page)).rest.near.some((key) => key.startsWith('place:'))).toBe(true);

  // Décochée : elle disparaît.
  await page.locator('#parcoursInfoPlaces').uncheck();
  await expect.poll(async () => (await info(page)).rest.near.some((key) => key.startsWith('place:'))).toBe(false);
  expect(errors).toEqual([]);
});

test('tout réinitialiser : l’onglet revient aux défauts après confirmation', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  await openInfoTab(page);

  // Des réglages bien éloignés des défauts.
  await page.locator('#parcoursInfoNear').selectOption('all');
  await page.locator('#parcoursInfo [data-info-design="banner"]').click();
  await page.locator('#parcoursInfoSize').fill('20');
  await page.locator('#parcoursInfoPlaces').check();
  await expect.poll(async () => (await info(page)).settings).toMatchObject({
    near: 'all', design: 'banner', size: 20, places: true,
  });

  // Le bouton demande confirmation ; annuler ne change rien.
  await page.locator('#parcoursInfoReset').click();
  await expect(page.locator('.gcm-confirm-modal')).toBeVisible();
  await page.locator('.gcm-confirm-modal [data-gcm-role="cancel"]').click();
  await expect(page.locator('.gcm-confirm-modal')).toHaveCount(0);
  await expect.poll(async () => (await info(page)).settings.near).toBe('all');

  // Confirmé : tout revient aux défauts — fiche coupée comprise.
  await page.locator('#parcoursInfoReset').click();
  await page.locator('.gcm-confirm-modal [data-gcm-role="confirm"]').click();
  await expect.poll(async () => (await info(page)).settings).toMatchObject({
    near: 'none', fixed: 'none', design: 'card', size: 13, places: false, two_lines: false,
    name: true, dt: true, favorites: true, owner: false,
  });
  await expect(page.locator('#parcoursInfoOn')).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('réglage par étape : masquée jamais, forcée passe outre le filtre', async ({ page, request }) => {
  const { id } = (await (await request.get('/api/parcours')).json()).parcours[0];
  const errors = collectErrors(page);
  // Les patchs passent par l'API : la page est rechargée pour les relire.
  // Les patchs passent par l'API : la page est rechargée pour les relire,
  // et les réglages de la fiche (en mémoire) sont reposés à chaque fois.
  const openFiltered = async () => {
    await openReady(page);
    await openInfoTab(page);
    await page.locator('#parcoursInfoNear').selectOption('all');
    await page.locator('#parcoursInfoFilter').selectOption('dt');
    await expect.poll(async () => (await info(page)).settings).toMatchObject({ near: 'all', filter: 'dt' });
  };
  const setCard = async (key, infoCard) => {
    const patch = await request.patch(`/api/parcours/${id}/overrides`, { data: { overrides: [{ key, infoCard }] } });
    expect(patch.ok()).toBeTruthy();
    await openFiltered();
  };
  await setCard('GCPAR04', 'hide');

  // Filtre D/T au seuil 3 : la fixture (D 1,5 / T 2 partout) vide tout.
  await expect.poll(async () => (await info(page)).rest.near).toEqual([]);

  // Filtre retiré : toutes les étapes ont leur fiche, sauf GCPAR04 masquée.
  await page.locator('#parcoursInfoFilter').selectOption('all');
  await expect.poll(async () => (await info(page)).rest.near.length).toBeGreaterThan(2);
  expect((await info(page)).rest.near).not.toContain('GCPAR04');

  // GCPAR02 forcée : seule rescapée du filtre.
  await page.locator('#parcoursInfoFilter').selectOption('dt');
  await setCard('GCPAR02', 'force');
  await expect.poll(async () => (await info(page)).rest.near).toEqual(['GCPAR02']);

  // Retiré, le filtre s'applique à nouveau à toutes.
  await setCard('GCPAR02', null);
  await expect.poll(async () => (await info(page)).rest.near).toEqual([]);
  expect(errors).toEqual([]);
});
