// Panneaux de statistiques — comptage : remplissage pendant la lecture,
// saut incrémental dans la chronologie, métriques (mois, semaine, attributs,
// propriétaires, âge, extrêmes, année d'activité), couverture, tours,
// paliers, redessin ciblé, grand nombre dans une case.
// Helpers et fixture : stats-panels-helpers.mjs.
import { expect, test } from '@playwright/test';
import {
  GAP_FIXTURE, openWithFixture, putStats, resetStats, savedStats,
  setRhythm, snapshot, sum,
} from './stats-panels-helpers.mjs';

test.beforeEach(async ({ page }) => {
  await resetStats(page);
});

test.afterEach(async ({ page }) => {
  await resetStats(page);
  await expect.poll(async () => (await savedStats(page)).panels.length).toBe(0);
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

test('grille des trouvailles mois × année et tuile « total » suivent le saut', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'eeeeee01', kind: 'grid', metric: 'finds_ym' },
    // Le compteur réduit à la tuile « Trouvailles » : sa pseudo-métrique
    // constante doit suffire à faire tourner l'accumulateur — sinon
    // l'ensemble des métriques est vide et rien n'est jamais compté.
    { id: 'eeeeee02', kind: 'counter', metric: 'summary', options: { items: ['total'] } },
  ] });
  await openWithFixture(page, '#stats');
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Au repos : les six trouvailles de la fixture, toutes en janvier 2026.
  let state = await snapshot(page);
  expect(state.total).toBe(6);
  expect(state.counts.finds_ym).toEqual({ 202601: 6 });
  expect(state.counts.total).toEqual({ 1: 6 });

  // Saut jusqu'à la fin du 04/01 : quatre trouvailles comptées, le total
  // et le mois de la grille suivent (une seule ligne, l'année 2026).
  const paused = await page.evaluate(async () =>
    (await import('/static/js/index.js')).startPausedPreview());
  expect(paused).toBe(true);
  expect(await page.evaluate(async () =>
    (await import('/static/js/index.js')).seekAnimationToDate(new Date('2026-01-04T00:00:00')))).toBe(true);
  state = await snapshot(page);
  expect(state.mode).toBe('animating');
  expect(state.total).toBe(4);
  expect(state.counts.finds_ym).toEqual({ 202601: 4 });
  expect(state.counts.total).toEqual({ 1: 4 });

  await page.locator('#btnQuickStop').click();
  await expect.poll(() => page.evaluate(async () =>
    (await import('/static/js/index.js')).previewPlaybackState())).toBe('idle');
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
