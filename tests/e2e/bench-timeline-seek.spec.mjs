// Mesure (pas un test) : coût d'un saut de la barre de chronologie
// (seekAnimationToDate) sur une grosse base générée. Ignoré par défaut ;
// lancer avec :
//   MYGCFLOW_BENCH=1 [BENCH_N=20000] npm run test:e2e -- bench-timeline-seek
// Référence et interprétation : AGENTS.md, « Benchmark saut de la barre ».
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dismissFirstUseModal } from './first-use.mjs';

const N = Number(process.env.BENCH_N || 20000);
const DAYS = 3650;

// GPX « My Finds » déterministe : N trouvailles sur ~10 ans, plus denses
// vers la fin (comme un compte qui prend de l'ampleur).
function makeGpx(file) {
  const types = ['Traditional Cache', 'Multi-cache', 'Unknown Cache', 'Letterbox Hybrid', 'Earthcache'];
  const parts = [`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="Groundspeak Pocket Query" xmlns="http://www.topografix.com/GPX/1/0" xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
<name>My Finds Pocket Query - bench</name><desc>Groundspeak bench</desc><author>Groundspeak</author>`];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const t0 = Date.UTC(2014, 0, 1);
  for (let i = 0; i < N; i++) {
    const day = Math.floor(Math.pow(rnd(), 0.8) * DAYS);
    const date = new Date(t0 + day * 86400000).toISOString().slice(0, 10);
    const lat = (43 + rnd() * 7).toFixed(5);
    const lon = (-1 + rnd() * 8).toFixed(5);
    const code = `GCB${i.toString(36).toUpperCase().padStart(5, '0')}`;
    parts.push(`<wpt lat="${lat}" lon="${lon}"><time>2010-01-01T00:00:00Z</time><name>${code}</name><urlname>C ${i}</urlname><groundspeak:cache><groundspeak:name>C ${i}</groundspeak:name><groundspeak:type>${types[i % types.length]}</groundspeak:type><groundspeak:container>Micro</groundspeak:container><groundspeak:difficulty>1.5</groundspeak:difficulty><groundspeak:terrain>2.0</groundspeak:terrain><groundspeak:country>France</groundspeak:country><groundspeak:state>Bretagne</groundspeak:state><groundspeak:logs><groundspeak:log><groundspeak:date>${date}T10:00:00Z</groundspeak:date><groundspeak:type>Found it</groundspeak:type></groundspeak:log></groundspeak:logs></groundspeak:cache></wpt>`);
  }
  parts.push('</gpx>');
  fs.writeFileSync(file, parts.join('\n'));
}

test.skip(!process.env.MYGCFLOW_BENCH, 'mesure à la demande (MYGCFLOW_BENCH=1)');

test.afterEach(async ({ page }) => {
  await page.request.put('/api/settings', { data: { stats: { enabled: true, panels: [] } } });
});

test('saut de la barre de chronologie sur une grosse base', async ({ page }) => {
  test.setTimeout(600_000);
  const file = path.join(os.tmpdir(), `mygcflow-bench-finds-${N}.gpx`);
  if (!fs.existsSync(file)) makeGpx(file);
  // Deux panneaux Stats : leur recalcul fait partie du saut.
  await page.request.put('/api/settings', { data: { stats: { enabled: true, panels: [
    { kind: 'counter', metric: 'summary', title: 'Trouvailles' },
    { kind: 'bars', metric: 'type', title: 'Types' },
  ] } } });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 300_000 });
  await expect.poll(async () => page.evaluate(async () => (await import('/static/js/index.js')).pointsByDate.size),
    { timeout: 300_000 }).toBeGreaterThan(100);
  await page.waitForTimeout(3000); // fin des recalculs consécutifs au chargement
  await page.locator('#btnTimelineBar').click();

  const result = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    if (!app.startPausedPreview()) return { error: 'aperçu pas en pause' };
    const st = app.getTimelineState();
    const span = Math.round((st.end - st.start) / 86400000) + 1;
    const seekTo = async (offset) => {
      const date = new Date(st.start);
      date.setDate(date.getDate() + offset);
      const t = performance.now();
      app.seekAnimationToDate(date);
      const ms = performance.now() - t;
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      return ms;
    };
    // Glissement simulé : 60 positions d'un bout à l'autre, puis retour.
    const drag = [];
    for (let i = 0; i < 60; i++) drag.push(await seekTo(Math.round(i / 59 * (span - 1))));
    for (let i = 59; i >= 0; i--) drag.push(await seekTo(Math.round(i / 59 * (span - 1))));
    // Pas d'un jour (clavier, molette) au milieu de la plage.
    const steps = [];
    const mid = Math.round(span / 2);
    for (let i = 0; i < 20; i++) steps.push(await seekTo(mid + i));
    // Part des panneaux Stats seuls.
    const stats = [];
    for (let i = 0; i < 60; i++) {
      const date = new Date(st.start);
      date.setDate(date.getDate() + Math.round(i / 59 * (span - 1)));
      const t = performance.now();
      app.seekStatsToDate(date);
      stats.push(performance.now() - t);
    }
    const summary = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return { mean: +mean.toFixed(1), p50: +sorted[Math.floor(sorted.length / 2)].toFixed(1), max: +sorted.at(-1).toFixed(1) };
    };
    return { span, drag: summary(drag), steps: summary(steps), statsOnly: summary(stats) };
  });
  console.log(`BENCH ${N} trouvailles`, JSON.stringify(result));
  expect(result.error).toBeUndefined();
});
