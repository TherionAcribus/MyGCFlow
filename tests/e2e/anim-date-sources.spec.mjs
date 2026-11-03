// Sources des dates d'animation (onglet Animation) : chaque champ montre
// sous lui les puces « Données », « Sélection » (étendue réelle des caches
// filtrées, quand elle diffère des données), « Filtre » (si un filtre de
// dates actif diffère des données) et « Personnalisée » — cette dernière
// uniquement quand la valeur saisie ne correspond à aucune des sources,
// pour que l'état « date à la main » ne passe pas pour un état neutre.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
}

async function importFixture(page) {
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
}

// Une date affichée différente de celle du champ, sans supposer le format
// localisé : on reprend la valeur courante en changeant l'année.
async function otherDisplayedDate(page, selector, year = 2019) {
  const current = await page.locator(selector).inputValue();
  const other = current.replace(/\d{4}/, String(year));
  expect(other).not.toBe(current);
  return other;
}

async function setFieldDate(page, selector, value) {
  await page.locator(selector).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test.beforeEach(async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();
  await openReadyApp(page);
  await importFixture(page);
  await page.locator('a[href="#animation"]').click();
});

test('date à la main : puce « Personnalisée » visible, retour par « Données »', async ({ page }) => {
  const dataChip = page.locator('#btnResetAnimStartDate');
  const customChip = page.locator('#animCustomStartInfo');

  // Pré-remplie sur les données : « Données » cochée, pas de Personnalisée.
  await expect(dataChip).toHaveClass(/is-active/);
  await expect(customChip).toBeHidden();

  // Saisie d'une date hors bornes : « Personnalisée » prend le relais.
  const custom = await otherDisplayedDate(page, '#animDateStart');
  await setFieldDate(page, '#animDateStart', custom);
  await expect(dataChip).not.toHaveClass(/is-active/);
  await expect(customChip).toBeVisible();
  await expect(customChip).toContainText('Personnalisée');

  // « Données » réapplique la borne : les deux états repassent à la normale.
  await dataChip.click();
  await expect(page.locator('#animDateStart')).not.toHaveValue(custom);
  await expect(dataChip).toHaveClass(/is-active/);
  await expect(customChip).toBeHidden();
});

test('filtre de dates actif : puce « Filtre » proposée puis cochée au clic', async ({ page }) => {
  // Un filtre de dates différent des données fait apparaître la puce Filtre.
  const filterDate = await otherDisplayedDate(page, '#datePickerStart');
  await setFieldDate(page, '#datePickerStart', filterDate);
  await expect(page.locator('#animFilterStartInfo')).toBeVisible();
  const filterChip = page.locator('#animFilterStartValue');
  await expect(filterChip).toContainText(filterDate);
  await expect(filterChip).not.toHaveClass(/is-active/);

  // Copier la valeur du filtre coche sa puce — et masque « Personnalisée ».
  await filterChip.click();
  await expect(filterChip).toHaveClass(/is-active/);
  await expect(page.locator('#animCustomStartInfo')).toBeHidden();
  await expect(page.locator('#btnResetAnimStartDate')).not.toHaveClass(/is-active/);
});

test('filtre hors dates : puces « Sélection » proposent l\u2019étendue réelle des caches', async ({ page }) => {
  // Sans filtre, l'étendue de la sélection rejoint « Données » : rien à
  // proposer, les puces Sélection restent cachées.
  await expect(page.locator('#animSelectionStartInfo')).toBeHidden();
  await expect(page.locator('#animSelectionEndInfo')).toBeHidden();

  // Filtre de type (pas de critère de dates) : la sélection devient les deux
  // Multi du jeu (02/01 → 04/01 au lieu de 01/01 → 06/01). Les puces
  // « Sélection » apparaissent — sans puce « Filtre », le critère de dates
  // n'ayant pas bougé.
  await page.locator('#selectType').evaluate(el => el.tomselect.setValue(['Multi-cache']));

  const selStartChip = page.locator('#animSelectionStartValue');
  const selEndChip = page.locator('#animSelectionEndValue');
  const dataStartChip = page.locator('#btnResetAnimStartDate');
  const dataEndChip = page.locator('#btnResetAnimEndDate');

  await expect(page.locator('#animSelectionStartInfo')).toBeVisible();
  await expect(page.locator('#animSelectionEndInfo')).toBeVisible();
  await expect(page.locator('#animFilterStartInfo')).toBeHidden();
  await expect(page.locator('#animFilterEndInfo')).toBeHidden();

  // La date proposée diffère de la borne « Données » (01/01 → 02/01 et
  // 06/01 → 04/01). Texte comparé aux valeurs affichées pour rester
  // indépendant du format de date actif.
  const selStartText = await selStartChip.locator('.date-source-value').innerText();
  const selEndText = await selEndChip.locator('.date-source-value').innerText();
  const dataStartText = await dataStartChip.locator('.date-source-value').innerText();
  const dataEndText = await dataEndChip.locator('.date-source-value').innerText();
  expect(selStartText).not.toBe(dataStartText);
  expect(selEndText).not.toBe(dataEndText);
  expect(selStartText).not.toBe(selEndText);

  // Cliquer « Sélection » applique la date au champ et coche sa puce.
  await selStartChip.click();
  await expect(page.locator('#animDateStart')).toHaveValue(selStartText);
  await expect(selStartChip).toHaveClass(/is-active/);
  await expect(dataStartChip).not.toHaveClass(/is-active/);
  await expect(page.locator('#animCustomStartInfo')).toBeHidden();

  await selEndChip.click();
  await expect(page.locator('#animDateEnd')).toHaveValue(selEndText);
  await expect(selEndChip).toHaveClass(/is-active/);
  await expect(dataEndChip).not.toHaveClass(/is-active/);
  await expect(page.locator('#animCustomEndInfo')).toBeHidden();

  // Retour à « Données » : la puce Sélection se décoche sans disparaître.
  await dataStartChip.click();
  await expect(dataStartChip).toHaveClass(/is-active/);
  await expect(selStartChip).not.toHaveClass(/is-active/);
  await expect(page.locator('#animSelectionStartInfo')).toBeVisible();
});

test('rechargement : le filtre de dates persisté est restauré et appliqué, sans erreur JS', async ({ page }) => {
  // Filtre de dates posé et persisté (localStorage filtersSelection) : au
  // rechargement, restoreSelectedValues le reprend dans les champs et émet
  // change → updateAnimFilterInfo lit getSelectionDateExtent. Puis
  // setPickerDates (bornes des données) NE doit PAS écraser les champs déjà
  // posés : sinon le filtre est perdu, la sélection repart sur toutes les
  // données et les change émis ré-persistaient la sélection écrasée.
  // Régressions visées : les compteurs d'étendue de bdd.js étaient en let,
  // encore en zone morte au moment du change prématuré → ReferenceError
  // « Cannot access 'selectionExtentStart' » ; et l'écrasement des champs
  // restaurés par les bornes des données (filtre perdu au reload).
  // Date de filtre DANS la plage des données (la valeur du champ de fin) :
  // une date hors plage serait ramenée à la borne au rechargement et la
  // valeur restaurée ne serait plus lisible dans le champ.
  const filterDate = await page.locator('#datePickerEnd').inputValue();
  await setFieldDate(page, '#datePickerStart', filterDate);
  await expect(page.locator('#animFilterStartInfo')).toBeVisible();
  // La persistance est debouncée (applySelectionChange) : attendre qu'elle
  // soit effective avant de recharger, sinon la restauration n'a rien à lire.
  // Début posé sur la valeur du champ de fin : les deux bornes persistées
  // doivent coïncider — comparaison indépendante du format de date affiché.
  await expect.poll(() => page.evaluate(() => {
    const dates = JSON.parse(localStorage.getItem('filtersSelection') || '{}').dates || {};
    return dates.startDate && dates.startDate === dates.endDate;
  })).toBe(true);

  // Même traitement sur le filtre « publié le » : il était persisté mais
  // jamais restauré — le champ devait repartir vide puis être écrasé par la
  // borne des données. Début posé sur la valeur du champ de fin.
  const publishedDate = await page.locator('#publishedDatePickerEnd').inputValue();
  await setFieldDate(page, '#publishedDatePickerStart', publishedDate);
  await expect.poll(() => page.evaluate(() => {
    const dates = JSON.parse(localStorage.getItem('filtersSelection') || '{}').published_dates || {};
    return dates.startDate && dates.startDate === dates.endDate;
  })).toBe(true);

  // Sélection filtrée attendue après rechargement : même compteur « n / 6 »
  // (n < 6, les deux filtres de dates restreignent le jeu) — preuve que la
  // sélection restaurée est réellement appliquée, pas seulement relue.
  await expect(page.locator('#filtersCounter')).not.toContainText('6 / 6');
  const expectedCounter = await page.locator('#filtersCounter').innerText();

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // La restauration du filtre réécrit le datepicker pendant l'évaluation des
  // modules (scripts deferred, avant DOMContentLoaded) : c'est ce change
  // prématuré qui lisait selectionExtentStart en zone morte. Depuis le
  // correctif, setPickerDates n'écrase plus les champs déjà posés : les
  // change prématurés viennent de la restauration seule — on ne compte que
  // ceux émis avant DOMContentLoaded, preuve que le chemin visé a couru.
  await page.addInitScript(() => {
    window.__domReady = false;
    window.__dateStartEarlyChanges = 0;
    document.addEventListener('DOMContentLoaded', () => { window.__domReady = true; });
    document.addEventListener('change', (e) => {
      if (e.target?.id === 'datePickerStart' && !window.__domReady) window.__dateStartEarlyChanges++;
    }, true);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  // Les champs gardent les valeurs posées (pas réécrasés par les bornes des
  // données) et la sélection restaurée est appliquée au jeu chargé.
  await expect(page.locator('#datePickerStart')).toHaveValue(filterDate);
  await expect(page.locator('#publishedDatePickerStart')).toHaveValue(publishedDate);
  await expect(page.locator('#filtersCounter')).toHaveText(expectedCounter);

  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__dateStartEarlyChanges)).toBeGreaterThan(0);
});

test('les puces sont mutuellement exclusives sur les deux champs', async ({ page }) => {
  const custom = await otherDisplayedDate(page, '#animDateEnd', 2018);
  await setFieldDate(page, '#animDateEnd', custom);
  await expect(page.locator('#animCustomEndInfo')).toBeVisible();
  await expect(page.locator('#btnResetAnimEndDate')).not.toHaveClass(/is-active/);

  // L'état personnalisé est indépendant par champ : le début reste « Données ».
  await expect(page.locator('#animCustomStartInfo')).toBeHidden();
  await expect(page.locator('#btnResetAnimStartDate')).toHaveClass(/is-active/);
});
