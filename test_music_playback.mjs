import test from 'node:test';
import assert from 'node:assert/strict';

import {
    crossfadedLoopChannels, crossfadedLoopOffsetMs, loopCrossfadeMs, loopPeriodMs, playbackGain, sourcePositionAt,
} from './static/js/music_playback.mjs';

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

test('un raccord fondu est borné à 40 % du motif', () => {
    assert.equal(loopCrossfadeMs(10_000, 1_000), 1_000);
    assert.equal(loopCrossfadeMs(2_000, 1_000), 800);
    assert.equal(loopCrossfadeMs(0, 1_000), 0);
    assert.equal(loopCrossfadeMs(10_000, 0), 0);
});

test('avec un raccord fondu, chaque reprise arrive plus tôt d\'autant', () => {
    // Motif de 10 s, raccord de 2 s : une reprise toutes les 8 s.
    const plan = { startMs: 2_000, loop: { startMs: 2_000, endMs: 12_000, crossfadeMs: 2_000 } };
    assert.equal(loopPeriodMs(plan.loop), 8_000);
    // À 9 s de vidéo : 1 s dans la première reprise (pendant le raccord).
    assert.deepEqual(sourcePositionAt(9_000, plan), { sourceMs: 3_000, playedLoopsMs: 8_000 });
    // La piste construite : premier tour (0 à 8 s), puis la reprise répétée.
    assert.equal(crossfadedLoopOffsetMs(5_000, plan.loop), 5_000);
    assert.equal(crossfadedLoopOffsetMs(9_000, plan.loop), 9_000);
    assert.equal(crossfadedLoopOffsetMs(17_000, plan.loop), 9_000);
});

test('la piste à raccord fondu enchaîne la fin qui s\'efface sur le début qui monte', () => {
    // 1 échantillon = 1 ms. Motif de 10 éch. : la valeur vaut sa position + 1.
    const data = Float32Array.from({ length: 12 }, (_, i) => i + 1);
    const { channels, loopStartSeconds } = crossfadedLoopChannels([data], 1000, {
        startMs: 1, endMs: 11, crossfadeMs: 2,
    });
    const [out] = channels;
    // Premier tour : motif[0, 8] = valeurs 2 à 9 ; la reprise commence à 8 éch.
    assert.equal(out.length, 16);
    assert.equal(loopStartSeconds, 0.008);
    assert.deepEqual([...out.subarray(0, 8)], [2, 3, 4, 5, 6, 7, 8, 9]);
    // Raccord : motif[8, 10] (10, 11) qui s'efface + motif[0, 2] (2, 3) qui monte.
    const q = (x) => [Math.cos((Math.PI / 2) * x), Math.sin((Math.PI / 2) * x)];
    const [o1, i1] = q(0.25);
    const [o2, i2] = q(0.75);
    assert.ok(Math.abs(out[8] - (10 * o1 + 2 * i1)) < 1e-5);
    assert.ok(Math.abs(out[9] - (11 * o2 + 3 * i2)) < 1e-5);
    // Puis la suite du motif, sans le raccord : motif[2, 8] = valeurs 4 à 9.
    assert.deepEqual([...out.subarray(10)], [4, 5, 6, 7, 8, 9]);
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
