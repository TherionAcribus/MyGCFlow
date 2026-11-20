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
  // Rendu « pastilles » : les points du thème ne sont pas dessinés dessous.
  expect(snap.themePoints).toBe(false);
  expect(snap.style).toMatchObject({ render: 'stops', size: 11, numbers: 'trip', plan_line: 'dashed', trail_color: '#00b8d4' });
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

// Rendu unique : le plan au repos et la lecture dessinent les étapes de la
// même façon — pastilles du parcours, ou points du thème avec le numéro à côté.
test('rendu des étapes : pastilles ou points du thème, identique au repos et en lecture', async ({ page }) => {
  const errors = collectErrors(page);
  let snap = await openReady(page);
  const [day1] = countedKeys(snap);
  const counted = snap.days.flatMap((day) => day.keys).filter((key) => snap.stopStyles[key]?.label).length;

  // Pastilles : la lecture les peint elle-même, points du thème masqués.
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).playStops.drawn).toBeGreaterThan(0);
  expect((await snapshot(page)).themePoints).toBe(false);
  await page.locator('#btnQuickStop').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(false);

  await openStyleSubtab(page, '#tabPoints');
  await page.locator('#parcoursStyleRender').selectOption('theme');
  await expect.poll(async () => (await snapshot(page)).themePoints).toBe(true);
  snap = await snapshot(page);
  // Numéro dans une petite pastille, décalée en haut à droite du point.
  const badge = snap.stopStyles[day1[0]];
  expect(badge).toMatchObject({ label: '1', color: '#0072c6', radius: 8 });
  expect(badge.offset[0]).toBeGreaterThan(0);
  expect(badge.offset[1]).toBeGreaterThan(0);
  expect(snap.layer.stops).toBeGreaterThanOrEqual(counted);

  // L'étape reste survolable par son point (disque invisible).
  const [x, y] = snap.stopPixels[day1[0]];
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + x, box.y + y);
  await expect.poll(async () => (await snapshot(page)).mapHover).toContain(day1[0]);

  // Sans numéro : plus rien du plan sur les étapes, le point du thème seul.
  await page.locator('#parcoursStyleNumbers').selectOption('none');
  await expect.poll(async () => (await snapshot(page)).stopStyles[day1[0]]?.label).toBe('');
  await page.locator('#parcoursStyleNumbers').selectOption('trip');

  // Lecture en rendu thème : les numéros suivent les points qui apparaissent.
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).playStops.drawn).toBeGreaterThan(0);
  expect((await snapshot(page)).themePoints).toBe(true);
  await page.locator('#btnQuickStop').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(false);

  await page.locator('#parcoursStyleRender').selectOption('stops');
  await expect.poll(async () => (await snapshot(page)).themePoints).toBe(false);
  expect((await snapshot(page)).stopStyles[day1[0]]).toMatchObject({ label: '1', radius: 11, offset: [0, 0] });
  expect(errors).toEqual([]);
});

// Couleur par journée ou par type de cache, trait aux couleurs des journées.
const hexToRgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

test('couleur des étapes par journée ou par type ; trait aux couleurs des journées', async ({ page }) => {
  const errors = collectErrors(page);
  // GCPAR02 servi comme un DNF (la fixture n'en a pas) : pastille creuse.
  await page.route('**/api/parcours/*/inputs', async (route) => {
    const body = await (await route.fetch()).json();
    for (const stop of body.days.flatMap((day) => day.stops)) {
      if (stop.key === 'GCPAR02') Object.assign(stop, { kind: 'dnf', key: 'dnf:9003' });
    }
    await route.fulfill({ json: body });
  });
  let snap = await openReady(page);
  expect(snap.stopStyles['dnf:9003']).toMatchObject({ color: '#868e96', hollow: false });
  const [day1, day2] = countedKeys(snap);
  const [date1, date2] = snap.days.map((day) => day.date);
  await openStyleSubtab(page, '#tabPoints');
  await expect(page.locator('#parcoursStyleDayPalette')).toBeHidden();

  await page.locator('#parcoursStyleColorBy').selectOption('day');
  await expect.poll(async () => (await snapshot(page)).style.color_by).toBe('day');
  snap = await snapshot(page);
  const [c1, c2] = [snap.dayColors[date1], snap.dayColors[date2]];
  expect(c1).not.toBe(c2);
  expect(snap.stopStyles[day1[0]]).toMatchObject({ color: c1, hollow: false, textColor: '#ffffff' });
  expect(snap.stopStyles[day2[0]]).toMatchObject({ color: c2, hollow: false });
  // Palette montrée, couleurs par nature des étapes masquées (lieux et
  // bases restent réglables).
  await expect(page.locator('#parcoursStyleDayPalette')).toBeVisible();
  await expect(page.locator('#parcoursStyleDayPalette .parcours-day-swatch')).toHaveCount(8);
  await expect(page.locator('#parcoursStyleColorFind')).toBeHidden();
  await expect(page.locator('#parcoursStyleColorPlace')).toBeVisible();
  // La liste suit : pastille de l'étape, point de couleur de la journée.
  await expect(page.locator(`.parcours-stop[data-stop-key="${day2[0]}"] .parcours-stop-index`))
    .toHaveCSS('background-color', hexToRgb(c2));
  await expect(page.locator(`.parcours-day[data-date="${date2}"] .parcours-day-dot`))
    .toHaveCSS('background-color', hexToRgb(c2));
  // Le DNF passe en creux : fond blanc, numéro de la couleur du jour.
  expect(snap.stopStyles['dnf:9003']).toMatchObject({ color: c1, hollow: true, textColor: c1 });
  const dnfBadge = page.locator('.parcours-stop[data-stop-key="dnf:9003"] .parcours-stop-index');
  await expect(dnfBadge).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(dnfBadge).toHaveCSS('color', hexToRgb(c1));

  // Par type de cache : couleurs Geocaching (traditionnelle en vert).
  await page.locator('#parcoursStyleColorBy').selectOption('type');
  await expect.poll(async () => (await snapshot(page)).stopStyles.GCPAR01?.color).toBe('#008000');
  await expect(page.locator('.parcours-day-dot')).toHaveCount(0);

  // Trait aux couleurs des journées : ligne du plan de chaque journée, trait
  // et géocacheur de la lecture ; la couleur fixe n'est plus réglable.
  await openStyleSubtab(page, '#tabParcoursTrail');
  await page.locator('#parcoursStyleTrailByDay').check();
  await expect.poll(async () => (await snapshot(page)).style.trail_by_day).toBe(true);
  await expect(page.locator('#parcoursStyleTrailColor')).toBeDisabled();
  snap = await snapshot(page);
  const rgba = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')}, ${a})`;
  expect(snap.planLineColors[date1]).toBe(rgba(c1, 0.55));
  expect(snap.planLineColors[date2]).toBe(rgba(c2, 0.55));
  await expect(page.locator(`.parcours-day[data-date="${date1}"] .parcours-day-dot`)).toHaveCount(1);
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).playStops.headColor).toBe(c1);
  await page.locator('#btnQuickStop').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(false);
  expect(errors).toEqual([]);
});
