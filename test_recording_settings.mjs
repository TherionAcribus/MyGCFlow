import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RECORDING_LIMITS,
    estimateRecordingSizeBytes,
    formatEstimatedFileSize,
    isValidRecordingInteger,
    normalizeRecordingBitrateMbps,
    normalizeRecordingFps,
    recordingQualityProfileFor,
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

test('les profils sont détectés uniquement sur une correspondance exacte', () => {
    assert.equal(recordingQualityProfileFor(24, 4), 'compact');
    assert.equal(recordingQualityProfileFor(30, 6), 'standard');
    assert.equal(recordingQualityProfileFor(60, 12), 'fluid');
    assert.equal(recordingQualityProfileFor(30, 8), 'custom');
});

test('la taille estimée dépend du bitrate et de la durée', () => {
    const bytes = estimateRecordingSizeBytes({ bitrateMbps: 6, durationMs: 60_000 });
    assert.equal(bytes, 45_000_000);
    assert.equal(formatEstimatedFileSize(bytes), '45.0 Mo');
    assert.equal(formatEstimatedFileSize(1_250_000_000), '1.3 Go');
});
