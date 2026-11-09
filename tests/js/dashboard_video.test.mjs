// Vidéo d'un tableau de bord entier (dashboard_video.mjs) : découpage du
// temps, fondus, comptage des chiffres clés, champs de la musique.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_SLIDE_SECONDS, FADE_MS, INTRO_MS, countUp, dashboardVideoDuration, musicFields, slideSeconds, videoMoment,
} from '../../static/js/dashboard_video.mjs';

test('durées : ouverture puis un écran par graphique', () => {
    assert.equal(slideSeconds('8'), 8);
    assert.equal(slideSeconds(7), DEFAULT_SLIDE_SECONDS);
    assert.equal(dashboardVideoDuration(8, 6), INTRO_MS + 48000);
    assert.equal(dashboardVideoDuration(0, 6), INTRO_MS);
});

test('moment de la vidéo : ouverture, écrans, fin', () => {
    const intro = videoMoment(0, 3, 4);
    assert.deepEqual([intro.kind, intro.fade], ['intro', 0]);
    const first = videoMoment(INTRO_MS + 100, 3, 4);
    assert.equal(first.kind, 'slide');
    assert.equal(first.index, 0);
    assert.equal(first.fade, 100 / FADE_MS);
    // Animation sur 70 % de l'écran, puis le graphique complet.
    assert.equal(videoMoment(INTRO_MS + 2800, 3, 4).progress, 1);
    assert.ok(videoMoment(INTRO_MS + 1400, 3, 4).progress < 0.6);
    const third = videoMoment(INTRO_MS + 8000 + 600, 3, 4);
    assert.deepEqual([third.index, third.fade], [2, 1]);
    assert.equal(videoMoment(INTRO_MS + 12000, 3, 4).kind, 'end');
});

test('chiffre clé : de 0 à sa valeur, entier si elle l’est', () => {
    assert.equal(countUp(812, 0), 0);
    assert.equal(countUp(812, 1), 812);
    assert.ok(countUp(812, 0.5) > 406);           // décélère : déjà plus de la moitié
    assert.ok(Number.isInteger(countUp(812, 0.37)));
    assert.equal(countUp(2.5, 1), 2.5);
    assert.equal(countUp(null, 0.5), null);
});

test('musique : bibliothèque ou fichier, bouclée et fondue', () => {
    assert.equal(musicFields(null), null);
    assert.deepEqual(musicFields({ kind: 'library', file: 'ete.mp3', start: 12 }),
        { audio_loop: '1', audio_fade_out: '2', audio: 'ete.mp3', audio_start: '12' });
    assert.deepEqual(musicFields({ kind: 'upload' }), { audio_loop: '1', audio_fade_out: '2' });
});
