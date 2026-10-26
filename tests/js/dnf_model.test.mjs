// Points DNF : apparition, résolution, passages du trait (static/js/dnf_model.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    buildDnfEntries,
    DNF_POINT_DEFAULTS,
    dnfAliveInWindow,
    dnfPointOptions,
    dnfRevisitBetween,
    dnfSameDayResolved,
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

test('DNF répété : une tentative de plus dans ]début, fin]', () => {
    const [entry] = buildDnfEntries([dnf('GC1', ['2011-08-20', '2011-09-01', '2011-09-10'])], day);
    // L'apparition ne compte pas : elle joue déjà le flash d'ajout.
    assert.equal(dnfRevisitBetween(entry, day('2011-08-19'), day('2011-08-20')), false);
    assert.equal(dnfRevisitBetween(entry, day('2011-08-20'), day('2011-08-31')), false);
    assert.equal(dnfRevisitBetween(entry, day('2011-08-20'), day('2011-09-01')), true);
    assert.equal(dnfRevisitBetween(entry, day('2011-09-01'), day('2011-09-10')), true);
    assert.equal(dnfRevisitBetween(entry, day('2011-09-10'), day('2011-09-30')), false);
});

test('résolu le jour même : seule la résolution intra-journée de la fenêtre', () => {
    const [same] = buildDnfEntries([dnf('GC1', ['2021-09-10'], '2021-09-10')], day);
    assert.equal(dnfSameDayResolved(same, day('2021-08-01'), day('2021-09-10')), true);
    assert.equal(dnfSameDayResolved(same, day('2021-09-10'), day('2021-09-11')), false);  // borne exclue
    assert.equal(dnfSameDayResolved(same, day('2021-08-01'), day('2021-09-09')), false);
    // Résolue plus tard : cas ordinaire, le point s'est affiché entre-temps.
    const [later] = buildDnfEntries([dnf('GC2', ['2021-09-10'], '2021-09-12')], day);
    assert.equal(dnfSameDayResolved(later, day('2021-08-01'), day('2021-09-12')), false);
    // Jamais résolu.
    const [open] = buildDnfEntries([dnf('GC3', ['2021-09-10'])], day);
    assert.equal(dnfSameDayResolved(open, day('2021-08-01'), day('2021-09-10')), false);
});

test('fenêtre de période : un DNF en échec dans la fenêtre est retenu', () => {
    const open = dnf('GC1', ['2011-08-20']).properties;              // jamais résolu
    const mid = dnf('GC2', ['2011-08-20'], '2012-01-08').properties;
    // Apparu avant le début de la fenêtre, encore en échec : retenu.
    assert.equal(dnfAliveInWindow(open, '2015-01-01', null), true);
    assert.equal(dnfAliveInWindow(mid, '2015-01-01', null), false);  // résolu avant
    assert.equal(dnfAliveInWindow(mid, '2011-01-01', null), true);   // résolu dans
    assert.equal(dnfAliveInWindow(mid, '2011-08-20', null), true);   // en échec au début
    assert.equal(dnfAliveInWindow(mid, '2012-01-08', null), false);  // résolu le jour même
    // Apparu après la fin de la fenêtre : écarté.
    assert.equal(dnfAliveInWindow(open, null, '2011-08-19'), false);
    assert.equal(dnfAliveInWindow(open, null, '2011-08-20'), true);
    // Fenêtre fermée : en échec à un moment entre les deux bornes.
    assert.equal(dnfAliveInWindow(mid, '2011-01-01', '2011-12-31'), true);
    assert.equal(dnfAliveInWindow(mid, '2011-09-01', '2011-12-31'), true);
    assert.equal(dnfAliveInWindow(mid, '2012-01-09', '2012-12-31'), false);
    assert.equal(dnfAliveInWindow(open, '2011-01-01', '2011-12-31'), true);
    // Sans borne ni date d'apparition : rien à écarter.
    assert.equal(dnfAliveInWindow({ source_kind: 'dnf' }, '2011-01-01', null), true);
});

test('Stats : un événement par DNF, à sa date, avec les propriétés de la cache', async () => {
    const { dnfEventsByDate, dnfStatesAt } = await import('../../static/js/dnf_model.mjs');
    const features = [
        dnf('GC1', ['2011-08-20', '2011-09-01'], '2012-01-08'),
        dnf('GC2', ['2011-09-01']),
    ];
    const byDate = dnfEventsByDate(features);
    const sept = byDate.get(new Date('2011-09-01T00:00:00').toDateString());
    assert.deepEqual(sept.map((e) => e.properties.gc_code), ['GC1', 'GC2']);
    assert.equal(sept[0].properties.date_find, '2011-09-01');
    assert.equal(byDate.get(new Date('2011-08-20T00:00:00').toDateString()).length, 1);
    const entries = buildDnfEntries(features, day);
    // État au jour : comptes + somme des délais de résolution + record de
    // passages (tuiles « au jour » de stats_panels › sourceDayTiles).
    assert.deepEqual(dnfStatesAt(entries, day('2011-08-31')),
        { open: 1, resolved: 0, resolveDays: 0, visits: 1, visitsCode: 'GC1' });
    assert.deepEqual(dnfStatesAt(entries, day('2012-01-08')),
        { open: 1, resolved: 1, resolveDays: day('2012-01-08') - day('2011-08-20'), visits: 2, visitsCode: 'GC1' });
});

test('style DNF : normalisation et valeurs par défaut', () => {
    // Entrée absente ou incomplète → le rendu historique (point noir, contour
    // blanc de 2 px, icône des échecs).
    assert.deepEqual(dnfPointOptions(null), DNF_POINT_DEFAULTS);
    assert.deepEqual(dnfPointOptions({}), DNF_POINT_DEFAULTS);
    // Valeurs admises, normalisées (hexa minuscule, entier borné).
    assert.deepEqual(dnfPointOptions({
        shape: 'diamond', color: '#AA11BB', borderColor: '#FFCC00',
        borderWidth: '3', icon: 'type',
    }), { shape: 'diamond', color: '#aa11bb', borderColor: '#ffcc00', borderWidth: 3, icon: 'type' });
    // Hors bornes ou inconnues → bornées ou valeur par défaut.
    assert.equal(dnfPointOptions({ borderWidth: 9 }).borderWidth, 6);
    assert.equal(dnfPointOptions({ borderWidth: -2 }).borderWidth, 0);
    assert.equal(dnfPointOptions({ borderWidth: 'x' }).borderWidth, DNF_POINT_DEFAULTS.borderWidth);
    assert.equal(dnfPointOptions({ shape: 'hexagon' }).shape, 'circle');
    assert.equal(dnfPointOptions({ color: 'red' }).color, '#000000');
    assert.equal(dnfPointOptions({ color: '#fff' }).color, '#000000');
    assert.equal(dnfPointOptions({ icon: 'miss' }).icon, 'dnf');
});
