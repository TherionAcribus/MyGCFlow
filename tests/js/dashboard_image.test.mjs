// Image d'un tableau de bord entier (dashboard_image.mjs) : netteté bornée,
// textes coupés et répartis sur les lignes du navigateur, glyphes d'icônes.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    IMAGE_MAX_AREA, IMAGE_MAX_SIDE, applyTextTransform, colorVisible, ellipsize, iconGlyph, imageRatio, splitLines, wrapText,
} from '../../static/js/dashboard_image.mjs';

// Police fictive : 10 px par caractère.
const measure = (s) => s.length * 10;

test('netteté : ×2, réduite pour un très grand tableau', () => {
    assert.equal(imageRatio(1300, 1800), 2);
    // Très haut : le côté reste sous la limite.
    const tall = imageRatio(1300, 12000);
    assert.ok(12000 * tall <= IMAGE_MAX_SIDE);
    assert.ok(tall < 2);
    // Très grand : la surface reste sous la limite.
    const big = imageRatio(6000, 7000);
    assert.ok(6000 * big * 7000 * big <= IMAGE_MAX_AREA);
    assert.ok(imageRatio(0, 0) > 0);
});

test('texte coupé par « … » à la largeur', () => {
    assert.equal(ellipsize('Trouvailles', 200, measure), 'Trouvailles');
    assert.equal(ellipsize('Trouvailles par mois', 100, measure), 'Trouvaill…');
    assert.ok(measure(ellipsize('Trouvailles par mois', 100, measure)) <= 100);
    // Pas d'espace avant les points de suspension.
    assert.equal(ellipsize('ab cd ef', 40, measure), 'ab…');
    assert.equal(ellipsize('abc', 5, measure), '');
});

test('mots répartis sur les lignes mises en page', () => {
    assert.deepEqual(splitLines('Sans D/T : 3 · Seule la première période', [130, 120, 200], measure),
        ['Sans D/T : 3', '· Seule la', 'première période']);
    assert.deepEqual(splitLines('un deux', [200], measure), ['un deux']);
    assert.deepEqual(splitLines('un', [], measure), []);
    // Un mot plus long que sa ligne y reste quand même.
    assert.deepEqual(splitLines('anticonstitutionnellement oui', [50, 80], measure), ['anticonstitutionnellement', 'oui']);
});

test('en-tête : texte libre coupé en lignes', () => {
    assert.deepEqual(wrapText('Toute la période · 812 trouvailles', 200, measure), ['Toute la période ·', '812 trouvailles']);
    assert.deepEqual(wrapText('', 200, measure), []);
});

test('glyphe d’icône, couleurs visibles, casse', () => {
    assert.equal(iconGlyph('""'), '');
    assert.equal(iconGlyph('none'), '');
    assert.equal(iconGlyph(''), '');
    assert.equal(colorVisible('rgba(0, 0, 0, 0)'), false);
    assert.equal(colorVisible('transparent'), false);
    assert.equal(colorVisible('rgb(255, 255, 255)'), true);
    assert.equal(colorVisible('rgba(10, 20, 30, 0.2)'), true);
    assert.equal(colorVisible('rgb(10 20 30 / 0)'), false);
    assert.equal(applyTextTransform('Mes défis', 'uppercase'), 'MES DÉFIS');
    assert.equal(applyTextTransform('mes défis', 'capitalize'), 'Mes Défis');
    assert.equal(applyTextTransform('Mes', 'none'), 'Mes');
});
