import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';


// Carte « Mes logs » (onglet Données, docs/logs-geocaching.md, lot B) :
// aperçu, import, retraits annoncés, refus d'un autre compte, suppression.
// La fixture (données fictives) contient 7 logs exploitables, dont 4 du
// compte 1234567 (2 DNF), 3 lignes illisibles et 2 fiches de caches.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.join(HERE, '..', 'fixtures', 'gc_logs', 'logs-contract-valid.json');


function contractWith(changes, testInfo, name) {
  const doc = JSON.parse(readFileSync(CONTRACT, 'utf-8'));
  changes(doc);
  const file = testInfo.outputPath(name);
  writeFileSync(file, JSON.stringify(doc));
  return file;
}


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
}


async function preview(page, file) {
  await page.locator('#gc-logs-file-input').setInputFiles(file);
  await expect(page.locator('#gcLogsPreviewModal')).toBeVisible({ timeout: 20_000 });
}


async function confirmImport(page) {
  await page.locator('#gcLogsPreviewConfirmBtn').click();
  await expect(page.locator('#gcLogsPreviewModal')).toBeHidden();
  await expect(page.locator('#gcLogsActivity')).toBeHidden({ timeout: 30_000 });
}


// Les logs vivent dans la base partagée par le runtime de test.
test.afterEach(async ({ request }) => {
  await request.post('/api/logs/clear').catch(() => {});
});


test('aperçu puis import : le statut reflète les logs', async ({ page }) => {
  await openReadyApp(page);
  const status = page.locator('#gcLogsStatus');
  await expect(status).toHaveText('Aucun log importé');
  await expect(page.locator('#gcLogsClearBtn')).toBeHidden();

  await preview(page, CONTRACT);
  await expect(page.locator('#gcLogsPreviewChanges')).toContainText('7 nouveaux logs');
  await expect(page.locator('#gcLogsPreviewChanges')).toContainText('compte Joueur_Fictif');
  await expect(page.locator('#gcLogsPreviewRemovals')).toBeHidden();
  await expect(page.locator('#gcLogsPreviewContent')).toContainText('À vous : 2 DNF');
  // Fichier daté, couverture complète déclarée, échéance du jeton visible.
  await expect(page.locator('#gcLogsPreviewChanges')).not.toContainText('pas daté');
  await expect(page.locator('#gcLogsPreviewContent'))
    .toContainText('Couverture complète déclarée (2 périmètres)');
  await expect(page.locator('#gcLogsPreviewExpiry')).toContainText('À valider avant');
  // Lignes illisibles et cache sans position : signalées, pas bloquantes.
  const issues = page.locator('#gcLogsPreviewIssues');
  await expect(issues).toBeVisible();
  await expect(issues.locator('li')).toContainText(['date absente ou illisible (1)']);

  await confirmImport(page);
  await expect(status).toContainText('7 logs enregistrés');
  await expect(status).toContainText('Joueur_Fictif');
  const detail = page.locator('#gcLogsDetail');
  await expect(detail).toContainText('À vous : 2 DNF, 1 trouvaille, 1 autre');
  await expect(detail).toContainText("3 logs d'autres joueurs");
  await expect(detail).toContainText('1 cache sans position connue');
  // Dernier import rappelé dans le détail : date + bilan + source.
  await expect(detail).toContainText('Dernier import le');
  await expect(detail).toContainText('7 nouveaux logs');
  // Exporter vit dans les options avancées : les ouvrir avant de le lire.
  await page.locator('#gcLogsAdvanced summary').click();
  await expect(page.locator('#gcLogsExportBtn')).toBeVisible();
  await expect(page.locator('#gcLogsClearBtn')).toBeVisible();
});


test('réimport : rien de nouveau, puis retrait annoncé avant validation', async ({ page }, testInfo) => {
  await openReadyApp(page);
  await preview(page, CONTRACT);
  await confirmImport(page);

  // Fichier sans date d'export : l'avertissement dit qu'il écrasera les
  // versions enregistrées plutôt que d'être ignoré.
  const undated = contractWith(doc => { delete doc.exported_at; }, testInfo, 'sans-date.json');
  await preview(page, undated);
  await expect(page.locator('#gcLogsPreviewChanges')).toContainText('pas daté');
  await page.locator('#gcLogsPreviewModal [data-bs-dismiss="modal"]').first().click();
  await expect(page.locator('#gcLogsPreviewModal')).toBeHidden();

  await preview(page, CONTRACT);
  await expect(page.locator('#gcLogsPreviewChanges')).toContainText('7 logs déjà connus');
  await page.locator('#gcLogsPreviewModal [data-bs-dismiss="modal"]').first().click();
  await expect(page.locator('#gcLogsPreviewModal')).toBeHidden();

  // Le DNF GL803Y79 a disparu d'un export qui déclare contenir tous les DNF
  // du compte : le retrait est montré AVANT d'être fait.
  const without = contractWith(doc => {
    doc.logs = doc.logs.filter(rec => rec.log_code !== 'GL803Y79');
  }, testInfo, 'sans-un-dnf.json');
  await preview(page, without);
  const removals = page.locator('#gcLogsPreviewRemovals');
  await expect(removals).toBeVisible();
  await expect(removals).toContainText('1 log sera retiré');
  await expect(removals).toContainText('GC9ZZZZ — 2021-05-02 — DNF — Joueur_Fictif');
  await confirmImport(page);
  await expect(page.locator('#gcLogsStatus')).toContainText('6 logs enregistrés');
});


test('un fichier d\'un autre compte est refusé', async ({ page }, testInfo) => {
  await openReadyApp(page);
  await preview(page, CONTRACT);
  await confirmImport(page);

  const other = contractWith(doc => { doc.account = { user_id: 999, username: 'Autre' }; },
    testInfo, 'autre-compte.json');
  await page.locator('#gc-logs-file-input').setInputFiles(other);
  await expect(page.locator('.gcm-toast.show').filter({ hasText: '999' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#gcLogsPreviewModal')).toBeHidden();
  await expect(page.locator('#gcLogsStatus')).toContainText('7 logs enregistrés');
});


test('un fichier mygcflow-logs déposé sur la page part vers « Mes logs »', async ({ page }) => {
  await openReadyApp(page);
  const content = readFileSync(CONTRACT, 'utf-8');
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'mes-logs.json', { type: 'application/json' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, content);
  await expect(page.locator('#gcLogsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#labsPreviewModal')).toBeHidden();
});


test('le favori reçoit l\'export : bandeau puis aperçu avant l\'import', async ({ page }) => {
  // Le favori est généré par le serveur avec son jeton d'installation.
  const bm = await page.request.get('/api/logs/bookmarklet');
  const js = (await bm.json()).bookmarklet;
  expect(js.startsWith('javascript:')).toBe(true);
  const token = /TOKEN\s*=\s*"([^"]+)"/.exec(js)[1];
  expect(token).toBeTruthy();

  // Même envoi que le favori depuis geocaching.com (origine simulée).
  const received = await page.request.post('/api/logs/receive', {
    headers: { 'X-MyGCFlow-Token': token, 'Origin': 'https://www.geocaching.com' },
    data: readFileSync(CONTRACT),
  });
  expect(received.status()).toBe(202);

  await openReadyApp(page);
  const alert = page.locator('#gcLogsPendingAlert');
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await page.locator('#gcLogsPendingViewBtn').click();
  await expect(page.locator('#gcLogsPreviewModal')).toBeVisible();
  await expect(page.locator('#gcLogsPreviewChanges')).toContainText('7 nouveaux logs');
  await confirmImport(page);
  await expect(page.locator('#gcLogsStatus')).toContainText('7 logs enregistrés');
  await expect(alert).toBeHidden();
});


test('une cache sans position est placée depuis la modale de complétion', async ({ page }) => {
  await openReadyApp(page);
  await preview(page, CONTRACT);
  await confirmImport(page);

  const detail = page.locator('#gcLogsDetail');
  await expect(detail).toContainText('1 cache sans position connue');
  await detail.getByRole('button', { name: 'compléter' }).click();
  const modal = page.locator('#gcLogsCoordsModal');
  await expect(modal).toBeVisible();

  const row = modal.locator('[data-gc-code="GC2PR3N"]');
  await expect(row).toBeVisible();
  await row.locator('input').fill('48.8584, 2.2945');
  await row.getByRole('button', { name: 'Placer' }).click();
  await expect(row).toHaveCount(0);
  await expect(modal.locator('#gcLogsCoordsList')).toContainText('Aucune cache sans position');

  await page.locator('#gcLogsCoordsClose').click();
  await expect(detail).not.toContainText('cache sans position connue');
  // La correction a placé le point DNF : GC2PR3N sort de l'attente.
  const dnf = await (await page.request.get('/api/logs/dnf_features')).json();
  expect(dnf.pending).toBe(0);
  expect(dnf.features.map(f => f.properties.gc_code)).toContain('GC2PR3N');
});


test('le bouton du favori reçoit son lien javascript:', async ({ page }) => {
  await openReadyApp(page);
  const link = page.locator('#gcLogsBookmarkletLink');
  await expect(link).toBeVisible();
  await expect(link).not.toHaveAttribute('aria-disabled', 'true');
  await expect(link).toHaveAttribute('href', /^javascript:/);
  await expect(page.locator('#gcLogsCopyLinkBtn')).toBeEnabled();
});


test('« Supprimer mes logs » vide la collection après confirmation', async ({ page }) => {
  await openReadyApp(page);
  await preview(page, CONTRACT);
  await confirmImport(page);

  await page.locator('#gcLogsClearBtn').click();
  await page.locator('.gcm-confirm-modal [data-gcm-role="confirm"]').click();
  await expect(page.locator('#gcLogsStatus')).toHaveText('Aucun log importé');
  await expect(page.locator('#gcLogsClearBtn')).toBeHidden();
  await expect(page.locator('#gcLogsDetail')).toBeHidden();
});
