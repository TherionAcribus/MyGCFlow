// Vidéo d'un tableau de bord entier (dashboard_video.mjs) : découpage du
// temps, fondus, comptage des chiffres clés, champs de la musique.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_SLIDE_SECONDS, FADE_MS, INTRO_MS, OUTRO_MS, countUp, dashboardVideoDuration, musicFields, slideSeconds,
    videoMoment,
} from '../../static/js/dashboard_video.mjs';

test('durées : ouverture, un écran par graphique, fermeture', () => {
    assert.equal(slideSeconds('8'), 8);
    assert.equal(slideSeconds(7), DEFAULT_SLIDE_SECONDS);
    assert.equal(dashboardVideoDuration(8, 6), INTRO_MS + 48000 + OUTRO_MS);
    assert.equal(dashboardVideoDuration(0, 6), INTRO_MS + OUTRO_MS);
    // 2 graphiques de 4 s : 3 s + 2 × 4 s + 3 s.
    assert.equal(dashboardVideoDuration(2, 4), 14000);
});

test('durées arbitraires (« calée sur la musique ») avec allowAny', () => {
    // Sans allowAny, une durée hors des quatre choix retombe au défaut.
    assert.equal(slideSeconds(7.33), DEFAULT_SLIDE_SECONDS);
    assert.equal(slideSeconds(7.33, true), 7.33);
    // Hors borne ]0, 600] ou non finie : le défaut aussi.
    assert.equal(slideSeconds(0, true), DEFAULT_SLIDE_SECONDS);
    assert.equal(slideSeconds(601, true), DEFAULT_SLIDE_SECONDS);
    assert.equal(slideSeconds('x', true), DEFAULT_SLIDE_SECONDS);
    // Le drapeau se propage : le total et les moments gardent le non-entier.
    assert.equal(dashboardVideoDuration(2, 7.33, true), INTRO_MS + 2 * 7330 + OUTRO_MS);
    assert.equal(dashboardVideoDuration(2, 7.33), INTRO_MS + 2 * DEFAULT_SLIDE_SECONDS * 1000 + OUTRO_MS);
    const moment = videoMoment(INTRO_MS + 7330, 2, 7.33, true);
    assert.equal(moment.kind, 'slide');
    assert.equal(moment.index, 1);
    // À 6,5 s le 1ᵉʳ écran court encore à 7,33 s ; rabattu à 6 s (sans
    // allowAny), le même instant est déjà dans le 2ᵉ.
    assert.equal(videoMoment(INTRO_MS + 6500, 2, 7.33, true).index, 0);
    assert.equal(videoMoment(INTRO_MS + 6500, 2, 7.33).index, 1);
});

test('moment de la vidéo : ouverture, écrans, fermeture, fin', () => {
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
    // Après le dernier graphique : la vidéo se referme sur la carte de
    // titre (bookend, 3 s) ; 'end' au-delà de la durée totale.
    const outro = videoMoment(11500, 2, 4);      // 3000 + 2 × 4000 + 500
    assert.deepEqual([outro.kind, outro.index, outro.local], ['outro', 2, 500]);
    assert.equal(videoMoment(INTRO_MS + 12000, 3, 4).kind, 'outro');
    assert.equal(videoMoment(INTRO_MS + 12000 + OUTRO_MS, 3, 4).kind, 'end');
    assert.equal(videoMoment(14000, 2, 4).kind, 'end');
});

test('sans écran de fin : la vidéo s’arrête sur le dernier graphique', () => {
    assert.equal(dashboardVideoDuration(2, 4, false, false), INTRO_MS + 8000);
    assert.equal(dashboardVideoDuration(2, 7.33, true, false), INTRO_MS + 2 * 7330);
    // Juste après le dernier écran : 'end' (le dernier graphique reste),
    // jamais la carte de titre.
    const after = videoMoment(INTRO_MS + 8000 + 500, 2, 4, false, false);
    assert.deepEqual([after.kind, after.index, after.fade], ['end', 1, 1]);
    assert.equal(videoMoment(INTRO_MS + 7000, 2, 4, false, false).kind, 'slide');
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
    // Bornes de la carte reprises : le motif bouclé joue [start, end].
    assert.deepEqual(musicFields({ kind: 'library', file: 'ete.mp3', start: 12, end: 95 }),
        { audio_loop: '1', audio_fade_out: '2', audio: 'ete.mp3', audio_start: '12', audio_end: '95' });
    // Pas de borne de fin (0 = fin du fichier) : rien n'est envoyé.
    assert.deepEqual(musicFields({ kind: 'library', file: 'ete.mp3', end: 0 }),
        { audio_loop: '1', audio_fade_out: '2', audio: 'ete.mp3' });
    assert.deepEqual(musicFields({ kind: 'upload' }), { audio_loop: '1', audio_fade_out: '2' });
});

test('musique : les fondus réglés dans la fenêtre sont envoyés', () => {
    // Fondu de sortie choisi ; fondu d'entrée ajouté seulement s'il est
    // non nul (0 = le serveur n'a rien à fondre).
    assert.deepEqual(musicFields({ kind: 'library', file: 'ete.mp3' }, { fadeOut: 4 }),
        { audio_loop: '1', audio_fade_out: '4', audio: 'ete.mp3' });
    assert.deepEqual(musicFields({ kind: 'library', file: 'ete.mp3' }, { fadeOut: 4, fadeIn: 1.5 }),
        { audio_loop: '1', audio_fade_out: '4', audio_fade_in: '1.5', audio: 'ete.mp3' });
    assert.deepEqual(musicFields({ kind: 'upload' }, { fadeOut: 3, fadeIn: 0 }),
        { audio_loop: '1', audio_fade_out: '3' });
});
