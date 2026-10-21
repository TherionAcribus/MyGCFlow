// Barre de chronologie (timeline_bar.js) : sous la carte, hors de la zone
// capturée ; son curseur amène la carte, le compteur et les panneaux Stats à
// une date, depuis le repos, en pause ou pendant la lecture.
//
// Fixture principale : 6 caches, une par jour du 01 au 06/01/2026 — la plage
// compte 6 jours (curseur 0..5) et le jour k montre k + 1 caches.
import { expect, test } from '@playwright/test';
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

// Clic au milieu de la case du jour `offset` (plage de `span` jours).
async function clickDay(page, offset, span) {
  const box = await page.locator('#timelineBarTrack').boundingBox();
  await page.mouse.click(box.x + (offset + 0.5) / span * box.width, box.y + box.height / 2);
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
  await clickDay(page, 2, 6);
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

  // Repos : le premier cran ouvre l'aperçu en pause et recule le curseur
  // d'un jour (05/01 → 5 caches sur la carte).
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

  const track = page.locator('#timelineBarTrack');
  const menu = page.locator('.timeline-bar-menu');
  const box = await track.boundingBox();
  const rightClickDay = (offset, span) =>
    page.mouse.click(box.x + (offset + 0.5) / span * box.width, box.y + box.height / 2, { button: 'right' });
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

  // « Début ici » au 3ᵉ jour : le champ, la plage (6 → 4 jours) et le PUT.
  await rightClickDay(2, 6);
  await expect(menu).toBeVisible();
  let put = animationPut();
  await menu.getByRole('menuitem', { name: /Début de l.animation ici/ }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#animDateStart')).toHaveValue(await formatDate('2026-01-03'));
  await expect.poll(async () => (await bar(page)).valueMax).toBe(3);
  await put;

  // « Fin ici » au 2ᵉ jour de la nouvelle plage (04/01) : 4 → 2 jours.
  await rightClickDay(1, 4);
  await expect(menu).toBeVisible();
  put = animationPut();
  await menu.getByRole('menuitem', { name: /Fin de l.animation ici/ }).click();
  await expect(page.locator('#animDateEnd')).toHaveValue(await formatDate('2026-01-04'));
  await expect.poll(async () => (await bar(page)).valueMax).toBe(1);
  await put;

  // « Plage complète » : retour à l'étendue des données — et la plage du
  // test est déjà restaurée pour les specs suivants (rien d'autre ne
  // persiste : les dates ne sont pas enregistrées, cf. ci-dessus).
  await rightClickDay(0, 2);
  await expect(menu).toBeVisible();
  const full = menu.getByRole('menuitem', { name: 'Plage complète' });
  await expect(full).toBeEnabled();
  put = animationPut();
  await full.click();
  await expect.poll(async () => (await bar(page)).valueMax).toBe(5);
  await expect(page.locator('#animDateStart')).toHaveValue(await formatDate('2026-01-01'));
  await expect(page.locator('#animDateEnd')).toHaveValue(await formatDate('2026-01-06'));
  await put;

  // Plage déjà à l'étendue des données : l'item est désactivé, Échap ferme.
  await rightClickDay(0, 6);
  await expect(menu.getByRole('menuitem', { name: 'Plage complète' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Tab hors du menu : il ne reste pas ouvert derrière le focus.
  await rightClickDay(0, 6);
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();

  // Clic droit en plein glissement : le geste se termine avant que le menu
  // ne s'ouvre (la carte n'est plus pilotée par le pointeur).
  await page.mouse.move(box.x + 1.5 / 6 * box.width, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(async () => (await bar(page)).dragging).toBe(true);
  await rightClickDay(3, 6);
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
    await clickDay(page, 0, 6);
    await expect.poll(() => playback(page)).toBe('paused');
    await expect.poll(async () => (await bar(page)).valueNow).toBe(0);
    expect(await mapPointCount(page)).toBe(1);
    await clickDay(page, 4, 6);
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
    await clickDay(page, offset, span);
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
