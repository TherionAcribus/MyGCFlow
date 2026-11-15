// Tuile image d'un tableau de bord (image_tile.mjs, chart_spec.mjs,
// dashboard_model.mjs) : normalisation, cadrage, zoom de la vidéo.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chartSources, createChartSpec, normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { normalizeDashboard, specFitsDashboard } from '../../static/js/dashboard_model.mjs';
import { fitRect, imageUrl, imageZoom, isImageSpec, normalizeImageView } from '../../static/js/image_tile.mjs';

const FILE = '0123456789abcdef.png';

test('description d’une tuile image : légende, fichier, cadrage', () => {
    const spec = normalizeChartSpec({
        id: 'abcdef12', title: '  Mon club\n', view: { chart: 'image', image: { file: FILE, fit: 'cover' } },
        // Champs de graphique ignorés.
        groupBy: 'month', measure: { op: 'distinct', field: 'country' }, periods: [{ kind: 'year', year: 2024 }],
    });
    assert.equal(isImageSpec(spec), true);
    assert.equal(spec.id, 'abcdef12');
    assert.equal(spec.title, 'Mon club');
    assert.deepEqual(spec.view, { chart: 'image', image: { file: FILE, fit: 'cover' } });
    assert.equal(spec.groupBy, 'none');
    assert.deepEqual(spec.measure, { op: 'count' });
    assert.equal(spec.periods, null);
    assert.equal(spec.filters, null);
    // Pas de source : rien à charger, jamais « données indisponibles ».
    assert.deepEqual(chartSources(spec), []);
    // Idempotente.
    assert.deepEqual(normalizeChartSpec(spec), spec);
});

test('tuile image : fichier invalide ou chemin écartés, cadrage par défaut', () => {
    assert.deepEqual(normalizeImageView({ chart: 'image', image: { file: '../secret.png', fit: 'zoom' } }),
        { chart: 'image', image: { file: '', fit: 'contain' } });
    assert.deepEqual(normalizeImageView({ chart: 'image' }), { chart: 'image', image: { file: '', fit: 'contain' } });
    assert.equal(normalizeImageView({ image: { file: 'ABCDEF0123456789.png' } }).image.file, '');
    assert.equal(normalizeImageView({ image: { file: '0123456789abcdef.jpg' } }).image.file, '0123456789abcdef.jpg');
    assert.equal(imageUrl(FILE), '/api/images/0123456789abcdef.png');
});

test('tuile image : dupliquée avec un nouvel identifiant', () => {
    const spec = normalizeChartSpec({ id: 'abcdef12', view: { chart: 'image', image: { file: FILE } } });
    const copy = createChartSpec(structuredClone(spec), () => 'fedcba98');
    assert.equal(copy.id, 'fedcba98');
    assert.deepEqual(copy.view, spec.view);
});

test('tuile image : admise dans un tableau Évolution comme dans un tableau personnel', () => {
    const item = { size: 'S', spec: { id: 'abcdef12', view: { chart: 'image', image: { file: FILE } } } };
    const evolution = normalizeDashboard({ id: 'aaaaaa', kind: 'evolution', dataset: 3, items: [item] });
    assert.equal(evolution.items.length, 1);
    assert.equal(evolution.items[0].spec.view.image.file, FILE);
    const personal = normalizeDashboard({ id: 'bbbbbb', items: [item] });
    assert.equal(personal.items.length, 1);
    assert.equal(specFitsDashboard(evolution.items[0].spec, evolution), true);
});

test('cadrage : image entière ou tuile remplie, centrée', () => {
    // 200 × 100 dans 100 × 100.
    assert.deepEqual(fitRect(200, 100, 100, 100, 'contain'), { x: 0, y: 25, width: 100, height: 50 });
    assert.deepEqual(fitRect(200, 100, 100, 100, 'cover'), { x: -50, y: 0, width: 200, height: 100 });
    // Zoom autour du centre.
    assert.deepEqual(fitRect(100, 100, 100, 100, 'contain', 1.5), { x: -25, y: -25, width: 150, height: 150 });
    // Tailles nulles : rien à dessiner.
    assert.deepEqual(fitRect(0, 100, 100, 100), { x: 0, y: 0, width: 0, height: 0 });
});

test('vidéo : léger zoom jusqu’à la taille entière, décéléré, borné', () => {
    assert.equal(imageZoom(0), 0.95);
    assert.equal(imageZoom(1), 1);
    assert.equal(imageZoom(2), 1);
    assert.equal(imageZoom(-1), 0.95);
    assert.ok(imageZoom(0.5) > 0.975);
});
