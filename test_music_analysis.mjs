import test from 'node:test';
import assert from 'node:assert/strict';

import {
    analyzeChannels, gainDb, LOUDNESS_TARGET_DB, loudnessStats, normalizationGain,
} from './static/js/music_analysis.mjs';

const RATE = 1000;

// Signal carré d'amplitude `level` (sa moyenne quadratique vaut `level`).
function square(ms, level) {
    return Float32Array.from({ length: ms }, (_, i) => (i % 2 ? level : -level));
}

const db = (v) => 20 * Math.log10(v);

test('le niveau est celui des passages audibles, silences écartés', () => {
    const data = new Float32Array(4000);
    data.set(square(2000, 0.1), 2000); // 2 s de silence puis 2 s à 0,1
    const stats = loudnessStats([data], RATE);
    assert.ok(Math.abs(stats.loudnessDb - db(0.1)) < 0.01);
    assert.ok(Math.abs(stats.peak - 0.1) < 1e-6);
});

test('une piste muette n\'a pas de niveau mesurable', () => {
    assert.deepEqual(loudnessStats([new Float32Array(2000)], RATE), { loudnessDb: null, peak: 0 });
    assert.deepEqual(loudnessStats([], RATE), { loudnessDb: null, peak: 0 });
});

test('l\'analyse inclut le niveau', () => {
    const result = analyzeChannels([square(2000, 0.5)], RATE);
    assert.ok(Math.abs(result.loudnessDb - db(0.5)) < 0.01);
    assert.ok(Math.abs(result.peak - 0.5) < 1e-6);
});

test('le gain amène le niveau vers la cible', () => {
    // Trop fort de 6 dB : divisé par deux environ.
    const loud = normalizationGain({ loudnessDb: LOUDNESS_TARGET_DB + 6, peak: 0.5 });
    assert.ok(Math.abs(gainDb(loud) + 6) < 0.01);
    // Trop faible de 6 dB, avec de la marge sous la crête : relevé de 6 dB.
    const quiet = normalizationGain({ loudnessDb: LOUDNESS_TARGET_DB - 6, peak: 0.2 });
    assert.ok(Math.abs(gainDb(quiet) - 6) < 0.01);
});

test('le gain ne fait jamais saturer la crête', () => {
    // Niveau très bas mais crête à 0,6 : pas plus de 0,9 / 0,6.
    const gain = normalizationGain({ loudnessDb: -40, peak: 0.6 });
    assert.ok(Math.abs(gain - 1.5) < 1e-9);
});

test('sans mesure, le volume reste inchangé', () => {
    assert.equal(normalizationGain({ loudnessDb: null, peak: 0 }), 1);
    assert.equal(normalizationGain(), 1);
    assert.equal(gainDb(1), 0);
});
