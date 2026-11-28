// Banc de lecture : budget d'image sur un parcours de 500 étapes (power
// trail, 5 journées × 100). Le GPX « My Finds » est généré à la volée.
//
// Mesure : deltas requestAnimationFrame pendant la lecture, reprise au
// milieu du parcours (~250 pastilles affichées par image). Résultats en
// console — pas de seuil dur (les machines de test varient), mais le test
// reste une non-régression fonctionnelle (chronologie, lecture, arrêt).
import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importGpx } from './gpx-import.mjs';
import { dismissFirstUseModal } from './first-use.mjs';
import {
  cleanUp,
  clearLogs,
  deleteAllParcours,
  openParcoursPage,
  snapshot,
} from './parcours-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FINDS = 500;
const PER_DAY = 100;

// Power trail : 100 m entre trouvailles, 4 min d'écart, 5 journées.
function powerTrailGpx() {
  const DEG_PER_100M = 0.1 / (111.195 * Math.cos((45.9 * Math.PI) / 180));
  const wpts = [];
  for (let n = 0; n < FINDS; n++) {
    const day = Math.floor(n / PER_DAY);
    const date = `2025-07-${String(12 + day).padStart(2, '0')}`;
    const minutes = 8 * 60 + (n % PER_DAY) * 4;
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    const lat = (45.9 + (n % PER_DAY) * DEG_PER_100M).toFixed(6);
    const lon = (6.10 + day * 0.02 + (n % 5) * DEG_PER_100M * 0.3).toFixed(6);
    wpts.push(`  <wpt lat="${lat}" lon="${lon}"><time>2024-01-01T00:00:00Z</time><name>GCPT${String(n).padStart(4, '0')}</name><urlname>PT ${n}</urlname><groundspeak:cache><groundspeak:name>PT ${n}</groundspeak:name><groundspeak:type>Traditional Cache</groundspeak:type><groundspeak:container>Small</groundspeak:container><groundspeak:difficulty>1.5</groundspeak:difficulty><groundspeak:terrain>1.5</groundspeak:terrain><groundspeak:country>France</groundspeak:country><groundspeak:state>Banc</groundspeak:state><groundspeak:logs><groundspeak:log id="${7000 + n}"><groundspeak:date>${date}T${hh}:${mm}:00Z</groundspeak:date><groundspeak:type>Found it</groundspeak:type><groundspeak:finder id="4242">e2e-parcours</groundspeak:finder><groundspeak:text encoded="False">TFTC</groundspeak:text></groundspeak:log></groundspeak:logs></groundspeak:cache></wpt>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="Groundspeak Pocket Query"
     xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
  <name>My Finds Pocket Query - banc power trail</name>
  <author>Groundspeak</author>
${wpts.join('\n')}
</gpx>`;
}

// Deltas rAF + durée du dessin de lecture (postrender de la couche tête :
// sa source est vide, le temps y est quasi tout drawPlayHead) collectés
// dans la page pendant une fenêtre de lecture.
async function measureFrames(page, ms) {
  await page.evaluate(async () => {
    const samples = [];
    let last = 0;
    const collect = (t) => {
      if (last) samples.push(t - last);
      last = t;
      requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);
    window.__parcoursBench = samples;
    const drawTimes = [];
    window.__parcoursDraw = drawTimes;
    const app = await import('/static/js/index.js');
    // La couche tête est créée au départ de la lecture : l'attendre.
    const attach = () => {
      const layer = app.getMap().getLayers().getArray()
        .find((l) => l.get('name') === 'parcours-head');
      if (!layer) { setTimeout(attach, 100); return; }
      let start = 0;
      layer.on('prerender', () => { start = performance.now(); });
      layer.on('postrender', () => { drawTimes.push(performance.now() - start); });
    };
    attach();
  });
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const stats = (arr) => {
      const d = arr.slice().sort((a, b) => a - b);
      const p = (share) => d[Math.floor(d.length * share)] ?? 0;
      return {
        frames: d.length,
        p50: +p(0.5).toFixed(2),
        p95: +p(0.95).toFixed(2),
        max: +(d[d.length - 1] ?? 0).toFixed(2),
        over16: d.filter((x) => x > 16.7).length,
        over33: d.filter((x) => x > 33.4).length,
      };
    };
    return { raf: stats((window.__parcoursBench || []).slice(1)), draw: stats(window.__parcoursDraw || []) };
  });
}

test('banc : temps d’image en lecture sur 500 étapes', async ({ page, request }) => {
  test.setTimeout(300_000);
  const gpx = path.join(os.tmpdir(), 'mygcflow-power-trail-bench.gpx');
  await fs.writeFile(gpx, powerTrailGpx());
  await deleteAllParcours(request);
  await clearLogs(request);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await importGpx(page, gpx);
  await expect.poll(async () => (await (await request.get('/api/parcours')).json()).finds,
    { timeout: 60_000 }).toEqual({ first: '2025-07-12', last: '2025-07-16' });
  const create = await request.post('/api/parcours',
    { data: { name: 'Power trail', date_start: '2025-07-12', date_end: '2025-07-16' } });
  expect(create.status()).toBe(201);

  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status, { timeout: 60_000 }).toBe('ready');
  const rest = await snapshot(page);
  expect(rest.timeline.stopQ.length).toBe(FINDS);
  console.log(`chronologie : ${rest.timeline.quanta} quanta, ${rest.timeline.stopQ.length} étapes`);

  // Reprise au milieu : ~250 étapes atteintes pendant la mesure.
  const [frames, snap] = await Promise.all([
    measureFrames(page, 12_000),
    (async () => {
      // Survol d'abord (force : le hit-test échouerait — tant que les
      // actions sont masquées, le texte intercepte au-dessus d'elles) :
      // les actions superposées sont sans pointer-events au repos.
      const playButton = page.locator('.parcours-stop-play').nth(249);
      await playButton.hover({ force: true });
      await playButton.click();
      await expect.poll(async () => (await snapshot(page)).running).toBe(true);
      await page.waitForTimeout(10_000);
      return snapshot(page);
    })(),
  ]);

  await page.locator('#btnQuickStop').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(false);

  console.log(`cadence : ${frames.raf.frames} images · p50 ${frames.raf.p50} ms · p95 ${frames.raf.p95} ms`
    + ` · max ${frames.raf.max} ms · >16,7 ms : ${frames.raf.over16} · >33,4 ms : ${frames.raf.over33}`);
  console.log(`dessin lecture : ${frames.draw.frames} images · p50 ${frames.draw.p50} ms`
    + ` · p95 ${frames.draw.p95} ms · max ${frames.draw.max} ms`);
  console.log(`contexte : currentQ ${snap.currentQ} · pastilles peintes ${snap.playStops.drawn}`
    + ` · piles ${snap.playStops.piles.length} · suivi ${snap.camera.following}`);
  expect(snap.playStops.drawn).toBeGreaterThan(0);
  await cleanUp(request);
});
