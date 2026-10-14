import test from 'node:test';
import assert from 'node:assert/strict';

import { playbackGain, sourcePositionAt } from './static/js/music_playback.mjs';

test('sans boucle, la vidéo avance dans le fichier depuis le point de départ', () => {
    assert.deepEqual(sourcePositionAt(0, { startMs: 8_000 }), { sourceMs: 8_000, playedLoopsMs: 0 });
    assert.deepEqual(sourcePositionAt(5_000, { startMs: 8_000 }), { sourceMs: 13_000, playedLoopsMs: 0 });
    assert.deepEqual(sourcePositionAt(-3, {}), { sourceMs: 0, playedLoopsMs: 0 });
});

test('en boucle, une position de la vidéo retombe dans le motif répété', () => {
    // Motif de 2 s à 12 s (10 s) : à 25 s de vidéo, deux tours joués, 5 s dans le troisième.
    const plan = { startMs: 2_000, loop: { startMs: 2_000, endMs: 12_000 } };
    assert.deepEqual(sourcePositionAt(25_000, plan), { sourceMs: 7_000, playedLoopsMs: 20_000 });
    assert.deepEqual(sourcePositionAt(10_000, plan), { sourceMs: 2_000, playedLoopsMs: 10_000 });
});

test('le volume suit les fondus d\'entrée et de sortie', () => {
    const plan = { volume: 0.8, fadeInMs: 2_000, fadeOutMs: 4_000, videoMs: 20_000 };
    assert.equal(playbackGain(0, plan), 0);
    assert.equal(playbackGain(1_000, plan), 0.4);
    assert.equal(playbackGain(10_000, plan), 0.8);
    assert.equal(playbackGain(18_000, plan), 0.4);
    assert.equal(playbackGain(20_000, plan), 0);
});

test('sans fondu, le volume est plein ; sans durée de vidéo, pas de fondu de sortie', () => {
    assert.equal(playbackGain(5_000, { volume: 0.5 }), 0.5);
    assert.equal(playbackGain(5_000, { volume: 1, fadeOutMs: 3_000, videoMs: 0 }), 1);
    assert.equal(playbackGain(5_000, {}), 1);
});
