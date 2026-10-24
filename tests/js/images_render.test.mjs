// Images sur la carte : dessin pur (static/js/images_render.mjs) — hauteur,
// ajustement, effets d'entrée/sortie, tracé dans un contexte factice.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    IMAGE_EFFECT_EASINGS,
    IMAGE_ZOOM_FROM,
    cubicBezier,
    drawImagePanel,
    effectTimingCss,
    effectTransform,
    fitRect,
    focusInDisplay,
    imagePanelHeight,
    imageShadowCss,
    imageShadowParams,
    naturalInDisplay,
} from '../../static/js/images_render.mjs';
import { imageItemDefaults } from '../../static/js/images_model.mjs';

function itemWith(style = {}, position = {}) {
    const item = imageItemDefaults();
    return { ...item, style: { ...item.style, ...style }, position: { ...item.position, ...position } };
}

// ---------------------------------------------------------------------------
// imagePanelHeight
// ---------------------------------------------------------------------------

test('imagePanelHeight : la hauteur imposée l’emporte toujours', () => {
    const item = itemWith({ shape: 'circle' }, { height: 90, width: 160 });
    assert.equal(imagePanelHeight(item, { width: 400, height: 200 }), 90);
});

test('imagePanelHeight : rond = carré, proportions inconnues = carré', () => {
    const item = itemWith({ shape: 'circle' }, { width: 120 });
    assert.equal(imagePanelHeight(item, { width: 400, height: 200 }), 120);
    assert.equal(imagePanelHeight(itemWith({ shape: 'rect' }, { width: 120 }), null), 120);
    assert.equal(imagePanelHeight(itemWith({ shape: 'rect' }, { width: 120 }), { width: 0, height: 0 }), 120);
});

test('imagePanelHeight : proportions de l’image, marge intérieure comprise', () => {
    // Largeur 100, marge 10 : zone intérieure 80 → 80 × (50/100) + 20 = 60.
    const item = itemWith({ padding: 10 }, { width: 100 });
    assert.equal(imagePanelHeight(item, { width: 100, height: 50 }), 60);
    // La marge est bornée à la moitié de la largeur : intérieure plancher 1.
    const huge = itemWith({ padding: 100 }, { width: 100 });
    assert.equal(imagePanelHeight(huge, { width: 100, height: 100 }), 101);
});

test('imagePanelHeight : un quart de tour échange les proportions', () => {
    const natural = { width: 200, height: 100 };
    assert.equal(imagePanelHeight(itemWith({ rotate: 0 }, { width: 100 }), natural), 50);
    assert.equal(imagePanelHeight(itemWith({ rotate: 90 }, { width: 100 }), natural), 200);
    assert.equal(imagePanelHeight(itemWith({ rotate: 270 }, { width: 100 }), natural), 200);
    // 180° ne change pas les proportions ; le miroir non plus.
    assert.equal(imagePanelHeight(itemWith({ rotate: 180 }, { width: 100 }), natural), 50);
    assert.equal(imagePanelHeight(itemWith({ mirror: true }, { width: 100 }), natural), 50);
});

// ---------------------------------------------------------------------------
// naturalInDisplay / focusInDisplay (orientation)
// ---------------------------------------------------------------------------

test('naturalInDisplay : les quarts de tour échangent largeur et hauteur', () => {
    const natural = { width: 200, height: 100 };
    assert.deepEqual(naturalInDisplay(natural, 90), { width: 100, height: 200 });
    assert.deepEqual(naturalInDisplay(natural, 270), { width: 100, height: 200 });
    assert.equal(naturalInDisplay(natural, 0), natural);
    assert.equal(naturalInDisplay(natural, 180), natural);
});

test('focusInDisplay : le point source suit rotation puis miroir affiché', () => {
    const focus = (x, y, rotate = 0, mirror = false) =>
        focusInDisplay({ focus_x: x * 100, focus_y: y * 100, rotate, mirror });
    // Sans orientation : inchangé ; miroir : x inversé.
    assert.deepEqual(focus(0.25, 0.75), { x: 0.25, y: 0.75 });
    assert.deepEqual(focus(0.25, 0.75, 0, true), { x: 0.75, y: 0.75 });
    // 90° horaire : le coin haut-gauche (0,0) part en haut à droite (1,0).
    assert.deepEqual(focus(0, 0, 90), { x: 1, y: 0 });
    assert.deepEqual(focus(0.25, 0.75, 90), { x: 0.25, y: 0.25 });
    // 180° : les deux axes inversés ; 270° : rotation inverse.
    assert.deepEqual(focus(0.25, 0.75, 180), { x: 0.75, y: 0.25 });
    assert.deepEqual(focus(0.25, 0.75, 270), { x: 0.75, y: 0.75 });
    // Miroir + 90° : le miroir retourne le résultat (après rotation, dans
    // l'espace affiché) : (0.25, 0.25) → x inversé.
    assert.deepEqual(focus(0.25, 0.75, 90, true), { x: 0.75, y: 0.25 });
});

// ---------------------------------------------------------------------------
// fitRect
// ---------------------------------------------------------------------------

test('fitRect : contain montre toute l’image, centrée, bandes vides', () => {
    // 200 × 100 dans une zone 100 × 100 : largeur pleine, bandes haut/bas.
    assert.deepEqual(fitRect('contain', { width: 200, height: 100 }, 0, 0, 100, 100),
        { x: 0, y: 25, width: 100, height: 50 });
    // La position de la zone est respectée.
    assert.deepEqual(fitRect('contain', { width: 200, height: 100 }, 10, 20, 100, 100),
        { x: 10, y: 45, width: 100, height: 50 });
});

test('fitRect : cover remplit la zone, l’excédent déborde centré', () => {
    // 200 × 100 dans 100 × 100 : échelle 1 → 200 × 100, déborde de 50 de chaque côté.
    assert.deepEqual(fitRect('cover', { width: 200, height: 100 }, 0, 0, 100, 100),
        { x: -50, y: 0, width: 200, height: 100 });
    // Image haute dans une zone large : déborde en hauteur.
    assert.deepEqual(fitRect('cover', { width: 100, height: 200 }, 0, 0, 100, 50),
        { x: 0, y: -75, width: 100, height: 200 });
});

test('fitRect : proportions inconnues → la zone entière', () => {
    assert.deepEqual(fitRect('cover', null, 5, 10, 100, 50), { x: 5, y: 10, width: 100, height: 50 });
    assert.deepEqual(fitRect('contain', { width: 0, height: 0 }, 5, 10, 100, 50),
        { x: 5, y: 10, width: 100, height: 50 });
});

test('fitRect : cover suit le point focal, 0.5 = le centrage d’avant', () => {
    const natural = { width: 200, height: 100 }; // couvre en largeur : 200 × 100
    // Sans focus : centré (comportement d'origine). Fraction 0.5 : identique.
    const centered = { x: -50, y: 0, width: 200, height: 100 };
    assert.deepEqual(fitRect('cover', natural, 0, 0, 100, 100), centered);
    assert.deepEqual(fitRect('cover', natural, 0, 0, 100, 100, { x: 0.5, y: 0.5 }), centered);
    // Bord gauche de l'image au bord gauche de la zone ; bord droit aligné
    // à droite — le point focal reste dans la partie visible.
    assert.deepEqual(fitRect('cover', natural, 0, 0, 100, 100, { x: 0, y: 0.5 }),
        { x: 0, y: 0, width: 200, height: 100 });
    assert.deepEqual(fitRect('cover', natural, 0, 0, 100, 100, { x: 1, y: 0.5 }),
        { x: -100, y: 0, width: 200, height: 100 });
    // Fractions invalides : le centre sert de repli ; hors [0, 1] : bornées.
    assert.deepEqual(fitRect('cover', natural, 0, 0, 100, 100, { x: Number.NaN, y: 0.5 }), centered);
    assert.deepEqual(fitRect('cover', natural, 0, 0, 100, 100, { x: 2, y: -1 }),
        { x: -100, y: 0, width: 200, height: 100 });
    // contain ignore le point focal : l'image entière reste centrée.
    assert.deepEqual(fitRect('contain', natural, 0, 0, 100, 100, { x: 0, y: 0 }),
        { x: 0, y: 25, width: 100, height: 50 });
});

// ---------------------------------------------------------------------------
// cubicBezier / effectTimingCss
// ---------------------------------------------------------------------------

test('cubicBezier : extrémités fixées, courbe linéaire = identité', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    assert.equal(linear(0), 0);
    assert.equal(linear(1), 1);
    assert.ok(Math.abs(linear(0.25) - 0.25) < 1e-6);
    for (const [x1, y1, x2, y2] of Object.values(IMAGE_EFFECT_EASINGS)) {
        const fn = cubicBezier(x1, y1, x2, y2);
        assert.equal(fn(0), 0);
        assert.equal(fn(1), 1);
    }
});

test('cubicBezier : « slide » est un ease-out (vite au début, monotone)', () => {
    const slide = cubicBezier(...IMAGE_EFFECT_EASINGS.slide);
    assert.ok(slide(0.5) > 0.5 && slide(0.5) < 1);
    let previous = 0;
    for (let x = 0.01; x <= 1; x += 0.01) {
        const y = slide(x);
        assert.ok(y >= previous - 1e-9, `non monotone à x=${x}`);
        previous = y;
    }
});

test('cubicBezier : « zoom » dépasse 1 (rebond) puis revient', () => {
    const zoom = cubicBezier(...IMAGE_EFFECT_EASINGS.zoom);
    let peak = 0;
    for (let x = 0; x <= 1; x += 0.01) peak = Math.max(peak, zoom(x));
    assert.ok(peak > 1, 'le rebond doit dépasser 1');
    assert.ok(zoom(0.95) < peak, 'l’avancement redescend avant la fin');
});

test('effectTimingCss : easing connus en cubic-bezier, le reste linear', () => {
    assert.equal(effectTimingCss('slide'), `cubic-bezier(${IMAGE_EFFECT_EASINGS.slide.join(', ')})`);
    assert.equal(effectTimingCss('zoom'), `cubic-bezier(${IMAGE_EFFECT_EASINGS.zoom.join(', ')})`);
    assert.equal(effectTimingCss('fade'), 'linear');
    assert.equal(effectTimingCss('inconnu'), 'linear');
});

// ---------------------------------------------------------------------------
// effectTransform (slide via slideOffset, zoom, identité)
// ---------------------------------------------------------------------------

const CONTAINER = { width: 100, height: 100 };

test('effectTransform slide : sortie par le bord le plus proche, entièrement dehors', () => {
    // Plus près du bord gauche (10) : décalage de -(x + largeur) = -40.
    const nearLeft = { x: 10, y: 40, width: 30, height: 20 };
    assert.deepEqual(effectTransform('slide', 0, nearLeft, CONTAINER), { dx: -40, dy: 0, scale: 1 });
    assert.deepEqual(effectTransform('slide', 0.5, nearLeft, CONTAINER), { dx: -20, dy: 0, scale: 1 });
    // À sa place : aucun décalage (offset.dx × (1 - p) peut valoir -0,
    // équivalent à 0 avec ===).
    const done = effectTransform('slide', 1, nearLeft, CONTAINER);
    assert.ok(done.dx === 0 && done.dy === 0 && done.scale === 1);
    // Bord droit (0) : décalage de container.width - x = 20.
    assert.deepEqual(effectTransform('slide', 0, { x: 80, y: 40, width: 20, height: 20 }, CONTAINER),
        { dx: 20, dy: 0, scale: 1 });
    // Bord haut et bas.
    assert.deepEqual(effectTransform('slide', 0, { x: 40, y: 5, width: 20, height: 15 }, CONTAINER),
        { dx: 0, dy: -20, scale: 1 });
    assert.deepEqual(effectTransform('slide', 0, { x: 40, y: 95, width: 20, height: 5 }, CONTAINER),
        { dx: 0, dy: 5, scale: 1 });
});

test('effectTransform slide : à égalité, la première direction gagne (gauche)', () => {
    // Gaps identiques gauche/haut (5) : l’ordre documenté fait gagner la gauche.
    const rect = { x: 5, y: 5, width: 20, height: 20 };
    const { dx, dy } = effectTransform('slide', 0, rect, CONTAINER);
    assert.equal(dx, -25);
    assert.equal(dy, 0);
});

test('effectTransform zoom : de la moitié de la taille, rebond au-delà de 1', () => {
    assert.deepEqual(effectTransform('zoom', 0, null, null), { dx: 0, dy: 0, scale: IMAGE_ZOOM_FROM });
    assert.deepEqual(effectTransform('zoom', 1, null, null), { dx: 0, dy: 0, scale: 1 });
    // Rebond (progress > 1) : l’échelle dépasse sa taille.
    const { scale } = effectTransform('zoom', 1.2, null, null);
    assert.ok(scale > 1);
});

test('effectTransform : fondu et cas limites = identité', () => {
    const identity = { dx: 0, dy: 0, scale: 1 };
    assert.deepEqual(effectTransform('fade', 0, null, null), identity);
    assert.deepEqual(effectTransform('inconnu', 0, null, null), identity);
    // Slide sans rectangle : rien à déplacer.
    assert.deepEqual(effectTransform('slide', 0, null, CONTAINER), identity);
    // Progress non finie (donnée absente) : l’image est à sa place.
    assert.deepEqual(effectTransform('zoom', Number.NaN, null, null), identity);
});

// ---------------------------------------------------------------------------
// drawImagePanel dans un contexte factice
// ---------------------------------------------------------------------------

// Contexte 2D minimal : enregistre les appels, ne dessine rien.
function stubCtx() {
    const calls = [];
    const ctx = {
        calls,
        save() { calls.push('save'); },
        restore() { calls.push('restore'); },
        beginPath() {}, moveTo() {}, ellipse() {}, rect() {}, arcTo() {}, closePath() {},
        clip() { calls.push('clip'); },
        fillRect(x, y, w, h) { calls.push(['fill', x, y, w, h]); },
        drawImage(source, x, y, w, h) { calls.push(['draw', source, x, y, w, h]); },
        translate(x, y) { calls.push(['translate', x, y]); },
        rotate(a) { calls.push(['rotate', a]); },
        scale(x, y) { calls.push(['scale', x, y]); },
        stroke() { calls.push('stroke'); },
    };
    return ctx;
}

test('drawImagePanel : sans source ni fond, seule la forme découpe', () => {
    const ctx = stubCtx();
    drawImagePanel(ctx, 100, 80, itemWith({ background_opacity: 0, border_width: 0 }), null);
    assert.deepEqual(ctx.calls, ['save', 'clip', 'restore']);
});

test('drawImagePanel : opacité, fond sur toute la boîte, image ajustée', () => {
    const ctx = stubCtx();
    const source = { naturalWidth: 200, naturalHeight: 100 };
    drawImagePanel(ctx, 100, 100, itemWith({
        opacity: 50, background: '#102030', background_opacity: 40, fit: 'contain', border_width: 0,
    }), source, 1);
    assert.equal(ctx.globalAlpha, 0.5);
    assert.equal(ctx.fillStyle, 'rgba(16, 32, 48, 0.4)');
    assert.deepEqual(ctx.calls[1], 'clip');
    assert.deepEqual(ctx.calls[2], ['fill', 0, 0, 100, 100]);
    // contain : 200 × 100 → 100 × 50 centrée en hauteur.
    assert.deepEqual(ctx.calls[3], ['draw', source, 0, 25, 100, 50]);
    assert.equal(ctx.calls.at(-1), 'restore');
});

test('drawImagePanel : cover avec marge, clip intérieur isolé du tracé', () => {
    const ctx = stubCtx();
    drawImagePanel(ctx, 100, 100, itemWith({ padding: 10, fit: 'cover', border_width: 0 }),
        { naturalWidth: 200, naturalHeight: 100 }, 1);
    // Un second save/clip encadre le draw : la bordure ne doit pas être
    // rognée à la zone intérieure (commentaire du module).
    assert.deepEqual(ctx.calls.filter((c) => c === 'save'), ['save', 'save']);
    assert.deepEqual(ctx.calls.filter((c) => c === 'clip'), ['clip', 'clip']);
    // Zone intérieure 80 × 80 à partir de (10, 10) : image 200 × 100 couvre
    // en hauteur → 160 × 80, déborde de 40 de chaque côté.
    assert.deepEqual(ctx.calls.find((c) => c[0] === 'draw'),
        ['draw', { naturalWidth: 200, naturalHeight: 100 }, -30, 10, 160, 80]);
});

test('drawImagePanel : rotation autour du centre, dimensions échangées', () => {
    const ctx = stubCtx();
    const source = { naturalWidth: 200, naturalHeight: 100 };
    // Image paysage tournée de 90° : portrait 50 × 100 centré dans la boîte
    // (100 × 100), centre (50, 50). Avant rotation elle est dessinée en
    // dimensions échangées (100 × 50).
    drawImagePanel(ctx, 100, 100, itemWith({ fit: 'contain', rotate: 90 }), source, 1);
    const i = ctx.calls.findIndex((c) => c[0] === 'translate');
    assert.deepEqual(ctx.calls[i], ['translate', 50, 50]);
    assert.deepEqual(ctx.calls[i + 1], ['rotate', Math.PI / 2]);
    assert.deepEqual(ctx.calls[i + 2], ['draw', source, -50, -25, 100, 50]);
    // La transformée est encadrée : le tracé suivant repart sans rotation.
    assert.equal(ctx.calls[i - 1], 'save');
    assert.equal(ctx.calls[i + 3], 'restore');
});

test('drawImagePanel : miroir retourné dans l’espace affiché', () => {
    const ctx = stubCtx();
    const source = { naturalWidth: 200, naturalHeight: 100 };
    // contain : 200 × 100 → 100 × 50 centrée ((0,15)→(100,65)), miroir =
    // scale(-1, 1) après translation au centre du rect (50, 40) — AVANT
    // rotate dans le code : dans la composée, il retourne le résultat
    // affiché, à toute rotation.
    drawImagePanel(ctx, 100, 80, itemWith({ fit: 'contain', mirror: true }), source, 1);
    const i = ctx.calls.findIndex((c) => c[0] === 'translate');
    assert.deepEqual(ctx.calls[i], ['translate', 50, 40]);
    assert.deepEqual(ctx.calls[i + 1], ['scale', -1, 1]);
    assert.deepEqual(ctx.calls[i + 2], ['rotate', 0]);
    assert.deepEqual(ctx.calls[i + 3], ['draw', source, -50, -25, 100, 50]);
});

test('drawImagePanel : la bordure est doublée puis rognée par la forme', () => {
    const ctx = stubCtx();
    drawImagePanel(ctx, 100, 80, itemWith({ border_width: 3, border_color: '#fff' }), null, 2);
    assert.equal(ctx.strokeStyle, '#fff');
    // Trait doublé et mis à l’échelle : seule la moitié intérieure reste.
    assert.equal(ctx.lineWidth, 3 * 2 * 2);
    assert.equal(ctx.calls.at(-2), 'stroke');
});

// ---------------------------------------------------------------------------
// Ombre portée : paramètres communs aperçu (drop-shadow CSS) / vidéo (shadow*)
// ---------------------------------------------------------------------------

test('imageShadowParams : les défauts reproduisent l’ombre historique', () => {
    // Style d'origine (figé avant le réglage) : offsetY 4, flou 12, noir 35 %.
    assert.deepEqual(imageShadowParams(imageItemDefaults().style),
        { x: 0, y: 4, blur: 12, color: 'rgba(0, 0, 0, 0.35)' });
    // scale : px réels par px CSS (vignettes, vidéo).
    const style = { shadow_x: -10, shadow_y: 6, shadow_blur: 20, shadow_color: '#102030', shadow_opacity: 50 };
    assert.deepEqual(imageShadowParams(style, 2),
        { x: -20, y: 12, blur: 40, color: 'rgba(16, 32, 48, 0.5)' });
    // Couleur inconnue ou non normalisée : blanc, comme drawImagePanel.
    assert.equal(imageShadowParams({ shadow_opacity: 40 }).color, 'rgba(255, 255, 255, 0.4)');
});

test('imageShadowCss : même paramétrage en drop-shadow pour l’aperçu', () => {
    assert.equal(imageShadowCss(imageItemDefaults().style),
        'drop-shadow(0px 4px 12px rgba(0, 0, 0, 0.35))');
    assert.equal(imageShadowCss(
        { shadow_x: 8, shadow_y: -4, shadow_blur: 6, shadow_color: '#ff0000', shadow_opacity: 25 }, 0.5),
        'drop-shadow(4px -2px 3px rgba(255, 0, 0, 0.25))');
});
