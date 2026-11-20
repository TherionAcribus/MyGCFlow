// Page Parcours : apparence des étapes et du trait, réglée dans l'onglet Style
// (bloc du thème points.parcours_style, parcours_style.mjs, docs/parcours.md) —
// carte « Étapes du parcours » du sous-onglet Points, sous-onglet Trajet propre
// à la page.
//
// Réglages posés en mémoire par l'interface, thème jamais enregistré : rien à
// remettre en sortie hormis les données (cleanUp).
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

async function openStyleSubtab(page, href) {
  await page.locator('a[href="#style"]').click();
  await page.locator(`a[href="${href}"]`).click();
}

// Clés des étapes comptées (numérotées) de chaque journée.
function countedKeys(snap) {
  return snap.days.map((day) => day.keys.filter((key) => snap.stopStyles[key]?.label));
}

test('défauts : pastilles numérotées sur tout le parcours, ligne du plan à la couleur du trait', async ({ page }) => {
  const errors = collectErrors(page);
  const snap = await openReady(page);
  expect(snap.style).toMatchObject({ size: 11, numbers: 'trip', plan_line: 'dashed', trail_color: '#00b8d4' });
  const [day1, day2] = countedKeys(snap);
  expect(day1.length).toBeGreaterThan(1);
  expect(day2.length).toBeGreaterThan(0);
  expect(snap.stopStyles[day1[0]]).toMatchObject({ label: '1', color: '#0072c6', textColor: '#ffffff', radius: 11 });
  // Numérotation continue : la deuxième journée poursuit la première.
  expect(snap.stopStyles[day2[0]].label).toBe(String(day1.length + 1));
  expect(snap.planLine).toEqual({ color: 'rgba(0, 184, 212, 0.55)', width: 3, dash: [6, 6] });
  expect(snap.trail).toEqual({ color: 'rgba(0, 184, 212, 1)', solid: '#00b8d4', width: 3 });
  expect(errors).toEqual([]);
});

test('carte « Étapes du parcours » : numéros par journée, couleur, taille bornée, liste assortie', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  await openStyleSubtab(page, '#tabPoints');
  await expect(page.locator('#parcoursStopsCard')).toBeVisible();

  await page.locator('#parcoursStyleNumbers').selectOption('day');
  await expect.poll(async () => (await snapshot(page)).style.numbers).toBe('day');
  let snap = await snapshot(page);
  const [day1, day2] = countedKeys(snap);
  expect(snap.stopStyles[day1[0]].label).toBe('1');
  expect(snap.stopStyles[day2[0]].label).toBe('1');

  // Couleur claire : le numéro passe en sombre, dans le plan comme dans la liste.
  await page.locator('#parcoursStyleColorFind').fill('#ffeb3b');
  await expect.poll(async () => (await snapshot(page)).stopStyles[day1[0]]?.color).toBe('#ffeb3b');
  snap = await snapshot(page);
  expect(snap.stopStyles[day1[0]].textColor).toBe('#212529');
  const badge = page.locator(`.parcours-stop[data-stop-key="${day1[0]}"] .parcours-stop-index`);
  await expect(badge).toHaveCSS('background-color', 'rgb(255, 235, 59)');
  await expect(badge).toHaveCSS('color', 'rgb(33, 37, 41)');
  await expect(badge).toHaveText('1');

  // Taille hors bornes : ramenée à 18, champ réaffiché à la sortie.
  const size = page.locator('#parcoursStyleSize');
  await size.fill('30');
  await size.blur();
  await expect(size).toHaveValue('18');
  await expect.poll(async () => (await snapshot(page)).stopStyles[day1[0]]?.radius).toBe(18);

  // Aucun numéro : pastilles muettes sur la carte, rang du parcours dans la liste.
  await page.locator('#parcoursStyleNumbers').selectOption('none');
  await expect.poll(async () => (await snapshot(page)).stopStyles[day2[0]]?.label).toBe('');
  await expect(page.locator(`.parcours-stop[data-stop-key="${day2[0]}"] .parcours-stop-index`))
    .toHaveText(String(day1.length + 1));

  await page.locator('#btnParcoursStyleColorsReset').click();
  await expect.poll(async () => (await snapshot(page)).stopStyles[day1[0]]?.color).toBe('#0072c6');
  await expect(page.locator('#parcoursStyleColorFind')).toHaveValue('#0072c6');
  expect(errors).toEqual([]);
});

test('sous-onglet Trajet : trait de la lecture, ligne du plan, rien du trajet du mode principal', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  await expect(page.locator('a[href="#tabTrail"]')).toHaveCount(0);
  await openStyleSubtab(page, '#tabParcoursTrail');

  await page.locator('#parcoursStyleTrailColor').fill('#ff0000');
  await page.locator('#parcoursStyleTrailWidth').fill('6');
  await page.locator('#parcoursStyleTrailWidth').blur();
  await page.locator('#parcoursStyleTrailOpacity').fill('50');
  await expect(page.locator('#parcoursStyleTrailOpacityValue')).toHaveText('50%');
  await expect.poll(async () => (await snapshot(page)).trail)
    .toEqual({ color: 'rgba(255, 0, 0, 0.5)', solid: '#ff0000', width: 6 });
  let snap = await snapshot(page);
  expect(snap.planLine).toEqual({ color: 'rgba(255, 0, 0, 0.275)', width: 6, dash: [12, 12] });

  await page.locator('#parcoursStylePlanLine').selectOption('solid');
  await expect.poll(async () => (await snapshot(page)).planLine)
    .toEqual({ color: 'rgba(255, 0, 0, 0.275)', width: 6, dash: null });
  await page.locator('#parcoursStylePlanLine').selectOption('none');
  await expect.poll(async () => (await snapshot(page)).planLine).toBe(null);
  snap = await snapshot(page);
  expect(snap.layer.lines).toBeGreaterThan(0);

  // Le trait de la lecture prend la couleur choisie (géocacheur opaque).
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(true);
  await page.locator('#btnQuickStop').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(false);
  expect(errors).toEqual([]);
});

test('un thème chargé remet ses réglages dans les contrôles et le plan', async ({ page }) => {
  const errors = collectErrors(page);
  await openReady(page);
  await openStyleSubtab(page, '#tabPoints');
  // Chargement d'un thème : options remplacées, puis reflet et redessin
  // (syncPointOptionsUI, refreshPoints → moteur › styleChanged).
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.point.parcoursStyle = { ...app.options.point.parcoursStyle, numbers: 'day', size: 9 };
    app.syncPointOptionsUI();
    app.refreshPoints(app.options);
  });
  await expect(page.locator('#parcoursStyleNumbers')).toHaveValue('day');
  await expect(page.locator('#parcoursStyleSize')).toHaveValue('9');
  const snap = await snapshot(page);
  const [, day2] = countedKeys(snap);
  expect(snap.stopStyles[day2[0]]).toMatchObject({ label: '1', radius: 9 });
  expect(errors).toEqual([]);
});
