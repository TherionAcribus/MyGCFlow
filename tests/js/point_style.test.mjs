// Style WebGL des points DNF : forme/couleur/contour du thème en vectoriel,
// icône des échecs ou du type + anneau en mode icônes
// (static/js/dnf_point_style.mjs, options pkg.options.point.dnf — branchées
// dans buildPointStyle via le drapeau `dnf`).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDnfIcon, buildDnfRingStyle, dnfShapeStyle } from '../../static/js/dnf_point_style.mjs';

function base(over = {}) {
    return {
        center: { size: '8', color: '#ff5722', mode: 'fix' },
        border: { size: '10', color: '#123456', mode: 'fix' },
        shape: 'circle',
        mode: 'vectoriel',
        iconSet: 'geocaching',
        iconSize: '24',
        appearAnimation: false,
        recentGlowDays: 0,
        ...over,
    };
}

const SPRITE = {
    url: 'sprite.png',
    sheetWidth: 256,
    sheetHeight: 256,
    map: {
        trad: { x: 0, y: 0, w: 32, h: 32 },
        dnf: { x: 64, y: 64, w: 32, h: 32 },
    },
    typeMap: { 'Traditional Cache': 'trad' },
};

function iconBase(dnf) {
    return base({ mode: 'icone', sprite: SPRITE, dnf });
}

test('vectoriel : point noir à contour blanc par défaut', () => {
    const style = dnfShapeStyle(base(), 8, 10, 2);
    assert.equal(style['circle-fill-color'], '#000000');
    assert.equal(style['circle-stroke-color'], '#ffffff');
    assert.equal(style['circle-stroke-width'], 2);
    assert.equal(style['circle-radius'], 8);
});

test('vectoriel : forme, couleur et contour du thème', () => {
    const style = dnfShapeStyle(base({
        dnf: { shape: 'diamond', color: '#aa11bb', borderColor: '#ffcc00', borderWidth: 4 },
    }), 8, 10, 2);
    assert.equal(style['shape-points'], 4);
    assert.equal(style['shape-angle'], 0);
    assert.equal(style['shape-fill-color'], '#aa11bb');
    assert.equal(style['shape-stroke-color'], '#ffcc00');
    assert.equal(style['shape-stroke-width'], 4);
    assert.equal('circle-radius' in style, false);
});

test('vectoriel : « same » prend la forme des trouvailles', () => {
    const style = dnfShapeStyle(base({
        shape: 'triangle',
        dnf: { shape: 'same', borderWidth: 0 },
    }), 8, 10, 2);
    // Forme des trouvailles, contour à l'épaisseur du thème, couleur DNF.
    assert.equal(style['shape-points'], 3);
    assert.equal(style['shape-stroke-color'], '#ffffff');
    assert.equal(style['shape-stroke-width'], 2);
});

test('vectoriel : épaisseur nulle = pas de contour', () => {
    const style = dnfShapeStyle(base({ dnf: { borderWidth: 0 } }), 8, 10, 2);
    assert.equal('circle-stroke-color' in style, false);
});

test('icônes : « dnf » écrase l\'icône par celle des échecs', () => {
    const style = { 'icon-offset': ['match'], 'icon-size': ['match'] };
    applyDnfIcon(style, iconBase({ icon: 'dnf' }));
    assert.deepEqual(style['icon-offset'], [64, 64]);
    assert.deepEqual(style['icon-size'], [32, 32]);
});

test('icônes : « type » garde les correspondances par type', () => {
    const style = { 'icon-offset': ['match'], 'icon-size': ['match'] };
    applyDnfIcon(style, iconBase({ icon: 'type' }));
    assert.equal(style['icon-offset'][0], 'match');
});

test('anneau : couleur du contour sous l\'icône, jamais en vectoriel', () => {
    assert.equal(buildDnfRingStyle(base()), null);
    assert.equal(buildDnfRingStyle(iconBase({ borderWidth: 0 })), null);
    const ring = buildDnfRingStyle(iconBase({ borderColor: '#ffcc00', borderWidth: 3 }));
    assert.equal(ring['circle-fill-color'], '#ffcc00');
    // Rayon = moitié de l'icône + épaisseur, enveloppé par l'échelle
    // d'effacement (applyDnfVanish : '*', rayon, cas 'vanish').
    assert.deepEqual(ring['circle-radius'].slice(0, 2), ['*', 12 + 3]);
});
