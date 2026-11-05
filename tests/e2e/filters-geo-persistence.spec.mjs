// Persistance du filtre Pays / Région (#selectCountry / #selectState,
// panneau Filtres de l'onglet Données) : la sélection est enregistrée dans
// localStorage « filtersSelection » (clés countries / states) et doit
// survivre au rechargement — populateCountryStateSelects, qui recrée les
// options toutes cochées, restaure la sélection persistée en fin de
// peuplement (snapshot de la sélection en cours pour un repeuplement après
// import, repli sur filtersSelection sinon).
// Le GPX est généré en mémoire : la fixture my-finds.gpx ne porte qu'un
// pays (France) et qu'une région (Île-de-France) — il en faut deux de
// chaque pour tester une dé-selection.
import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';
import { openDataSubTab } from './data-subtabs.mjs';

const GPX_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="Groundspeak Pocket Query"
     xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
  <name>My Finds Pocket Query - MyGCFlow E2E</name>
  <desc>Groundspeak deterministic browser test fixture</desc>
  <author>Groundspeak</author>`;

const gpxWpt = (code, name, day, country, state) => `<wpt lat="48.86${day}" lon="2.36${day}"><time>2025-01-0${day}T00:00:00Z</time><name>${code}</name><urlname>${name}</urlname><groundspeak:cache><groundspeak:name>${name}</groundspeak:name><groundspeak:type>Traditional Cache</groundspeak:type><groundspeak:container>Micro</groundspeak:container><groundspeak:difficulty>1.5</groundspeak:difficulty><groundspeak:terrain>1.5</groundspeak:terrain><groundspeak:country>${country}</groundspeak:country><groundspeak:state>${state}</groundspeak:state><groundspeak:logs><groundspeak:log><groundspeak:date>2026-01-0${day}T10:00:00Z</groundspeak:date><groundspeak:type>Found it</groundspeak:type></groundspeak:log></groundspeak:logs></groundspeak:cache></wpt>`;

// Deux pays × deux régions : décocher un pays retire ses deux caches,
// décocher une région n'en retire qu'une.
const FIXTURE_GPX = GPX_HEAD + [
  gpxWpt('GCFR01', 'Paris centre', 1, 'France', 'Île-de-France'),
  gpxWpt('GCFR02', 'Phare breton', 2, 'France', 'Bretagne'),
  gpxWpt('GCBE03', 'Beffroi wallon', 3, 'Belgique', 'Wallonie'),
  gpxWpt('GCBE04', 'Canal flamand', 4, 'Belgique', 'Flandre'),
].join('') + '</gpx>';

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
}

async function importGpx(page) {
  await page.locator('#file-input').setInputFiles({
    name: 'my-finds-geo.gpx', mimeType: 'application/gpx+xml',
    buffer: Buffer.from(FIXTURE_GPX, 'utf-8'),
  });
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4', { timeout: 45_000 });
}

async function clearDb(request) {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();
}

// Ouvre le menu Tom Select d'un select puis clique une option par sa valeur
// (case à cocher du plugin checkbox_options — bascule la sélection).
async function toggleOption(page, selectId, value) {
  await page.locator(`#${selectId}`).evaluate(el => el.tomselect.open());
  await page.locator(`.filter-field:has(#${selectId}) .ts-dropdown .option[data-value="${value}"]`).click();
}

// Options réelles (hors placeholder) d'un select — valeurs dans l'ordre du DOM.
const realOptionValues = (page, selectId) => page
  .locator(`#${selectId} option:not([disabled]):not([value=""])`)
  .evaluateAll(opts => opts.map(o => o.value));

const optionSelected = (page, selectId, value) => page
  .locator(`#${selectId} option[value="${value}"]`).evaluate(o => o.selected);

const savedFilters = page => page.evaluate(
  () => JSON.parse(localStorage.getItem('filtersSelection') || '{}'));

// Attend que les selects Pays/Région soient peuplés (le peuplement est
// asynchrone : /api/country_state après le chargement des données).
async function waitGeoFiltersPopulated(page, minOptions = 2) {
  await page.waitForFunction(
    n => document.querySelectorAll('#selectCountry option:not([disabled])').length >= n,
    minOptions);
}


test('filtre Pays : la dé-selection survit au rechargement et refiltre', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importGpx(page);
  await openDataSubTab(page, 'filters');
  await waitGeoFiltersPopulated(page);

  // Décocher « Belgique » : il ne reste que les deux caches françaises.
  await toggleOption(page, 'selectCountry', 'Belgique');
  await expect(page.locator('#filtersCounter')).toContainText('2 / 4', { timeout: 15_000 });
  // La liste des régions est reconstruite sur les pays retenus.
  expect((await realOptionValues(page, 'selectState')).sort())
    .toEqual(['Bretagne', 'Île-de-France']);

  // La persistance est debouncée (~200 ms) : attendre l'écriture.
  await expect.poll(async () => (await savedFilters(page)).countries, { timeout: 15_000 })
    .toEqual(['France']);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await waitGeoFiltersPopulated(page);

  // Le pays reste décoché et le compteur refiltré (pas « 4 / 4 »).
  expect(await optionSelected(page, 'selectCountry', 'Belgique')).toBe(false);
  expect(await optionSelected(page, 'selectCountry', 'France')).toBe(true);
  expect((await realOptionValues(page, 'selectState')).sort())
    .toEqual(['Bretagne', 'Île-de-France']);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 4', { timeout: 15_000 });

  // Un changement de pays APRÈS le rechargement fonctionne toujours : le
  // listener reconstruit les régions (Wallonie et Flandre reviennent).
  await openDataSubTab(page, 'filters');
  await toggleOption(page, 'selectCountry', 'Belgique');
  expect((await realOptionValues(page, 'selectState')).sort())
    .toEqual(['Bretagne', 'Flandre', 'Wallonie', 'Île-de-France']);
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4', { timeout: 15_000 });
});


test('filtre Région : la dé-selection survit au rechargement et refiltre', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importGpx(page);
  await openDataSubTab(page, 'filters');
  await waitGeoFiltersPopulated(page);

  // Décocher « Bretagne » : trois caches restent dans la sélection.
  await toggleOption(page, 'selectState', 'Bretagne');
  await expect(page.locator('#filtersCounter')).toContainText('3 / 4', { timeout: 15_000 });
  await expect.poll(async () => ((await savedFilters(page)).states || []).slice().sort(), { timeout: 15_000 })
    .toEqual(['Flandre', 'Wallonie', 'Île-de-France']);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await waitGeoFiltersPopulated(page);

  expect(await optionSelected(page, 'selectState', 'Bretagne')).toBe(false);
  expect(await optionSelected(page, 'selectState', 'Île-de-France')).toBe(true);
  await expect(page.locator('#filtersCounter')).toContainText('3 / 4', { timeout: 15_000 });

  // Re-cocher la région après rechargement : filtrage et résumé suivent.
  await openDataSubTab(page, 'filters');
  await toggleOption(page, 'selectState', 'Bretagne');
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4', { timeout: 15_000 });
});


test('pays persisté absent des données : pas d’option fantôme cochée', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importGpx(page);
  await openDataSubTab(page, 'filters');
  await waitGeoFiltersPopulated(page);

  // Simule un réimport sans ce pays : la sélection persistée mentionne un
  // pays qui n'existe plus dans l'arbre — l'option doit disparaître avec
  // lui (assainissement de setSelectValues), les vraies valeurs restent.
  await page.evaluate(() => {
    localStorage.setItem('filtersSelection', JSON.stringify({
      countries: ['France', 'Narnia'],
      states: ['Île-de-France', 'Bretagne', 'Comté de Narnia'],
    }));
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await waitGeoFiltersPopulated(page);

  // « France » restaurée, « Belgique » décochée, « Narnia » nulle part.
  expect(await optionSelected(page, 'selectCountry', 'France')).toBe(true);
  expect(await optionSelected(page, 'selectCountry', 'Belgique')).toBe(false);
  await expect(page.locator('#selectCountry option[value="Narnia"]')).toHaveCount(0);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 4', { timeout: 15_000 });

  // La prochaine écriture debouncée assainit la persistance : le fantôme
  // ne survit pas non plus dans filtersSelection.
  await expect.poll(async () => (await savedFilters(page)).countries, { timeout: 15_000 })
    .toEqual(['France']);
  await expect.poll(async () => ((await savedFilters(page)).states || []).slice().sort(), { timeout: 15_000 })
    .toEqual(['Bretagne', 'Île-de-France']);
});
