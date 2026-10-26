// Caches posées sur la carte principale : apparition, état, flash d'un lot,
// passages du trait (static/js/owner_model.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    buildOwnerEntries,
    ownerFlashBetween,
    ownerStateAt,
    ownerVisibleAt,
    ownerVisitsByDay,
} from '../../static/js/owner_model.mjs';
import { isoToDayNumber as day } from '../../static/js/evolution_timeline.mjs';

function owned(code, appear, { states = [], events = [], coords = [6, 49] } = {}) {
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords },
        properties: { source_kind: 'owned', gc_code: code, date_find: appear,
                      owner_states: states, owner_events: events },
    };
}

const GCP4 = owned('GCP0004', '2019-05-01', {
    states: [['2019-07-01', 1], ['2019-07-15', 0], ['2019-09-01', 1], ['2019-09-10', 0]],
    events: [['2019-07-01', 'disable'], ['2019-07-15', 'enable'], ['2019-09-01', 'disable'],
             ['2019-09-10', 'maintenance'], ['2019-09-10', 'enable']],
});

test('entrées triées par apparition, illisibles et étapes inconnues écartées', () => {
    const entries = buildOwnerEntries([
        GCP4,
        owned('GCP0001', '2018-03-05', { events: [['2018-04-01', 'find'], ['2018-05-01', 'unarchive']] }),
        { properties: { date_find: 'jamais' } },
    ], day);
    assert.deepEqual(entries.map(e => e.feature.properties.gc_code), ['GCP0001', 'GCP0004']);
    // Un désarchivage joue la réactivation ; « find » n'est pas une étape.
    assert.deepEqual(entries[0].events, [{ day: day('2018-05-01'), kind: 'enable' }]);
});

test('présente dès son apparition, jamais retirée', () => {
    const [entry] = buildOwnerEntries([GCP4], day);
    assert.equal(ownerVisibleAt(entry, day('2019-04-30')), false);
    assert.equal(ownerVisibleAt(entry, day('2019-05-01')), true);
    assert.equal(ownerVisibleAt(entry, day('2030-01-01')), true);
});

test('état au jour : désactivée puis réactivée', () => {
    const [entry] = buildOwnerEntries([GCP4], day);
    assert.equal(ownerStateAt(entry, day('2019-06-30')), 0);
    assert.equal(ownerStateAt(entry, day('2019-07-01')), 1);
    assert.equal(ownerStateAt(entry, day('2019-07-15')), 0);
    assert.equal(ownerStateAt(entry, day('2019-09-05')), 1);
    assert.equal(ownerStateAt(entry, day('2019-09-10')), 0);
});

test('flash d\'un lot : le type le plus marquant, parmi ceux qui flashent', () => {
    const [entry] = buildOwnerEntries([GCP4], day);
    const between = (a, b, enabled) => ownerFlashBetween(entry, day(a), day(b), enabled);
    assert.equal(between('2019-04-30', '2019-05-01'), 'place');
    assert.equal(between('2019-05-01', '2019-06-30'), null);
    // Le 10/09 : maintenance et réactivation — la réactivation l'emporte.
    assert.equal(between('2019-09-09', '2019-09-10'), 'enable');
    assert.equal(between('2019-09-09', '2019-09-10', (kind) => kind !== 'enable'), 'maintenance');
    // Lot qui couvre tout : désactivation > réactivation > pose > maintenance.
    assert.equal(between('2019-01-01', '2019-12-31'), 'disable');
    assert.equal(between('2019-01-01', '2019-12-31', () => false), null);
});

test('passages : la pose puis un par jour d\'étape, bornés par la fin', () => {
    const entries = buildOwnerEntries([GCP4], day);
    const visits = ownerVisitsByDay(entries, day('2019-08-01'));
    assert.deepEqual([...visits.keys()], [day('2019-05-01'), day('2019-07-01'), day('2019-07-15')]);
    const all = ownerVisitsByDay(entries);
    assert.equal(all.size, 5);                       // le 10/09 ne compte qu'une fois
    assert.deepEqual(all.get(day('2019-09-10')), [[6, 49]]);
});
