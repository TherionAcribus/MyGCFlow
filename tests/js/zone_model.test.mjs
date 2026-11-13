// Cartes par zones : valeurs par zone et par date, échelle, moments clés.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findsTable, tableFromRecords } from '../../static/js/chart_sources.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';
import {
    ZONE_COLUMNS, createZoneState, keyMoments, normalizeZoneMeasure, shareScaleThresholds, zoneScale,
} from '../../static/js/zone_model.mjs';

const day = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return dayNumber({ y, m, d });
};

// Trouvailles en Bretagne et Pays de la Loire, une hors carte, un Lab.
function finds() {
    const rec = (iso, region, sub, extra = {}) => ({
        day: day(iso), zone_country: region ? 'FR' : '', zone_region: region, zone_subregion: sub,
        cache_type: 'Traditional', difficulty: 2, terrain: 2, ...extra,
    });
    return tableFromRecords([
        rec('2020-03-01', 'FR-BRE', 'FR-29'),
        rec('2020-03-01', 'FR-BRE', 'FR-56', { cache_type: 'Mystery', difficulty: 4, terrain: 1.5 }),
        rec('2021-06-10', 'FR-PDL', 'FR-44', { difficulty: 1, terrain: 1 }),
        rec('2021-06-12', 'FR-BRE', 'FR-29', { cache_type: 'Mystery', difficulty: 3, terrain: 2 }),
        rec('2022-01-05', '', '', {}),
        rec('2022-02-01', 'FR-BRE', 'FR-29', { cache_type: 'Adventure Lab', difficulty: null, terrain: null, kind: 1 }),
    ], { source: 'finds' });
}

test('compte par niveau, hors carte à part', () => {
    const table = finds();
    const s = createZoneState({ table, level: 'region', measure: { op: 'count' } });
    s.seek(day('2021-12-31'));
    assert.deepEqual(Object.fromEntries(s.values()), { 'FR-BRE': 3, 'FR-PDL': 1 });
    assert.equal(s.outside, 0);
    s.seek(Infinity);
    assert.deepEqual(Object.fromEntries(s.values()), { 'FR-BRE': 4, 'FR-PDL': 1 });
    assert.equal(s.outside, 1);
    const sub = createZoneState({ table, level: 'subregion', measure: { op: 'count' } }).seek(Infinity);
    assert.equal(sub.valueOf('FR-29'), 3);
    assert.equal(sub.valueOf('FR-75'), null);
    assert.deepEqual(sub.extent, { first: day('2020-03-01'), last: day('2022-02-01') });
});

test('types différents, couverture D/T et moyenne (Labs écartés)', () => {
    const table = finds();
    const at = (measure) => createZoneState({ table, level: 'region', measure }).seek(Infinity);
    assert.equal(at({ op: 'distinct', field: 'cache_type' }).valueOf('FR-BRE'), 3);
    // D/T : (2,2), (4,1.5), (3,2) ; le Lab n'en a pas.
    assert.equal(at({ op: 'dt_coverage' }).valueOf('FR-BRE'), 3);
    // Objectif de complétude : 81 − couvertes ; zone sans ligne : null.
    const missing = at({ op: 'dt_missing' });
    assert.equal(missing.valueOf('FR-BRE'), 78);
    assert.equal(missing.valueOf('FR-29'), null);
    assert.equal(at({ op: 'mean', field: 'difficulty' }).valueOf('FR-BRE'), 3);
    assert.equal(at({ op: 'first_day' }).valueOf('FR-PDL'), day('2021-06-10'));
    // Zone dont aucune ligne n'a de D : pas de moyenne (et non 0).
    const labs = tableFromRecords([{ day: 1, zone_region: 'X-1', difficulty: null }]);
    assert.equal(createZoneState({ table: labs, level: 'region', measure: { op: 'mean' } }).seek(5).valueOf('X-1'), null);
});

test('densité par km²', () => {
    const s = createZoneState({ table: finds(), level: 'region', measure: { op: 'count', per: 'km2' },
        areas: new Map([['FR-BRE', 27208]]) }).seek(Infinity);
    assert.equal(s.valueOf('FR-BRE'), 4 / 27208);
    assert.equal(s.valueOf('FR-PDL'), null);   // surface inconnue
});

test('mode « actives » : la valeur redescend', () => {
    const table = tableFromRecords([
        { day: 10, endDay: 20, zone_region: 'A' },
        { day: 12, endDay: NaN, zone_region: 'A' },
        { day: 15, endDay: 15, zone_region: 'A' },   // archivée sans date : jamais active
        { day: 30, endDay: 40, zone_region: 'B' },
    ]);
    const s = createZoneState({ table, level: 'region', measure: { op: 'count', mode: 'active' } });
    assert.equal(s.seek(9).valueOf('A'), null);
    assert.equal(s.seek(15).valueOf('A'), 2);
    assert.equal(s.seek(20).valueOf('A'), 1);
    assert.equal(s.seek(35).valueOf('B'), 1);
    assert.equal(s.seek(40).valueOf('B'), null);
    assert.equal(s.seek(19).valueOf('A'), 2);    // retour en arrière
});

test('mesures normalisées et compatibilités', () => {
    assert.deepEqual(normalizeZoneMeasure({ op: '??' }), { op: 'count', mode: 'cumulative', per: null });
    assert.deepEqual(normalizeZoneMeasure({ op: 'distinct', field: 'state' }),
        { op: 'distinct', mode: 'cumulative', per: null, field: 'cache_type' });
    assert.equal(normalizeZoneMeasure({ op: 'first_day', mode: 'active' }).mode, 'cumulative');
    assert.equal(normalizeZoneMeasure({ op: 'mean', per: 'km2' }).per, null);
    assert.equal(normalizeZoneMeasure({ op: 'count', mode: 'active', per: 'km2' }).per, 'km2');
});

test('zones modifiées : seulement celles qui ont bougé', () => {
    const s = createZoneState({ table: finds(), level: 'subregion', measure: { op: 'count' } });
    s.seek(day('2020-03-01'));
    assert.deepEqual(s.drainChanged().sort(), ['FR-29', 'FR-56']);
    s.seek(day('2021-06-10'));
    assert.deepEqual(s.drainChanged(), ['FR-44']);
    s.seek(day('2021-06-10'));
    assert.deepEqual(s.drainChanged(), []);
    s.seek(day('2020-01-01'));                      // retour au début : tout ce qui avait une valeur
    assert.deepEqual(s.drainChanged().sort(), ['FR-29', 'FR-44', 'FR-56']);
});

// Générateur pseudo-aléatoire reproductible (mulberry32).
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomTable(seed, n) {
    const r = rng(seed);
    const pick = (list) => list[Math.floor(r() * list.length)];
    const records = [];
    for (let i = 0; i < n; i++) {
        const start = Math.floor(r() * 400);
        records.push({
            day: start,
            endDay: r() < 0.5 ? start + Math.floor(r() * 200) : NaN,
            zone_region: pick(['A', 'B', 'C', '']),
            cache_type: pick(['T', 'M', 'L', 'E']),
            owner: pick(['o1', 'o2', 'o3', '']),
            difficulty: pick([1, 1.5, 2, 3, 5, null]),
            terrain: pick([1, 2, 2.5, 4, null]),
        });
    }
    return tableFromRecords(records);
}

// Calcul naïf depuis zéro, pour comparaison.
function brute(table, measure, d) {
    const spec = normalizeZoneMeasure(measure);
    const col = table[ZONE_COLUMNS.region];
    const ids = table.dicts[ZONE_COLUMNS.region];
    const groups = new Map();
    for (let row = 0; row < table.n; row++) {
        if (table.day[row] > d) continue;
        if (spec.mode === 'active' && table.endDay[row] <= d) continue;
        if (col[row] < 0) continue;
        const id = ids[col[row]];
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(row);
    }
    const out = new Map();
    for (const [id, rows] of groups) {
        let v;
        if (spec.op === 'count') v = rows.length;
        else if (spec.op === 'distinct') v = new Set(rows.map((x) => table[spec.field][x]).filter((x) => x >= 0)).size;
        else if (spec.op === 'dt_coverage') {
            v = new Set(rows.filter((x) => Number.isFinite(table.difficulty[x]) && Number.isFinite(table.terrain[x]))
                .map((x) => `${table.difficulty[x]}/${table.terrain[x]}`)).size;
        } else if (spec.op === 'mean') {
            const vals = rows.map((x) => table[spec.field][x]).filter(Number.isFinite);
            v = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        } else if (spec.op === 'first_day') v = Math.min(...rows.map((x) => table.day[x]));
        if (v !== null) out.set(id, v);
    }
    return out;
}

test('sauts dans tous les sens = calcul depuis zéro', () => {
    const measures = [
        { op: 'count' }, { op: 'count', mode: 'active' },
        { op: 'distinct', field: 'cache_type' }, { op: 'distinct', field: 'owner', mode: 'active' },
        { op: 'dt_coverage' }, { op: 'dt_coverage', mode: 'active' },
        { op: 'mean', field: 'difficulty' }, { op: 'mean', field: 'terrain', mode: 'active' },
        { op: 'first_day' },
    ];
    for (const seed of [1, 2, 3]) {
        const table = randomTable(seed, 300);
        const r = rng(seed * 7);
        for (const measure of measures) {
            const s = createZoneState({ table, level: 'region', measure });
            for (let k = 0; k < 40; k++) {
                const d = Math.floor(r() * 700) - 50;
                const got = s.seek(d).values();
                const want = brute(table, measure, d);
                assert.equal(got.size, want.size, `${JSON.stringify(measure)} jour ${d}`);
                for (const [id, v] of want) {
                    assert.ok(Math.abs(got.get(id) - v) < 1e-9, `${JSON.stringify(measure)} ${id} jour ${d} : ${got.get(id)} ≠ ${v}`);
                }
            }
        }
    }
});

test('lignes retenues (filtres de la page)', () => {
    const table = finds();
    const s = createZoneState({ table, level: 'region', measure: { op: 'count' }, rows: Int32Array.from([0, 2]) });
    assert.deepEqual(Object.fromEntries(s.seek(Infinity).values()), { 'FR-BRE': 1, 'FR-PDL': 1 });
});

test('instantanés aux moments clés', () => {
    const s = createZoneState({ table: finds(), level: 'region', measure: { op: 'count' } });
    const snaps = s.snapshots([day('2021-12-31'), day('2020-12-31')]);
    assert.deepEqual(snaps.map((x) => Object.fromEntries(x.values)), [{ 'FR-BRE': 2 }, { 'FR-BRE': 3, 'FR-PDL': 1 }]);
});

test('findsTable lit les colonnes de zones', () => {
    const table = findsTable({
        count: 2, date: ['2024-01-01', '2024-01-02'],
        zone_country: [0, -1], zone_region: [0, -1], zone_subregion: [0, 5],
        dicts: { zone_country: ['FR'], zone_region: ['FR-BRE'], zone_subregion: ['FR-29'] },
    });
    const s = createZoneState({ table, level: 'subregion', measure: { op: 'count' } }).seek(Infinity);
    assert.deepEqual(Object.fromEntries(s.values()), { 'FR-29': 1 });
    assert.equal(s.outside, 1);   // index hors dictionnaire → hors carte
    // Ancien format (v1, sans colonnes) : tout hors carte, sans erreur.
    const old = findsTable({ count: 1, date: ['2024-01-01'] });
    assert.equal(createZoneState({ table: old, level: 'region', measure: {} }).seek(Infinity).outside, 1);
});

test('échelle par quantiles : autant de zones par classe', () => {
    const scale = zoneScale([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1000], { classes: 4 });
    assert.deepEqual(scale.breaks, [4, 7, 10]);
    assert.equal(scale.classOf(1), 0);
    assert.equal(scale.classOf(4), 1);
    assert.equal(scale.classOf(1000), 3);
    assert.equal(scale.classOf(null), null);
    assert.deepEqual(scale.ranges()[0], [1, 4]);
});

test('échelle : valeurs égales, linéaire, log, seuils, années', () => {
    assert.equal(zoneScale([5, 5, 5]).classes, 1);
    assert.equal(zoneScale([]).classes, 1);
    assert.equal(zoneScale([1, 1, 1, 1, 9], { classes: 5 }).classes, 2);
    assert.deepEqual(zoneScale([0, 100], { mode: 'linear', classes: 4 }).breaks, [25, 50, 75]);
    const log = zoneScale([0, 999], { mode: 'log', classes: 3 });
    assert.ok(Math.abs(log.breaks[0] - 9) < 1e-9 && Math.abs(log.breaks[1] - 99) < 1e-9);
    assert.deepEqual(zoneScale([1, 50], { mode: 'fixed', thresholds: [10, 5, 20] }).breaks, [5, 10, 20]);
    // Part trouvée : seuils fixes ronds 0–100 %, symétriques autour de 50,
    // partagés par la carte et les mini-cartes.
    assert.deepEqual(shareScaleThresholds(5), [20, 40, 60, 80]);
    assert.deepEqual(shareScaleThresholds(4), [25, 50, 75]);
    assert.deepEqual(shareScaleThresholds(2), [50]);
    const share = zoneScale([33.3, 50], { mode: 'fixed', classes: 5, thresholds: shareScaleThresholds(5) });
    assert.equal(share.classes, 5);
    assert.equal(share.classOf(0), 0);
    assert.equal(share.classOf(33.3), 1);
    assert.equal(share.classOf(50), 2);
    assert.equal(share.classOf(100), 4);
    const years = zoneScale([day('2015-06-01'), day('2017-03-01'), day('2020-12-31')], { mode: 'year', classes: 3 });
    assert.deepEqual(years.breaks, [day('2017-01-01'), day('2019-01-01')]);
    assert.equal(years.classOf(day('2016-12-31')), 0);
    assert.equal(zoneScale(new Map([['a', 1], ['b', 3]]), { classes: 2 }).classes, 2);
});

test('échelle signée : coupure à 0, classe du côté vide', () => {
    // Comparaison à une date : écarts signés. Aucune classe à cheval sur
    // zéro — un gain ne partage jamais la couleur d'une perte.
    const mixed = zoneScale([-3, -1, 2, 6], { classes: 4, signed: true });
    assert.ok(mixed.breaks.includes(0));
    assert.equal(mixed.classOf(-2), 0);
    assert.equal(mixed.classOf(2), mixed.breaks.indexOf(0) + 1);
    // Échelle finale toute positive (cumul) : les pertes vues pendant
    // l'animation tombent dans la première classe, celle du rouge.
    const gains = zoneScale([1, 1, 2], { classes: 5, signed: true });
    assert.equal(gains.breaks[0], 0);
    assert.equal(gains.classOf(-4), 0);
    // Symétrique : toutes pertes → la dernière classe reçoit les gains.
    const losses = zoneScale([-5, -2, -1], { classes: 4, signed: true });
    assert.equal(losses.breaks[losses.breaks.length - 1], 0);
    assert.equal(losses.classOf(3), losses.classes - 1);
    // Le total reste dans le budget demandé.
    assert.ok(mixed.classes <= 4 && gains.classes <= 5 && losses.classes <= 4);
    // Sans `signed`, comportement inchangé (pas de coupure forcée).
    assert.equal(zoneScale([1, 1, 2], { classes: 5 }).breaks.includes(0), false);
});

// 26 trouvailles par an sur 2019-2023, une tous les 14 jours, chacune dans
// une nouvelle zone les premières semaines.
function regularFinds() {
    const records = [];
    for (let i = 0; i < 130; i++) {
        records.push({ day: day('2019-01-07') + i * 14, zone_subregion: `Z${Math.min(i, 9)}` });
    }
    return tableFromRecords(records);
}

test('moments : fins d\'année, la dernière à date', () => {
    const table = regularFinds();
    const last = table.day[table.n - 1];
    const moments = keyMoments(table, { rules: ['year_end'] });
    assert.deepEqual(moments.map((m) => m.kind), ['year_end', 'year_end', 'year_end', 'year_end', 'last']);
    assert.equal(moments.at(-1).day, last);
    assert.deepEqual(moments.at(-1).also.map((m) => m.year), [2023]);   // fin 2023 = dernier jour
    assert.equal(moments[0].day, day('2019-12-31'));
});

test('moments : paliers, nouvelles zones, fusion des proches, plafond', () => {
    const table = regularFinds();
    const ms = keyMoments(table, { rules: ['milestones'], milestones: [10, 100] });
    assert.deepEqual(ms.filter((m) => m.kind === 'milestone').map((m) => [m.value, m.day]),
        [[10, table.day[9]], [100, table.day[99]]]);

    const zonesOnly = keyMoments(table, { rules: ['new_zone'], minGapDays: 1 });
    assert.equal(zonesOnly.filter((m) => m.kind === 'new_zone').length, 10);
    // Nouvelles zones toutes les deux semaines, écart minimal de 21 jours :
    // elles se fondent deux à deux, la plus récente garde la vignette.
    const merged = keyMoments(table, { rules: ['new_zone'] }).filter((m) => m.kind === 'new_zone');
    assert.equal(merged.length, 5);
    assert.deepEqual(merged[0].zones, ['Z1']);
    assert.deepEqual(merged[0].also[0].zones, ['Z0']);

    // Un palier 3 jours avant une fin d'année : le palier, prioritaire, l'emporte.
    const near = keyMoments(table, { rules: ['year_end', 'milestones'], milestones: [26] });
    const m26 = near.find((m) => m.kind === 'milestone');
    assert.equal(m26.day, day('2019-12-23'));
    assert.ok(m26.also.some((m) => m.kind === 'year_end' && m.year === 2019));
    assert.ok(!near.some((m) => m.kind === 'year_end' && m.year === 2019));

    // Plafond : fins de trimestre réparties, le dernier jour toujours là.
    const capped = keyMoments(table, { rules: ['quarter_end'], max: 6 });
    assert.equal(capped.length, 6);
    assert.equal(capped.at(-1).kind, 'last');
    assert.ok(capped[0].day < day('2020-01-01'));
});

test('moments : dates libres prioritaires, table vide', () => {
    const table = regularFinds();
    const custom = day('2021-07-14');
    const ms = keyMoments(table, { rules: ['year_end', 'custom'], custom: [custom, day('1990-01-01')], max: 3 });
    assert.ok(ms.some((m) => m.kind === 'custom' && m.day === custom));
    assert.equal(ms.length, 3);
    assert.deepEqual(keyMoments(tableFromRecords([]), { rules: ['year_end'] }), []);
});
