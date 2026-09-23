import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RECORDING_LIMITS,
    isValidRecordingInteger,
    isValidRecordingNumber,
    normalizeRecordingBitrateMbps,
    normalizeRecordingFps,
    normalizeRecordingScaleFactor,
    normalizeRecordingSlowdownFactor,
    recordingQualityProfileFor,
    bitrateIsCappedFor,
    recommendedBitrateMbps,
} from './static/js/recording_settings.mjs';

test('les FPS sont arrondis et bornés entre 1 et 60', () => {
    assert.equal(normalizeRecordingFps(300), 60);
    assert.equal(normalizeRecordingFps(-4), 1);
    assert.equal(normalizeRecordingFps('29.6'), 30);
    assert.equal(normalizeRecordingFps('abc'), 30);
});

test('le bitrate est arrondi et borné entre 1 et 30 Mbps', () => {
    assert.equal(normalizeRecordingBitrateMbps(6000), 30);
    assert.equal(normalizeRecordingBitrateMbps(0), 1);
    assert.equal(normalizeRecordingBitrateMbps('11.7'), 12);
    assert.equal(normalizeRecordingBitrateMbps('abc'), 6);
});

test('la validation refuse les valeurs hors plage et les décimales', () => {
    assert.equal(isValidRecordingInteger('60', RECORDING_LIMITS.fps), true);
    assert.equal(isValidRecordingInteger('300', RECORDING_LIMITS.fps), false);
    assert.equal(isValidRecordingInteger('29.5', RECORDING_LIMITS.fps), false);
    assert.equal(isValidRecordingInteger('', RECORDING_LIMITS.fps), false);
});

test('le ralentissement est un entier borné entre 1 et 20', () => {
    assert.equal(normalizeRecordingSlowdownFactor(0), 1);
    assert.equal(normalizeRecordingSlowdownFactor(30), 20);
    assert.equal(normalizeRecordingSlowdownFactor('2.6'), 3);
    assert.equal(isValidRecordingNumber('2', RECORDING_LIMITS.slowdownFactor), true);
    assert.equal(isValidRecordingNumber('2.5', RECORDING_LIMITS.slowdownFactor), false);
});

test("le facteur d'échelle est borné et aligné sur des pas de 0,25", () => {
    assert.equal(normalizeRecordingScaleFactor(0), 1);
    assert.equal(normalizeRecordingScaleFactor(4), 3);
    assert.equal(normalizeRecordingScaleFactor('1.62'), 1.5);
    assert.equal(isValidRecordingNumber('1.5', RECORDING_LIMITS.scaleFactor), true);
    assert.equal(isValidRecordingNumber('1.6', RECORDING_LIMITS.scaleFactor), false);
});

test('les profils sont détectés uniquement sur une correspondance exacte', () => {
    assert.equal(recordingQualityProfileFor(24, 4), 'compact');
    assert.equal(recordingQualityProfileFor(30, 6), 'standard');
    assert.equal(recordingQualityProfileFor(60, 12), 'fluid');
    assert.equal(recordingQualityProfileFor(30, 8), 'custom');
});

test('le débit conseillé en 1080p reste celui d\'aujourd\'hui', () => {
    // 6 Mbit/s : exactement la valeur du profil « Standard ». Changer la
    // résolution ne doit pas changer ce que reçoit un utilisateur en 1080p.
    assert.equal(recommendedBitrateMbps({ width: 1920, height: 1080, fps: 30 }), 6);
});

test('le débit conseillé suit le nombre de pixels et les images par seconde', () => {
    assert.equal(recommendedBitrateMbps({ width: 2560, height: 1440, fps: 30 }), 11);
    assert.equal(recommendedBitrateMbps({ width: 3840, height: 2160, fps: 30 }), 25);
    // Deux fois plus d'images par seconde : deux fois plus de débit.
    assert.equal(recommendedBitrateMbps({ width: 1920, height: 1080, fps: 60 }), 12);
});

test('le débit conseillé reste dans les bornes réglables', () => {
    const tiny = recommendedBitrateMbps({ width: 320, height: 180, fps: 24 });
    assert.equal(tiny, RECORDING_LIMITS.bitrateMbps.min);
    const huge = recommendedBitrateMbps({ width: 3840, height: 2160, fps: 60 });
    assert.equal(huge, RECORDING_LIMITS.bitrateMbps.max);
});

test('le plafond de débit est signalé quand il devient limitant', () => {
    assert.equal(bitrateIsCappedFor({ width: 3840, height: 2160, fps: 60 }), true);
    assert.equal(bitrateIsCappedFor({ width: 3840, height: 2160, fps: 30 }), false);
    assert.equal(bitrateIsCappedFor({ width: 1920, height: 1080, fps: 30 }), false);
});

test('des dimensions absentes ou absurdes donnent le débit minimal', () => {
    for (const args of [{}, { width: 0, height: 0, fps: 30 }, { width: NaN, height: NaN }]) {
        assert.equal(recommendedBitrateMbps(args), RECORDING_LIMITS.bitrateMbps.min);
        assert.equal(bitrateIsCappedFor(args), false);
    }
});

