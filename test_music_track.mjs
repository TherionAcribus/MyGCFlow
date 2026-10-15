import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createMusicTrack, isAudioFile, RECENT_MUSIC_MAX, withoutRecentMusic, withRecentMusic, withRecentStart,
} from './static/js/music_track.mjs';

test('une musique choisie passe en tête des récentes, sans doublon', () => {
    const recent = [{ file: 'a', name: 'A', start: 0 }, { file: 'b', name: 'B', start: 5 }];
    assert.deepEqual(withRecentMusic(recent, { file: 'b', name: 'B', start: 5 }).map((r) => r.file), ['b', 'a']);
    assert.deepEqual(withRecentMusic(recent, { file: 'c', name: 'C', start: 0 }).map((r) => r.file), ['c', 'a', 'b']);
    assert.deepEqual(withRecentMusic(undefined, { file: 'c', name: 'C', start: 0 }).map((r) => r.file), ['c']);
    const many = Array.from({ length: 20 }, (_, i) => ({ file: `m${i}`, name: `m${i}`, start: 0 }));
    assert.equal(withRecentMusic(many, { file: 'x', name: 'X', start: 0 }).length, RECENT_MUSIC_MAX);
});

test('le point de départ d\'une musique récente suit ses changements', () => {
    const recent = [{ file: 'a', name: 'A', start: 0 }, { file: 'b', name: 'B', start: 5 }];
    assert.deepEqual(withRecentStart(recent, 'a', 12), [{ file: 'a', name: 'A', start: 12 }, recent[1]]);
    assert.deepEqual(withRecentStart(recent, 'z', 12), recent);
    assert.deepEqual(withoutRecentMusic(recent, 'a'), [recent[1]]);
});

test('un fichier de musique est reconnu à son type ou à son extension', () => {
    assert.equal(isAudioFile({ name: 'piste', type: 'audio/mpeg' }), true);
    // Sans type MIME (fréquent sous Windows) : l'extension suffit.
    for (const name of ['a.mp3', 'a.FLAC', 'a.opus', 'a.m4a', 'a.wav', 'a.wma']) {
        assert.equal(isAudioFile({ name, type: '' }), true, name);
    }
    for (const file of [
        { name: 'trouvailles.gpx', type: 'application/gpx+xml' },
        { name: 'export.zip', type: 'application/zip' },
        { name: 'clip.webm', type: 'video/webm' },
        { name: 'clip.mp4', type: '' },
        null,
    ]) {
        assert.equal(isAudioFile(file), false, file?.name);
    }
});

// Envoi simulé : chaque appel est noté et reste en attente jusqu'à ce que le
// test le résolve (nom) ou le rejette (erreur).
function fakeUpload() {
    const calls = [];
    const upload = (file) => new Promise((resolve, reject) => calls.push({ file, resolve, reject }));
    return { calls, upload };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('choisir une musique la copie aussitôt sur le serveur', async () => {
    const { calls, upload } = fakeUpload();
    const track = createMusicTrack({ upload });
    const file = { name: 'a.mp3' };
    track.select(file);
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, file);
    assert.equal(track.file(), file);
    assert.equal(track.hasFile(), true);
});

test('un export attend la copie en cours au lieu de renvoyer le fichier', async () => {
    const { calls, upload } = fakeUpload();
    const track = createMusicTrack({ upload });
    track.select({ name: 'a.mp3' });
    const pending = track.serverName();
    await flush();
    calls[0].resolve('a-0123.mp3');
    assert.equal(await pending, 'a-0123.mp3');
    // Copie faite : les exports suivants ne renvoient plus rien.
    assert.equal(await track.serverName(), 'a-0123.mp3');
    assert.equal(calls.length, 1);
});

test('une copie échouée est retentée au prochain besoin, pas mémorisée', async () => {
    const { calls, upload } = fakeUpload();
    const errors = [];
    const track = createMusicTrack({ upload, onUploadError: (err) => errors.push(err.message) });
    track.select({ name: 'a.mp3' });
    await flush();
    calls[0].reject(new Error('hors ligne'));
    const failed = track.serverName();
    assert.equal(await failed, null);
    assert.ok(errors.includes('hors ligne'));

    const retry = track.serverName();
    await flush();
    assert.equal(calls.length, 2);
    calls[1].resolve('a-0123.mp3');
    assert.equal(await retry, 'a-0123.mp3');
});

test('la copie d\'une musique remplacée entre-temps ne devient pas celle de la nouvelle', async () => {
    const { calls, upload } = fakeUpload();
    const track = createMusicTrack({ upload });
    const first = { name: 'a.mp3' };
    const second = { name: 'b.mp3' };
    track.select(first);
    track.select(second);
    await flush();
    calls[0].resolve('a-0123.mp3');
    calls[1].resolve('b-4567.mp3');
    assert.equal(await track.serverName(), 'b-4567.mp3');
});

test('un export garde la musique qu\'il a prise au départ', async () => {
    const { calls, upload } = fakeUpload();
    const track = createMusicTrack({ upload });
    const first = { name: 'a.mp3' };
    track.select(first);
    await flush();
    calls[0].resolve('a-0123.mp3');
    track.select({ name: 'b.mp3' });
    // L'export a figé `first` : il reçoit son nom, sans nouvel envoi, et la
    // musique courante reste la nouvelle.
    assert.equal(await track.serverName(first), 'a-0123.mp3');
    assert.equal(calls.filter((c) => c.file === first).length, 1);
    assert.equal(track.file().name, 'b.mp3');
});

test('reprendre une musique déjà copiée ne la renvoie pas', async () => {
    const { calls, upload } = fakeUpload();
    const track = createMusicTrack({ upload });
    const file = { name: 'a.mp3' };
    track.select(file);
    await flush();
    calls[0].resolve('a-0123.mp3');
    await track.serverName();
    track.clear();
    track.select(file);
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(await track.serverName(), 'a-0123.mp3');
});

test('une musique rechargée depuis le serveur n\'y est pas renvoyée', async () => {
    const { calls, upload } = fakeUpload();
    const track = createMusicTrack({ upload });
    track.select({ name: 'a.mp3' }, { serverName: 'a-0123.mp3' });
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(await track.serverName(), 'a-0123.mp3');
});

test('sans musique, pas de nom ni d\'envoi', async () => {
    const { calls, upload } = fakeUpload();
    const track = createMusicTrack({ upload });
    assert.equal(await track.serverName(), null);
    track.select({ name: 'a.mp3' });
    track.clear();
    assert.equal(track.hasFile(), false);
    assert.equal(track.file(), null);
    assert.equal(await track.serverName(), null);
    track.select(null);
    assert.equal(track.hasFile(), false);
    assert.equal(calls.length, 1);
});

test('une version lisible remplace l’original pour l’écran seulement', async () => {
    const track = createMusicTrack({ upload: async (file) => `${file.name}-copie` });
    const original = { name: 'morceau.wma' };
    const lisible = { name: 'morceau.wma.m4a' };
    track.select(original);
    assert.equal(track.playable(), original);
    track.setPlayable(original, lisible);
    assert.equal(track.playable(), lisible);
    assert.equal(track.playable(original), lisible);
    // La musique, et donc ce qui part à l'export, reste l'original.
    assert.equal(track.file(), original);
    assert.equal(await track.serverName(), 'morceau.wma-copie');
    track.clear();
    assert.equal(track.playable(), null);
});

test('une musique illisible le reste, pour elle seule', () => {
    const track = createMusicTrack({ upload: async () => 'x' });
    const illisible = { name: 'casse.wma' };
    const autre = { name: 'bonne.mp3' };
    track.select(illisible);
    assert.equal(track.isUnreadable(), false);
    track.markUnreadable(illisible);
    assert.equal(track.isUnreadable(), true);
    track.select(autre);
    assert.equal(track.isUnreadable(), false);
    assert.equal(track.isUnreadable(illisible), true);
});
