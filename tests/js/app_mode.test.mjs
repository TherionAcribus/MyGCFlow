// Mode de la page (static/js/app_mode.mjs) et clés de stockage par page.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    MODE_EVOLUTION,
    MODE_MAIN,
    MODE_POSES,
    appMode,
    isEvolutionPage,
    isLifecyclePage,
    isMainPage,
    isPosesPage,
    modeOf,
    perPage,
} from '../../static/js/app_mode.mjs';
import { statsPanelsKey } from '../../static/js/stats_model.mjs';
import { imagesItemsKey } from '../../static/js/images_model.mjs';

const page = (mode) => ({ body: { dataset: mode === undefined ? {} : { mode } } });

test('le mode vient de data-mode, une valeur inconnue vaut le mode principal', () => {
    assert.equal(appMode(page('main')), MODE_MAIN);
    assert.equal(appMode(page('evolution')), MODE_EVOLUTION);
    assert.equal(appMode(page('poses')), MODE_POSES);
    assert.equal(appMode(page('autre')), MODE_MAIN);
    assert.equal(appMode(page(undefined)), MODE_MAIN);
    assert.equal(appMode(null), MODE_MAIN);
});

test('prédicats de page : Évolution et Mes poses partagent le moteur cycle de vie', () => {
    const cases = [
        ['main', { main: true, evolution: false, poses: false, lifecycle: false }],
        ['evolution', { main: false, evolution: true, poses: false, lifecycle: true }],
        ['poses', { main: false, evolution: false, poses: true, lifecycle: true }],
    ];
    for (const [mode, expected] of cases) {
        const doc = page(mode);
        assert.equal(isMainPage(doc), expected.main, mode);
        assert.equal(isEvolutionPage(doc), expected.evolution, mode);
        assert.equal(isPosesPage(doc), expected.poses, mode);
        assert.equal(isLifecyclePage(doc), expected.lifecycle, mode);
    }
});

test('modeOf accepte un nom de mode ou l’ancien booléen « page Évolution »', () => {
    assert.equal(modeOf(true), MODE_EVOLUTION);
    assert.equal(modeOf(false), MODE_MAIN);
    assert.equal(modeOf(undefined), MODE_MAIN);
    assert.equal(modeOf('poses'), MODE_POSES);
    assert.equal(modeOf('inconnu'), MODE_MAIN);
});

test('perPage choisit la valeur du mode, repli sur main', () => {
    const map = { main: 'a', evolution: 'b', poses: 'c' };
    assert.equal(perPage(map, 'main'), 'a');
    assert.equal(perPage(map, 'evolution'), 'b');
    assert.equal(perPage(map, 'poses'), 'c');
    assert.equal(perPage({ main: 'a', evolution: 'b' }, 'poses'), 'a');
    // Hors navigateur (pas de document), la page courante vaut le mode principal.
    assert.equal(perPage(map), 'a');
});

test('clés de liste par page : panneaux Stats et images', () => {
    assert.deepEqual(['main', 'evolution', 'poses'].map(statsPanelsKey), ['panels', 'evolution_panels', 'poses_panels']);
    assert.deepEqual(['main', 'evolution', 'poses'].map(imagesItemsKey), ['items', 'evolution_items', 'poses_items']);
    // Ancienne forme booléenne, encore utilisée par des appelants.
    assert.equal(statsPanelsKey(true), 'evolution_panels');
    assert.equal(statsPanelsKey(false), 'panels');
    assert.equal(imagesItemsKey(true), 'evolution_items');
    assert.equal(imagesItemsKey(false), 'items');
});
