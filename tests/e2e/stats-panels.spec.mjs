// Panneaux de statistiques posés sur la carte (onglet Stats).
//
// Le dessin (canvas) n'est pas comparé au pixel près : on observe l'état
// exposé par getStatsSnapshot() — mode, comptes, panneaux visibles, nombre de
// passes vidéo — et la géométrie des <canvas class="stats-panel">.
//
// Fixture : 6 caches, une par jour du 01 au 06/01/2026, D/T toutes distinctes
// (1/1 → 3,5/3,5), 3 Traditional, 2 Multi, 1 Event.
//
// `stats` est une préférence globale partagée par tous les specs d'un run :
// chaque test repart de la liste vide et la remet en place en sortant.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
const GAP_FIXTURE = path.join(HERE, 'fixtures', 'my-finds-gap.gpx');
const DEFAULT_STATS = { enabled: true, panels: [], evolution_panels: [] };

async function putStats(page, stats) {
  const response = await page.request.put('/api/settings', { data: { stats } });
  expect(response.ok()).toBe(true);
}

async function savedStats(page) {
  return (await (await page.request.get('/api/settings')).json()).stats;
}

// Bloc `stats` persisté, une fois `ready(stats)` vrai (écriture debouncée).
async function savedStatsWhen(page, ready) {
  let stats = null;
  await expect.poll(async () => {
    stats = await savedStats(page);
    return ready(stats);
  }).toBe(true);
  return stats;
}

async function openWithFixture(page, hash = '', fixture = FIXTURE, expectedCount = '6 / 6') {
  await page.goto(`/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(fixture);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Chargement et affichage des points' }).first())
    .toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#filtersCounter')).toContainText(expectedCount);
  // Les filtres se réappliquent encore un peu après l'import, chacun par une
  // reconstruction de l'index : attendre qu'il ne bouge plus.
  let previous = -1;
  await expect.poll(async () => {
    const revision = await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDateRevision);
    const stable = revision === previous;
    previous = revision;
    return stable;
  }, { intervals: [700], timeout: 15_000 }).toBe(true);
}

function snapshot(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getStatsSnapshot());
}

const sum = (counts) => Object.values(counts || {}).reduce((s, n) => s + n, 0);

async function setRhythm(page, daysPerSecond) {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#animationConfigTab').click();
  await page.locator('#inputDaysPerSecond').fill(String(daysPerSecond));
  await page.locator('#inputExtraEndTime').fill('0');
}

test.beforeEach(async ({ page }) => {
  await putStats(page, DEFAULT_STATS);
});

test.afterEach(async ({ page }) => {
  await putStats(page, DEFAULT_STATS);
  await expect.poll(async () => (await savedStats(page)).panels.length).toBe(0);
});

test('un modèle pose la matrice D/T, ancrée, empilée et retrouvée au redémarrage', async ({ page }) => {
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('#statsEmpty')).toBeVisible();

  await page.locator('#btnStatsAdd').click();
  await page.locator('[data-stats-preset="dt"]').click();

  const matrix = page.locator('canvas.stats-panel');
  await expect(matrix).toHaveCount(1);
  await expect(matrix).toBeVisible();
  // Ancre « en bas à gauche » : position exprimée depuis ce coin, convention
  // relue pour la vidéo.
  await expect(matrix).toHaveCSS('left', '16px');
  await expect(matrix).toHaveCSS('bottom', '16px');

  // Au repos : totaux de la sélection, toutes les caches dans la matrice.
  let state = await snapshot(page);
  expect(state.mode).toBe('rest');
  expect(state.total).toBe(6);
  expect(sum(state.counts.dt) + state.excluded.dt).toBe(6);
  expect(Object.keys(state.counts.dt)).toHaveLength(6);

  // Deux histogrammes sur le même coin : empilés, sans chevauchement.
  await page.locator('#btnStatsAdd').click();
  await page.locator('[data-stats-preset="types-sizes"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(3);
  const types = await page.locator('canvas.stats-panel').nth(1).boundingBox();
  const sizes = await page.locator('canvas.stats-panel').nth(2).boundingBox();
  expect(types && sizes).toBeTruthy();
  const [upper, lower] = [types, sizes].sort((a, b) => a.y - b.y);
  expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y);

  state = await snapshot(page);
  expect(state.counts.cache_type['Traditional Cache']).toBe(3);
  expect(state.counts.cache_type['Multi-cache']).toBe(2);

  // Persistance (debounce 500 ms), puis restauration au rechargement.
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.metric))
    .toEqual(['dt', 'cache_type', 'container']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(3, { timeout: 15_000 });
});

test('la galerie « Ajouter » montre des vignettes, se filtre et pose le panneau choisi', async ({ page }) => {
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await page.locator('#btnStatsAdd').click();
  const gallery = page.locator('#statsGalleryModal');
  await expect(gallery).toBeVisible();
  await expect(page.locator('#inputStatsGallerySearch')).toBeFocused();
  await expect(page.locator('#statsGallerySlots')).toHaveText('Places libres : 6 sur 6');

  // Vignettes dessinées avec les données : un canvas par panneau posé.
  const card = (selector) => gallery.locator(selector);
  await expect(card('[data-stats-preset="dt"] .stats-gallery-thumb canvas')).toHaveCount(1);
  await expect(card('[data-stats-preset="types-sizes"] .stats-gallery-thumb canvas')).toHaveCount(2);
  await expect(card('[data-stats-preset="dt"] .stats-gallery-thumb')).toHaveClass(/has-preview/);
  // Dessiner la galerie ne pose rien et ne touche pas aux comptes des panneaux.
  expect((await snapshot(page)).visible).toEqual([]);

  // Recherche : sans accents ni casse, sur le titre, la description et la forme.
  const search = page.locator('#inputStatsGallerySearch');
  await search.fill('anneau');
  await expect(card('[data-stats-add="donut:cache_type"]')).toBeVisible();
  await expect(card('[data-stats-add="bar:cache_type"]')).toBeHidden();
  await expect(card('[data-stats-preset="dt"]')).toBeHidden();
  await search.fill('EXTREME');
  await expect(card('[data-stats-preset="extremes"]')).toBeVisible();
  await expect(card('[data-stats-add="donut:cache_type"]')).toBeHidden();
  await search.fill('zzz introuvable');
  await expect(page.locator('#statsGalleryEmpty')).toBeVisible();
  await search.fill('');
  await expect(page.locator('#statsGalleryEmpty')).toBeHidden();
  await expect(card('[data-stats-add="bar:year"]')).toBeVisible();

  // Un clic pose le panneau, referme la galerie et le sélectionne.
  await card('[data-stats-add="donut:country"]').click();
  await expect(gallery).toBeHidden();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect(page.locator('#statsPanelList li.is-selected')).toHaveCount(1);
  await expect(page.locator('#selectStatsKind')).toHaveValue('donut');
});

test('un panneau apparaît en fondu à sa création', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await openWithFixture(page);
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);
  // Le nom d'animation reste posé après la fin du fondu : pas de chronométrage
  // d'opacité (flaky).
  await expect(canvas).toHaveCSS('animation-name', 'stats-panel-in');
});

test('un modèle à deux panneaux se désactive quand il ne reste qu\'une place', async ({ page }) => {
  const five = ['f0000001', 'f0000002', 'f0000003', 'f0000004', 'f0000005']
    .map((id, i) => ({ id, kind: 'bar', metric: 'cache_type', position: { anchor: 'top-right', dy: i * 8 } }));
  await putStats(page, { enabled: true, panels: five });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  // Une seule place sur six : les modèles à deux panneaux sont désactivés
  // avec la raison affichée ; les panneaux seuls restent proposés.
  await page.locator('#btnStatsAdd').click();
  const preset = page.locator('[data-stats-preset="types-sizes"]');
  await expect(preset).toBeDisabled();
  await expect(preset.locator('.stats-slots-hint')).toHaveText('2 places requises');
  await expect(page.locator('[data-stats-add="bar:year"]')).toBeEnabled();
  await expect(page.locator('#statsGallerySlots')).toHaveText('Places libres : 1 sur 6');

  // Une suppression libère la place : le modèle redevient cliquable et pose
  // bien ses deux panneaux d'un coup. (Échap ferme la galerie, sinon elle
  // recouvre la liste — une fois ouverte : pendant son fondu d'entrée, la
  // touche serait ignorée.)
  await expect(page.locator('#inputStatsGallerySearch')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#statsGalleryModal')).toBeHidden();
  await page.locator('#statsPanelList [data-action="delete"]').first().click();
  await page.locator('#btnStatsAdd').click();
  await preset.click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(6);
  // Le clic referme la galerie ; complète, elle le dit.
  await expect(page.locator('#statsGalleryModal')).toBeHidden();
  await page.locator('#btnStatsAdd').click();
  await expect(page.locator('#statsGallerySlots')).toContainText('Plus de place');
  await expect(page.locator('[data-stats-add="bar:year"]')).toBeDisabled();
});

test('la lecture remplit les panneaux jour après jour, l\'arrêt rend les totaux', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'aaaaaa01', kind: 'grid', metric: 'dt' },
    { id: 'bbbbbb01', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-right', dy: 64 } },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  await setRhythm(page, 2);

  await page.locator('#btnQuickPreview').click();
  // Au départ, aucune cache n'est antérieure à la date de début : l'état
  // courant repart de zéro puis grandit, il ne montre pas les totaux.
  await expect.poll(async () => {
    const state = await snapshot(page);
    return state.mode === 'animating' && state.total > 0 && state.total < 6;
  }, { intervals: [50], timeout: 10_000 }).toBe(true);

  // Fin naturelle : état final conservé, cohérent avec le compteur.
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(6);
  let state = await snapshot(page);
  expect(state.mode).toBe('animating');
  expect(sum(state.counts.dt) + state.excluded.dt).toBe(6);
  expect(state.counts.cache_type['Traditional Cache']).toBe(3);
  await expect(page.locator('#spanNbCaches')).toHaveText('6');

  // Nouveau filtre après la fin : totaux de la nouvelle sélection.
  await page.evaluate(() => {
    document.querySelector('#selectType').tomselect.setValue(['Traditional Cache']);
  });
  await expect(page.locator('#filtersCounter')).toContainText('3 / 6');
  await expect.poll(async () => {
    const s = await snapshot(page);
    return `${s.mode}:${s.total}`;
  }).toBe('rest:3');
  state = await snapshot(page);
  expect(state.counts.cache_type).toEqual({ 'Traditional Cache': 3 });
});

test('un saut dans la chronologie recalcule les comptes dans les deux sens', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'dddddd01', kind: 'grid', metric: 'dt' },
    { id: 'dddddd02', kind: 'counter', metric: 'summary' },
  ] });
  await openWithFixture(page, '#stats');
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Le saut n'est accepté que sur un aperçu en pause (barre de chronologie).
  const paused = await page.evaluate(async () =>
    (await import('/static/js/index.js')).startPausedPreview());
  expect(paused).toBe(true);
  const seek = (iso) => page.evaluate(async (d) =>
    (await import('/static/js/index.js')).seekAnimationToDate(new Date(d)), iso);

  // Fin du 04/01 : quatre trouvailles comptées (une par jour depuis le 01).
  expect(await seek('2026-01-04T00:00:00')).toBe(true);
  let state = await snapshot(page);
  expect(state.mode).toBe('animating');
  expect(state.total).toBe(4);
  expect(sum(state.counts.dt)).toBe(4);

  // En arrière : les jours retirés sont décomptés, l'état du 02/01 revient.
  // Les cases retirées restent à 0 (la clé est gardée — la barre glisse vers
  // 0 au lieu de disparaître, cf. stats_model › remove).
  expect(await seek('2026-01-02T00:00:00')).toBe(true);
  state = await snapshot(page);
  expect(state.total).toBe(2);
  expect(sum(state.counts.dt)).toBe(2);
  expect(Object.values(state.counts.dt).filter((n) => n > 0)).toHaveLength(2);

  // En avant jusqu'au bout : les six, comme le déroulé.
  expect(await seek('2026-01-06T00:00:00')).toBe(true);
  state = await snapshot(page);
  expect(state.total).toBe(6);
  expect(sum(state.counts.dt)).toBe(6);
  expect(Object.keys(state.counts.dt)).toHaveLength(6);

  await page.locator('#btnQuickStop').click();
  await expect.poll(() => page.evaluate(async () =>
    (await import('/static/js/index.js')).previewPlaybackState())).toBe('idle');
});

test('un export repart de zéro, même après un aperçu, et dessine les panneaux dans la vidéo', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await openWithFixture(page);
  await setRhythm(page, 6);

  // Aperçu complet : l'accumulateur finit à 6.
  await page.locator('#btnQuickPreview').click();
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(6);
  const drawsBefore = (await snapshot(page)).videoDrawCount;

  // Capture image par image (réglage en mémoire seulement : pas de
  // préférence globale modifiée pour les specs suivants).
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.record.mode = 'images';
    app.options.record.fps = 12;
    app.options.flash.mode = 'none';
  });
  await page.locator('#btnQuickExport').click({ force: true });
  // Le démarrage de l'enregistrement remet l'accumulateur à l'état initial.
  await expect.poll(async () => {
    const state = await snapshot(page);
    return state.mode === 'animating' && state.total < 6;
  }, { intervals: [50], timeout: 30_000 }).toBe(true);

  const ready = page.locator('#modal_video_ready');
  await expect(ready).toBeVisible({ timeout: 120_000 });
  const state = await snapshot(page);
  expect(state.total).toBe(6);
  expect(state.videoDrawCount).toBeGreaterThan(drawsBefore);
  await ready.locator('.modal-footer [data-bs-dismiss="modal"]').click();
});

test('l\'interrupteur général masque les panneaux sans perdre la liste', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);

  await page.locator('#switchStats').uncheck();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);
  await expect.poll(async () => (await savedStats(page)).enabled).toBe(false);
  expect((await savedStats(page)).panels).toHaveLength(1);

  await page.locator('#switchStats').check();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect.poll(async () => (await savedStats(page)).enabled).toBe(true);
});

test('onglet Stats en mode Évolution : listes indépendantes, panneau étranger masqué', async ({ page }) => {
  // Deux listes séparées : un panneau du mode principal n'apparaît pas en
  // Évolution ; un panneau à métrique étrangère dans `evolution_panels`
  // reste listé, marqué « (Trouvailles) », mais n'est pas dessiné.
  await putStats(page, { enabled: true,
    panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }],
    evolution_panels: [{ id: 'bbbbbb02', kind: 'grid', metric: 'dt' }] });
  await page.goto('/evolution#stats', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('a[href="#stats"]')).toHaveCount(1);
  await expect(page.locator('#stats')).toHaveCount(1);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);
  const list = page.locator('#statsPanelList li');
  await expect(list).toHaveCount(1);
  await expect(list).toContainText('(Trouvailles)');
});

test('anneau, courbe et compteurs se remplissent pendant la lecture', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await putStats(page, { enabled: true, panels: [
    { id: 'cccccc01', kind: 'counter', metric: 'summary', position: { anchor: 'top-left' },
      options: { items: ['days', 'best_day', 'streak', 'types', 'countries', 'states'] } },
    { id: 'cccccc02', kind: 'line', metric: 'cumulative', position: { anchor: 'bottom-left' } },
    { id: 'cccccc03', kind: 'donut', metric: 'cache_type', position: { anchor: 'top-right' } },
    { id: 'cccccc04', kind: 'bar', metric: 'country', position: { anchor: 'bottom-right' }, options: { sort: 'race' } },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(4);

  // Au repos : les métriques dont dépendent courbe et compteurs sont comptées.
  let state = await snapshot(page);
  expect(state.metrics.sort()).toEqual(['cache_type', 'country', 'day', 'state']);
  expect(Object.keys(state.counts.day)).toHaveLength(6);
  expect(state.counts.country).toEqual({ France: 6 });

  await setRhythm(page, 2);
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => {
    const s = await snapshot(page);
    return s.mode === 'animating' && s.total > 0 && s.total < 6;
  }, { intervals: [50], timeout: 10_000 }).toBe(true);
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(6);
  state = await snapshot(page);
  expect(Object.keys(state.counts.day)).toHaveLength(6);
  expect(errors).toEqual([]);
});

test('la courbe avance pendant les jours sans trouvaille', async ({ page }) => {
  // Numéro de jour du 01/01/2026, convention dayNumber (jours depuis l'epoch).
  const DAY1 = Date.UTC(2026, 0, 1) / 86400000;
  await putStats(page, { enabled: true, panels: [
    { id: 'eeeeee02', kind: 'line', metric: 'cumulative', position: { anchor: 'bottom-left' } },
  ] });
  // Fixture : trouvailles les 1er et 6 janvier, quatre jours vides entre les deux.
  await openWithFixture(page, '', GAP_FIXTURE, '2 / 2');
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  // 1 j/s : au-delà de la durée des tweens (~600 ms), aucun redessin ne
  // survit entre deux lots sans accumulateStatsForDates.
  await setRhythm(page, 1);

  await page.locator('#btnQuickPreview').click();
  // Pendant le trou (total bloqué à 1), la tête dessinée continue d'avancer
  // au lieu de rester sur la dernière trouvaille.
  await expect.poll(async () => {
    const s = await snapshot(page);
    return s.mode === 'animating' && s.total === 1 ? s.drawnHeads?.eeeeee02 : null;
  }, { intervals: [50], timeout: 10_000 }).toBeGreaterThan(DAY1 + 1);

  // Fin naturelle : les deux trouvailles comptées, tête sur le dernier jour.
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(2);
  await expect.poll(async () => (await snapshot(page)).drawnHeads?.eeeeee02,
    { timeout: 10_000 }).toBe(DAY1 + 5);
});

test('« Appliquer cette apparence à tous » copie le style, palette exceptée, et s\'annule', async ({ page }) => {
  const look = { background: '#112233', background_opacity: 60, text_color: '#eeeeee',
    accent_color: '#ff8800', font_size: 14, radius: 4, inherit_font: false };
  await putStats(page, { enabled: true, panels: [
    { id: 'a9e00001', kind: 'bar', metric: 'cache_type', style: { ...look, palette: 'multi' } },
    { id: 'a9e00002', kind: 'bar', metric: 'difficulty', position: { anchor: 'top-right' } },
    // Masqué : fait partie de la liste, il suit aussi.
    { id: 'a9e00003', kind: 'grid', metric: 'dt', enabled: false },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const before = (await savedStats(page)).panels;
  const button = page.locator('#btnStatsStyleToAll');
  // Le premier panneau est sélectionné ; le bouton vit dans la section Apparence.
  await page.locator('#statsSectionAppearance > summary').click();
  await expect(button).toBeEnabled();
  await button.click();

  const pick = (style) => Object.fromEntries(Object.keys(look).map((key) => [key, style[key]]));
  await expect.poll(async () => (await savedStats(page)).panels.slice(1).map((p) => pick(p.style)))
    .toEqual([look, look]);
  const after = (await savedStats(page)).panels;
  // La palette reste celle de chaque panneau (dégradé pour la difficulté).
  expect(after[1].style.palette).toBe(before[1].style.palette);
  expect(after[0].style.palette).toBe('multi');
  const undo = page.locator('.gcm-toast.show').filter({ hasText: 'Apparence appliquée à 2 autres panneaux' })
    .locator('.gcm-toast-action').filter({ hasText: 'Annuler' });
  await expect(undo).toBeVisible();

  // « Annuler » : le style d'avant revient sur les deux autres.
  await undo.click();
  await expect.poll(async () => (await savedStats(page)).panels.slice(1).map((p) => p.style))
    .toEqual(before.slice(1).map((p) => p.style));

  // Seul dans la liste : rien à quoi l'appliquer.
  await page.locator('#statsPanelList [data-action="delete"]').nth(2).click();
  await page.locator('#statsPanelList [data-action="delete"]').nth(1).click();
  await expect(page.locator('#statsPanelList li')).toHaveCount(1);
  await expect(button).toBeDisabled();
});

test('une suppression se signale, s\'enregistre aussitôt et s\'annule', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'aa000001', kind: 'bar', metric: 'cache_type', title: 'Types test' },
    { id: 'aa000002', kind: 'grid', metric: 'dt' },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('#statsPanelList li')).toHaveCount(2);

  await page.locator('#statsPanelList [data-action="delete"]').first().click();
  // Statut global : l'écriture structurelle est confirmée sous « Panneaux ».
  await expect(page.locator('#statsSaveStatus')).toHaveClass(/is-saved/, { timeout: 10_000 });
  await expect(page.locator('#statsPanelList li')).toHaveCount(1);
  const undo = page.locator('.gcm-toast.show .gcm-toast-action').filter({ hasText: 'Annuler' });
  await expect(undo).toBeVisible();
  // Enregistrement immédiat : le serveur a déjà la liste à jour.
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['aa000002']);

  // « Annuler » : le panneau revient à sa place, sauvegarde repartie.
  await undo.click();
  await expect(page.locator('#statsPanelList li')).toHaveCount(2);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['aa000001', 'aa000002']);
});

test('la liste des panneaux se réordonne à la souris', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'aa000001', kind: 'grid', metric: 'dt', position: { anchor: 'top-left' } },
    { id: 'aa000002', kind: 'counter', metric: 'summary', position: { anchor: 'top-right' } },
    { id: 'aa000003', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const items = page.locator('#statsPanelList li');
  // Premier item déposé dans la moitié basse du troisième → après lui.
  const target = items.nth(2);
  const box = await target.boundingBox();
  await items.nth(0).dragTo(target, { targetPosition: { x: 20, y: box.height - 4 } });
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id).join(','))
      .toBe('aa000002,aa000003,aa000001');
});

test('les marges sont celles du coin : communes à la pile, reprises en la rejoignant', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'c0a10001', kind: 'counter', metric: 'summary', position: { anchor: 'top-right', dx: 16, dy: 16 } },
    { id: 'c0a10002', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-left', dx: 40, dy: 30 } },
    { id: 'c0a10003', kind: 'bar', metric: 'container', position: { anchor: 'bottom-left', dx: 16, dy: 8 } },
  ] });
  const margins = async () => (await savedStats(page)).panels
    .map((p) => `${p.id}:${p.position.anchor}:${p.position.dx}/${p.position.dy}`);
  // Le serveur normalise : la pile bas-gauche prend les marges de son premier.
  expect(await margins()).toEqual([
    'c0a10001:top-right:16/16', 'c0a10002:bottom-left:40/30', 'c0a10003:bottom-left:40/30',
  ]);
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  // Modifier la marge d'un panneau de la pile l'applique à toute la pile.
  await page.locator('li[data-panel-id="c0a10003"] .stats-panel-name').click();
  await page.locator('#statsSectionPosition summary').click();
  const dy = page.locator('#inputStatsDy');
  await expect(dy).toHaveValue('30');
  await dy.fill('50');
  await dy.press('Tab');
  await expect.poll(margins).toEqual([
    'c0a10001:top-right:16/16', 'c0a10002:bottom-left:40/50', 'c0a10003:bottom-left:40/50',
  ]);

  // Le premier panneau de la liste rejoint le coin bas-gauche : il en prend
  // les marges au lieu d'imposer les siennes (16/16) à la pile.
  await page.locator('li[data-panel-id="c0a10001"] .stats-panel-name').click();
  await page.locator('label[for="statsAnchor-bottom-left"]').click();
  await expect.poll(margins).toEqual([
    'c0a10001:bottom-left:40/50', 'c0a10002:bottom-left:40/50', 'c0a10003:bottom-left:40/50',
  ]);
  // Il ouvre la pile à 40 px du bord gauche et 50 px du bas du cadre.
  const host = await page.locator('#mapWithFrames').boundingBox();
  await expect.poll(async () => {
    const box = await page.locator('canvas.stats-panel[data-panel-id="c0a10001"]').boundingBox();
    return [Math.round(box.x - host.x), Math.round(host.y + host.height - box.y - box.height)];
  }).toEqual([40, 50]);

  // Ligne médiane : la pile est centrée, la marge verticale est grisée.
  await page.locator('label[for="statsAnchor-middle-right"]').click();
  await expect(dy).toBeDisabled();
  await expect(page.locator('#inputStatsDx')).toBeEnabled();
});

test('aimantation : lâché près d’un coin, un panneau rejoint sa pile ; ailleurs ou avec Alt, il reste libre', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'a1a90001', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left', width: 240 } },
    { id: 'a1a90002', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-right', dx: 30, dy: 24 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const panel = page.locator('canvas.stats-panel[data-panel-id="a1a90001"]');
  await expect(panel).toBeVisible();
  const ghost = page.locator('#mapWithFrames > .stats-snap-ghost');
  const host = await page.locator('#mapWithFrames').boundingBox();
  const snapTargets = () => page.evaluate(async () =>
    (await import('/static/js/index.js')).getStatsSnapTargets('a1a90001'));
  // Glisse le panneau (saisi en son centre) pour que son coin haut-gauche
  // arrive en (left, top), repère du conteneur.
  const dragTopLeftTo = async (left, top, { release = true } = {}) => {
    const box = await panel.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(host.x + left + box.width / 2, host.y + top + box.height / 2, { steps: 10 });
    if (release) await page.mouse.up();
  };

  // Coin bas-droit : le panneau, premier de la liste, ouvrira la pile ;
  // l'emplacement tient compte des marges de la pile (30/24).
  const target = (await snapTargets()).find((t) => t.anchor === 'bottom-right');
  expect(target).toBeTruthy();
  expect((await snapTargets()).some((t) => t.anchor === 'middle-center')).toBe(false);
  await dragTopLeftTo(target.x - 20, target.y - 10, { release: false });
  // Pendant le geste : le repère montre la destination exacte.
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('data-anchor', 'bottom-right');
  const ghostBox = await ghost.boundingBox();
  expect(Math.abs(ghostBox.x - (host.x + target.x))).toBeLessThan(2);
  expect(Math.abs(ghostBox.y - (host.y + target.y))).toBeLessThan(2);
  await page.mouse.up();
  await expect(ghost).toBeHidden();
  await expect.poll(async () => (await savedStats(page)).panels[0].position)
    .toMatchObject({ mode: 'anchor', anchor: 'bottom-right', dx: 30, dy: 24 });
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    return Math.abs(box.x - host.x - target.x) < 1 && Math.abs(box.y - host.y - target.y) < 1;
  }).toBe(true);

  // Au centre de la carte (aucun coin proche) : position libre.
  const box = await panel.boundingBox();
  await dragTopLeftTo((host.width - box.width) / 2, (host.height - box.height) / 2, { release: false });
  await expect(ghost).toBeHidden();
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.mode).toBe('free');

  // Alt maintenue : pas d'aimantation, même tout près d'un coin.
  const again = (await snapTargets()).find((t) => t.anchor === 'bottom-right');
  await page.keyboard.down('Alt');
  await dragTopLeftTo(again.x - 10, again.y - 10, { release: false });
  await expect(ghost).toBeHidden();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await savedStats(page)).panels[0].position.mode).toBe('free');
});

test('un panneau glissé passe en position libre, choisir un coin l’y ramène', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'dddddd01', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left', width: 240 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  // Onglet ouvert, au repos : les panneaux se saisissent à la souris.
  await expect(page.locator('#mapWithFrames')).toHaveClass(/stats-editing/);
  const panel = page.locator('canvas.stats-panel');
  const box = await panel.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 - 120, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await savedStats(page)).panels[0].position.mode).toBe('free');
  const { position } = (await savedStats(page)).panels[0];
  expect(position.x).toBeGreaterThan(0);
  expect(position.x).toBeLessThan(1);
  expect(position.y).toBeGreaterThan(0);
  expect(position.y).toBeLessThan(1);
  const moved = await panel.boundingBox();
  expect(Math.abs(moved.x - (box.x + 150))).toBeLessThan(4);
  expect(Math.abs(moved.y - (box.y - 120))).toBeLessThan(4);
  // La section Position ne s'ouvre plus d'elle-même : son sous-libellé signale
  // la position libre, l'alerte se retrouve en dépliant.
  await expect(page.locator('#statsPositionHintFree')).toBeVisible();
  await page.locator('#statsSectionPosition summary').click();
  await expect(page.locator('#statsFreePosition')).toBeVisible();

  // Un coin choisi dans le formulaire remet le panneau dans sa pile.
  await page.locator('label[for="statsAnchor-top-right"]').click();
  await expect.poll(async () => (await savedStats(page)).panels[0].position)
    .toMatchObject({ mode: 'anchor', anchor: 'top-right' });
  await expect(page.locator('#statsFreePosition')).toBeHidden();
});

test('seul le panneau qui anime est redessiné, dans l\'aperçu comme dans la vidéo', async ({ page }) => {
  // Grille sans surlignage (rien ne glisse), histogramme (barres animées),
  // courbe (tête animée, avance seule sur un jour vide).
  await putStats(page, { enabled: true, panels: [
    { id: 'd7a0a001', kind: 'grid', metric: 'dt', options: { highlight: 'none' }, position: { anchor: 'bottom-left' } },
    { id: 'ba0a0a01', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-right' } },
    { id: 'c0a0a001', kind: 'line', metric: 'cumulative', position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(3);

  // Horloge pilotée à la main, en un seul evaluate (aucun rAF ne s'intercale) :
  // une trouvaille le 01/01 à t = 1000 ms, valeurs animées sur 600 ms.
  const steps = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const day = (n) => new Date(2026, 0, n);
    const video = document.createElement('canvas');
    video.width = 1200;
    video.height = 900;
    const ctx = video.getContext('2d');
    const out = {};
    const frame = (label, now) => {
      app.tickStatsPanels(now);
      app.addStatsPanelsToCanvas(ctx, video.width, video.height, 1);
      out[label] = structuredClone(app.getStatsSnapshot().draws);
    };
    // Fin d'axe au 10/01 : la tête de courbe peut avancer au-delà du 06.
    app.resetStatsForAnimation({ startDate: day(1), endDate: day(10), highlightMs: 600 });
    frame('start', 0);
    app.accumulateStatsForDates([day(1)], 1000);
    frame('find', 1000);
    frame('t1100', 1100);
    frame('t1200', 1200);
    frame('t1300', 1300);
    frame('settled', 1700);   // tweens finis : une dernière frame nette
    frame('idle', 1800);      // plus rien ne bouge
    app.accumulateStatsForDates([day(7)], 3000);   // jour sans trouvaille
    frame('empty', 3000);
    return out;
  });

  const delta = (from, to, id, kind = 'preview') => steps[to][id][kind] - steps[from][id][kind];
  for (const kind of ['preview', 'video']) {
    // La trouvaille change le contenu des trois.
    for (const id of ['d7a0a001', 'ba0a0a01', 'c0a0a001']) expect(delta('start', 'find', id, kind)).toBe(1);
    // Pendant les valeurs animées : barres et courbe à chaque frame, la grille jamais.
    expect(delta('find', 't1300', 'ba0a0a01', kind)).toBe(3);
    expect(delta('find', 't1300', 'c0a0a001', kind)).toBe(3);
    expect(delta('find', 't1300', 'd7a0a001', kind)).toBe(0);
    // Fin des animations : une dernière frame pour ceux qui animaient, puis plus rien.
    expect(delta('t1300', 'settled', 'ba0a0a01', kind)).toBe(1);
    expect(delta('t1300', 'settled', 'c0a0a001', kind)).toBe(1);
    expect(delta('t1300', 'settled', 'd7a0a001', kind)).toBe(0);
    for (const id of ['d7a0a001', 'ba0a0a01', 'c0a0a001']) expect(delta('settled', 'idle', id, kind)).toBe(0);
    // Jour vide : seule la tête de courbe avance.
    expect(delta('idle', 'empty', 'c0a0a001', kind)).toBe(1);
    expect(delta('idle', 'empty', 'ba0a0a01', kind)).toBe(0);
    expect(delta('idle', 'empty', 'd7a0a001', kind)).toBe(0);
  }
});

test('un grand nombre tient dans sa case de la matrice D/T', async ({ page }) => {
  // 280 px, police 12 : pad 10, libellés de ligne 29 → case de 25,7 px,
  // 24,2 px à l'intérieur (écart 1,5). Le texte doit tenir dans 86 % de
  // l'intérieur — avant, « 12 345 » (~30 px) débordait sur les voisines.
  const INNER = (280 - 20 - 29) / 9 - 1.5;
  await putStats(page, { enabled: true, panels: [
    { id: 'd7b16001', kind: 'grid', metric: 'dt', options: { cell_mode: 'count' },
      position: { anchor: 'bottom-left', width: 280 }, style: { font_size: 12 } },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);

  // Chaque fillText du panneau est relevé avec sa largeur à la police du
  // moment ; puis 12 344 copies d'une cache passent en D1,5/T1,5.
  const drawn = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const calls = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (this.canvas?.dataset?.panelId === 'd7b16001') {
        calls.push({ text: String(text), width: this.measureText(text).width, font: this.font });
      }
      return original.call(this, text, ...rest);
    };
    const [features] = app.pointsByDate.values();
    const model = features[0];
    for (let i = 0; i < 12344; i++) {
      const copy = structuredClone(model);
      copy.properties.difficulty = 1.5;
      copy.properties.terrain = 1.5;
      features.push(copy);
    }
    app.bumpPointsByDateRevision();
    app.refreshStatsPanels();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    CanvasRenderingContext2D.prototype.fillText = original;
    return calls;
  });

  // La case 1,5/1,5 compte 12 344 (aucune cache de la fixture n'y est) :
  // format court (« 12,3 k »), jamais le nombre complet qui déborderait.
  const big = drawn.filter((call) => /k/i.test(call.text) && /^12/.test(call.text));
  expect(big.length).toBeGreaterThan(0);
  expect(drawn.some((call) => call.text.replace(/\s/g, '') === '12344')).toBe(false);
  // Toutes les valeurs de case — même police que le grand nombre — tiennent.
  const valueFont = big[0].font;
  const values = drawn.filter((call) => call.font === valueFont);
  expect(values.length).toBeGreaterThan(1);
  for (const call of values) expect(call.width).toBeLessThanOrEqual(INNER * 0.86 + 0.5);
});

test('« Dupliquer » décale la copie d\'un panneau libre, empile celle d\'un panneau ancré', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'c0b1e001', kind: 'bar', metric: 'cache_type', position: { mode: 'free', x: 0.5, y: 0.5, width: 240 } },
    { id: 'c0b1e002', kind: 'bar', metric: 'container', position: { anchor: 'top-left', width: 240 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = (id) => page.locator(`canvas.stats-panel[data-panel-id="${id}"]`);
  const duplicate = (id) => page.locator(`#statsPanelList [data-panel-id="${id}"] [data-action="duplicate"]`);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Libre : la copie, posée juste après l'original, est décalée de 24 px.
  const original = await canvas('c0b1e001').boundingBox();
  await duplicate('c0b1e001').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(3);
  const ids = (await savedStatsWhen(page, (s) => s.panels.length === 3)).panels.map((p) => p.id);
  const copyId = ids[1];
  expect(ids[0]).toBe('c0b1e001');
  const copy = await canvas(copyId).boundingBox();
  expect(Math.abs(copy.x - original.x - 24)).toBeLessThanOrEqual(1);
  expect(Math.abs(copy.y - original.y - 24)).toBeLessThanOrEqual(1);
  expect((await savedStats(page)).panels[1].position.mode).toBe('free');

  // Ancré : la copie rejoint la pile du coin, sous l'original, sans le recouvrir.
  const anchored = await canvas('c0b1e002').boundingBox();
  await duplicate('c0b1e002').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(4);
  const saved = await savedStatsWhen(page, (s) => s.panels.length === 4);
  const stacked = saved.panels[3];
  expect(saved.panels[2].id).toBe('c0b1e002');
  expect(stacked.position.mode).toBe('anchor');
  expect(stacked.position.anchor).toBe('top-left');
  const below = await canvas(stacked.id).boundingBox();
  expect(below.y).toBeGreaterThanOrEqual(anchored.y + anchored.height);
});

test('le glisser d\'un panneau ne reconstruit pas son équivalent textuel', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'd0a97001', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);

  // Chaque mutation du texte alternatif est comptée : pendant le glisser, la
  // position est appliquée en place (previewStatsPanelPosition), sans
  // renormalisation — sinon settingsRev changerait à chaque pointermove et
  // toutes les <li> de l'équivalent seraient recréées par mouvement.
  await page.evaluate(() => {
    const alt = document.querySelector('.stats-panel-alt');
    window.__altMutations = 0;
    window.__altObserver = new MutationObserver(() => { window.__altMutations += 1; });
    window.__altObserver.observe(alt, { childList: true, subtree: true });
  });
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 5 });
  // Pendant le glisser : zéro reconstruction — la position n'entre pas dans
  // la clé a11y. (La reconstruction unique au dépôt, via le commit
  // renormalisé, est voulue : elle est mesurée avant le mouse.up.)
  expect(await page.evaluate(() => window.__altMutations)).toBe(0);
  await page.mouse.up();
  // Le dépôt a bien persisté la position libre (commit renormalisé).
  await expect.poll(async () => (await savedStats(page)).panels[0].position.mode).toBe('free');
});

test('une pile de coin démarre sous le titre au lieu de le recouvrir', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'eeeeee01', kind: 'counter', metric: 'summary', position: { anchor: 'top-left', dx: 16, dy: 16 } },
  ] });
  await openWithFixture(page);
  const title = page.locator('#titleFrame');
  test.skip(!(await title.isVisible()), 'Le thème courant ne montre pas de titre.');
  const titleBox = await title.boundingBox();
  const panelBox = await page.locator('canvas.stats-panel').boundingBox();
  const overlapsHorizontally = panelBox.x < titleBox.x + titleBox.width && titleBox.x < panelBox.x + panelBox.width;
  expect(overlapsHorizontally).toBe(true);
  expect(panelBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
});

test('un panneau se redimensionne par son bord droit', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00001', kind: 'bar', metric: 'cache_type',
      position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);
  // Mode édition : le tactile glisse/redimensionne au lieu de défiler.
  await expect(canvas).toHaveCSS('touch-action', 'none');

  const box = await canvas.boundingBox();
  const midY = box.y + box.height / 2;
  // Survol du bord droit : curseur de redimensionnement.
  await page.mouse.move(box.x + box.width - 4, midY);
  await expect(canvas).toHaveCSS('cursor', 'ew-resize');
  // Glisser depuis le bord droit élargit le panneau (~80 px).
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4 + 80, midY, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.width)
      .toBeGreaterThanOrEqual(355);  // 280 par défaut + ~80, marges de clamp
});

test('un panneau s\'étire en hauteur : champ, bord bas ; les grilles l\'ignorent', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00002', kind: 'bar', metric: 'cache_type',
      position: { anchor: 'top-left', height: 400 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);

  // Hauteur imposée au chargement : le canvas fait ~400 px CSS de haut.
  await expect.poll(async () => (await canvas.boundingBox()).height)
    .toBeGreaterThan(396);
  await expect.poll(async () => (await canvas.boundingBox()).height)
    .toBeLessThan(404);

  // Le champ « Hauteur » reflète la valeur ; le modifier étire le panneau.
  await page.locator('#statsSectionPosition summary').click();
  const heightInput = page.locator('#inputStatsHeight');
  await expect(heightInput).toHaveValue('400');
  await heightInput.fill('500');
  await heightInput.press('Tab');
  await expect.poll(async () => (await savedStats(page)).panels[0].position.height).toBe(500);
  await expect.poll(async () => (await canvas.boundingBox()).height)
    .toBeGreaterThan(496);

  // Champ vidé : retour à la hauteur automatique (position.height = null).
  await heightInput.fill('');
  await heightInput.press('Tab');
  await expect.poll(async () => (await savedStats(page)).panels[0].position.height).toBeNull();
  const naturalHeight = (await canvas.boundingBox()).height;
  expect(naturalHeight).toBeLessThan(300);

  // Bord bas : curseur ns-resize au survol, glisser qui impose la hauteur.
  const box = await canvas.boundingBox();
  const midX = box.x + box.width / 2;
  await page.mouse.move(midX, box.y + box.height - 4);
  await expect(canvas).toHaveCSS('cursor', 'ns-resize');
  await page.mouse.down();
  await page.mouse.move(midX, box.y + box.height - 4 + 80, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.height)
    .toBeGreaterThanOrEqual(Math.round(box.height) + 60);

  // Coin bas-droit : les deux axes d'un coup (nwse-resize).
  const corner = await canvas.boundingBox();
  await page.mouse.move(corner.x + corner.width - 4, corner.y + corner.height - 4);
  await expect(canvas).toHaveCSS('cursor', 'nwse-resize');
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width - 4 + 40, corner.y + corner.height - 4 + 60, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => {
    const p = (await savedStats(page)).panels[0].position;
    return p.width >= Math.round(corner.width) + 30 && p.height >= Math.round(corner.height) + 50;
  }).toBe(true);

  // Grille : champ masqué et hauteur stockée ignorée (cases carrées).
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00005', kind: 'grid', metric: 'dt',
      position: { anchor: 'top-left', height: 700 } },
  ] });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#stats"]').click();
  await expect(canvas).toHaveCount(1);
  await page.locator('#statsSectionPosition summary').click();
  await expect(heightInput).toBeHidden();
  const gridBox = await canvas.boundingBox();
  expect(Math.abs(gridBox.height - 700)).toBeGreaterThan(50);
  // Ni curseur ns-resize, ni poignée basse sur une grille.
  await page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height - 4);
  await expect(canvas).toHaveCSS('cursor', 'grab');
});

test('les poignées suivent le pointeur : bords gauche/haut d’une ancre bas-droite', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00010', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-right' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);
  const box = await canvas.boundingBox();
  const midY = box.y + box.height / 2;

  // Le bord droit est fixe (ancre) : pas de poignée là, elle est à gauche.
  await page.mouse.move(box.x + box.width - 4, midY);
  await expect(canvas).toHaveCSS('cursor', 'grab');
  await page.mouse.move(box.x + 4, midY);
  await expect(canvas).toHaveCSS('cursor', 'ew-resize');
  // Tirer le bord gauche vers la gauche élargit le panneau ; le bord droit
  // ne bouge pas, le bord gauche suit le pointeur.
  await page.mouse.down();
  await page.mouse.move(box.x + 4 - 80, midY, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.width)
    .toBeGreaterThanOrEqual(355);
  const wide = await canvas.boundingBox();
  expect(Math.abs((wide.x + wide.width) - (box.x + box.width))).toBeLessThan(2);
  expect(Math.abs(wide.x - (box.x - 80))).toBeLessThan(4);

  // Même logique en hauteur : poignée sur le bord haut, bord bas immobile.
  const midX = wide.x + wide.width / 2;
  await page.mouse.move(midX, wide.y + 4);
  await expect(canvas).toHaveCSS('cursor', 'ns-resize');
  await page.mouse.down();
  await page.mouse.move(midX, wide.y + 4 - 60, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.height)
    .toBeGreaterThanOrEqual(Math.round(wide.height) + 50);
  const tall = await canvas.boundingBox();
  expect(Math.abs((tall.y + tall.height) - (wide.y + wide.height))).toBeLessThan(2);

  // Coin haut-gauche : les deux axes, diagonale nwse.
  await page.mouse.move(tall.x + 4, tall.y + 4);
  await expect(canvas).toHaveCSS('cursor', 'nwse-resize');

  // Ancre bas-gauche : le coin des poignées est en haut à droite (nesw).
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00011', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-left' } },
  ] });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#stats"]').click();
  await expect(canvas).toHaveCount(1);
  const left = await canvas.boundingBox();
  await page.mouse.move(left.x + left.width - 4, left.y + 4);
  await expect(canvas).toHaveCSS('cursor', 'nesw-resize');
});

test('un panneau libre redimensionné garde son coin haut-gauche', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00012', kind: 'bar', metric: 'cache_type',
      position: { mode: 'free', x: 0.5, y: 0.5 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);
  const box = await canvas.boundingBox();
  const midY = box.y + box.height / 2;

  // Sans épingle, x = 0,5 de l'espace restant aurait déplacé le bord gauche
  // de la moitié de l'élargissement : la poignée aurait fui le pointeur.
  await page.mouse.move(box.x + box.width - 4, midY);
  await expect(canvas).toHaveCSS('cursor', 'ew-resize');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4 + 80, midY, { steps: 4 });
  // Pendant le glisser (aperçu appliqué au rAF suivant) : bord gauche
  // immobile, bord droit sous le pointeur.
  await expect.poll(async () => {
    const during = await canvas.boundingBox();
    return Math.abs((during.x + during.width) - (box.x + box.width + 80)) < 4;
  }).toBe(true);
  expect(Math.abs((await canvas.boundingBox()).x - box.x)).toBeLessThan(2);
  await page.mouse.up();

  // Persisté : largeur élargie ET x/y recalculés pour ce coin.
  await expect.poll(async () => (await savedStats(page)).panels[0].position.width)
    .toBeGreaterThanOrEqual(355);
  const saved = (await savedStats(page)).panels[0].position;
  expect(saved.mode).toBe('free');
  expect(saved.x).toBeGreaterThan(0.5);
  // Après rechargement (positions relues du serveur), même coin haut-gauche.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(canvas).toHaveCount(1);
  const reloaded = await canvas.boundingBox();
  expect(Math.abs(reloaded.x - box.x)).toBeLessThan(2);
  expect(Math.abs(reloaded.y - box.y)).toBeLessThan(2);
});

test('la pile de coin se replace quand le cartouche d’infos grandit', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'eeeeee02', kind: 'counter', metric: 'summary', position: { anchor: 'top-right', dx: 16, dy: 16 } },
  ] });
  await openWithFixture(page);
  const infos = page.locator('#infosFrame');
  const panel = page.locator('canvas.stats-panel');
  test.skip(!(await infos.isVisible()), 'Le profil courant ne montre pas la boîte d’infos.');
  await expect(panel).toBeVisible();

  // La pile démarre sous la boîte (coin haut-droit = celui des infos).
  const startsBelow = async () => {
    const infosBox = await infos.boundingBox();
    const panelBox = await panel.boundingBox();
    return panelBox.y >= infosBox.y + infosBox.height;
  };
  await expect.poll(startsBelow).toBe(true);

  // Le cartouche peut grandir sans que la carte bouge (compteur plus long,
  // modèle d'infos, style appliqué) : la pile doit se replier sous la boîte
  // élargie, pas rester à la hauteur mesurée avant.
  await page.evaluate(() => { document.getElementById('infosFrame').style.fontSize = '64px'; });
  await expect.poll(startsBelow).toBe(true);
});

test('un patch partiel conserve les panneaux courants', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'eeeeee03', kind: 'counter', metric: 'summary' },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);

  // Le serveur traite `stats` comme un patch de premier niveau : une clé
  // absente garde sa valeur. Le client doit tenir le même contrat — sinon
  // { enabled: false } viderait localement la liste gardée côté serveur.
  const applied = await page.evaluate(async () =>
    (await import('/static/js/index.js')).applyStatsSettings({ enabled: false }));
  expect(applied.enabled).toBe(false);
  expect(applied.panels).toHaveLength(1);
  expect(applied.panels[0].id).toBe('eeeeee03');
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);

  // Réactivation symétrique : la liste a survécu, le panneau réapparaît.
  const restored = await page.evaluate(async () =>
    (await import('/static/js/index.js')).applyStatsSettings({ enabled: true }));
  expect(restored.panels).toHaveLength(1);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
});

test('chaque panneau expose un équivalent textuel accessible', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'a11ce001', kind: 'counter', metric: 'summary', position: { anchor: 'top-left' } },
    { id: 'a11ce002', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: 'a11ce003', kind: 'line', metric: 'cumulative', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '', GAP_FIXTURE, '2 / 2');
  const canvases = page.locator('canvas.stats-panel');
  await expect(canvases).toHaveCount(3);
  // Le canvas reste muet ; son double hors écran porte les mêmes chiffres.
  await expect(canvases.first()).toHaveAttribute('aria-hidden', 'true');
  const alts = page.locator('.stats-panel-alt');
  await expect(alts).toHaveCount(3);
  await expect(alts.first()).toHaveClass(/visually-hidden/);

  // Le titre est le premier nœud : ^… évite que « Types de caches » matche
  // aussi la tuile « Types de caches différents » du compteur.
  const counter = alts.filter({ hasText: /^Chiffres clés/ });
  await expect(counter).toContainText('Jours avec trouvaille : 2');
  const types = alts.filter({ hasText: /^Types de caches/ });
  await expect(types).toContainText('Traditional Cache : 2');
  const line = alts.filter({ hasText: /^Progression des trouvailles/ });
  await expect(line).toContainText('2 trouvailles au');

  // Le texte suit les comptes, jour par jour : rejouer l'animation met la
  // liste à jour (tête de courbe comprise pendant les jours vides).
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.resetStatsForAnimation({ startDate: new Date(2026, 0, 1) });
    app.accumulateStatsForDates([new Date(2026, 0, 1)], performance.now());
    app.tickStatsPanels(performance.now());
  });
  await expect(types).toContainText('Traditional Cache : 1');
  await expect(line).toContainText('1 trouvailles au 1 janv.');

  // Jours vides : les comptes ne bougent pas mais la tête de la courbe, oui.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.accumulateStatsForDates([new Date(2026, 0, 2), new Date(2026, 0, 3)], performance.now());
    app.tickStatsPanels(performance.now());
  });
  await expect(line).toContainText('1 trouvailles au 3 janv.');

  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.accumulateStatsForDates(
      [new Date(2026, 0, 4), new Date(2026, 0, 5), new Date(2026, 0, 6)], performance.now());
    app.tickStatsPanels(performance.now());
  });
  await expect(line).toContainText('2 trouvailles au 6 janv.');
  await expect(types).toContainText('Traditional Cache : 2');
});

test('en lecture, le texte accessible d\'une grille suit au plus une fois par seconde, puis rattrape', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'ca1e0001', kind: 'grid', metric: 'calendar', position: { anchor: 'bottom-left', width: 440 } },
  ] });
  await openWithFixture(page);
  const alt = page.locator('.stats-panel-alt');
  // Au repos : les six jours de la fixture, tout de suite.
  await expect(alt).toContainText('6 janv. : 1');

  // Rafale : début d'animation puis trois jours de trouvailles, en moins
  // d'une seconde. Sans limite, quatre reconstructions ; ici une au plus.
  const burst = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const day = (n) => new Date(2026, 0, n);
    const before = app.getStatsSnapshot().a11yRebuilds;
    app.resetStatsForAnimation({ startDate: day(1), endDate: day(6) });
    app.tickStatsPanels(0);
    for (let n = 1; n <= 3; n++) {
      app.accumulateStatsForDates([day(n)], n * 1000);
      app.tickStatsPanels(n * 1000);
    }
    return app.getStatsSnapshot().a11yRebuilds - before;
  });
  expect(burst).toBeLessThanOrEqual(1);

  // Rattrapage : le texte finit sur les comptes affichés (trois jours).
  await expect(alt).toContainText('3 janv. : 1', { timeout: 3_000 });
  await expect(alt).not.toContainText('4 janv.');

  // Retour au repos : totaux de la sélection, sans attendre.
  await page.evaluate(async () => (await import('/static/js/index.js')).showStatsTotals());
  await expect(alt).toContainText('6 janv. : 1', { timeout: 500 });
});

test('le panneau choisi dans la liste porte le repère de sélection sur la carte', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '5e100001', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: '5e100002', kind: 'bar', metric: 'container', position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  const first = page.locator('canvas.stats-panel[data-panel-id="5e100001"]');
  const second = page.locator('canvas.stats-panel[data-panel-id="5e100002"]');
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  // Sans choix explicite, le premier panneau est sélectionné.
  await expect(first).toHaveClass(/is-selected/);
  await expect(second).not.toHaveClass(/is-selected/);

  // Choisir l'autre panneau dans la liste déplace le repère sur son canvas.
  await page.locator('li[data-panel-id="5e100002"] .stats-panel-name').click();
  await expect(second).toHaveClass(/is-selected/);
  await expect(first).not.toHaveClass(/is-selected/);

  // Le liseré n'est visible qu'en mode édition : il disparaît quand on quitte
  // l'onglet, sans perdre la sélection.
  await expect(page.locator('#mapWithFrames')).toHaveClass(/stats-editing/);
  await page.locator('a[href="#style"]').click();
  await expect(page.locator('#mapWithFrames')).not.toHaveClass(/stats-editing/);
  await expect(second).toHaveClass(/is-selected/);
});

test('les sections Position et Apparence sont repliées par défaut et mémorisent leur état', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '5ec70001', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: '5ec70002', kind: 'bar', metric: 'container', position: { mode: 'free', x: 0.3, y: 0.4 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  const position = page.locator('#statsSectionPosition');
  const appearance = page.locator('#statsSectionAppearance');
  // Repliées par défaut : leurs contrôles sont hors de vue.
  await expect(position).toHaveJSProperty('open', false);
  await expect(appearance).toHaveJSProperty('open', false);
  await expect(page.locator('#inputStatsWidth')).toBeHidden();
  await expect(page.locator('#inputStatsBackground')).toBeHidden();

  // Le résumé déplie la section au clic.
  await position.locator('summary').click();
  await expect(position).toHaveJSProperty('open', true);
  await expect(page.locator('#inputStatsWidth')).toBeVisible();
  await position.locator('summary').click();
  await expect(position).toHaveJSProperty('open', false);

  // Un panneau glissé sur la carte (position libre) n'ouvre plus la section :
  // c'est le sous-libellé du summary qui signale le mode courant.
  await page.locator('li[data-panel-id="5ec70002"] .stats-panel-name').click();
  await expect(position).toHaveJSProperty('open', false);
  await expect(page.locator('#statsFreePosition')).toBeHidden();
  await expect(page.locator('#statsPositionHintFree')).toBeVisible();
  await expect(page.locator('#statsPositionHintAnchored')).toBeHidden();
  await position.locator('summary').click();
  await expect(position).toHaveJSProperty('open', true);
  await expect(page.locator('#statsFreePosition')).toBeVisible();

  // L'état ouvert/fermé est mémorisé en localStorage et restauré au rechargement.
  await appearance.locator('summary').click();
  await expect(appearance).toHaveJSProperty('open', true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#stats"]').click();
  await page.locator('li[data-panel-id="5ec70001"] .stats-panel-name').click();
  await expect(position).toHaveJSProperty('open', true);
  await expect(appearance).toHaveJSProperty('open', true);

  await appearance.locator('summary').click();
  await expect(appearance).toHaveJSProperty('open', false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#stats"]').click();
  await page.locator('li[data-panel-id="5ec70001"] .stats-panel-name').click();
  await expect(position).toHaveJSProperty('open', true);
  await expect(appearance).toHaveJSProperty('open', false);
});

test('« Réorganiser » ne déplace que les panneaux en conflit', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '5e080001', kind: 'bar', metric: 'cache_type', position: { mode: 'free', x: 0.1, y: 0.1 } },
    { id: '5e080002', kind: 'bar', metric: 'container', position: { mode: 'free', x: 0.1, y: 0.1 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  // Les deux panneaux libres se recouvrent : l'alerte propose la réorganisation.
  const warnings = page.locator('#statsLayoutWarnings');
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText('chevauche');
  await warnings.getByRole('button', { name: 'Réorganiser automatiquement' }).click();

  // Le premier panneau, qui ne gêne personne, reste libre ; le second part
  // au premier coin où il tient sans rien chevaucher. Plus d'avertissement.
  await expect(warnings).toBeHidden();
  const second = page.locator('canvas.stats-panel[data-panel-id="5e080002"]');
  await expect(second).toHaveCSS('left', '16px');
  await expect(second).toHaveCSS('bottom', '16px');
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.position.mode))
    .toEqual(['free', 'anchor']);
  expect((await savedStats(page)).panels[1].position.anchor).toBe('bottom-left');

  // Réversible : le toast « Annuler » restaure les positions libres d'avant.
  const toast = page.locator('.gcm-toast.show').filter({ hasText: 'Panneaux réorganisés' });
  await expect(toast).toBeVisible();
  await toast.locator('.gcm-toast-action').filter({ hasText: 'Annuler' }).click();
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.position.mode))
    .toEqual(['free', 'free']);
});

test('« Réorganiser » prévient quand la place manque pour tous les panneaux', async ({ page }) => {
  // Trois panneaux plus grands que la carte : aucun emplacement ne les
  // sépare, le toast le dit au lieu d'annoncer un succès.
  const huge = (id, metric) => ({ id, kind: 'bar', metric,
    position: { anchor: 'top-left', width: 1200, height: 1200 } });
  await putStats(page, { enabled: true, panels: [
    huge('5e090001', 'cache_type'), huge('5e090002', 'container'), huge('5e090003', 'difficulty'),
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const warnings = page.locator('#statsLayoutWarnings');
  await expect(warnings).toBeVisible();
  await warnings.getByRole('button', { name: 'Réorganiser automatiquement' }).click();
  await expect(page.locator('.gcm-toast.show').filter({ hasText: 'la place manque' })).toBeVisible();
  // Les avertissements restent : le problème n'est pas réglé.
  await expect(warnings).toBeVisible();
});

test('le panneau sélectionné s\'exporte en PNG et en CSV', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '5e0a0001', kind: 'bar', metric: 'cache_type', title: 'Mes types', position: { anchor: 'top-left' } },
    { id: '5e0a0002', kind: 'counter', metric: 'summary', position: { anchor: 'top-right' },
      options: { items: ['days', 'types'] } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Nom de fichier : le titre du panneau en slug ASCII (« Mes types » →
  // « stats-mes-types ») ; sans titre, le titre par défaut est slugué.
  // Image redessinée à l'échelle choisie (2× par défaut, suffixe « @2x ») :
  // dimensions = taille du panneau sur la carte × échelle (en-tête IHDR).
  const box = await page.locator('canvas.stats-panel[data-panel-id="5e0a0001"]').evaluate(
    (el) => ({ width: parseFloat(el.style.width), height: parseFloat(el.style.height) }));
  const exportPng = async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#btnStatsExportPng').click(),
    ]);
    const bytes = fs.readFileSync(await download.path());
    return { name: download.suggestedFilename(), bytes,
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };
  const scale = page.locator('#selectStatsPngScale');
  await expect(scale).toHaveValue('2');
  await expect(scale.locator('option[value="2"]'))
    .toHaveText(`2× — ${Math.round(box.width * 2)} × ${Math.round(box.height * 2)} px`);
  const png = await exportPng();
  expect(png.name).toBe('stats-mes-types@2x.png');
  expect([...png.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  expect([png.width, png.height]).toEqual([Math.round(box.width * 2), Math.round(box.height * 2)]);
  await scale.selectOption('4');
  const png4 = await exportPng();
  expect(png4.name).toBe('stats-mes-types@4x.png');
  expect([png4.width, png4.height]).toEqual([Math.round(box.width * 4), Math.round(box.height * 4)]);
  await scale.selectOption('1');
  const png1 = await exportPng();
  expect(png1.name).toBe('stats-mes-types.png');
  expect([png1.width, png1.height]).toEqual([Math.round(box.width), Math.round(box.height)]);
  // Choix retenu par le navigateur.
  expect(await page.evaluate(() => localStorage.getItem('statsPngScale'))).toBe('1');

  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnStatsExportCsv').click(),
  ]);
  expect(csv.suggestedFilename()).toBe('stats-mes-types.csv');
  const content = fs.readFileSync(await csv.path(), 'utf8');
  expect(content.charCodeAt(0)).toBe(0xFEFF);
  expect(content).toContain('Catégorie;Nombre;Pourcentage');
  expect(content).toContain('Traditional Cache;3');

  // L'export suit le panneau sélectionné dans la liste ; sans titre propre
  // c'est le titre par défaut (« Chiffres clés » → « stats-chiffres-cles »).
  await page.locator('#statsPanelList').getByText('Chiffres clés').click();
  const [csv2] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnStatsExportCsv').click(),
  ]);
  expect(csv2.suggestedFilename()).toBe('stats-chiffres-cles.csv');
  const content2 = fs.readFileSync(await csv2.path(), 'utf8');
  expect(content2).toContain('Chiffre;Valeur;Détail');
  expect(content2).toContain('Jours avec trouvaille;6');
  expect(content2).toContain('Types de caches différents;3');

  // Masqué, il n'a plus de canvas sur la carte mais s'exporte encore,
  // redessiné à sa largeur réglée (280 px par défaut).
  await page.locator('#statsPanelList li', { hasText: 'Chiffres clés' }).locator('[data-action="toggle"]').uncheck();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect(page.locator('#btnStatsExportPng')).toBeEnabled();
  const hidden = await exportPng();
  expect(hidden.name).toBe('stats-chiffres-cles.png');
  expect(hidden.width).toBe(280);
});

test('une configuration nommée enregistre et ré-applique la liste de panneaux', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'c0f60001', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: 'c0f60002', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Enregistrer la configuration actuelle sous un nom.
  await page.locator('#btnStatsConfigs').click();
  await page.locator('[data-stats-config-save]').click();
  await page.locator('#inputStatsConfigName').fill('Ma config');
  await page.locator('#btnStatsConfigSaveOk').click();
  await expect.poll(async () => (await savedStats(page)).configs?.map((c) => c.name))
    .toEqual(['Ma config']);

  // Liste vidée par l'UI, puis la configuration ré-applique tout.
  const deletes = page.locator('#statsPanelList [data-action="delete"]');
  while (await deletes.count()) await deletes.first().click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);

  await page.locator('#btnStatsConfigs').click();
  await page.locator('[data-config-apply="Ma config"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['c0f60001', 'c0f60002']);

  // La configuration peut ensuite être supprimée du menu.
  await page.locator('#btnStatsConfigs').click();
  await page.locator('[data-config-delete="Ma config"]').click();
  await expect.poll(async () => (await savedStats(page)).configs).toEqual([]);
});

test('les nouvelles métriques (mois, semaine, attributs, propriétaires) se comptent', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'f00ba001', kind: 'bar', metric: 'month', position: { anchor: 'top-left' } },
    { id: 'f00ba002', kind: 'bar', metric: 'weekday', position: { anchor: 'top-right' } },
    { id: 'f00ba003', kind: 'donut', metric: 'attribute', position: { anchor: 'bottom-left' } },
    { id: 'f00ba004', kind: 'bar', metric: 'owner', position: { anchor: 'bottom-right' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const alts = page.locator('.stats-panel-alt');
  await expect(alts).toHaveCount(4);

  // La fixture : 6 trouvailles du jeudi 01/01 au mardi 06/01/2026.
  const month = alts.filter({ hasText: /^Trouvailles par mois/ });
  await expect(month).toContainText('janv. : 6');
  const weekday = alts.filter({ hasText: /^Jours de la semaine/ });
  await expect(weekday).toContainText('dim. : 1');
  await expect(weekday).toContainText('mar. : 1');

  // La fixture ne porte ni attributs ni propriétaire : exclus et « Inconnu ».
  const attribute = alts.filter({ hasText: /^Attributs/ });
  const owner = alts.filter({ hasText: /^Propriétaires/ });
  await expect(attribute).toContainText('Sans attribut : 6');
  await expect(owner).toContainText('Inconnu : 6');

  // Injectés dans les features de l'index, puis relevé : les comptes suivent.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    for (const features of app.pointsByDate.values()) {
      for (const f of features) {
        f.properties.owner = 'Therion';
        f.properties.attributes = [
          { name: 'Scenic view', inc: 1 },
          { name: 'Available during winter', inc: 0 },   // forme négative
        ];
      }
    }
    app.bumpPointsByDateRevision();
    app.refreshStatsPanels();
  });
  await expect(attribute).toContainText('Scenic view : 6');
  await expect(attribute).not.toContainText('Available during winter');
  await expect(owner).toContainText('Therion : 6');
});

test('les panneaux s\'exportent en JSON et se ré-importent', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e9e00101', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: 'e9e00102', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Export de la liste du mode courant depuis le menu « Configurations ».
  await page.locator('#btnStatsConfigs').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-stats-panels-export]').click(),
  ]);
  expect(download.suggestedFilename()).toBe('stats-panneaux-finds.json');
  const jsonPath = await download.path();
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  expect(json.mode).toBe('finds');
  expect(json.panels).toHaveLength(2);

  // Liste vidée par l'UI : l'import la restaure depuis le fichier.
  const deletes = page.locator('#statsPanelList [data-action="delete"]');
  while (await deletes.count()) await deletes.first().click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);
  await page.setInputFiles('#statsPanelsImportFile', jsonPath);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['e9e00101', 'e9e00102']);
  await expect(page.locator('.gcm-toast.show').filter({ hasText: 'importé' })).toHaveCount(1);

  // Un fichier illisible est refusé proprement.
  const badPath = path.join(HERE, 'fixtures', '_bad-panels.json');
  fs.writeFileSync(badPath, '{ invalide');
  try {
    await page.setInputFiles('#statsPanelsImportFile', badPath);
    await expect(page.locator('.gcm-toast.show').filter({ hasText: 'Import impossible' })).toHaveCount(1);
    await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  } finally {
    fs.unlinkSync(badPath);
  }

  // Un fichier lisible mais sans panneau exploitable est refusé AVANT tout
  // commit : la liste courante (2 panneaux) n'est pas vidée par l'import.
  const emptyPath = path.join(HERE, 'fixtures', '_empty-panels.json');
  const nopePath = path.join(HERE, 'fixtures', '_nope-panels.json');
  fs.writeFileSync(emptyPath, JSON.stringify({ mode: 'finds', panels: [] }));
  fs.writeFileSync(nopePath, JSON.stringify([{ kind: 'nope' }]));
  try {
    await page.setInputFiles('#statsPanelsImportFile', emptyPath);
    await expect(page.locator('.gcm-toast.show').filter({ hasText: 'Import impossible' })).toHaveCount(1);
    await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
    await expect.poll(async () => (await savedStats(page)).panels).toHaveLength(2);

    await page.setInputFiles('#statsPanelsImportFile', nopePath);
    await expect(page.locator('.gcm-toast.show').filter({ hasText: 'Import impossible' }).last()).toHaveCount(1);
    await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
    await expect.poll(async () => (await savedStats(page)).panels).toHaveLength(2);
  } finally {
    fs.unlinkSync(emptyPath);
    fs.unlinkSync(nopePath);
  }
});

test('« Lignes au maximum » est proposé pour les métriques à catégories', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '7ab1e501', kind: 'bar', metric: 'attribute', position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  // Le panneau unique est sélectionné par défaut ; attributs = catégoriel.
  const maxItems = page.locator('#inputStatsMaxItems');
  await expect(maxItems).toBeVisible();
  // Passage à une métrique ordonnée : plus de top-N, le champ se masque.
  await page.locator('#selectStatsMetric').selectOption('year');
  await expect(maxItems).toBeHidden();
});

test('« Les nouveautés » n\'est proposé qu\'aux types qui la distinguent', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '9h1ghl01', kind: 'counter', metric: 'summary', position: { anchor: 'top-left' } },
    { id: '9h1ghl02', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const list = page.locator('#statsPanelList');
  const newOption = page.locator('#selectStatsHighlight option[value="new"]');
  // Compteurs : « new » indisponible ; barres : proposée.
  await list.locator('li', { hasText: 'Chiffres clés' }).locator('[data-action="select"]').click();
  await expect(newOption).toBeDisabled();
  await list.locator('li', { hasText: 'Types de caches' }).locator('[data-action="select"]').click();
  await expect(newOption).toBeEnabled();
});

test('la palette « types de caches » n\'est proposée qu\'à la métrique type', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'a11ce001', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: 'a11ce002', kind: 'donut', metric: 'country', position: { anchor: 'top-right' },
      style: { palette: 'gc' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const list = page.locator('#statsPanelList');
  const gcOption = page.locator('#selectStatsPalette option[value="gc"]');
  // Type de cache : palette Groundspeak proposée.
  await list.locator('li', { hasText: 'Types de caches' }).locator('[data-action="select"]').click();
  await expect(gcOption).toBeEnabled();
  // Pays : sans objet — retirée ; un « gc » stocké s'affiche « accent »,
  // le rendu effectif (le réglage n'est pas réécrit).
  await list.locator('li', { hasText: 'Pays' }).locator('[data-action="select"]').click();
  await expect(gcOption).toBeDisabled();
  await expect(page.locator('#selectStatsPalette')).toHaveValue('accent');
});

test('la forme d\'un panneau catégoriel se change sans perdre ses réglages', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'f0be0001', kind: 'bar', metric: 'cache_type', title: 'Mes types',
      position: { mode: 'free', x: 0.4, y: 0.5 } },
    { id: 'f0be0002', kind: 'bar', metric: 'year', position: { anchor: 'top-right' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const list = page.locator('#statsPanelList');
  const kindSelect = page.locator('#selectStatsKind');

  // Métrique unique au type « bar » : pas de select de forme.
  await list.locator('li', { hasText: 'Trouvailles par année' }).locator('[data-action="select"]').click();
  await expect(page.locator('#statsKindField')).toBeHidden();

  // Types de caches : barres ou anneau.
  await list.locator('li', { hasText: 'Mes types' }).locator('[data-action="select"]').click();
  await expect(kindSelect).toBeVisible();
  await kindSelect.selectOption('donut');
  // Même panneau (id, titre, position libre), options d'anneau (trou).
  await expect.poll(async () => {
    const s = await savedStats(page);
    const p = s.panels.find((x) => x.id === 'f0be0001');
    return p && `${p.kind}|${p.title}|${p.position.mode}|${typeof p.options.hole}`;
  }).toBe('donut|Mes types|free|number');
});

test('le panneau sélectionné a un aperçu dans l\'onglet', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'b0a1e001', kind: 'bar', metric: 'cache_type',
      position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await page.locator('#statsPanelList li').locator('[data-action="select"]').click();
  const preview = page.locator('#statsPanelPreview');
  await expect(preview).toBeVisible();
  // Bitmap à la largeur réelle du panneau (280 par défaut), non vide.
  const { width, painted } = await preview.evaluate((c) => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) { painted = true; break; }
    }
    return { width: c.width, painted };
  });
  expect(width).toBe(280);
  expect(painted).toBe(true);
  // L'aperçu suit la largeur quand le champ change : la section Position est
  // repliée par défaut, et le réaffichage part de l'événement « change ».
  await page.locator('#statsSectionPosition summary').click();
  await page.locator('#inputStatsWidth').fill('400');
  await page.locator('#inputStatsWidth').press('Tab');
  await expect.poll(() => preview.evaluate((c) => c.width)).toBe(400);
});

test('la ligne de couverture d\'une grille affiche le pourcentage', async ({ page }) => {
  // 6 combinaisons D/T distinctes sur 81 : « Combinaisons : 6/81 (7 %) ».
  await putStats(page, { enabled: true, panels: [
    { id: 'c0fe0001', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left' },
      options: { show_coverage: true } },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  const alt = page.locator('.stats-panel-alt');
  await expect(alt).toContainText('Combinaisons : 6/81');
  await expect(alt).toContainText('%');
});

test('la matrice D/T affiche les tours quand l\'option est activée', async ({ page }) => {
  // 6 combinaisons remplies sur 81 : aucun tour complet → « Tours de matrice : 0 ».
  await putStats(page, { enabled: true, panels: [
    { id: 'c0fe0002', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left' },
      options: { show_loops: true } },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect(page.locator('.stats-panel-alt')).toContainText('Tours de matrice : 0');
});

test('l\'âge à la trouvaille et ses tuiles se comptent', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'a9e00101', kind: 'bar', metric: 'age', position: { anchor: 'top-left' } },
    { id: 'a9e00102', kind: 'counter', metric: 'summary', position: { anchor: 'bottom-left' },
      options: { items: ['oldest', 'same_day'] } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const alts = page.locator('.stats-panel-alt');
  await expect(alts).toHaveCount(2);

  // La fixture : publiées du 01/01 au 06/01/2025, trouvées un an plus tard jour pour jour.
  const age = alts.filter({ hasText: /^Âge des caches trouvées/ });
  await expect(age).toContainText('1 à 2 ans : 6');
  await expect(age).toContainText('Le jour même : 0');
  const tiles = alts.filter({ hasText: /^Chiffres clés/ });
  await expect(tiles).toContainText('Plus ancienne cache trouvée : 2025 (1 janv. 2025)');
  await expect(tiles).toContainText('Trouvées le jour de publication : 0');

  // Deux caches trouvées le jour de leur publication, une sans date (exclue).
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const all = [...app.pointsByDate.values()].flat();
    all[0].properties.published_date = all[0].properties.date_find;
    all[1].properties.published_date = all[1].properties.date_find;
    all[2].properties.published_date = null;
    app.bumpPointsByDateRevision();
    app.refreshStatsPanels();
  });
  await expect(age).toContainText('Le jour même : 2');
  await expect(age).toContainText('1 à 2 ans : 3');
  await expect(age).toContainText('Sans date de publication : 1');
  await expect(tiles).toContainText('Trouvées le jour de publication : 2');
});

test('les grilles Jasmer et calendrier affichent aussi leurs tours', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'c0fe0101', kind: 'grid', metric: 'calendar', position: { anchor: 'bottom-left' },
      options: { show_loops: true } },
    { id: 'c0fe0102', kind: 'grid', metric: 'jasmer', position: { anchor: 'bottom-right' },
      options: { show_loops: true } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const alts = page.locator('.stats-panel-alt');
  await expect(alts).toHaveCount(2);
  await expect(alts.filter({ hasText: /^Calendrier 366/ })).toContainText('Tours de calendrier : 0');
  await expect(alts.filter({ hasText: /^Grille Jasmer/ })).toContainText('Tours de Jasmer : 0');

  // L'aide du réglage suit la grille sélectionnée.
  await page.locator('#statsPanelList li').filter({ hasText: 'Grille Jasmer' }).click();
  await expect(page.locator('#switchStatsLoops')).toBeChecked();
  const help = page.locator('#helpStatsLoops [data-stats-metric]');
  await expect(help.filter({ hasText: 'mois de publication' })).toBeVisible();
  await expect(help.filter({ hasText: '366 jours' })).toBeHidden();
  await expect(help.filter({ hasText: '81 combinaisons' })).toBeHidden();
});

test('la courbe marque les paliers franchis', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'a11e0001', kind: 'line', metric: 'cumulative', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const alt = page.locator('.stats-panel-alt');
  await expect(alt).toHaveCount(1);
  // 6 trouvailles : aucun palier.
  await expect(alt).toContainText('6 trouvailles');
  await expect(alt).not.toContainText('Paliers');

  // 20 copies de chaque jour → 126 trouvailles, la 100ᵉ le 05/01/2026.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    for (const features of app.pointsByDate.values()) {
      const base = [...features];
      for (let i = 0; i < 20; i++) {
        for (const f of base) features.push({ ...f, properties: { ...f.properties } });
      }
    }
    app.bumpPointsByDateRevision();
    app.refreshStatsPanels();
  });
  await expect(alt).toContainText('Paliers : 100 (5 janv. 2026)');

  // L'option se coupe depuis le formulaire.
  await page.locator('#statsPanelList li').first().click();
  await expect(page.locator('#switchStatsMilestones')).toBeChecked();
  await page.locator('#switchStatsMilestones').uncheck();
  await expect(alt).not.toContainText('Paliers');
  await expect.poll(async () => (await savedStats(page)).panels[0].options.show_milestones).toBe(false);
});

test('les points extrêmes s\'affichent en coordonnées géocaching', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  // Le modèle « Points extrêmes » pose une tuile par direction.
  await page.locator('#btnStatsAdd').click();
  await page.locator('[data-stats-preset="extremes"]').click();
  const alt = page.locator('.stats-panel-alt');
  await expect(alt).toHaveCount(1);

  // Fixture : de GCE2E001 (48.8501, 2.3501) à GCE2E006 (48.8556, 2.3556).
  await expect(alt).toContainText('Trouvaille la plus au nord : N 48° 51.336 (GCE2E006');
  await expect(alt).toContainText('Trouvaille la plus au sud : N 48° 51.006 (GCE2E001');
  await expect(alt).toContainText("Trouvaille la plus à l'est : E 002° 21.336 (GCE2E006");
  await expect(alt).toContainText("Trouvaille la plus à l'ouest : E 002° 21.006 (GCE2E001");
});

test('l\'année d\'activité montre les jours de trouvaille de la dernière année', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await page.locator('#btnStatsAdd').click();
  await page.locator('[data-stats-preset="activity"]').click();
  const alt = page.locator('.stats-panel-alt');
  await expect(alt).toHaveCount(1);

  // Fixture : une trouvaille par jour du 01/01 au 06/01/2026.
  await expect(alt).toContainText('Activité 2026');
  await expect(alt).toContainText('1 janv. 2026 : 1');
  await expect(alt).toContainText('6 janv. 2026 : 1');
  await expect(alt).toContainText('Jours : 6/365');
  const saved = (await savedStats(page)).panels[0];
  expect(saved.metric).toBe('activity');
  expect(saved.position.width).toBe(520);

  // Pas de « tours » pour une année : l'option n'est pas proposée.
  await page.locator('#statsPanelList li').first().click();
  await expect(page.locator('#switchStatsLoops')).toBeHidden();
});

test('l\'aperçu du formulaire suit les données sans toucher au formulaire', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'b0a1e101', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await page.locator('#statsPanelList li').locator('[data-action="select"]').click();
  const preview = page.locator('#statsPanelPreview');
  await expect(preview).toBeVisible();
  // Même pipeline et même taille (DPR 1 en test) : l'aperçu et le panneau de
  // la carte doivent donner le même bitmap.
  const sameAsMap = () => page.evaluate(() => {
    const map = document.querySelector('canvas.stats-panel[data-panel-id="b0a1e101"]');
    const prev = document.getElementById('statsPanelPreview');
    return !!map && map.width === prev.width && map.height === prev.height
      && map.toDataURL() === prev.toDataURL();
  });
  await expect.poll(sameAsMap).toBe(true);

  // Les données changent sous le formulaire (nouveau type pour toutes les
  // caches) : l'aperçu se redessine avec la carte.
  const before = await preview.evaluate((c) => c.toDataURL());
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    for (const features of app.pointsByDate.values()) {
      for (const f of features) f.properties.cache_type = 'Mystery Cache';
    }
    app.bumpPointsByDateRevision();
    app.refreshStatsPanels();
  });
  await expect.poll(() => preview.evaluate((c) => c.toDataURL())).not.toBe(before);
  await expect.poll(sameAsMap).toBe(true);

  // Onglet quitté pendant le changement : l'aperçu se rattrape au retour.
  await page.locator('a[href="#data"]').click();
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    for (const features of app.pointsByDate.values()) {
      for (const f of features) f.properties.cache_type = 'Traditional Cache';
    }
    app.bumpPointsByDateRevision();
    app.refreshStatsPanels();
  });
  await page.locator('a[href="#stats"]').click();
  await expect.poll(sameAsMap).toBe(true);
});

test('touche Suppr : le panneau sélectionné est supprimé (même effet que le bouton)', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'de1e7001', kind: 'counter', metric: 'summary', position: { anchor: 'top-left' } },
    { id: 'de1e7002', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-right' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('#mapWithFrames')).toHaveClass(/stats-editing/);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  // Le clic sur l'onglet laisse le focus sur son lien : Suppr viserait
  // l'élément de la page, pas un contrôle du panneau — on s'en affranchit.
  await page.evaluate(() => document.activeElement?.blur?.());

  // Sélection dans la liste puis Suppr : le panneau part (liste, carte,
  // réglages) et le toast « Annuler » s'affiche — comme le bouton.
  await page.locator('#statsPanelList li[data-panel-id="de1e7001"] [data-action="select"]').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('#statsPanelList li')).toHaveCount(1);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['de1e7002']);
  const undo = page.locator('.gcm-toast.show .gcm-toast-actions button', { hasText: 'Annuler' });
  await expect(undo).toBeVisible();

  // « Annuler » : le panneau revient à sa place.
  await undo.click();
  await expect(page.locator('#statsPanelList li')).toHaveCount(2);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['de1e7001', 'de1e7002']);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Dans un champ, Suppr garde son rôle natif (pas de suppression).
  await page.locator('#statsPanelList li[data-panel-id="de1e7001"] [data-action="select"]').click();
  await page.locator('#inputStatsTitle').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('#statsPanelList li')).toHaveCount(2);
});
