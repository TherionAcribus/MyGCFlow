import test from 'node:test';
import assert from 'node:assert/strict';

import {
    captureRatioFor,
    DEFAULT_CAPTURE_RESOLUTION,
    MAX_CAPTURE_PIXELS,
    MAX_CAPTURE_RATIO,
    normalizeCaptureResolution,
} from './static/js/capture_resolution.mjs';

const WINDOW = { cssWidth: 1280, cssHeight: 540 };

test('sans consigne, la capture garde le comportement actuel', () => {
    const r = captureRatioFor({ ...WINDOW, devicePixelRatio: 1 });
    assert.deepEqual(r, { ratio: 1, width: 1280, height: 540, limited: false });
    const hidpi = captureRatioFor({ ...WINDOW, devicePixelRatio: 2 });
    assert.equal(hidpi.ratio, 2);
    assert.equal(hidpi.width, 2560);
});

test('une hauteur demandée fixe le facteur de rendu', () => {
    // Fenêtre de 540 px de haut visée en 1080 : rendu 2x.
    const r = captureRatioFor({ ...WINDOW, devicePixelRatio: 1, resolution: '1080p' });
    assert.equal(r.ratio, 2);
    assert.deepEqual([r.width, r.height], [2560, 1080]);
    assert.equal(r.limited, false);
});

test('la densité de l\'écran reste un plancher', () => {
    // Écran HiDPI : la sortie ne doit pas être dégradée sous ce qu'on a déjà.
    const r = captureRatioFor({ cssWidth: 1920, cssHeight: 1200, devicePixelRatio: 2, resolution: '1080p' });
    assert.equal(r.ratio, 2);
    assert.equal(r.height, 2400);
});

test('le facteur est plafonné', () => {
    const r = captureRatioFor({ cssWidth: 640, cssHeight: 360, devicePixelRatio: 1, resolution: '2160p' });
    assert.equal(r.ratio, MAX_CAPTURE_RATIO);   // 6x demandé, 4x accordé
    assert.equal(r.limited, true);
});

test('le nombre de pixels est plafonné', () => {
    const r = captureRatioFor({ cssWidth: 3840, cssHeight: 2160, devicePixelRatio: 1, resolution: '2160p' });
    assert.ok(r.width * r.height <= MAX_CAPTURE_PIXELS);
    assert.ok(r.ratio <= MAX_CAPTURE_RATIO);
});

test('une valeur inconnue retombe sur le comportement actuel', () => {
    assert.equal(normalizeCaptureResolution('4k'), DEFAULT_CAPTURE_RESOLUTION);
    assert.equal(normalizeCaptureResolution(undefined), DEFAULT_CAPTURE_RESOLUTION);
    assert.equal(normalizeCaptureResolution('1440p'), '1440p');
    assert.equal(captureRatioFor({ ...WINDOW, devicePixelRatio: 1, resolution: 'énorme' }).ratio, 1);
});

test('des dimensions absurdes ne produisent ni zéro ni NaN', () => {
    for (const args of [{}, { cssWidth: 0, cssHeight: 0 }, { cssWidth: NaN, cssHeight: NaN, devicePixelRatio: NaN }]) {
        const r = captureRatioFor({ ...args, resolution: '1080p' });
        assert.ok(Number.isFinite(r.ratio) && r.ratio >= 1);
        assert.ok(r.width >= 1 && r.height >= 1);
    }
});

test('le facteur d\'échelle de MediaRecorder passe par le même calcul', () => {
    // « x2 » sur une fenêtre 1280x540 : sortie 2560x1080, rendue à 2x.
    const r = captureRatioFor({ ...WINDOW, devicePixelRatio: 1, multiplier: 2 });
    assert.equal(r.ratio, 2);
    assert.deepEqual([r.width, r.height], [2560, 1080]);
});

test('hauteur visée et facteur d\'échelle : le plus exigeant gagne', () => {
    const higher = captureRatioFor({ ...WINDOW, devicePixelRatio: 1, multiplier: 3, resolution: '1080p' });
    assert.equal(higher.ratio, 3);   // x3 demande plus que 1080p
    const target = captureRatioFor({ ...WINDOW, devicePixelRatio: 1, multiplier: 1.5, resolution: '2160p' });
    assert.equal(target.ratio, 4);   // 2160p demande 4x, pile le plafond
    assert.equal(target.limited, false);
});

test('un facteur d\'échelle absurde ne dégrade pas la sortie', () => {
    for (const multiplier of [0, -2, NaN, undefined]) {
        assert.equal(captureRatioFor({ ...WINDOW, devicePixelRatio: 2, multiplier }).ratio, 2);
    }
});
