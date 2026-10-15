import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PLAYLIST_MAX, playlistDisplayName, playlistMoved, playlistWith, playlistWithout, trackDurationText,
} from './static/js/music_playlist.mjs';

const a = { file: 'a.mp3', name: 'A' };
const b = { file: 'b.mp3', name: 'B' };
const c = { file: 'c.mp3', name: 'C' };

test('le premier ajout fait de la musique courante le premier morceau', () => {
    assert.deepEqual(playlistWith([], a, b), [a, b]);
    assert.deepEqual(playlistWith(undefined, a, b), [a, b]);
    // Enchaînement en cours : le morceau s'ajoute à la fin.
    assert.deepEqual(playlistWith([a, b], { file: 'mix.flac' }, c), [a, b, c]);
});

test('un enchaînement est borné', () => {
    const full = Array.from({ length: PLAYLIST_MAX }, (_, i) => ({ file: `${i}.mp3` }));
    assert.equal(playlistWith(full, a, b).length, PLAYLIST_MAX);
});

test('un morceau monte, descend, ou part', () => {
    assert.deepEqual(playlistMoved([a, b, c], 1, -1), [b, a, c]);
    assert.deepEqual(playlistMoved([a, b, c], 1, 1), [a, c, b]);
    // Au bord : rien ne bouge.
    assert.deepEqual(playlistMoved([a, b, c], 0, -1), [a, b, c]);
    assert.deepEqual(playlistMoved([a, b, c], 2, 1), [a, b, c]);
    assert.deepEqual(playlistWithout([a, b, c], 1), [a, c]);
});

test('le nom et les durées d\'un enchaînement', () => {
    assert.equal(playlistDisplayName([a, b, { file: 'd.mp3' }]), 'A + B + d.mp3');
    assert.equal(trackDurationText(187.4), '3:07');
    assert.equal(trackDurationText(0), '');
    assert.equal(trackDurationText(undefined), '');
});
