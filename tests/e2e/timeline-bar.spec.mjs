// Barre de chronologie (timeline_bar.js) : sous la carte, hors de la zone
// capturée ; son curseur amène la carte, le compteur et les panneaux Stats à
// une date, depuis le repos, en pause ou pendant la lecture.
//
// Fixture principale : 6 caches, une par jour du 01 au 06/01/2026 — la plage
// compte 6 jours (curseur 0..5) et le jour k montre k + 1 caches.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
const EVO_A = path.join(HERE, 'fixtures', 'evolution-a.csv');
const EVO_B = path.join(HERE, 'fixtures', 'evolution-b.csv');
const DEFAULT_STATS = { enabled: true, panels: [], evolution_panels: [], configs: [] };

async function putStats(page, stats) {
  const response = await page.request.put('/api/settings', { data: { stats } });
  expect(response.ok()).toBe(true);
}

async function openWithFixture(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Chargement et affichage des points' }).first())
    .toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6');
  let previous = -1;
  await expect.poll(async () => {
    const revision = await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDateRevision);
    const stable = revision === previous;
    previous = revision;
    return stable;
  }, { intervals: [700], timeout: 15_000 }).toBe(true);
}

function bar(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getTimelineBarSnapshot());
}

function playback(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).previewPlaybackState());
}

function stats(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getStatsSnapshot());
}

function mapPointCount(page) {
  return page.evaluate(() => window.vectorSource?.getFeatures().length ?? 0);
}

// L'axe de la piste déborde la plage d'une marge de chaque côté (dans la
// limite des données) : les positions se calculent sur l'axe du snapshot.
// Abscisse du milieu de la case du jour `axisOffset` de l'axe.
async function axisX(page, axisOffset) {
  const box = await page.locator('#timelineBarTrack').boundingBox();
  const snap = await bar(page);
  return box.x + (axisOffset + 0.5) / snap.axisSpan * box.width;
}

async function trackMidY(page) {
  const box = await page.locator('#timelineBarTrack').boundingBox();
  return box.y + box.height / 2;
}

// Clic au milieu de la case du jour `offset` de la PLAGE.
async function clickDay(page, offset, options = {}) {
  const snap = await bar(page);
  await page.mouse.click(await axisX(page, snap.rangeOffset + offset), await trackMidY(page), options);
}

// Jour de l'axe d'une date « AAAA-MM-JJ ».
async function axisOffsetOf(page, iso) {
  return page.evaluate(async (value) => {
    const app = await import('/static/js/index.js');
    const snap = app.getTimelineBarSnapshot();
    const date = new Date(`${value}T00:00:00`);
    return Math.round((date - snap.axisStart) / 86_400_000);
  }, iso);
}

async function showBar(page) {
  await page.locator('#btnTimelineBar').click();
  await expect(page.locator('#timelineBar')).toBeVisible();
  await expect(page.locator('#btnTimelineBar')).toHaveAttribute('aria-pressed', 'true');
  await hideToolbarTooltip(page);
}

// Après un clic, la bulle d'aide d'un bouton de disposition réapparaît tant
// qu'il garde le focus (préréglages compris) et masque ses voisins.
async function hideToolbarTooltip(page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  await expect(page.locator('.tooltip.show')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await putStats(page, {
    ...DEFAULT_STATS,
    panels: [{ kind: 'counter', metric: 'summary', title: 'Trouvailles' }],
  });
});

test.afterEach(async ({ page }) => {
  await putStats(page, DEFAULT_STATS);
});

test('le curseur amène la carte, le compteur et les Stats à la date choisie', async ({ page }) => {
  await openWithFixture(page);
  await expect(page.locator('#timelineBar')).toBeHidden();
  await showBar(page);

  // Hors de la zone capturée : jamais dans #mapWithFrames.
  expect(await page.evaluate(() => !!document.getElementById('timelineBar').closest('#mapWithFrames'))).toBe(false);

  // Repos : la plage entière, curseur sur la fin (toute la sélection).
  let snap = await bar(page);
  expect(snap.valueMax).toBe(5);
  expect(snap.valueNow).toBe(5);
  expect(snap.valueText).toContain('6 caches');
  expect(await playback(page)).toBe('idle');

  // Clic sur le 3ᵉ jour : aperçu ouvert en pause, état de la fin du 03/01.
  await clickDay(page, 2);
  await expect.poll(() => playback(page)).toBe('paused');
  await expect(page.locator('#btnQuickPause')).toHaveClass(/restart/);
  await expect.poll(async () => (await bar(page)).valueNow).toBe(2);
  expect(await mapPointCount(page)).toBe(3);
  await expect(page.locator('#spanNbCaches')).toHaveText('3');
  let s = await stats(page);
  expect(s.mode).toBe('animating');
  expect(s.total).toBe(3);

  // Clavier : un jour, les bornes, un mois (bridé à la plage).
  const track = page.locator('#timelineBarTrack');
  await track.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(1);
  await expect.poll(() => mapPointCount(page)).toBe(2);
  await page.keyboard.press('End');
  await expect.poll(async () => (await stats(page)).total).toBe(6);
  expect(await mapPointCount(page)).toBe(6);
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(0);
  await expect.poll(() => mapPointCount(page)).toBe(1);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(5);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await stats(page)).total).toBe(1);
  await expect(page.locator('#spanNbCaches')).toHaveText('1');
  // Compte au singulier : « 1 cache », pas « 1 caches » (\b exclut le pluriel).
  expect((await bar(page)).valueText).toMatch(/1 cache\b/);
  await expect(page.locator('#timelineBarDate')).toContainText(/1 cache\b/);
  // Toujours en pause après la série de frappes.
  await page.waitForTimeout(500);
  expect(await playback(page)).toBe('paused');

  // Reprise (relais de la barre d'outils) : l'animation repart du 01/01 et
  // va au bout.
  await page.locator('#btnQuickPause').click();
  await expect.poll(() => playback(page), { timeout: 20_000 }).toBe('idle');
  s = await stats(page);
  expect(s.total).toBe(6);
  snap = await bar(page);
  expect(snap.valueNow).toBe(5);

  // Le style et l'affichage sont retenus par le navigateur.
  await page.locator('[data-timeline-style="curve"]').click();
  await expect(page.locator('[data-timeline-style="curve"]')).toHaveAttribute('aria-pressed', 'true');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('#timelineBar')).toBeVisible();
  expect((await bar(page)).style).toBe('curve');
});

test('la molette promène le curseur jour par jour (Maj : une semaine)', async ({ page }) => {
  await openWithFixture(page);
  await showBar(page);

  const box = await page.locator('#timelineBarTrack').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await playback(page)).toBe('idle');

  // Repos, piste sans focus : la molette laisse la page tranquille (la
  // survoler en faisant défiler ne lance pas l'aperçu).
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(400);
  expect(await playback(page)).toBe('idle');
  expect((await bar(page)).valueNow).toBe(5);

  // Piste focalisée : le premier cran ouvre l'aperçu en pause et recule le
  // curseur d'un jour (05/01 → 5 caches sur la carte).
  await page.locator('#timelineBarTrack').focus();
  await page.mouse.wheel(0, -120);
  await expect.poll(() => playback(page)).toBe('paused');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(4);
  await expect.poll(() => mapPointCount(page)).toBe(5);
  await expect(page.locator('#spanNbCaches')).toHaveText('5');

  // Chaque cran : un jour — vers le bas avance, vers le haut recule.
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await bar(page)).valueNow).toBe(3);
  await expect.poll(() => mapPointCount(page)).toBe(4);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await bar(page)).valueNow).toBe(4);
  // La page ne défile pas pendant le scrub.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Maj + cran : une semaine, bridée aux bornes (4 → 0, puis 0 → 5).
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(0);
  await expect.poll(() => mapPointCount(page)).toBe(1);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 120);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(5);
  expect(await mapPointCount(page)).toBe(6);

  // Silence > 350 ms : la rafale est terminée, l'aperçu reste en pause.
  await page.waitForTimeout(500);
  expect(await playback(page)).toBe('paused');
  expect((await bar(page)).valueNow).toBe(5);
});

test('clic droit : définir la plage depuis la barre', async ({ page }) => {
  await openWithFixture(page);
  await showBar(page);

  const menu = page.locator('.timeline-bar-menu');
  const rightClickAxis = async (axisOffset) =>
    page.mouse.click(await axisX(page, axisOffset), await trackMidY(page), { button: 'right' });
  const rightClickDate = async (iso) => rightClickAxis(await axisOffsetOf(page, iso));
  // Les dates d'animation ne font pas partie des préférences persistées
  // (AnimationPrefs : rythme et caméra seulement — elles sont recalées sur
  // les données à chaque chargement). Ce qui persiste ici est le PUT des
  // préférences d'animation déclenché par la pose d'une borne.
  const animationPut = () => page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === 'PUT' && request.url().includes('/api/settings')
      && (request.postData() || '').includes('"animation"');
  });
  const formatDate = (iso) => page.evaluate(async (value) =>
    (await import('/static/js/index.js')).formatDateDisplay(new Date(`${value}T00:00:00`)), iso);

  // « Début ici » au 03/01 : le champ, la plage (6 → 4 jours) et le PUT.
  await rightClickDate('2026-01-03');
  await expect(menu).toBeVisible();
  let put = animationPut();
  await menu.getByRole('menuitem', { name: /Début de l.animation ici/ }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#animDateStart')).toHaveValue(await formatDate('2026-01-03'));
  await expect.poll(async () => (await bar(page)).valueMax).toBe(3);
  await put;
  // Plage de 4 jours : une marge d'un jour (⌈4/4⌉) avant, dans les données.
  let snap = await bar(page);
  expect(snap.axisSpan).toBe(5);
  expect(snap.rangeOffset).toBe(1);

  // « Fin ici » au 04/01 : 4 → 2 jours.
  await rightClickDate('2026-01-04');
  await expect(menu).toBeVisible();
  put = animationPut();
  await menu.getByRole('menuitem', { name: /Fin de l.animation ici/ }).click();
  await expect(page.locator('#animDateEnd')).toHaveValue(await formatDate('2026-01-04'));
  await expect.poll(async () => (await bar(page)).valueMax).toBe(1);
  await put;

  // Une borne qui croiserait l'autre est désactivée : « Fin ici » avant le
  // début (marge de gauche, 02/01)...
  await rightClickDate('2026-01-02');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Fin de l.animation ici/ })).toBeDisabled();
  // ... mais « Début ici » dans la marge étend la plage.
  put = animationPut();
  await menu.getByRole('menuitem', { name: /Début de l.animation ici/ }).click();
  await expect(page.locator('#animDateStart')).toHaveValue(await formatDate('2026-01-02'));
  await expect.poll(async () => (await bar(page)).valueMax).toBe(2);
  await put;

  // « Plage complète » : retour à l'étendue des données — et la plage du
  // test est déjà restaurée pour les specs suivants (rien d'autre ne
  // persiste : les dates ne sont pas enregistrées, cf. ci-dessus).
  await rightClickAxis(0);
  await expect(menu).toBeVisible();
  const full = menu.getByRole('menuitem', { name: 'Plage complète' });
  await expect(full).toBeEnabled();
  put = animationPut();
  await full.click();
  await expect.poll(async () => (await bar(page)).valueMax).toBe(5);
  await expect(page.locator('#animDateStart')).toHaveValue(await formatDate('2026-01-01'));
  await expect(page.locator('#animDateEnd')).toHaveValue(await formatDate('2026-01-06'));
  await put;
  snap = await bar(page);
  expect(snap.axisSpan).toBe(6);
  expect(snap.rangeOffset).toBe(0);

  // Plage déjà à l'étendue des données : l'item est désactivé, Échap ferme.
  await rightClickAxis(0);
  await expect(menu.getByRole('menuitem', { name: 'Plage complète' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Tab hors du menu : il ne reste pas ouvert derrière le focus.
  await rightClickAxis(0);
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();

  // Clic droit en plein glissement : le geste se termine avant que le menu
  // ne s'ouvre (la carte n'est plus pilotée par le pointeur).
  await page.mouse.move(await axisX(page, 1), await trackMidY(page));
  await page.mouse.down();
  await expect.poll(async () => (await bar(page)).dragging).toBe(true);
  await rightClickAxis(3);
  await expect(menu).toBeVisible();
  expect((await bar(page)).dragging).toBe(false);
  await expect(page.locator('#timelineBar')).not.toHaveClass(/is-dragging/);
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('survoler la piste montre la date visée, sans toucher la carte', async ({ page }) => {
  await openWithFixture(page);
  await showBar(page);

  const box = await page.locator('#timelineBarTrack').boundingBox();
  const y = box.y + box.height / 2;
  // À ~50 % : le fantôme suit le pointeur, la date affichée est celle du
  // jour survolé — pas la fin de plage — et la carte reste au repos.
  await page.mouse.move(box.x + box.width / 2, y);
  await expect.poll(async () => (await bar(page)).hover).toBeGreaterThanOrEqual(0);
  const snap = await bar(page);
  expect(snap.hover).toBeLessThan(snap.valueMax);
  // ARIA : toujours le curseur réel, le survol n'est pas la valeur.
  expect(snap.valueNow).toBe(snap.valueMax);
  const dateText = await page.locator('#timelineBarDate').textContent();
  const endText = await page.locator('#timelineBarEnd').textContent();
  expect(dateText).not.toContain(endText);
  expect(await playback(page)).toBe('idle');
  expect(await mapPointCount(page)).toBe(6);

  // Hors de la piste : plus de fantôme, l'étiquette revient au curseur.
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await bar(page)).hover).toBeNull();
  await expect(page.locator('#timelineBarDate')).toContainText(endText);
});

test('pendant la lecture, glisser le curseur met en pause puis relance depuis la nouvelle date', async ({ page }) => {
  await openWithFixture(page);
  await showBar(page);
  await page.locator('a[href="#animation"]').click();
  await page.locator('#animationConfigTab').click();
  const rate = page.locator('#inputDaysPerSecond');
  const previousRate = await rate.inputValue();
  await rate.fill('1');
  try {
    await page.locator('#btnQuickPreview').click();
    await expect.poll(() => playback(page)).toBe('playing');

    const box = await page.locator('#timelineBarTrack').boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 4.5 / 6 * box.width, y);
    await page.mouse.down();
    // Pendant le geste : en pause, l'état suit le pointeur.
    await expect.poll(() => playback(page)).toBe('paused');
    await expect.poll(async () => (await stats(page)).total).toBe(5);
    await page.mouse.move(box.x + 1.5 / 6 * box.width, y, { steps: 4 });
    await expect.poll(() => mapPointCount(page)).toBe(2);
    await page.mouse.up();

    // Relâché : la lecture reprend depuis le 02/01 (1 j/s). Le total 3 ne
    // reste affiché qu'une seconde : relevé serré (les intervalles par
    // défaut de expect.poll montent à 1 s et manquaient souvent la fenêtre
    // — l'animation était alors déjà au bout, total 6).
    await expect.poll(() => playback(page), { intervals: [100] }).toBe('playing');
    await expect.poll(async () => (await stats(page)).total, { intervals: [100], timeout: 5_000 }).toBe(3);
    const now = (await bar(page)).valueNow;
    expect(now).toBeGreaterThanOrEqual(2);
    expect(now).toBeLessThan(5);

    // La lecture a ajouté ses propres points depuis le dernier saut : le
    // saut suivant reconstruit la carte (le suivi incrémental est périmé),
    // puis les sauts avancent et reculent par différence — jamais de point
    // en double ni oublié.
    // (Lecture éventuellement déjà au bout : le clic sur la barre rouvre
    // alors l'aperçu en pause — la carte a, là aussi, été remplie ailleurs.)
    if (await playback(page) === 'playing') await page.locator('#btnQuickPause').click();
    await clickDay(page, 0);
    await expect.poll(() => playback(page)).toBe('paused');
    await expect.poll(async () => (await bar(page)).valueNow).toBe(0);
    expect(await mapPointCount(page)).toBe(1);
    await clickDay(page, 4);
    await expect.poll(async () => (await bar(page)).valueNow).toBe(4);
    expect(await mapPointCount(page)).toBe(5);
    await page.locator('#timelineBarTrack').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => mapPointCount(page)).toBe(4);
    await expect(page.locator('#spanNbCaches')).toHaveText('4');
  } finally {
    if (await page.locator('#btnQuickStop').isVisible()) await page.locator('#btnQuickStop').click();
    await rate.fill(previousRate);
    await expect.poll(async () => String((await (await page.request.get('/api/settings')).json())
      .animation?.days_per_second)).toBe(String(Number(previousRate)));
  }
});

test('la barre se range sous la carte, en bandeau comme en panneau latéral', async ({ page }) => {
  await openWithFixture(page);
  await showBar(page);

  const boxes = () => page.evaluate(() => Object.fromEntries(['mapWithFrames', 'timelineBar', 'mapTabsResizer']
    .map((id) => [id, document.getElementById(id).getBoundingClientRect().toJSON()])));

  await page.locator('[data-layout="balanced"]').click();
  await hideToolbarTooltip(page);
  let b = await boxes();
  expect(Math.abs(b.timelineBar.top - b.mapWithFrames.bottom)).toBeLessThan(1.5);
  expect(Math.abs(b.mapTabsResizer.top - b.timelineBar.bottom)).toBeLessThan(1.5);

  await page.locator('[data-layout="sidebar"]').click();
  await hideToolbarTooltip(page);
  await expect(page.locator('#mapTabsContainer')).toHaveClass(/layout-sidebar/);
  b = await boxes();
  expect(Math.abs(b.timelineBar.left - b.mapWithFrames.left)).toBeLessThan(1.5);
  expect(Math.abs(b.timelineBar.width - b.mapWithFrames.width)).toBeLessThan(1.5);
  expect(Math.abs(b.timelineBar.top - b.mapWithFrames.bottom)).toBeLessThan(1.5);
  // Le séparateur reste à droite, sur toute la hauteur.
  expect(b.mapTabsResizer.left).toBeGreaterThanOrEqual(b.mapWithFrames.right - 1);
  expect(b.mapTabsResizer.height).toBeGreaterThan(b.mapWithFrames.height);

  // Masquée : la carte reprend toute la colonne.
  await page.locator('#btnTimelineBar').click();
  await hideToolbarTooltip(page);
  await expect(page.locator('#timelineBar')).toBeHidden();
  await expect.poll(async () => (await boxes()).mapWithFrames.height)
    .toBeGreaterThan(b.mapWithFrames.height + b.timelineBar.height - 2);
});

test('mode Évolution : carte, compteur et Stats suivent le curseur', async ({ page, request }) => {
  const res = await request.get('/api/evolution/datasets');
  for (const dataset of (await res.json()).datasets) {
    await request.delete(`/api/evolution/datasets/${dataset.id}`);
  }
  await request.put('/api/settings', { data: { evolution_undated_archives: 'hide' } });
  await putStats(page, {
    ...DEFAULT_STATS,
    evolution_panels: [{ kind: 'counter', metric: 'summary', title: 'Compteurs', options: { items: ['actives', 'placees', 'archivees'] } }],
  });
  await page.goto('/evolution#animation', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
  const loaded = page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('mygcflow:evolution-loaded', (e) => resolve(e.detail), { once: true });
  }));
  await page.locator('#evolutionCsvInput').setInputFiles([EVO_A, EVO_B]);
  expect((await loaded).selected).toBe(8);
  await page.locator('#animationConfigTab').click();
  const end = page.locator('#animDateEnd');
  await end.fill('15/01/2020');
  await end.dispatchEvent('change');
  await expect(page.locator('#spanNbCaches')).toHaveText('5');

  await showBar(page);
  const snap = await bar(page);
  const span = snap.valueMax + 1;
  expect(span).toBeGreaterThan(3);

  // À chaque position : compteur de la carte, panneau Stats et barre d'accord
  // (trois calculs distincts sur la même chronologie).
  // « actives? » : singulier ou pluriel selon le compte du jour visé.
  const countIn = (text) => Number(/([\d\s  ]+) actives?/.exec(text)?.[1].replace(/\D/g, ''));
  for (const offset of [0, Math.floor(span / 2), span - 1]) {
    await clickDay(page, offset);
    await expect.poll(async () => (await bar(page)).valueNow).toBe(offset);
    await expect.poll(() => playback(page)).toBe('paused');
    const current = await bar(page);
    const s = await stats(page);
    expect(s.mode).toBe('animating');
    expect(s.total).toBe(countIn(current.valueText));
    await expect(page.locator('#spanNbCaches')).toHaveText(String(s.total));
  }
  // Fin de plage : l'état connu du repos (actives 5, poses 8, archivées 3).
  const last = await stats(page);
  expect(last.total).toBe(5);
  expect(last.universes.placed.total).toBe(8);
  expect(last.universes.archived.total).toBe(3);
  await page.locator('#btnQuickStop').click();
  await expect.poll(() => playback(page)).toBe('idle');
});

test('plein écran : surimpression optionnelle, choix mémorisé', async ({ page }) => {
  await openWithFixture(page);
  await showBar(page);

  try {
    // Entrée plein écran : la classe fullscreen-mode sur <main> suffit (pas
    // l'API Fullscreen). La barre devient une surimpression au bas de la
    // carte — sans rien retrancher à #mapWithFrames, qui garde le viewport.
    await page.locator('#btnFullscreenMode').click();
    await expect(page.locator('main')).toHaveClass(/fullscreen-mode/);
    await hideToolbarTooltip(page);

    const overlay = page.locator('#timelineBar');
    await expect(overlay).toBeVisible();
    expect(await page.evaluate(() =>
      getComputedStyle(document.getElementById('timelineBar')).position)).toBe('fixed');
    const viewport = page.viewportSize();
    const mapBox = await page.locator('#mapWithFrames').boundingBox();
    const barBox = await overlay.boundingBox();
    expect(Math.abs(mapBox.width - viewport.width)).toBeLessThan(1);
    expect(Math.abs(mapBox.height - viewport.height)).toBeLessThan(1);
    // Centrée horizontalement, à 16 px du bas.
    expect(Math.abs(barBox.x + barBox.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(Math.abs(viewport.height - (barBox.y + barBox.height) - 16)).toBeLessThan(2);

    // Le bouton du menu flottant masque la surimpression ; choix mémorisé.
    await page.locator('#btnTimelineBarFs').click();
    await expect(overlay).toBeHidden();
    await expect(page.locator('#btnTimelineBarFs')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => localStorage.getItem('timelineBarFullscreen'))).toBe('0');

    // Rechargement : le choix survit — de retour en plein écran, la barre
    // est toujours masquée...
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mygcflowReady === true);
    await page.locator('#btnFullscreenMode').click();
    await expect(page.locator('main')).toHaveClass(/fullscreen-mode/);
    await hideToolbarTooltip(page);
    await expect(overlay).toBeHidden();
    await expect(page.locator('#btnTimelineBarFs')).toHaveAttribute('aria-pressed', 'false');
    // ... et le même bouton la réaffiche.
    await page.locator('#btnTimelineBarFs').click();
    await expect(overlay).toBeVisible();
    await expect(page.locator('#btnTimelineBarFs')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    // Rend la préférence à son état par défaut (absente = activée) et sort
    // du plein écran, pour ne pas polluer les specs suivants. Best-effort :
    // un échec ici ne doit pas masquer l'erreur d'origine du test.
    try {
      await page.evaluate(() => localStorage.removeItem('timelineBarFullscreen'));
      await hideToolbarTooltip(page);
      if (await page.locator('#btnToggleFullscreen').isVisible()) {
        await page.locator('#btnToggleFullscreen').click();
        await expect(page.locator('main')).not.toHaveClass(/fullscreen-mode/);
      }
    } catch (_) {}
  }
});

// --- Poignées, repères, bulle, raccourcis, caméra -----------------------------

const GAP_FIXTURE = path.join(HERE, 'fixtures', 'my-finds-gap.gpx');
const LOGO = path.join(HERE, 'fixtures', 'logo-opaque.png');

async function openWith(page, file, count) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#filtersCounter')).toContainText(`${count} / ${count}`);
  await expect.poll(async () => (await bar(page)).state !== null).toBe(true);
}

// Préférence globale d'animation remise à sa valeur, persistance attendue
// (sauvegarde debouncée : cf. AGENTS.md, camera_follow_mode).
async function waitAnimationPref(page, key, value) {
  await expect.poll(async () => String((await (await page.request.get('/api/settings')).json())
    .animation?.[key])).toBe(String(value));
}

async function setDaysPerSecond(page, value) {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#animationConfigTab').click();
  const rate = page.locator('#inputDaysPerSecond');
  const previous = await rate.inputValue();
  await rate.fill(String(value));
  await waitAnimationPref(page, 'days_per_second', Number(value));
  return previous;
}

// GPX « My Finds » de `perDay` trouvailles par jour sur `days` jours à
// partir du 01/01/2026. `spread` : jours éloignés de ~70 km (trajets de
// caméra), sinon tous proches.
function writeFindsGpx(file, days, perDay, { spread = false } = {}) {
  const parts = [`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="Groundspeak Pocket Query" xmlns="http://www.topografix.com/GPX/1/0" xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
<name>My Finds Pocket Query - MyGCFlow E2E</name><desc>Groundspeak deterministic browser test fixture</desc><author>Groundspeak</author>`];
  let n = 0;
  for (let d = 0; d < days; d++) {
    const date = `2026-01-${String(d + 1).padStart(2, '0')}`;
    for (let i = 0; i < perDay; i++, n++) {
      const code = `GCT${String(n).padStart(4, '0')}`;
      const lat = spread ? 44 + d * 0.6 : 48.8 + n * 0.001;
      const lon = spread ? d * 0.9 : 2.3 + d * 0.01;
      parts.push(`<wpt lat="${lat.toFixed(4)}" lon="${lon.toFixed(4)}"><time>2025-01-01T00:00:00Z</time><name>${code}</name><urlname>C ${n}</urlname><groundspeak:cache><groundspeak:name>C ${n}</groundspeak:name><groundspeak:type>Traditional Cache</groundspeak:type><groundspeak:container>Micro</groundspeak:container><groundspeak:difficulty>1.5</groundspeak:difficulty><groundspeak:terrain>1.5</groundspeak:terrain><groundspeak:country>France</groundspeak:country><groundspeak:state>Île-de-France</groundspeak:state><groundspeak:logs><groundspeak:log><groundspeak:date>${date}T10:00:00Z</groundspeak:date><groundspeak:type>Found it</groundspeak:type></groundspeak:log></groundspeak:logs></groundspeak:cache></wpt>`);
    }
  }
  parts.push('</gpx>');
  fs.writeFileSync(file, parts.join('\n'));
}

test('poignées : tirer une borne raccourcit ou étend la plage', async ({ page }) => {
  await openWithFixture(page);
  await showBar(page);
  const track = page.locator('#timelineBarTrack');
  const formatDate = (iso) => page.evaluate(async (value) =>
    (await import('/static/js/index.js')).formatDateDisplay(new Date(`${value}T00:00:00`)), iso);
  // Languette d'une borne : bande du haut, juste à l'intérieur de la plage.
  const handlePoint = async (which) => {
    const box = await track.boundingBox();
    const snap = await bar(page);
    const x0 = box.x + snap.rangeOffset / snap.axisSpan * box.width;
    const x1 = box.x + (snap.rangeOffset + snap.valueMax + 1) / snap.axisSpan * box.width;
    return { x: which === 'start' ? x0 + 2 : x1 - 2, y: box.y + 5 };
  };
  const grab = async (which) => {
    const point = await handlePoint(which);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    return point;
  };

  // Survol de la languette : curseur de redimensionnement.
  const start = await handlePoint('start');
  await page.mouse.move(start.x, start.y);
  await expect(page.locator('#timelineBar')).toHaveClass(/is-over-handle/);

  // Début tiré au 03/01 : bulle « Début : … » pendant le geste, borne
  // posée au relâchement ; la marge d'un jour apparaît à gauche.
  await grab('start');
  await page.mouse.move(await axisX(page, 2), start.y, { steps: 3 });
  let snap = await bar(page);
  expect(snap.rangeDrag).toEqual({ which: 'start', from: 2, to: 5 });
  expect(snap.tip?.[0]).toBe(`Début : ${await formatDate('2026-01-03')}`);
  expect(await playback(page)).toBe('idle'); // une borne n'est pas un saut
  await page.mouse.up();
  await expect(page.locator('#animDateStart')).toHaveValue(await formatDate('2026-01-03'));
  await expect.poll(async () => (await bar(page)).valueMax).toBe(3);
  snap = await bar(page);
  expect(snap.rangeDrag).toBeNull();
  expect(snap.axisSpan).toBe(5);
  expect(snap.rangeOffset).toBe(1);

  // Tiré dans la marge (02/01) : la plage s'étend.
  await grab('start');
  await page.mouse.move(await axisX(page, 0), start.y, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('#animDateStart')).toHaveValue(await formatDate('2026-01-02'));
  await expect.poll(async () => (await bar(page)).valueMax).toBe(4);

  // Échap pendant le geste : rien n'est posé.
  const end = await grab('end');
  await page.mouse.move(await axisX(page, 2), end.y, { steps: 3 });
  expect((await bar(page)).rangeDrag?.which).toBe('end');
  await page.keyboard.press('Escape');
  expect((await bar(page)).rangeDrag).toBeNull();
  await page.mouse.up();
  await expect(page.locator('#animDateEnd')).toHaveValue(await formatDate('2026-01-06'));
  expect((await bar(page)).valueMax).toBe(4);

  // Ramené au bord des données (01/01) : retour à la valeur par défaut —
  // la plage du test est restaurée pour les specs suivants.
  await grab('start');
  await page.mouse.move(await axisX(page, 0), start.y, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('#animDateStart')).toHaveValue(await formatDate('2026-01-01'));
  await expect.poll(async () => (await bar(page)).valueMax).toBe(5);
  expect((await bar(page)).axisSpan).toBe(6);
});

test('bulle et étiquette : nombre du jour, total et instant de la vidéo', async ({ page }) => {
  await openWithFixture(page);
  await showBar(page);
  const formatDate = (iso) => page.evaluate(async (value) =>
    (await import('/static/js/index.js')).formatDateDisplay(new Date(`${value}T00:00:00`)), iso);

  // Survol du 03/01 : date, trouvailles du jour, total, instant vidéo.
  await page.mouse.move(await axisX(page, 2), await trackMidY(page));
  await expect.poll(async () => (await bar(page)).tip?.length ?? 0).toBeGreaterThan(0);
  const tip = (await bar(page)).tip;
  expect(tip[0]).toBe(await formatDate('2026-01-03'));
  expect(tip[1]).toBe('Ce jour : 1 trouvaille');
  expect(tip[2]).toBe('Total : 3 caches');
  // Sans suivi de caméra, l'instant est exact (pas de « ≈ »).
  expect(tip[3]).toMatch(/^Vidéo : \d+:\d\d$/);
  await expect(page.locator('#timelineBarDate')).toContainText(/3 caches · \d+:\d\d$/);
  // La bulle est hors de la piste et ne prend pas le pointeur.
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.timeline-bar-tip')).pointerEvents))
    .toBe('none');

  // Pointeur parti : plus de bulle.
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await bar(page)).tip).toBeNull();
});

test('repères : trouvailles rondes et planing des images, détaillés par la bulle', async ({ page }, testInfo) => {
  const gpx = testInfo.outputPath('finds-250.gpx');
  writeFindsGpx(gpx, 10, 25);
  const logo = await (await page.request.post('/api/images', {
    multipart: { image: { name: 'logo-opaque.png', mimeType: 'image/png', buffer: fs.readFileSync(LOGO) } },
  })).json();
  await page.request.put('/api/settings', { data: { images: { enabled: true, items: [
    { id: 'babe0201', file: logo.file, name: 'Logo', schedule: { start: '2026-01-03', end: '2026-01-05', fade: 0 } },
  ] } } });
  try {
    await openWith(page, gpx, 250);
    await showBar(page);

    // 25 trouvailles par jour : la 100ᵉ le 04/01 (jour 3), la 200ᵉ le
    // 08/01 (jour 7) ; le logo apparaît le 03/01 et disparaît le 05/01.
    await expect.poll(async () => (await bar(page)).marks.length).toBe(4);
    const marks = (await bar(page)).marks;
    expect(marks.filter((m) => m.kind === 'milestone').map((m) => [m.offset, m.label]))
      .toEqual([[3, '100ᵉ trouvaille'], [7, '200ᵉ trouvaille']]);
    expect(marks.filter((m) => m.kind !== 'milestone').map((m) => [m.offset, m.kind, m.label]))
      .toEqual([[2, 'image-in', 'Apparition : Logo'], [4, 'image-out', 'Disparition : Logo']]);

    // Bulle au droit d'un repère : il y est nommé.
    const y = await trackMidY(page);
    await page.mouse.move(await axisX(page, 3), y);
    await expect.poll(async () => (await bar(page)).tip ?? []).toContain('100ᵉ trouvaille');
    expect((await bar(page)).tip).toContain('Ce jour : 25 trouvailles');
    expect((await bar(page)).tip).toContain('Total : 100 caches');
    await page.mouse.move(await axisX(page, 2), y);
    await expect.poll(async () => (await bar(page)).tip ?? []).toContain('Apparition : Logo');
  } finally {
    await page.request.put('/api/settings', { data: { images: { enabled: true, items: [] } } });
    if (logo?.file) await page.request.post('/api/images/delete', { data: { file: logo.file } });
  }
});

test('Espace lance, met en pause et relance ; Ctrl+flèches sautent les jours vides', async ({ page }) => {
  await openWith(page, GAP_FIXTURE, 2);
  await showBar(page);
  const track = page.locator('#timelineBarTrack');
  expect((await bar(page)).valueMax).toBe(5); // 01/01 → 06/01, rien entre les deux

  // Ctrl+← depuis le repos (curseur au 06/01) : aperçu ouvert en pause au
  // jour avec trouvaille précédent — le 01/01, les jours vides sautés.
  await track.focus();
  await page.keyboard.press('Control+ArrowLeft');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(0);
  await expect.poll(() => playback(page)).toBe('paused');
  expect(await mapPointCount(page)).toBe(1);
  // Plus rien avant : le curseur reste.
  await page.keyboard.press('Control+ArrowLeft');
  await page.waitForTimeout(400);
  expect((await bar(page)).valueNow).toBe(0);
  await page.keyboard.press('Control+ArrowRight');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(5);
  await expect.poll(() => mapPointCount(page)).toBe(2);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await bar(page)).valueNow).toBe(0);
  await page.waitForTimeout(500); // fin de la série de frappes
  expect(await playback(page)).toBe('paused');

  const previousRate = await setDaysPerSecond(page, 1);
  try {
    // Espace : reprise depuis le 01/01, pause, reprise.
    await track.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => playback(page), { intervals: [100] }).toBe('playing');
    await page.keyboard.press('Space');
    await expect.poll(() => playback(page), { intervals: [100] }).toBe('paused');
    expect((await bar(page)).valueNow).toBeLessThan(5);
    await page.keyboard.press('Space');
    await expect.poll(() => playback(page), { intervals: [100] }).toBe('playing');
    // La page n'a pas défilé.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.locator('#btnQuickStop').click();
    await expect.poll(() => playback(page)).toBe('idle');

    // Depuis le repos, Espace lance l'aperçu comme Prévisualiser.
    await track.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => playback(page), { intervals: [100] }).toBe('playing');
  } finally {
    if (await page.locator('#btnQuickStop').isVisible()) await page.locator('#btnQuickStop').click();
    await page.locator('#inputDaysPerSecond').fill(previousRate);
    await waitAnimationPref(page, 'days_per_second', Number(previousRate));
  }
});

test('caméra : le suivi reprend après un saut, sur la pose de la piste', async ({ page }, testInfo) => {
  // Un jour tous les ~70 km : la piste a de vrais trajets.
  const gpx = testInfo.outputPath('finds-spread.gpx');
  writeFindsGpx(gpx, 6, 1, { spread: true });
  await openWith(page, gpx, 6);
  await showBar(page);
  const previousRate = await setDaysPerSecond(page, 1);
  await page.locator('#cameraConfigTab').click();
  await page.locator('#switchCameraFollow').check();
  await waitAnimationPref(page, 'camera_follow', true);
  const camera = () => page.evaluate(async () => (await import('/static/js/index.js')).getCameraFollowSnapshot());
  try {
    // Au repos, avec le suivi : l'instant vidéo n'est qu'estimé (pré-roll
    // et pauses de la piste calculés au lancement).
    await page.mouse.move(await axisX(page, 2), await trackMidY(page));
    await expect.poll(async () => (await bar(page)).tip?.[3] ?? '').toMatch(/^Vidéo : ≈ \d+:\d\d$/);

    // Saut au 03/01 depuis le repos : la piste est gardée, recalée — la vue
    // est déjà sur sa pose à cet instant.
    await clickDay(page, 2);
    await expect.poll(() => playback(page)).toBe('paused');
    await expect.poll(async () => (await bar(page)).valueNow).toBe(2);
    let cam = await camera();
    expect(cam.enabled).toBe(true);
    expect(cam.suspended).toBe(false);
    expect(cam.track).toBe(true);
    expect(cam.pose).not.toBeNull();
    expect(Math.abs(cam.view.center[0] - cam.pose.center[0])).toBeLessThan(1);
    expect(Math.abs(cam.view.center[1] - cam.pose.center[1])).toBeLessThan(1);
    expect(Math.abs(cam.view.zoom - cam.pose.zoom)).toBeLessThan(1e-6);
    // En lecture : instant vidéo exact, celui du plan du lancement.
    expect((await bar(page)).valueText).toMatch(/· \d+:\d\d$/);

    // Reprise : le suivi continue sur la piste (plus de suspension).
    await track(page).focus();
    await page.keyboard.press('Space');
    await expect.poll(() => playback(page), { intervals: [100] }).toBe('playing');
    await page.waitForTimeout(300);
    cam = await camera();
    expect(cam.suspended).toBe(false);
    expect(cam.track).toBe(true);
  } finally {
    if (await page.locator('#btnQuickStop').isVisible()) await page.locator('#btnQuickStop').click();
    await page.locator('a[href="#animation"]').click();
    await page.locator('#cameraConfigTab').click();
    await page.locator('#switchCameraFollow').uncheck();
    await waitAnimationPref(page, 'camera_follow', false);
    await page.locator('#animationConfigTab').click();
    await page.locator('#inputDaysPerSecond').fill(previousRate);
    await waitAnimationPref(page, 'days_per_second', Number(previousRate));
  }
});

function track(page) {
  return page.locator('#timelineBarTrack');
}
