// Aides communes aux specs de la page Parcours (/parcours,
// docs/parcours.md).
//
// Fixture my-finds-parcours.gpx (compte 4242) : deux journées autour d'Annecy.
// 12/07/2025 : GCPAR03 (log 9001), GCPAR01 (9002), GCPAR02 (9003), alignées
// dans cet ordre — l'ordre des logs est retenu ;
// 13/07/2025 : GCPAR05 (9010), puis l'earthcache GCPAR04 (9011), type souvent
// logué après coup — une seule étape à log, ordre géographique depuis la
// veille : GCPAR04, la plus proche de GCPAR02, d'abord.
//
// Les logs du My Finds vivent hors de /clear_database : vidés en entrée et en
// sortie (AGENTS.md), comme les parcours créés et les préférences de la page.
import { expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { importGpx } from './gpx-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.join(HERE, 'fixtures', 'my-finds-parcours.gpx');

export async function clearLogs(request) {
  const response = await request.post('/api/logs/clear');
  expect(response.ok()).toBeTruthy();
}

export async function deleteAllParcours(request) {
  const { parcours } = await (await request.get('/api/parcours')).json();
  for (const item of parcours) {
    expect((await request.delete(`/api/parcours/${item.id}`)).ok()).toBeTruthy();
  }
}

export async function importFixture(page, request) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await importGpx(page, FIXTURE);
  // Fin réelle de l'import : trouvailles ET logs du My Finds en base.
  await expect.poll(async () => (await (await request.get('/api/parcours')).json()).finds,
    { timeout: 30_000 }).toEqual({ first: '2025-07-12', last: '2025-07-13' });
  await expect.poll(async () => (await (await request.get('/api/logs/status')).json()).account?.user_id ?? null,
    { timeout: 30_000 }).toBe(4242);
}

export async function createWeekend(request, name = 'Week-end') {
  const response = await request.post('/api/parcours',
    { data: { name, date_start: '2025-07-12', date_end: '2025-07-13' } });
  expect(response.status()).toBe(201);
  return (await response.json()).parcours;
}

// Tuile vide (PNG 1×1 transparent) servie à la place des tuiles OSM : la
// caméra de la lecture (lot 7) zoome et précharge à chaque lecture, et la
// suite complète finissait par recevoir des 429 du serveur de tuiles
// (usage automatisé contraire à ses règles), qui faisaient échouer les specs
// suivants relevant les erreurs de console.
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function openParcoursPage(page) {
  await page.route('**://tile.openstreetmap.org/**',
    (route) => route.fulfill({ contentType: 'image/png', body: BLANK_TILE }));
  await page.goto('/parcours', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.waitForFunction(() => window.mygcflowParcoursLoaded === true, null, { timeout: 30_000 });
}

// Sections « Enrichir le parcours » de l'onglet Données (`tracks`, `routing`,
// `collect`) : <details> repliés par défaut — les ouvrir avant tout clic ou
// `toBeVisible` sur leur contenu (un `toBeHidden` y passerait à tort).
export async function openEnrichSection(page, key) {
  const section = page.locator(`details[data-enrich-key="${key}"]`);
  await expect(section).toBeVisible();
  if (!(await section.evaluate((node) => node.open))) await section.locator('summary').click();
  await expect(section).toHaveAttribute('open', '');
}

export function snapshot(page) {
  return page.evaluate(() => window.getParcoursSnapshot());
}

export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

// Affichage des photos (lot 9), comme PHOTO_DISPLAY_DEFAULTS de
// parcours_photo_layout.mjs.
export const PHOTO_DISPLAY_DEFAULTS = Object.freeze({
  layout: 'stop', side: 'auto', anchor: 'top-right', leader: false, strip_edge: 'bottom', strip_reset: false, stack: false, pin: false, pin_size: 72,
  size: 220, frame: 'postcard', tilt: true, effect: 'fade', ken_burns: false, duration: 1.5, max_per_stop: 4,
  caption: '{legende}',
});

// Préférences globales de la page, remises en sortie de spec.
export async function resetParcoursSettings(request) {
  const response = await request.put('/api/settings', {
    data: {
      parcours_animation: { rhythm_mode: 'rate', days_per_second: 10 },
      parcours_playback: {
        pace: 'regular', hours: 'approx', camera: 'follow', framing: 'balanced',
        day_cards: true, head: 'mode', estimated_dashed: false, title: 'name',
      },
      parcours_routing: {
        enabled: false, provider: 'fossgis', fossgis_url: 'https://routing.openstreetmap.de', ors_key: '',
      },
      parcours_photo_display: PHOTO_DISPLAY_DEFAULTS,
      parcours_infos_template: '{date} · {heure} · {etapes} / {total} · {km}',
    },
  });
  expect(response.ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).parcours_animation.days_per_second)
    .toBe(10);
}

export async function cleanUp(request) {
  await deleteAllParcours(request);
  await clearLogs(request);
  await resetParcoursSettings(request);
}
