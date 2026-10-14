import test from 'node:test';
import assert from 'node:assert/strict';

import {
    musicTimeline, sourceMsAt, timelineMsAt, timelineX, waveformPath, waveformPeaks,
} from './static/js/music_waveform.mjs';
import { analyzeChannels } from './static/js/music_analysis.mjs';

test('les pics gardent le plus fort échantillon de chaque tranche, tous canaux confondus', () => {
    const left = Float32Array.from([0.1, -0.2, 0, 0, 0.05, 0]);
    const right = Float32Array.from([0, 0, -0.4, 0.1, 0, 0]);
    // Normalisés sur le plus fort (0,4).
    assert.deepEqual(waveformPeaks([left, right], 3), [0.5, 1, 0.125]);
});

test('une piste muette ou vide donne des pics nuls ou aucun', () => {
    assert.deepEqual(waveformPeaks([new Float32Array(4)], 2), [0, 0]);
    assert.deepEqual(waveformPeaks([], 10), []);
    assert.deepEqual(waveformPeaks([new Float32Array(0)], 10), []);
    // Jamais plus de tranches que d'échantillons.
    assert.equal(waveformPeaks([Float32Array.from([1, 1])], 10).length, 2);
});

test('l\'analyse tire la durée exacte de la piste décodée', () => {
    const rate = 1000;
    const data = new Float32Array(5000);
    data.fill(0.5, 0, 3000);
    const result = analyzeChannels([data], rate);
    assert.equal(result.durationMs, 5000);
    assert.equal(result.trailingSilenceMs, 2000);
    assert.ok(result.peaks.length > 0);
});

test('musique plus longue que la vidéo : la suite est marquée non jouée, le fondu finit avec la vidéo', () => {
    const tl = musicTimeline({ fileMs: 60_000, videoMs: 20_000, fadeMs: 3_000 });
    assert.equal(tl.spanMs, 60_000);
    assert.deepEqual(tl.segments, [{ startMs: 0, endMs: 60_000, sourceStartMs: 0 }]);
    assert.deepEqual(tl.cut, { startMs: 20_000, endMs: 60_000 });
    assert.deepEqual(tl.fade, { startMs: 17_000, endMs: 20_000 });
    assert.equal(tl.silent, null);
    assert.deepEqual(tl.loopPoints, []);
});

test('musique plus courte sans boucle : la fin de la vidéo est muette', () => {
    const tl = musicTimeline({ fileMs: 10_000, videoMs: 30_000 });
    assert.equal(tl.spanMs, 30_000);
    assert.deepEqual(tl.silent, { startMs: 10_000, endMs: 30_000 });
    assert.equal(tl.cut, null);
});

test('musique en boucle : copies successives jusqu\'à la fin de la vidéo', () => {
    const tl = musicTimeline({ fileMs: 12_000, videoMs: 25_000, loopMs: 10_000, fadeMs: 3_000 });
    assert.equal(tl.spanMs, 25_000);
    assert.deepEqual(tl.loopPoints, [10_000, 20_000]);
    assert.deepEqual(tl.segments.map((s) => [s.startMs, s.endMs]), [[0, 10_000], [10_000, 20_000], [20_000, 25_000]]);
    assert.equal(tl.silent, null);
    assert.equal(tl.cut, null);
    assert.deepEqual(tl.fade, { startMs: 22_000, endMs: 25_000 });
});

test('un écart sous la tolérance n\'est ni coupé ni muet', () => {
    const longer = musicTimeline({ fileMs: 20_400, videoMs: 20_000, toleranceMs: 1000 });
    assert.equal(longer.cut, null);
    const shorter = musicTimeline({ fileMs: 19_600, videoMs: 20_000, toleranceMs: 1000 });
    assert.equal(shorter.silent, null);
});

test('sans durée de vidéo connue, seule la musique est montrée', () => {
    const tl = musicTimeline({ fileMs: 8_000, videoMs: 0, loopMs: 4_000, fadeMs: 3_000 });
    assert.equal(tl.spanMs, 8_000);
    assert.equal(tl.segments.length, 1);
    assert.deepEqual([tl.cut, tl.silent, tl.fade], [null, null, null]);
    assert.equal(musicTimeline({ fileMs: 0 }).spanMs, 0);
});

test('le tracé suit les pics et reste plat là où la vidéo n\'a pas de musique', () => {
    const tl = musicTimeline({ fileMs: 1_000, videoMs: 2_000 });
    const d = waveformPath([1, 1], tl, 1_000, { width: 4, height: 100 });
    // Colonnes 0 et 1 : musique à pleine amplitude ; 2 et 3 : pas de musique.
    assert.equal(d, 'M0,0L1,0L2,50L3,50L4,50L4,50L3,50L2,50L1,100L0,100Z');
    // Un passage silencieux de la musique garde une épaisseur minimale.
    assert.equal(
        waveformPath([0, 0], musicTimeline({ fileMs: 1_000 }), 1_000, { width: 2, height: 100 }),
        'M0,49.5L1,49.5L2,49.5L2,50.5L1,50.5L0,50.5Z',
    );
    assert.equal(waveformPath([], tl, 1_000), '');
});

test('un point de départ décale la vidéo sur la musique et montre l\'intro sautée', () => {
    // Musique de 60 s démarrée à 10 s, vidéo de 20 s : jouée de 10 à 30 s.
    const tl = musicTimeline({ fileMs: 60_000, startMs: 10_000, videoMs: 20_000, fadeMs: 3_000 });
    assert.equal(tl.spanMs, 60_000);
    assert.equal(tl.startMs, 10_000);
    assert.deepEqual(tl.intro, { startMs: 0, endMs: 10_000 });
    assert.deepEqual(tl.cut, { startMs: 30_000, endMs: 60_000 });
    assert.deepEqual(tl.fade, { startMs: 27_000, endMs: 30_000 });
    // Musique trop courte une fois l'intro sautée : fin de vidéo muette.
    const short = musicTimeline({ fileMs: 20_000, startMs: 10_000, videoMs: 20_000 });
    assert.equal(short.spanMs, 30_000);
    assert.deepEqual(short.silent, { startMs: 20_000, endMs: 30_000 });
});

test('en boucle, chaque reprise repart du point de départ, pas du début du fichier', () => {
    // Musique de 12 s démarrée à 2 s : motif de 10 s, vidéo de 25 s.
    const tl = musicTimeline({ fileMs: 12_000, startMs: 2_000, videoMs: 25_000, loopMs: 10_000 });
    assert.equal(tl.spanMs, 27_000);
    assert.deepEqual(tl.loopPoints, [12_000, 22_000]);
    assert.deepEqual(
        tl.segments.map((s) => [s.startMs, s.endMs, s.sourceStartMs]),
        [[0, 12_000, 0], [12_000, 22_000, 2_000], [22_000, 27_000, 2_000]],
    );
});

test('un instant de la chronologie renvoie à la position entendue dans le fichier', () => {
    const tl = musicTimeline({ fileMs: 12_000, startMs: 2_000, videoMs: 25_000, loopMs: 10_000 });
    assert.equal(sourceMsAt(5_000, tl), 5_000);
    // Deuxième tour : 3 s après la reprise, soit 2 s + 3 s dans le fichier.
    assert.equal(sourceMsAt(15_000, tl), 5_000);
    const silent = musicTimeline({ fileMs: 10_000, videoMs: 30_000 });
    assert.equal(sourceMsAt(20_000, silent), null);
});

test('un point de départ hors de la musique est ramené dans ses bornes', () => {
    assert.equal(musicTimeline({ fileMs: 5_000, startMs: 9_000 }).startMs, 5_000);
    assert.equal(musicTimeline({ fileMs: 5_000, startMs: -1 }).intro, null);
});

test('les positions sont bornées à l\'étendue affichée', () => {
    const tl = musicTimeline({ fileMs: 10_000 });
    assert.equal(timelineX(2_500, tl, 1000), 250);
    assert.equal(timelineX(-5, tl, 1000), 0);
    assert.equal(timelineX(20_000, tl, 1000), 1000);
    assert.equal(timelineMsAt(250, tl, 1000), 2_500);
    assert.equal(timelineMsAt(-10, tl, 1000), 0);
    assert.equal(timelineMsAt(2000, tl, 1000), 10_000);
});
