// Garde-fou : la couleur du flash doit s'appliquer aux flashs en cours.
//
// Les styles de flash (flash_styles.js) lisent `options.flash.rgb`, pas
// `options.flash.color`. Tant que seul `color` était mis à jour par le
// sélecteur, la nouvelle couleur n'apparaissait qu'au prochain calcul de `rgb`
// (démarrage d'animation ou d'enregistrement) : le réglage semblait ignoré en
// cours d'animation, contrairement à la forme, la taille et la durée que les
// styles relisent telles quelles à chaque frame.
import { expect, test } from '@playwright/test';


async function openFlashPanel(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.gcmapReady === true, null, { timeout: 60_000 });

    // La base du runtime de test est vide : la modale de première utilisation
    // s'ouvre et intercepterait les clics sur les onglets.
    const firstUse = page.locator('#modal_first_use');
    await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await firstUse.isVisible()) {
        await firstUse.locator('[data-bs-dismiss="modal"]').click();
        await firstUse.waitFor({ state: 'hidden' });
    }

    await page.locator('a[href="#style"]').click();
    await page.locator('a[href="#tabPointsFlash"]').click();
}


test('changer la couleur du flash met à jour la couleur réellement dessinée', async ({ page }) => {
    await openFlashPanel(page);

    // Mode "couleur unique" : c'est le seul où le sélecteur hexadécimal compte.
    await page.check('#flashColorFix');

    // fill() sur un input[type=color] déclenche 'input' puis 'change', comme une
    // vraie sélection dans la boîte de dialogue.
    await page.locator('#flashColor').fill('#123456');

    const applied = await page.evaluate(async () => {
        const pkg = await import('/static/js/index.js');
        const flash = pkg.options.flash;
        // Couleur telle que la produirait un flash dessiné maintenant.
        const style = pkg.circleStyle(10, 1, flash, 'Traditional Cache');
        return {
            color: flash.color,
            rgb: flash.rgb,
            drawn: style?.getImage?.()?.getStroke?.()?.getColor?.() ?? null,
        };
    });

    expect(applied.color).toBe('#123456');
    expect(applied.rgb).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
    expect(applied.drawn).toBe('rgba(18, 52, 86, 1)');
});
