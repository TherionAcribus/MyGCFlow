import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RECORDING_LIMITS,
    isValidRecordingInteger,
    isValidRecordingNumber,
    normalizeAudioVolume,
    sliderFromVolume,
    standardLevelVolume,
    volumeFromSlider,
    normalizeRecordingBitrateMbps,
    normalizeRecordingFps,
    normalizeRecordingScaleFactor,
    normalizeRecordingSlowdownFactor,
    recordingQualityProfileFor,
    bitrateIsCappedFor,
    recommendedBitrateMbps,
    recorderMimeLabel,
    resolveRecorderMimeType,
} from './static/js/recording_settings.mjs';

test('chaque format proposé a un nom court', () => {
    assert.equal(recorderMimeLabel('video/webm;codecs=vp9'), 'VP9');
    assert.equal(recorderMimeLabel('video/webm;codecs=vp8'), 'VP8');
    assert.equal(recorderMimeLabel('video/mp4;codecs=h264'), 'H.264 (MP4)');
    assert.equal(recorderMimeLabel('video/webm'), 'WebM');
});

test('le format demandé est gardé quand le navigateur sait l\'encoder', () => {
    assert.equal(resolveRecorderMimeType('video/mp4;codecs=h264', () => true), 'video/mp4;codecs=h264');
    assert.equal(resolveRecorderMimeType('', () => true), 'video/webm;codecs=vp9');
});

test('sans VP9 (Firefox), la capture rapide retombe sur VP8', () => {
    const firefox = (mime) => mime === 'video/webm;codecs=vp8' || mime === 'video/webm';
    assert.equal(resolveRecorderMimeType('video/webm;codecs=vp9', firefox), 'video/webm;codecs=vp8');
    assert.equal(resolveRecorderMimeType('video/mp4;codecs=h264', firefox), 'video/webm;codecs=vp8');
});

test('aucun format encodable : pas de capture rapide', () => {
    assert.equal(resolveRecorderMimeType('video/webm;codecs=vp9', () => false), null);
    assert.equal(resolveRecorderMimeType('video/webm;codecs=vp9', () => { throw new Error('x'); }), null);
});

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

test('un volume à 0 reste muet, il ne retombe pas sur 100 %', () => {
    assert.equal(normalizeAudioVolume(0), 0);
    assert.equal(normalizeAudioVolume('0'), 0);
    assert.equal(normalizeAudioVolume('0.35'), 0.35);
});

test('le volume est borné entre 0 et 400 %, celui du fichier par défaut', () => {
    assert.equal(normalizeAudioVolume(4.5), 4);
    assert.equal(normalizeAudioVolume(1.8), 1.8);
    assert.equal(normalizeAudioVolume(-1), 0);
    for (const missing of [undefined, null, '', 'abc', NaN]) {
        assert.equal(normalizeAudioVolume(missing), 1);
    }
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


test('le curseur du volume a 100 % en son milieu', () => {
    assert.equal(volumeFromSlider(0), 0);
    assert.equal(volumeFromSlider(250), 0.5);
    assert.equal(volumeFromSlider(500), 1);
    assert.equal(volumeFromSlider(750), 2.5);
    assert.equal(volumeFromSlider(1000), 4);
    for (const volume of [0, 0.46, 1, 1.8, 4]) {
        assert.equal(volumeFromSlider(sliderFromVolume(volume)), volume);
    }
    assert.equal(sliderFromVolume(9), 1000);
});

test('le niveau standard place le volume, borné par le curseur', () => {
    assert.deepEqual(standardLevelVolume(0.4571), { volume: 0.46, limited: false });
    assert.deepEqual(standardLevelVolume(1.8), { volume: 1.8, limited: false });
    assert.deepEqual(standardLevelVolume(6.3), { volume: 4, limited: true });
    assert.deepEqual(standardLevelVolume(undefined), { volume: 1, limited: false });
});
