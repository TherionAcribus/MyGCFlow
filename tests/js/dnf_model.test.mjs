// Points DNF : apparition, résolution, passages du trait (static/js/dnf_model.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    buildDnfEntries,
    dnfVisibleAt,
    dnfVisibleStatic,
    dnfVisitsByDay,
} from '../../static/js/dnf_model.mjs';
import { isoToDayNumber as day } from '../../static/js/evolution_timeline.mjs';

function dnf(code, dates, resolved = null, coords = [2, 48]) {
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords },
        properties: { source_kind: 'dnf', gc_code: code, date_find: dates[0],
                      dnf_dates: dates, resolved_date: resolved },
    };
}

test('les entrées sont triées par premier DNF, illisibles écartées', () => {
    const entries = buildDnfEntries([
        dnf('GC2', ['2012-05-01']),
        dnf('GC1', ['2011-08-20', '2011-09-01'], '2012-01-08'),
        { properties: { date_find: 'jamais' } },
    ], day);
    assert.deepEqual(entries.map(e => e.feature.properties.gc_code), ['GC1', 'GC2']);
    assert.equal(entries[0].resolveDay, day('2012-01-08'));
    assert.equal(entries[1].resolveDay, null);
    assert.deepEqual(entries[0].visitDays, [day('2011-08-20'), day('2011-09-01')]);
});

test('visible du premier DNF jusqu\'à la veille de la trouvaille', () => {
    const [entry] = buildDnfEntries([dnf('GC1', ['2011-08-20'], '2012-01-08')], day);
    assert.equal(dnfVisibleAt(entry, day('2011-08-19')), false);
    assert.equal(dnfVisibleAt(entry, day('2011-08-20')), true);
    assert.equal(dnfVisibleAt(entry, day('2012-01-07')), true);
    assert.equal(dnfVisibleAt(entry, day('2012-01-08')), false);   // la trouvaille prend la place
});

test('un DNF jamais résolu reste visible', () => {
    const [entry] = buildDnfEntries([dnf('GC1', ['2011-08-20'])], day);
    assert.equal(dnfVisibleAt(entry, day('2030-01-01')), true);
    assert.equal(dnfVisibleStatic(entry, Infinity), true);
});

test('carte statique : résolu dans la période = remplacé par la trouvaille', () => {
    const [entry] = buildDnfEntries([dnf('GC1', ['2011-08-20'], '2012-01-08')], day);
    assert.equal(dnfVisibleStatic(entry, Infinity), false);
    assert.equal(dnfVisibleStatic(entry, day('2011-12-31')), true);   // période close avant
});

test('chaque DNF est un passage du trait, borné par la date de fin', () => {
    const entries = buildDnfEntries([
        dnf('GC1', ['2011-08-20', '2011-09-01'], null, [1, 1]),
        dnf('GC2', ['2011-09-01'], null, [2, 2]),
    ], day);
    const visits = dnfVisitsByDay(entries);
    assert.deepEqual(visits.get(day('2011-08-20')), [[1, 1]]);
    assert.deepEqual(visits.get(day('2011-09-01')), [[1, 1], [2, 2]]);
    assert.equal(dnfVisitsByDay(entries, day('2011-08-31')).size, 1);
});
