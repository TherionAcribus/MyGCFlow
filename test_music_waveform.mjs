import test from 'node:test';
import assert from 'node:assert/strict';

import {
    clampFades, FADE_LIMITS, formatStartTime, listenFromTimelineMs, musicStartForKey, musicTimeline,
    normalizeFadeSeconds, timelineMsAt, timelineX, waveformPath, waveformPeaks,
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

test('un point de départ hors de la musique est ramené dans ses bornes', () => {
    assert.equal(musicTimeline({ fileMs: 5_000, startMs: 9_000 }).startMs, 5_000);
    assert.equal(musicTimeline({ fileMs: 5_000, startMs: -1 }).intro, null);
});

test('le fondu d\'entrée part du point de départ', () => {
    const tl = musicTimeline({ fileMs: 60_000, startMs: 10_000, videoMs: 20_000, fadeInMs: 2_000 });
    assert.deepEqual(tl.fadeIn, { startMs: 10_000, endMs: 12_000 });
    assert.equal(musicTimeline({ fileMs: 60_000, fadeInMs: 2_000 }).fadeIn, null);
});

test('deux fondus plus longs que la vidéo sont réduits dans les mêmes proportions', () => {
    assert.deepEqual(clampFades({ videoMs: 10_000, fadeInMs: 2_000, fadeOutMs: 3_000 }), { fadeInMs: 2_000, fadeOutMs: 3_000 });
    assert.deepEqual(clampFades({ videoMs: 4_000, fadeInMs: 2_000, fadeOutMs: 6_000 }), { fadeInMs: 1_000, fadeOutMs: 3_000 });
    assert.deepEqual(clampFades({ videoMs: 0, fadeInMs: 2_000 }), { fadeInMs: 2_000, fadeOutMs: 0 });
});

test('une durée de fondu saisie est bornée', () => {
    assert.equal(normalizeFadeSeconds('4.5', 3), 4.5);
    assert.equal(normalizeFadeSeconds(0, 3), FADE_LIMITS.min);
    assert.equal(normalizeFadeSeconds(120, 3), FADE_LIMITS.max);
    assert.equal(normalizeFadeSeconds('', 3), 3);
    assert.equal(normalizeFadeSeconds('abc', 2), 2);
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

test('un clic sur la forme d’onde fait écouter la vidéo à partir de cet instant', () => {
    // Musique de 60 s démarrée à 10 s, vidéo de 30 s : axe de 0 à 60 s.
    const timeline = musicTimeline({ fileMs: 60_000, startMs: 10_000, videoMs: 30_000 });
    const options = { videoMs: 30_000, listenEndMs: 8_000 };
    assert.equal(listenFromTimelineMs(25_000, timeline, options), 15_000);
    // Dans l'intro sautée : depuis le début de la vidéo.
    assert.equal(listenFromTimelineMs(4_000, timeline, options), 0);
    // Après la fin de la vidéo : ses 8 dernières secondes.
    assert.equal(listenFromTimelineMs(50_000, timeline, options), 22_000);
    // Durée de vidéo inconnue : pas de borne.
    assert.equal(listenFromTimelineMs(50_000, timeline, {}), 40_000);
});

test('la poignée du point de départ se règle au clavier, dans ses bornes', () => {
    const at = (key, currentMs, shift = false) => musicStartForKey(key, { currentMs, maxMs: 19_000, shift });
    assert.equal(at('ArrowRight', 5_000), 5_100);
    assert.equal(at('ArrowLeft', 5_000, true), 4_000);
    assert.equal(at('ArrowUp', 18_950), 19_000);
    assert.equal(at('ArrowDown', 50), 0);
    assert.equal(at('PageUp', 5_000), 15_000);
    assert.equal(at('PageDown', 5_000), 0);
    assert.equal(at('Home', 5_000), 0);
    assert.equal(at('End', 5_000), 19_000);
    assert.equal(at('Enter', 5_000), null);
});

test('l’instant de la poignée s’affiche au dixième de seconde', () => {
    assert.equal(formatStartTime(0), '0:00.0');
    assert.equal(formatStartTime(5_340), '0:05.3');
    assert.equal(formatStartTime(65_250), '1:05.3');
    assert.equal(formatStartTime(599_960), '10:00.0');
});

test('un point de fin coupe la musique : la suite n\'est pas jouée, le fondu finit avec elle', () => {
    // Musique de 60 s jouée de 5 à 25 s, dans une vidéo de 30 s.
    const tl = musicTimeline({
        fileMs: 60_000, startMs: 5_000, endMs: 25_000, videoMs: 30_000, fadeMs: 3_000, fadeEndMs: 20_000,
    });
    assert.equal(tl.endMs, 25_000);
    assert.deepEqual(tl.cut, { startMs: 25_000, endMs: 60_000 });
    // La vidéo continue 10 s sans musique, après le point de fin.
    assert.deepEqual(tl.silent, { startMs: 25_000, endMs: 35_000 });
    assert.equal(tl.videoEndMs, 35_000);
    assert.deepEqual(tl.fade, { startMs: 22_000, endMs: 25_000 });
});

test('sans point de fin, la musique va au bout du fichier', () => {
    const tl = musicTimeline({ fileMs: 60_000, videoMs: 60_000 });
    assert.equal(tl.endMs, 60_000);
    assert.equal(tl.cut, null);
    assert.equal(tl.videoEndMs, null);
});

test('la poignée de fin se règle au clavier, sans passer sous sa borne basse', () => {
    const at = (key, currentMs) => musicStartForKey(key, { currentMs, minMs: 6_000, maxMs: 60_000 });
    assert.equal(at('ArrowLeft', 6_050), 6_000);
    assert.equal(at('Home', 30_000), 6_000);
    assert.equal(at('End', 30_000), 60_000);
});
