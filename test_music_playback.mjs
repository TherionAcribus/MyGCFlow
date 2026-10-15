import test from 'node:test';
import assert from 'node:assert/strict';

import {
    crossfadedLoopChannels, gainSchedule, LOOP_JOIN_MS, loopCrossfadeMs, loopEntry,
    loopPeriodMs, loopRepriseChannels, playbackGain,
} from './static/js/music_playback.mjs';

test('un raccord fondu est borné à 40 % du motif', () => {
    assert.equal(loopCrossfadeMs(10_000, 1_000), 1_000);
    assert.equal(loopCrossfadeMs(2_000, 1_000), 800);
    assert.equal(loopCrossfadeMs(0, 1_000), 0);
    assert.equal(loopCrossfadeMs(10_000, 0), 0);
});

test('avec un raccord fondu, chaque reprise arrive plus tôt d\'autant', () => {
    // Motif de 10 s, raccord de 2 s : une reprise toutes les 8 s.
    const loop = { startMs: 2_000, endMs: 12_000, crossfadeMs: 2_000 };
    assert.equal(loopPeriodMs(loop), 8_000);
    // À 9 s de vidéo : 1 s dans la première reprise (pendant le raccord).
    assert.deepEqual(loopEntry(9_000, loop), { first: null, repriseDelayMs: 0, repriseOffsetMs: 1_000 });
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

test('la reprise seule : le raccord puis la suite du motif, sans le premier tour', () => {
    // Mêmes données que la piste complète : la reprise en est la seconde moitié.
    const data = Float32Array.from({ length: 12 }, (_, i) => i + 1);
    const loop = { startMs: 1, endMs: 11, crossfadeMs: 2 };
    const { channels, motifStart, period } = loopRepriseChannels([data], 1000, loop);
    assert.equal(motifStart, 1);
    assert.equal(period, 8);
    const [full] = crossfadedLoopChannels([data], 1000, loop).channels;
    assert.deepEqual([...channels[0]], [...full.subarray(8)]);
});

test('sans raccord, la reprise est le motif tel quel', () => {
    const data = Float32Array.from({ length: 12 }, (_, i) => i + 1);
    const { channels, period } = loopRepriseChannels([data], 1000, { startMs: 1, endMs: 11, crossfadeMs: 0 });
    assert.equal(period, 10);
    assert.deepEqual([...channels[0]], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('le raccord minimal tient dans tout motif réaliste', () => {
    assert.equal(loopCrossfadeMs(2_000, LOOP_JOIN_MS), LOOP_JOIN_MS);
    // Motif minuscule : borné comme un raccord demandé.
    assert.equal(loopCrossfadeMs(20, LOOP_JOIN_MS), 8);
});

test('entrée dans une boucle : le reste du premier tour, puis la reprise', () => {
    // Motif de 2 s à 12 s, raccord de 2 s : une reprise toutes les 8 s.
    const loop = { startMs: 2_000, endMs: 12_000, crossfadeMs: 2_000 };
    assert.deepEqual(loopEntry(0, loop), {
        first: { sourceMs: 2_000, durationMs: 8_000 }, repriseDelayMs: 8_000, repriseOffsetMs: 0,
    });
    assert.deepEqual(loopEntry(5_000, loop), {
        first: { sourceMs: 7_000, durationMs: 3_000 }, repriseDelayMs: 3_000, repriseOffsetMs: 0,
    });
    // Deux reprises plus loin, même position dans la reprise.
    assert.deepEqual(loopEntry(17_000, loop), { first: null, repriseDelayMs: 0, repriseOffsetMs: 1_000 });
});

test('le volume programmé suit les fondus par segments linéaires', () => {
    const plan = { volume: 0.8, fadeInMs: 2_000, fadeOutMs: 4_000, videoMs: 20_000 };
    assert.deepEqual(gainSchedule(plan, 0), [
        { ms: 0, gain: 0 }, { ms: 2_000, gain: 0.8 }, { ms: 16_000, gain: 0.8 }, { ms: 20_000, gain: 0 },
    ]);
    // Départ au milieu du fondu d'entrée (reprise d'écoute) ; puis après lui.
    assert.deepEqual(gainSchedule(plan, 1_000)[0], { ms: 1_000, gain: 0.4 });
    const late = gainSchedule(plan, 17_000);
    assert.deepEqual(late.map((p) => p.ms), [17_000, 20_000]);
    assert.ok(Math.abs(late[0].gain - 0.6) < 1e-12);
    assert.equal(late[1].gain, 0);
    // Sans fondu ni durée connue : volume constant.
    assert.deepEqual(gainSchedule({ volume: 0.5 }, 3_000), [{ ms: 3_000, gain: 0.5 }]);
});

test('là où les deux fondus se chevauchent, le volume est échantillonné finement', () => {
    // Vidéo de 4 s, fondus de 3 s : chevauchement de 1 s à 3 s.
    const plan = { volume: 1, fadeInMs: 3_000, fadeOutMs: 3_000, videoMs: 4_000 };
    const points = gainSchedule(plan, 0);
    const inside = points.filter((p) => p.ms > 1_000 && p.ms < 3_000);
    assert.equal(inside.length, 15);
    for (const p of points) assert.ok(Math.abs(p.gain - playbackGain(p.ms, plan)) < 1e-12);
    assert.equal(points.at(-1).ms, 4_000);
});
