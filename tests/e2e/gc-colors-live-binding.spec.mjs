// Garde-fou sur la frontière de module gc_colors.js -> point_webgl_style.js / flash_styles.js.
//
// Les couleurs GC ne sont pas connues au chargement des modules : elles sont
// remplies après coup par requetedefaultGcColors(), qui RÉAFFECTE gcColorsFlat.
// Les consommateurs comptent donc sur la liaison vivante d'ES modules. Remplacer
// ces imports par une copie locale (ou un `const` figé à l'import) casserait
// silencieusement la colorisation : les points retomberaient sur le noir par
// défaut et les flashs sur le gris de repli, sans la moindre erreur en console.
import { test, expect } from '@playwright/test';

test('les couleurs GC traversent la frontière de module vers points et flashs', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.gcmapReady === true, null, { timeout: 60_000 });

    const result = await page.evaluate(async () => {
        const pkg = await import('/static/js/index.js');

        // 1. La table est bien remplie après le fetch de démarrage.
        const flatLength = pkg.gcColorsFlat.length;
        const hasTrad = pkg.gcColorsFlat.includes('Traditional Cache');

        // 2. Le style de points WebGL voit la table remplie (spread `...gcColorsFlat`).
        const style = pkg.buildPointStyle({
            mode: 'vectoriel',
            shape: 'circle',
            center: { size: 5, mode: 'gc', color: '#ff0000' },
            border: { size: 5, mode: 'gc', color: '#000000' },
        });
        const fill = style['circle-fill-color'] ?? style['shape-fill-color'];
        const matchCases = Array.isArray(fill) ? fill.length : 0;

        // 3. Les styles de flash voient la table (lookup direct par type).
        //    circleStyle porte la couleur sur le contour ; starStyle sur le remplissage.
        const flashOptions = { mode: 'circle', size: 40, color_type: 'gc', rgb: { r: 1, g: 2, b: 3 } };
        const gcFlash = pkg.circleStyle(10, 1, flashOptions, 'Traditional Cache');
        const gcFlashColor = gcFlash?.getImage?.()?.getStroke?.()?.getColor?.() ?? null;
        const gcStar = pkg.starStyle(10, 1, flashOptions, 'Traditional Cache');
        const gcStarColor = gcStar?.getImage?.()?.getFill?.()?.getColor?.() ?? null;

        // 4. Repli sur la couleur fixe quand color_type n'est pas 'gc'.
        const fixedFlash = pkg.circleStyle(10, 1, { ...flashOptions, color_type: 'fix' }, 'Traditional Cache');
        const fixedFlashColor = fixedFlash?.getImage?.()?.getStroke?.()?.getColor?.() ?? null;

        return { flatLength, hasTrad, matchCases, gcFlashColor, gcStarColor, fixedFlashColor };
    });

    // La table plate est remplie et contient les vrais types de cache.
    expect(result.flatLength).toBeGreaterThan(0);
    expect(result.hasTrad).toBe(true);

    // 'match' + ['get','cache_type'] + N paires + défaut : bien plus que les 3
    // éléments qu'on aurait avec une table vide (liaison figée à l'import).
    expect(result.matchCases).toBeGreaterThan(3);

    // Vert officiel des caches traditionnelles (#008000), pas le gris de repli
    // rgba(128,128,128,…) qu'on obtiendrait si defaultGcColors n'avait pas traversé.
    expect(result.gcFlashColor).toBe('rgba(0, 128, 0, 1)');
    expect(result.gcStarColor).toBe('rgba(0, 128, 0, 1)');
    // Couleur fixe : les composantes rgb passées en options.
    expect(result.fixedFlashColor).toBe('rgba(1, 2, 3, 1)');
});
