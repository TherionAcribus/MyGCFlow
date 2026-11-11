// Niveau « grille » des cartes par zones (static/js/zone_grid.mjs) et son
// calcul dans les mini-cartes (chart_zones.mjs). Lancer : npm run test:unit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    GRID_SIZES, cellArea, cellCenter, cellLabel, cellOf, cellRing, gridReference, normalizeGridSize, parseCell,
    withGridColumn,
} from '../../static/js/zone_grid.mjs';
import { findsTable } from '../../static/js/chart_sources.mjs';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { runZoneQuery } from '../../static/js/chart_zones.mjs';
import { makeLabels } from '../../static/js/chart_labels.mjs';

// Distance approchée en km (équirectangulaire locale).
function km([lon1, lat1], [lon2, lat2]) {
    const k = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    return Math.hypot((lon2 - lon1) * 111.32 * k, (lat2 - lat1) * 111.32);
}

test('référence : médiane arrondie à 5°, bornée', () => {
    assert.equal(gridReference([47.2, 48.4, 43.1, 49.9, 46.0]), 45);
    assert.equal(gridReference([NaN, 89]), 70);
    assert.equal(gridReference([]), 0);
    assert.equal(normalizeGridSize('50'), 50);
    assert.equal(normalizeGridSize(7), 25);
    assert.deepEqual(GRID_SIZES, [5, 10, 25, 50, 100]);
});

test('une case contient ses points ; ses voisines sont à une taille', () => {
    const nantes = [-1.5536, 47.2184];
    const id = cellOf(nantes[0], nantes[1], 25, 45);
    assert.match(id, /^h25\/45\/-?\d+\/-?\d+$/);
    assert.deepEqual(parseCell(id).size, 25);
    // Le centre est à moins d'un rayon (25 / √3 ≈ 14,4 km) du point.
    assert.ok(km(cellCenter(id), nantes) <= 25 / Math.sqrt(3) + 0.01);
    // Un point à 2 km : même case (sauf bord) ; à 60 km : autre case.
    assert.notEqual(cellOf(nantes[0] + 0.8, nantes[1], 25, 45), id);
    // Centre de la voisine plein est : 25 km dans le plan local, donc
    // 25 · cos(lat) / cos(lat0) sur le terrain (≈ 24 km à 47,2°).
    const { q, r } = parseCell(id);
    const neighbour = `h25/45/${q + 1}/${r}`;
    const expected = 25 * Math.cos((cellCenter(id)[1] * Math.PI) / 180) / Math.cos(Math.PI / 4);
    assert.ok(Math.abs(km(cellCenter(id), cellCenter(neighbour)) - expected) < 0.2);
    assert.equal(cellOf(0, 0, 25, 45), null);
    assert.equal(cellOf(NaN, 47, 25, 45), null);
    assert.equal(cellRing('nope'), null);
});

test('contour fermé, surface réelle', () => {
    const id = cellOf(2.35, 48.85, 25, 45);
    const ring = cellRing(id);
    assert.equal(ring.length, 7);
    assert.deepEqual(ring[0], ring[6]);
    // Hexagone de 25 km entre côtés opposés : (√3 / 2) · 25² ≈ 541 km² à
    // lat0, un peu moins plus au nord (cos(48,85°) / cos(45°)).
    const area = cellArea(id);
    assert.ok(area > 480 && area < 541, String(area));
    assert.match(cellLabel(id), /N · \d+,\d° E$/);
    assert.match(cellLabel(cellOf(-1.55, 47.2, 25, 45)), /° O$/);
});

test('colonne de cases d\'une table', () => {
    const table = withGridColumn({ n: 4, lat: Float64Array.from([47.2184, 47.22, NaN, 48.39]),
        lon: Float64Array.from([-1.5536, -1.55, 2, -4.48]), dicts: { cache_type: ['T'] } }, 25);
    assert.equal(table.dicts.zone_grid.length, 2);
    assert.deepEqual([...table.zone_grid], [0, 0, -1, 1]);
    assert.deepEqual(table.dicts.cache_type, ['T']);
});

test('référence de grille imposée : stable quand la sélection change', () => {
    // La carte principale passe le lat0 du jeu complet (baseGeojson) :
    // un sous-ensemble filtré garde les mêmes cases.
    const full = { n: 4, lat: Float64Array.from([47.2184, 48.3904, 48.8534, 45.7640]),
        lon: Float64Array.from([-1.5536, -4.4861, 2.3522, 4.8357]) };
    const sub = { n: 1, lat: Float64Array.from([45.7640]), lon: Float64Array.from([4.8357]) };
    // Sans lat0, le sous-ensemble seul changerait de référence (45 au lieu
    // de 50) — l'id de la case du Rhône ne serait pas le même.
    assert.notEqual(
        withGridColumn(sub, 25).dicts.zone_grid[0].split('/')[1],
        withGridColumn(full, 25).dicts.zone_grid.at(-1).split('/')[1],
    );
    const lat0 = gridReference(full.lat);
    const ref = withGridColumn(full, 25, { lat0 }).dicts.zone_grid.at(-1);
    assert.equal(withGridColumn(sub, 25, { lat0 }).dicts.zone_grid[0], ref);
});

test('mini-carte en grille : cases, densité par surface de case, libellés', () => {
    const table = findsTable({
        count: 4, date: ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'],
        lat: [47.2184, 47.2190, 48.3904, null], lon: [-1.5536, -1.5530, -4.4861, null],
    });
    const spec = normalizeChartSpec({ id: 'abcdef01', groupBy: 'zone_grid', view: { map: { gridSize: 50 } } });
    assert.equal(spec.view.chart, 'map');
    const result = runZoneQuery(spec, table, { today: 30000 });
    assert.equal(result.zones.level, 'grid');
    assert.equal(result.zones.gridSize, 50);
    assert.equal(result.keys.length, 2);
    assert.deepEqual(result.series[0].values, [2, 1]);
    assert.equal(result.meta.unknown, 1);   // sans position
    const dense = runZoneQuery(normalizeChartSpec({ ...spec, compare: { normalize: 'per_km2' } }), table, { today: 30000 });
    assert.ok(Math.abs(dense.series[0].values[0] - 2 / cellArea(result.keys[0])) < 1e-12);
    const labels = makeLabels({ locale: 'fr' });
    assert.match(labels.axisLabel('zone_grid', result.keys[0]), /° N · 1,\d° O/);
    assert.equal(labels.dimension('zone_grid'), 'Case de la grille (carte)');
});
