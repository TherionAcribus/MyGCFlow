// Chronologie de la page Mes poses (static/js/poses_timeline.mjs) et flashs
// par événement (static/js/event_flash.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    STATE_ACTIVE,
    STATE_ARCHIVED,
    STATE_DISABLED,
    appearancesInRange,
    buildPosesBase,
    buildPosesTimeline,
    filterPosesRows,
    findDayCounts,
    flashesInRange,
    maxFlashesInWindow,
    posesCounterAt,
    posesCounterMaxes,
    stateAt,
    stateChangesInRange,
    visibleSegment,
} from '../../static/js/poses_timeline.mjs';
import { filterRows } from '../../static/js/evolution_timeline.mjs';
import { EVO_NEVER_DAY } from '../../static/js/evolution_style.mjs';
import {
    EVENT_FLASH_KINDS,
    flashKindOfLog,
    flashScale,
    normalizeEventFlashes,
    resolveEventFlash,
    scaledFlash,
} from '../../static/js/event_flash.mjs';

const KINDS = ['publish', 'find', 'dnf', 'note', 'owner_note', 'alert', 'maintenance',
    'disable', 'enable', 'unarchive', 'archive', 'reviewer', 'other'];
const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));

// Trois caches : A (jour 0), B (jour 2, désactivée 5 → réactivée 8),
// C (jour 3, archivée 6 → désarchivée 9 → archivée 12, une trouvaille 13).
// Logs : `ev` trié par (jour, cache) comme le serveur.
function payload() {
    const ev = [
        // [cache, jour, type, fav, folded, auteur]
        [0, 0, K.publish, 0, 0, 0],
        [0, 0, K.find, 1, 0, 1],
        [0, 0, K.owner_note, 0, 1, 2],   // note ramenée au jour d'apparition
        [0, 1, K.find, 0, 0, 3],
        [1, 2, K.publish, 0, 0, 0],
        [2, 3, K.publish, 0, 0, 0],
        [0, 4, K.dnf, 0, 0, 4],
        [1, 5, K.disable, 0, 0, 2],
        [1, 5, K.find, 0, 0, 1],
        [1, 5, K.find, 0, 0, 3],
        [2, 6, K.archive, 0, 0, 2],
        [1, 8, K.enable, 0, 0, 2],
        [2, 9, K.unarchive, 0, 0, 0],
        [2, 12, K.archive, 0, 0, 0],
        [2, 13, K.find, 0, 0, 4],
    ];
    const st = [
        // [cache, jour, état, déduit] trié par (jour, cache)
        [1, 5, STATE_DISABLED, 0],
        [2, 6, STATE_ARCHIVED, 0],
        [1, 8, STATE_ACTIVE, 0],
        [2, 9, STATE_ACTIVE, 0],
        [2, 12, STATE_ARCHIVED, 0],
    ];
    const col = (rows, i) => rows.map((r) => r[i]);
    return {
        origin: '2020-01-01',
        count: 3,
        code: ['GCA', 'GCB', 'GCC'],
        name: ['A', 'B', 'C'],
        lon: [6.1, 6.2, 6.3],
        lat: [49.1, 49.2, 49.3],
        placed: [0, 2, 3],
        archived: [-1, -1, 12],
        status: [0, 0, 1],
        type: [0, 0, 1], types: ['Traditional Cache', 'Multi-cache'],
        size: [0, 0, 0], sizes: ['Micro'],
        difficulty: [0, 0, 0], difficulties: ['1'],
        terrain: [0, 0, 0], terrains: ['1'],
        country: [0, 0, 0], countries: ['France'],
        region: [0, 0, 0], regions: ['Grand-Est'],
        geoBorrowed: [0, 0, 0],
        appearSource: [0, 0, 0],
        st: { cache: col(st, 0), day: col(st, 1), state: col(st, 2), synthetic: col(st, 3) },
        ev: {
            cache: col(ev, 0), day: col(ev, 1), kind: col(ev, 2),
            fav: col(ev, 3), folded: col(ev, 4), author: col(ev, 5),
        },
        logKinds: KINDS,
        authors: ['Relecteur', 'Alice', 'Moi', 'Bob', 'Chloé'],
        meta: {},
    };
}

function setup(display = 'grey') {
    const base = buildPosesBase(payload());
    const rows = filterRows(base, { undatedMode: 'keep' });
    return { base, rows, timeline: buildPosesTimeline(base, rows, { archivedDisplay: display }) };
}

test('état d’une cache à une date', () => {
    const { base } = setup();
    assert.equal(stateAt(base, 1, 4), STATE_ACTIVE);
    assert.equal(stateAt(base, 1, 5), STATE_DISABLED);
    assert.equal(stateAt(base, 1, 7), STATE_DISABLED);
    assert.equal(stateAt(base, 1, 8), STATE_ACTIVE);
    assert.equal(stateAt(base, 2, 6), STATE_ARCHIVED);
    assert.equal(stateAt(base, 2, 10), STATE_ACTIVE);
    assert.equal(stateAt(base, 2, 20), STATE_ARCHIVED);
    assert.equal(stateAt(base, 0, 20), STATE_ACTIVE);
});

test('segments visibles : grisées toujours présentes, masquées par segment', () => {
    const { base } = setup();
    assert.deepEqual(visibleSegment(base, 2, 7, 'grey'), { placedDay: 3, archivedDay: EVO_NEVER_DAY });
    // Masquées : le segment en cours ne change qu'au désarchivage, pour que la
    // disparition du jour 6 ait le temps de se jouer.
    assert.deepEqual(visibleSegment(base, 2, 0, 'hide'), { placedDay: 3, archivedDay: 6 });
    assert.deepEqual(visibleSegment(base, 2, 8, 'hide'), { placedDay: 3, archivedDay: 6 });
    assert.deepEqual(visibleSegment(base, 2, 9, 'hide'), { placedDay: 9, archivedDay: 12 });
    assert.deepEqual(visibleSegment(base, 2, 30, 'hide'), { placedDay: 9, archivedDay: 12 });
    assert.deepEqual(visibleSegment(base, 0, 30, 'hide'), { placedDay: 0, archivedDay: EVO_NEVER_DAY });
});

test('compteurs jour par jour', () => {
    const { timeline: tl } = setup();
    const at = (tag, day) => posesCounterAt(tl, tag, day);
    assert.equal(at('posees', -1), 0);
    assert.equal(at('posees', 0), 1);
    assert.equal(at('posees', 3), 3);
    assert.equal(at('desactivees', 5), 1);
    assert.equal(at('desactivees', 8), 0);
    assert.equal(at('archivees', 6), 1);
    assert.equal(at('actives', 6), 2);        // actives + archivées = posées
    assert.equal(at('archivees', 9), 0);      // désarchivée
    assert.equal(at('archivees', 99), 1);     // au-delà : dernière valeur
    assert.equal(at('trouvailles', 0), 1);
    assert.equal(at('trouvailles', 13), 5);
    assert.equal(at('favoris', 13), 1);
    assert.equal(at('dnf', 13), 1);
    assert.equal(at('logs', 13), 15);         // ramenés compris
    // Alice, Bob, Chloé (Alice trouve deux fois, comptée une fois).
    assert.equal(at('trouveurs', 13), 3);
    assert.deepEqual(posesCounterMaxes(tl).posees, 3);
});

test('événements par plage de jours', () => {
    const { base, timeline: tl } = setup();
    assert.deepEqual(appearancesInRange(tl, 0, 2), [0, 1]);
    assert.deepEqual(appearancesInRange(tl, 3, 3), [2]);
    const changes = stateChangesInRange(tl, base, 5, 9);
    assert.deepEqual(changes.changed.sort(), [1, 2]);
    assert.deepEqual(changes.archived, [2]);
});

test('un flash par cache : le plus marquant gagne, la taille suit le volume', () => {
    const { base, timeline: tl } = setup();
    const all = () => true;
    // Jour 0 : publication + trouvaille avec favori (+ note ramenée, ignorée).
    assert.deepEqual(flashesInRange(tl, base, 0, 0, all), [{ k: 0, kind: 'publish', count: 2 }]);
    // Sans flash de publication, le favori l'emporte sur la trouvaille.
    const noPublish = (kind) => kind !== 'publish';
    assert.deepEqual(flashesInRange(tl, base, 0, 0, noPublish), [{ k: 0, kind: 'favorite', count: 2 }]);
    // Jour 5 : désactivation + deux trouvailles sur B.
    assert.deepEqual(flashesInRange(tl, base, 5, 5, all), [{ k: 1, kind: 'disable', count: 3 }]);
    // Plusieurs jours par lot : un flash par cache sur tout le lot.
    const batch = flashesInRange(tl, base, 0, 5, all);
    assert.equal(batch.length, 3);
});

test('archivées masquées : plus de flash après l’archivage, sauf l’archivage', () => {
    const grey = setup('grey');
    assert.deepEqual(flashesInRange(grey.timeline, grey.base, 13, 13), [{ k: 2, kind: 'find', count: 1 }]);
    const hide = setup('hide');
    assert.deepEqual(flashesInRange(hide.timeline, hide.base, 13, 13), []);
    assert.deepEqual(flashesInRange(hide.timeline, hide.base, 12, 12), [{ k: 2, kind: 'archive', count: 1 }]);
});

test('trouvailles reçues par jour (jalons des images) et pic de flashs', () => {
    const { base, timeline: tl } = setup();
    const counts = findDayCounts(tl, base);
    assert.deepEqual(counts.map(([, n]) => n), [1, 1, 2, 1]);
    assert.equal(counts[0][0], base.originDay);
    assert.equal(maxFlashesInWindow(tl, 1), 1);
    assert.ok(maxFlashesInWindow(tl, 30) >= 3);
});

test('findTotals : trouvailles reçues par cache, « folded » compris', () => {
    const base = buildPosesBase(payload());
    assert.ok(base.findTotals instanceof Int32Array);
    // A : 2 trouvailles, B : 2, C : 1 (les notes ramenées ne comptent pas).
    assert.deepEqual([...base.findTotals], [2, 2, 1]);
    // Une trouvaille ramenée au jour d'apparition reste une vraie trouvaille.
    const p = payload();
    p.ev.folded[1] = 1;
    assert.deepEqual([...buildPosesBase(p).findTotals], [2, 2, 1]);
});

test('filterPosesRows : état à l\'export et trouvailles reçues', () => {
    const base = buildPosesBase(payload());
    const all = filterRows(base, { undatedMode: 'keep' });
    // Critères inactifs (null/omis) : la sélection passe telle quelle.
    assert.deepEqual([...filterPosesRows(base, all, {})], [0, 1, 2]);
    assert.deepEqual([...filterPosesRows(base, all, { states: null, finds: undefined })], [0, 1, 2]);
    // État à l'export (status : 0 active, 1 archivée, 3 désactivée).
    assert.deepEqual([...filterPosesRows(base, all, { states: ['1'] })], [2]);
    assert.deepEqual([...filterPosesRows(base, all, { states: ['0', '3'] })], [0, 1]);
    assert.deepEqual([...filterPosesRows(base, all, { states: [] })], []);   // « Aucun »
    // Trouvailles reçues : les trois caches en ont au moins une.
    assert.deepEqual([...filterPosesRows(base, all, { finds: ['found'] })], [0, 1, 2]);
    assert.deepEqual([...filterPosesRows(base, all, { finds: ['never'] })], []);
    assert.deepEqual([...filterPosesRows(base, all, { finds: ['found', 'never'] })], [0, 1, 2]);
    assert.deepEqual([...filterPosesRows(base, all, { finds: [] })], []);
    // Les deux critères se combinent.
    assert.deepEqual([...filterPosesRows(base, all, { states: ['1'], finds: ['found'] })], [2]);
    assert.deepEqual([...filterPosesRows(base, all, { states: ['1'], finds: ['never'] })], []);
    // Retour typé (un .filter d'Int32Array en rend déjà un).
    assert.ok(filterPosesRows(base, all, {}) instanceof Int32Array);
});

test('filterPosesRows : « jamais trouvée » retient les caches sans trouvaille', () => {
    // Même jeu sans aucune trouvaille reçue.
    const p = payload();
    const keep = p.ev.kind.map((kind) => kind !== K.find);
    for (const key of ['cache', 'day', 'kind', 'fav', 'folded', 'author']) {
        p.ev[key] = p.ev[key].filter((_, j) => keep[j]);
    }
    const base = buildPosesBase(p);
    assert.deepEqual([...base.findTotals], [0, 0, 0]);
    const all = filterRows(base, { undatedMode: 'keep' });
    assert.deepEqual([...filterPosesRows(base, all, { finds: ['never'] })], [0, 1, 2]);
    assert.deepEqual([...filterPosesRows(base, all, { finds: ['found'] })], []);
});

test('filtres : une cache écartée ne compte plus', () => {
    const base = buildPosesBase(payload());
    const rows = filterRows(base, { types: ['Traditional Cache'], undatedMode: 'keep' });
    const tl = buildPosesTimeline(base, rows);
    assert.equal(tl.count, 2);
    assert.equal(posesCounterAt(tl, 'trouvailles', 99), 4);
    assert.equal(posesCounterAt(tl, 'archivees', 99), 0);
});

test('flashs : table des types, résolution, taille', () => {
    assert.equal(EVENT_FLASH_KINDS[0], 'archive');
    assert.equal(flashKindOfLog('find', true), 'favorite');
    assert.equal(flashKindOfLog('unarchive'), 'enable');
    assert.equal(flashKindOfLog('owner_note'), 'note');
    const events = normalizeEventFlashes({ find: { mode: 'bogus', size: 999 }, inconnu: {} });
    assert.equal(events.find.mode, 'circle');
    assert.equal(events.find.size, 200);
    assert.ok(!('inconnu' in events));

    const main = { mode: 'circle', size: 30 };
    // « same » reprend le flash principal, « none » éteint.
    assert.equal(resolveEventFlash('publish', main), main);
    assert.equal(resolveEventFlash('publish', { mode: 'none' }), null);
    assert.equal(resolveEventFlash('note', main), null);
    const fav = resolveEventFlash('favorite', main);
    assert.equal(fav.mode, 'star');
    assert.deepEqual(fav.rgb, { r: 255, g: 193, b: 7 });

    assert.equal(flashScale(1), 1);
    assert.equal(flashScale(8), 2);
    assert.equal(flashScale(1000), 2.5);
    assert.equal(flashScale(2) * 8 % 1, 0);   // quantifié au 1/8
    const scaled = scaledFlash(fav, 2);
    assert.equal(scaled.size, 72);
    assert.equal(scaledFlash(fav, 2), scaled);  // même objet : regroupements, cache de styles
    assert.equal(scaledFlash(fav, 1), fav);
});
