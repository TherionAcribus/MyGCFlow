import test from 'node:test';
import assert from 'node:assert/strict';

import {
    hasNotableTrailingSilence,
    MIN_TRAILING_SILENCE_MS,
    SILENCE_TAIL_MARGIN_MS,
    trailingSilenceMs,
    trimmedDurationMs,
} from './static/js/audio_silence.mjs';

const RATE = 1000; // 1 échantillon = 1 ms : les durées se lisent directement

// Piste de `audibleMs` de son suivie de `silentMs` de silence.
function track(audibleMs, silentMs, level = 0.5) {
    const data = new Float32Array(audibleMs + silentMs);
    data.fill(level, 0, audibleMs);
    return data;
}

test('trailingSilenceMs mesure le blanc de fin', () => {
    assert.equal(trailingSilenceMs([track(5000, 3000)], RATE), 3000);
});

test('trailingSilenceMs vaut 0 quand la piste finit sur du son', () => {
    assert.equal(trailingSilenceMs([track(5000, 0)], RATE), 0);
});

test('trailingSilenceMs retient le canal qui se tait le plus tard', () => {
    assert.equal(trailingSilenceMs([track(2000, 6000), track(7000, 1000)], RATE), 1000);
});

test('trailingSilenceMs ignore le bruit de fond sous le seuil', () => {
    const data = track(5000, 3000);
    data.fill(0.001, 5000); // ≈ -60 dBFS, sous le seuil de -50
    assert.equal(trailingSilenceMs([data], RATE), 3000);
});

test('trailingSilenceMs compte les échantillons négatifs comme du son', () => {
    assert.equal(trailingSilenceMs([track(5000, 3000, -0.5)], RATE), 3000);
});

test('trailingSilenceMs renvoie la durée complète d\'une piste muette', () => {
    assert.equal(trailingSilenceMs([new Float32Array(4000)], RATE), 4000);
});

test('trailingSilenceMs tolère des entrées inexploitables', () => {
    assert.equal(trailingSilenceMs([], RATE), 0);
    assert.equal(trailingSilenceMs(null, RATE), 0);
    assert.equal(trailingSilenceMs([track(10, 10)], 0), 0);
});

test('hasNotableTrailingSilence applique le seuil de signalement', () => {
    assert.equal(hasNotableTrailingSilence(MIN_TRAILING_SILENCE_MS - 1), false);
    assert.equal(hasNotableTrailingSilence(MIN_TRAILING_SILENCE_MS), true);
    assert.equal(hasNotableTrailingSilence(NaN), false);
});

test('trimmedDurationMs retire le blanc en gardant la marge', () => {
    assert.equal(trimmedDurationMs(180000, 4000), 176000 + SILENCE_TAIL_MARGIN_MS);
});

test('trimmedDurationMs laisse intact un blanc trop court pour être signalé', () => {
    assert.equal(trimmedDurationMs(180000, 400), 180000);
});

test('trimmedDurationMs ne rogne pas une piste entièrement muette', () => {
    assert.equal(trimmedDurationMs(4000, 4000), 4000);
});

test('trimmedDurationMs laisse passer une durée inconnue', () => {
    assert.equal(trimmedDurationMs(null, 4000), null);
    assert.ok(Number.isNaN(trimmedDurationMs(NaN, 4000)));
});
