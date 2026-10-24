// Panneaux de statistiques en mode Évolution (/evolution).
//
// Chaque mode a sa liste : `stats.evolution_panels` ici, `stats.panels` en
// mode principal — indépendantes. Un panneau à métrique étrangère dans la
// liste Évolution est marqué « (Trouvailles) » et non dessiné. Les comptes
// suivent trois univers : actives à la date affichée (ensemble vivant),
// poses et archivages cumulés.
//
// Comptes attendus avec les fixtures a+b (8 caches sélectionnées, GC1A03
// archivée sans date masquée), fin de plage au 15/01/2020 :
//   actives 5, poses 8, archivées 3 (A02 06/01, A05 08/01, B02 10/01),
//   pic d'actives 5 (05-07/01) ; types actives : Traditional Cache 3, Earthcache 1,
//   Virtual Cache 1 ; types posées : Traditional Cache 4, Multi-cache 1,
//   Earthcache 1, Event Cache 1, Virtual Cache 1.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_A = path.join(HERE, 'fixtures', 'evolution-a.csv');
const FIXTURE_B = path.join(HERE, 'fixtures', 'evolution-b.csv');
const DEFAULT_STATS = { enabled: true, panels: [], evolution_panels: [], configs: [] };

const PANELS = [
    { kind: 'counter', metric: 'summary', title: 'Compteurs', options: { items: ['actives', 'placees', 'archivees', 'peak'] } },
    { kind: 'bar', metric: 'status', title: 'Statut' },
    { kind: 'bar', metric: 'cache_type', title: 'Actives par type' },
    { kind: 'bar', metric: 'cache_type', title: 'Posées par type', options: { counted: 'placed' } },
    { kind: 'line', metric: 'actives', title: 'Courbe actives' },
    // Métrique propre au mode principal : marquée, jamais dessinée ici.
    { kind: 'grid', metric: 'dt', title: 'Matrice' },
];

async function putStats(page, stats) {
    const response = await page.request.put('/api/settings', { data: { stats } });
    expect(response.ok()).toBe(true);
}

async function deleteAllDatasets(request) {
    const res = await request.get('/api/evolution/datasets');
    expect(res.ok()).toBeTruthy();
    for (const dataset of (await res.json()).datasets) {
        const del = await request.delete(`/api/evolution/datasets/${dataset.id}`);
        expect(del.ok()).toBeTruthy();
    }
}

async function openEvolution(page) {
    await page.goto('/evolution#stats', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
}

function snapshot(page) {
    return page.evaluate(async () => (await import('/static/js/index.js')).getStatsSnapshot());
}

test.beforeEach(async ({ page, request }) => {
    await deleteAllDatasets(request);
    await request.put('/api/settings', { data: { evolution_undated_archives: 'hide' } });
    // Liste Évolution seule ; le panneau du mode principal ne doit jamais
    // apparaître ici (listes indépendantes).
    await putStats(page, { enabled: true, evolution_panels: PANELS,
        panels: [{ kind: 'counter', metric: 'summary', title: 'Trouvailles' }] });
});

test.afterEach(async ({ page }) => {
    await putStats(page, DEFAULT_STATS);
});

test('les panneaux Évolution comptent les trois univers et suivent l\'animation', async ({ page }) => {
    await openEvolution(page);
    const loaded = page.evaluate(() => new Promise((resolve) => {
        window.addEventListener('mygcflow:evolution-loaded', (e) => resolve(e.detail), { once: true });
    }));
    await page.locator('#evolutionCsvInput').setInputFiles([FIXTURE_A, FIXTURE_B]);
    expect((await loaded).selected).toBe(8);

    // Fin de plage au 15/01/2020 : état connu (actives 5). Rythme lent pour
    // que l'échantillonnage voie monter et descendre le compteur.
    await page.locator('a[href="#animation"]').click();
    await page.locator('#animationConfigTab').click();
    const end = page.locator('#animDateEnd');
    await end.fill('15/01/2020');
    await end.dispatchEvent('change');
    await page.locator('#inputDaysPerSecond').fill('10');
    await page.locator('#inputExtraEndTime').fill('0');
    await expect(page.locator('#spanNbCaches')).toHaveText('5');

    // 5 panneaux Évolution dessinés ; la grille D/T (mode principal) est
    // absente de la carte mais listée, marquée « (Trouvailles) ».
    await expect(page.locator('canvas.stats-panel')).toHaveCount(5);
    await page.locator('a[href="#stats"]').click();
    const list = page.locator('#statsPanelList');
    await expect(list.locator('li')).toHaveCount(6);
    await expect(list.locator('li').last()).toContainText('(Trouvailles)');

    // Le menu « Ajouter » est filtré par mode : presets Évolution visibles,
    // entrées du mode principal masquées (en-tête « Modèles » conservé).
    await page.locator('#btnStatsAdd').click();
    const menu = page.locator('#statsAddMenu');
    await expect(menu.locator('[data-stats-preset="evo-overview"]')).toBeVisible();
    await expect(menu.locator('[data-stats-add="bar:status"]')).toBeVisible();
    await expect(menu.locator('[data-stats-add="line:actives"]')).toBeVisible();
    await expect(menu.locator('[data-stats-preset="dt"]')).toBeHidden();
    await expect(menu.locator('[data-stats-add="bar:year"]')).toBeHidden();
    await expect(menu.locator('[data-stats-add="line:cumulative"]')).toBeHidden();
    await page.keyboard.press('Escape');
    // La galerie est une modale : son animation de fermeture dure encore
    // quelques centaines de millisecondes, pendant lesquelles elle intercepte
    // les clics sur la liste des panneaux (échec sous charge, mode strict).
    await expect(page.locator('#statsGalleryModal')).toBeHidden();

    // État au repos : actives à la date de fin, cumuls complets. Les comptes
    // exposent les clés canoniques ; l'ensemble actif conserve à 0 les types
    // entièrement archivés (la barre glisse vers 0 avant de disparaître).
    const state = await snapshot(page);
    expect(state.mode).toBe('rest');
    expect(state.total).toBe(5);
    expect(state.counts.cache_type).toEqual({
        'Traditional Cache': 3, Earthcache: 1, 'Virtual Cache': 1,
        'Multi-cache': 0, 'Event Cache': 0,
    });
    expect(state.universes.placed.total).toBe(8);
    expect(state.universes.placed.counts.cache_type)
        .toEqual({ 'Traditional Cache': 4, 'Multi-cache': 1, Earthcache: 1, 'Event Cache': 1, 'Virtual Cache': 1 });
    expect(state.universes.archived.total).toBe(3);
    expect(state.visible).toHaveLength(5);

    // Textes alternatifs : compteurs, statut, univers « posées » et courbe.
    const alt = (title) => page.locator('.stats-panel-alt', { hasText: title });
    const counters = alt('Compteurs');
    await expect(counters).toContainText('Caches actives : 5');
    await expect(counters).toContainText('Caches posées : 8');
    await expect(counters).toContainText('Caches archivées : 3');
    await expect(counters).toContainText('Pic de caches actives : 5');
    const status = alt('Statut');
    await expect(status).toContainText('Caches actives : 5');
    await expect(status).toContainText('Caches archivées : 3');
    // Noms de types en forme canonique (le catalogue FR les conserve en
    // anglais, comme les options des filtres).
    const actives = alt('Actives par type');
    await expect(actives).toContainText('Traditional Cache : 3');
    await expect(actives).toContainText('Virtual Cache : 1');
    await expect(alt('Posées par type')).toContainText('Traditional Cache : 4');
    await expect(alt('Courbe actives')).toContainText('Caches actives : 5 (15 janv. 2020)');

    // Le sélecteur « Compter » n'apparaît qu'en Évolution, hors métrique
    // « statut » (indifférente à l'univers).
    await list.locator('li', { hasText: 'Posées par type' }).locator('[data-action="select"]').click();
    await expect(page.locator('#selectStatsCounted')).toBeVisible();
    await expect(page.locator('#selectStatsCounted')).toHaveValue('placed');
    await list.locator('li', { hasText: 'Statut' }).locator('[data-action="select"]').click();
    await expect(page.locator('#selectStatsCounted')).toBeHidden();

    // Animation : les comptes repartent du début puis rejoignent le repos.
    await page.evaluate(async () => {
        const index = await import('/static/js/index.js');
        window.__statsSamples = [];
        const sample = () => {
            window.__statsSamples.push(index.getStatsSnapshot());
            window.__statsRaf = requestAnimationFrame(sample);
        };
        sample();
    });
    await page.locator('#btnQuickPreview').click();
    await expect(page.locator('#spanCurrentDate')).toHaveText('15/01/2020', { timeout: 30_000 });
    await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 30_000 });
    const collected = await page.evaluate(() => {
        cancelAnimationFrame(window.__statsRaf);
        return window.__statsSamples;
    });
    const animating = collected.filter((s) => s?.mode === 'animating');
    expect(animating.length).toBeGreaterThan(0);
    // Redépart du début de plage : le premier jour affiché applique déjà la
    // pose du 01/01 (l'échantillonnage rAF peut manquer l'état « 0 active »
    // d'avant le premier lot) — montée jusqu'à 5 puis descente aux archivages.
    expect(Math.min(...animating.map((s) => s.total))).toBeLessThanOrEqual(1);
    expect(Math.max(...animating.map((s) => s.total))).toBeGreaterThanOrEqual(5);
    const decreased = animating.some((s, i) => i > 0 && s.total < animating[i - 1].total);
    expect(decreased).toBe(true);
    // Retour au repos sur l'état de fin.
    expect((await snapshot(page)).total).toBe(5);
});

test('durée de vie des archivées et âge moyen des actives', async ({ page }) => {
    await putStats(page, { enabled: true, panels: [], evolution_panels: [
        { kind: 'bar', metric: 'lifetime', title: 'Durée de vie' },
        { kind: 'counter', metric: 'summary', title: 'Compteurs',
            options: { items: ['actives', 'age_moyen'] } },
    ] });
    await openEvolution(page);
    const loaded = page.evaluate(() => new Promise((resolve) => {
        window.addEventListener('mygcflow:evolution-loaded', (e) => resolve(e.detail), { once: true });
    }));
    await page.locator('#evolutionCsvInput').setInputFiles([FIXTURE_A, FIXTURE_B]);
    expect((await loaded).selected).toBe(8);
    // Même fin de plage que le test principal : état connu au 15/01/2020.
    await page.locator('a[href="#animation"]').click();
    await page.locator('#animationConfigTab').click();
    const end = page.locator('#animDateEnd');
    await end.fill('15/01/2020');
    await end.dispatchEvent('change');

    // Archivées datées : A02 (3 j), A05 (4 j), B02 (0 j) → « <1 an » ×3.
    // « Placées » lit les 8 caches : A01 survit jusqu'en 2026 (5-10 ans),
    // les quatre non archivées comptent parmi les exclues.
    const state = await snapshot(page);
    expect(state.universes.archived.counts.lifetime).toEqual({ 0: 3 });
    expect(state.universes.placed.counts.lifetime).toEqual({ 0: 3, 4: 1 });
    // Actives : A01, A04, A06, B01, B03 → âges 14+13+8+6+13 = 54 → 10,8 j.
    expect(state.meanActiveAge).toBeCloseTo(10.8);

    const alt = (title) => page.locator('.stats-panel-alt', { hasText: title });
    await expect(alt('Durée de vie')).toContainText("Moins d'un an : 3");
    const counters = alt('Compteurs');
    await expect(counters).toContainText('Caches actives : 5');
    await expect(counters).toContainText('Âge moyen des actives : 11 jours');

    // « Compter » : 'archived' est le défaut de la durée de vie ; basculer
    // sur « Poses cumulées » montre les cinq années d'A01 et les exclues.
    await page.locator('a[href="#stats"]').click();
    const list = page.locator('#statsPanelList');
    await list.locator('li', { hasText: 'Durée de vie' }).locator('[data-action="select"]').click();
    const counted = page.locator('#selectStatsCounted');
    await expect(counted).toBeVisible();
    await expect(counted).toHaveValue('archived');
    await counted.selectOption('placed');
    await expect(alt('Durée de vie')).toContainText('5 à 10 ans : 1');
    await expect(alt('Durée de vie')).toContainText('Jamais archivées : 4');
    await expect.poll(async () => {
        const res = await page.request.get('/api/settings');
        return (await res.json()).stats.evolution_panels.find((p) => p.metric === 'lifetime')?.options?.counted;
    }).toBe('placed');
});

test('le champ « Surligner » se masque quand il est sans effet', async ({ page }) => {
  await openEvolution(page);
  await page.locator('a[href="#stats"]').click();
  const list = page.locator('#statsPanelList');
  const field = page.locator('#statsHighlightField');
  // Statut : aucun surlignage possible → champ masqué.
  await list.locator('li', { hasText: 'Statut' }).locator('[data-action="select"]').click();
  await expect(field).toBeHidden();
  // Courbe Évolution : idem.
  await list.locator('li', { hasText: 'Courbe actives' }).locator('[data-action="select"]').click();
  await expect(field).toBeHidden();
  // Compteurs : le champ reste, mais « Les nouveautés » est retirée.
  await list.locator('li', { hasText: 'Compteurs' }).locator('[data-action="select"]').click();
  await expect(field).toBeVisible();
  await expect(page.locator('#selectStatsHighlight option[value="new"]')).toBeDisabled();
});

test('les configurations nommées retiennent leur mode', async ({ page }) => {
  // Une configuration de chaque mode : seule celle du mode courant s'applique.
  await putStats(page, { enabled: true, evolution_panels: PANELS,
    panels: [{ kind: 'counter', metric: 'summary', title: 'Trouvailles' }],
    configs: [
      { name: 'Conf finds', mode: 'finds', panels: [] },
      { name: 'Conf evo', mode: 'evolution', panels: [] },
    ] });
  await openEvolution(page);
  await page.locator('a[href="#stats"]').click();
  await page.locator('#btnStatsConfigs').click();

  const evo = page.locator('[data-config-apply="Conf evo"]');
  const finds = page.locator('[data-config-apply="Conf finds"]');
  await expect(evo).toBeEnabled();
  // Marquée « (Trouvailles) » et non applicable ; la croix reste active.
  await expect(finds).toBeDisabled();
  await expect(finds).toContainText('(Trouvailles)');
  await expect(finds).toHaveAttribute('title', 'Pas affiché dans ce mode');
  await expect(page.locator('[data-config-delete="Conf finds"]')).toBeEnabled();
  await page.keyboard.press('Escape');

  // Enregistrée depuis l'UI Évolution, une configuration porte son mode.
  await page.locator('#btnStatsConfigs').click();
  await page.locator('[data-stats-config-save]').click();
  await page.locator('#inputStatsConfigName').fill('De test');
  await page.locator('#btnStatsConfigSaveOk').click();
  await expect.poll(async () => {
    const res = await page.request.get('/api/settings');
    const stats = (await res.json()).stats;
    return stats.configs.find((c) => c.name === 'De test')?.mode;
  }).toBe('evolution');
});
