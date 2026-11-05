// Préréglages nommés de filtres (panneau Filtres de l'onglet Données) :
// localStorage « filterPresets » = { nom: sélection }, même forme que
// « filtersSelection » sans la clé « sources » (les sources affichées sont
// une préférence d'affichage globale, pas un filtre). Le nom est demandé par
// window.prompt ; l'application rejoue le chemin de la restauration au
// démarrage (restoreSelectedValues + refreshAttributeOwnerFilters).
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { openDataSubTab } from './data-subtabs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

// Les prédicats de waitForFunction doivent rester SYNCHRONES : une fonction
// async retourne une Promise, que Playwright interprète comme une valeur
// truthy — le wait résoudrait immédiatement, sans attendre la condition.
async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
}

async function importFixture(page) {
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
}

async function clearDb(request) {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();
}

// Décoche « Event Cache » dans le filtre Type → 5 découvertes sur 6.
async function uncheckEventType(page) {
  await page.locator('#selectType').evaluate(el => el.tomselect.open());
  await page.locator('.filter-field:has(#selectType) .ts-dropdown .option[data-value="Event Cache"]').click();
  await expect(page.locator('#filtersCounter')).toContainText('5 / 6', { timeout: 15_000 });
}

// Enregistre un préréglage : le nom passe par window.prompt, géré via
// l'événement « dialog » (accept = saisie du nom).
async function savePreset(page, name) {
  page.once('dialog', dialog => dialog.accept(name));
  await page.locator('#btnSaveFilterPreset').click();
  await expect(page.locator('#filterPresetSelect')).toHaveValue(name);
}

const readPresets = page => page.evaluate(() => JSON.parse(localStorage.getItem('filterPresets') || '{}'));


test('préréglages : enregistrer, appliquer après reset ; le select n\'est pas un filtre', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importFixture(page);
  await openDataSubTab(page, 'filters');

  // Repos : rien à appliquer ni à supprimer, seul « Enregistrer… » est actif.
  const presetSelect = page.locator('#filterPresetSelect');
  await expect(presetSelect).toContainText('Aucun préréglage enregistré');
  await expect(page.locator('#btnApplyFilterPreset')).toBeDisabled();
  await expect(page.locator('#btnDeleteFilterPreset')).toBeDisabled();
  await expect(page.locator('#btnSaveFilterPreset')).toBeEnabled();

  await uncheckEventType(page);
  await savePreset(page, 'Hors events');

  // Le préréglage est stocké sans la clé « sources » (préférence globale).
  const presets = await readPresets(page);
  expect(Object.keys(presets)).toEqual(['Hors events']);
  expect(presets['Hors events'].type).not.toContain('Event Cache');
  expect('sources' in presets['Hors events']).toBe(false);

  // Le select de préréglage n'est pas un filtre : pas de classe
  // filter-select, et le reset ne le touche pas.
  await expect(presetSelect).not.toHaveClass(/filter-select/);

  await page.locator('#btnResetAllFilters').click();
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 15_000 });
  await expect(presetSelect).toHaveValue('Hors events');

  // Choisir un nom ne fait rien seul : l'application est explicite.
  await presetSelect.selectOption('');
  await expect(page.locator('#btnApplyFilterPreset')).toBeDisabled();
  await presetSelect.selectOption('Hors events');

  await page.locator('#btnApplyFilterPreset').click();
  await expect(page.locator('#filtersCounter')).toContainText('5 / 6', { timeout: 15_000 });
});


test('préréglages : la recherche texte fait partie de la sélection enregistrée', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importFixture(page);
  await openDataSubTab(page, 'filters');

  const search = page.locator('#inputFilterSearch');
  await search.fill('multi');
  await expect(page.locator('#filtersCounter')).toContainText('2 / 6', { timeout: 15_000 });

  await savePreset(page, 'Recherche multi');

  await page.locator('#btnResetAllFilters').click();
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 15_000 });
  await expect(search).toHaveValue('');

  await page.locator('#btnApplyFilterPreset').click();
  await expect(page.locator('#filtersCounter')).toContainText('2 / 6', { timeout: 15_000 });
  await expect(search).toHaveValue('multi');
});


test('préréglages : suppression avec confirmation', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importFixture(page);
  await openDataSubTab(page, 'filters');

  await uncheckEventType(page);
  await savePreset(page, 'À supprimer');

  await page.locator('#btnDeleteFilterPreset').click();
  const modal = page.locator('.gcm-confirm-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('À supprimer');
  await modal.locator('[data-gcm-role="confirm"]').click();
  await expect(modal).toBeHidden();

  // Le select retombe sur le placeholder, les actions se désactivent.
  await expect(page.locator('#filterPresetSelect')).toHaveValue('');
  await expect(page.locator('#filterPresetSelect')).toContainText('Aucun préréglage enregistré');
  await expect(page.locator('#btnApplyFilterPreset')).toBeDisabled();
  await expect(page.locator('#btnDeleteFilterPreset')).toBeDisabled();
  expect(await readPresets(page)).toEqual({});
});


test('préréglages : le préréglage survit au rechargement sans s\'appliquer seul', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importFixture(page);
  await openDataSubTab(page, 'filters');

  await uncheckEventType(page);
  await savePreset(page, 'Hors events');

  // Revenir à la sélection complète puis attendre sa persistance (debounce
  // ~200 ms) : le rechargement ne doit pas rejouer le préréglage.
  await page.locator('#btnResetAllFilters').click();
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 15_000 });
  await expect.poll(async () => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('filtersSelection') || '{}'));
    return saved.type || [];
  }, { timeout: 15_000 }).toContain('Event Cache');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  // Le préréglage est toujours proposé mais non appliqué (placeholder).
  await expect(page.locator('#filterPresetSelect')).toHaveValue('');
  await expect(page.locator('#filterPresetSelect option[value="Hors events"]')).toHaveCount(1);

  await page.locator('#filterPresetSelect').selectOption('Hors events');
  await page.locator('#btnApplyFilterPreset').click();
  await expect(page.locator('#filtersCounter')).toContainText('5 / 6', { timeout: 15_000 });
});
