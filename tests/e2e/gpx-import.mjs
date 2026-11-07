// Import d'un GPX « My Finds » par le sélecteur de la carte « Mes Géocaches ».
//
// Sur une base qui contient déjà des géocaches, l'application ne remplace
// plus rien d'emblée : elle ouvre un aperçu des différences
// (#gpxDiffModal, « Remplacer mes géocaches ? ») et n'importe qu'au clic sur
// « Remplacer ma base ». Les specs partagent un même runtime : la plupart
// importent leur fixture sur la base laissée par la précédente, et
// expiraient en attendant un import resté suspendu à cette fenêtre (63 échecs
// constatés le 2026-11-07, dont toute la série music-options et images).
//
// La décision de l'application tient à `geocachesCount > 0` au moment du
// choix du fichier (handleGpxFile, bdd.js) : le helper lit cette même valeur
// juste avant, ce qui rend l'attente déterministe au lieu de guetter une
// fenêtre qui peut ne jamais venir.
//
// À ne pas utiliser pour un fichier qui n'est pas un My Finds valide (rejeté
// avant la décision, ou routé vers l'import Labs) : appeler setInputFiles
// directement. data-panel-compact.spec.mjs teste la fenêtre elle-même.
import { expect } from '@playwright/test';

export async function importGpx(page, files, { input = '#file-input' } = {}) {
    const asksConfirmation = await page.evaluate(async () => {
        const app = await import('/static/js/index.js');
        return (Number(app.geocachesCount) || 0) > 0;
    });
    await page.locator(input).setInputFiles(files);
    if (!asksConfirmation) return;
    const dialog = page.locator('#gpxDiffModal');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.locator('#gpxDiffConfirmBtn').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
}
