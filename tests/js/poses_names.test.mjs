// Pseudos flottants de Mes poses : réglages (static/js/poses_names.mjs, copie
// de poses_names.py comparée via tests/fixtures/poses/poses_names.json, écrite
// par tests/test_poses_names.py), choix des logs (poses_names_model.mjs) et
// animation des étiquettes (name_labels.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    NAME_CHOICES,
    NAME_COLOR_KINDS,
    NAME_EXCLUDE_MAX,
    NAME_KINDS,
    NAME_PRESETS,
    NAME_PRESET_KEYS,
    NAME_PRIVACY_MODES,
    NAME_PSEUDO_MAX,
    NAME_RANGES,
    NAME_TEMPLATE_MAX,
    namesPrivacyDefaults,
    normalizeNamesPrivacy,
    normalizePosesNames,
    posesNamesDefaults,
    posesNamesPresetOf,
    withPosesNamesPreset,
} from '../../static/js/poses_names.mjs';
import {
    NAME_TEXT_MAX,
    buildNameStats,
    displayPseudo,
    formatNameLabel,
    initialsOf,
    nameCandidates,
    nameKindOf,
    namePreviewCandidates,
    visitorNames,
} from '../../static/js/poses_names_model.mjs';
import {
    createNameLabels,
    drawNameLabels,
    finderColor,
    nameLabelColor,
    nameLabelPose,
    pruneNameLabels,
    spawnNameLabels,
} from '../../static/js/name_labels.mjs';
import { STATE_ARCHIVED, STATE_DISABLED, buildPosesBase, buildPosesTimeline, stateAt } from '../../static/js/poses_timeline.mjs';
import { filterRows } from '../../static/js/evolution_timeline.mjs';

const table = JSON.parse(readFileSync(new URL('../fixtures/poses/poses_names.json', import.meta.url), 'utf8'));
const plain = (value) => JSON.parse(JSON.stringify(value));

// --- Réglages -------------------------------------------------------------------

test('mêmes défauts, choix, bornes et styles que le serveur', () => {
    assert.deepEqual(posesNamesDefaults(), table.defaults);
    assert.deepEqual(namesPrivacyDefaults(), table.privacy_defaults);
    assert.deepEqual(plain(NAME_PRESETS), table.presets);
    assert.deepEqual([...NAME_PRESET_KEYS], table.preset_keys);
    assert.deepEqual(plain(NAME_CHOICES), table.choices);
    assert.deepEqual([...NAME_KINDS], table.kinds);
    assert.deepEqual([...NAME_COLOR_KINDS], table.color_kinds);
    assert.deepEqual([...NAME_PRIVACY_MODES], table.privacy_modes);
    assert.deepEqual(plain(NAME_RANGES), table.ranges);
    assert.equal(NAME_TEMPLATE_MAX, table.template_max);
    assert.equal(NAME_EXCLUDE_MAX, table.exclude_max);
    assert.equal(NAME_PSEUDO_MAX, table.pseudo_max);
});

test('normalisation : bornes, choix, valeur courante gardée', () => {
    const names = normalizePosesNames({
        size: 999, distance: -5, emphasis: '1.75', direction: 'nord', color: 'rouge',
        outline_color: '#ABCDEF', bold: 'oui', template: '{pseudo}\n{code}' + 'x'.repeat(200),
        kinds: { note: true, find: 1 }, kind_colors: { dnf: '#FF0000', loyal: 'bleu' },
    });
    assert.equal(names.size, 64);
    assert.equal(names.distance, 0);
    assert.equal(names.emphasis, 1.75);
    assert.equal(names.direction, 'up');
    assert.equal(names.color, '#ffffff');
    assert.equal(names.outline_color, '#abcdef');
    assert.equal(names.bold, true);
    assert.ok(!names.template.includes('\n'));
    assert.equal(names.template.length, NAME_TEMPLATE_MAX);
    assert.deepEqual(names.kinds, { find: true, dnf: false, note: true });
    assert.equal(names.kind_colors.dnf, '#ff0000');
    assert.equal(names.kind_colors.loyal, '#4fc3f7');
    const current = normalizePosesNames({ enabled: true, exit: 'scatter' });
    const updated = normalizePosesNames({ size: 20 }, current);
    assert.equal(updated.enabled, true);
    assert.equal(updated.exit, 'scatter');
});

test('styles prêts à l’emploi : mouvement et texte seulement, reconnus ensuite', () => {
    assert.equal(posesNamesPresetOf(posesNamesDefaults()), 'rise');
    const names = normalizePosesNames({ enabled: true, max_visible: 5, kinds: { dnf: true }, kind_colors: { ftf: '#123456' } });
    const burst = withPosesNamesPreset(names, 'burst');
    assert.equal(burst.direction, 'radial');
    assert.equal(burst.max_visible, 5);
    assert.equal(burst.kinds.dnf, true);
    assert.equal(burst.kind_colors.ftf, '#123456');
    assert.equal(posesNamesPresetOf(burst), 'burst');
    assert.equal(posesNamesPresetOf({ ...burst, size: 30 }), null);
    assert.deepEqual(withPosesNamesPreset(names, 'inconnu'), names);
    for (const [name, style] of Object.entries(NAME_PRESETS)) {
        const n = normalizePosesNames(style);
        for (const key of NAME_PRESET_KEYS) assert.equal(n[key], style[key], `${name}.${key}`);
    }
});

test('confidentialité : exclusions sans doublon, patch partiel', () => {
    assert.deepEqual(normalizeNamesPrivacy(null), { mode: 'show', exclude: [] });
    const p = normalizeNamesPrivacy({ mode: 'initials', exclude: 'Toto, toto;Titi\n  \nTata' });
    assert.deepEqual(p, { mode: 'initials', exclude: ['Toto', 'Titi', 'Tata'] });
    assert.deepEqual(normalizeNamesPrivacy({ mode: 'hidden' }, p).exclude, ['Toto', 'Titi', 'Tata']);
    assert.equal(normalizeNamesPrivacy({ mode: 'bof' }, p).mode, 'initials');
    assert.equal(normalizeNamesPrivacy({ exclude: Array.from({ length: 500 }, (_, i) => `p${i}`) }).exclude.length, NAME_EXCLUDE_MAX);
});

// --- Choix des logs ------------------------------------------------------------------

const KINDS = ['publish', 'find', 'dnf', 'note', 'owner_note', 'alert', 'maintenance',
    'disable', 'enable', 'unarchive', 'archive', 'reviewer', 'other'];
const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));

// Trois caches : A (jour 0), B (jour 2), C (jour 3, archivée au jour 12).
function payload() {
    const ev = [
        // [cache, jour, type, fav, folded, auteur]
        [0, 0, K.publish, 0, 0, 0],
        [0, 0, K.find, 1, 1, 1],          // Alice, ramenée au jour d'apparition
        [0, 1, K.find, 1, 0, 3],          // Bob, favori
        [1, 2, K.publish, 0, 0, 0],
        [2, 3, K.publish, 0, 0, 0],
        [0, 4, K.dnf, 0, 0, 4],           // Chloé
        [1, 5, K.find, 0, 0, 1],          // Alice : première trouvaille de B
        [1, 5, K.find, 0, 0, 3],          // Bob : sa 2e trouvaille chez moi
        [1, 5, K.note, 0, 0, 4],          // Chloé
        [2, 12, K.archive, 0, 0, 0],
        [2, 13, K.find, 0, 0, 4],         // Chloé, cache archivée
    ];
    const st = [[2, 12, STATE_ARCHIVED, 0]];
    const col = (rows, i) => rows.map((r) => r[i]);
    return {
        origin: '2020-01-01',
        count: 3,
        code: ['GCA', 'GCB', 'GCC'],
        name: ['Alpha', 'Bravo', 'Charlie'],
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

function setup() {
    const base = buildPosesBase(payload());
    const rows = filterRows(base, { undatedMode: 'keep' });
    const timeline = buildPosesTimeline(base, rows);
    return { base, timeline, stats: buildNameStats(base) };
}

const enabled = (extra = {}) => normalizePosesNames({ enabled: true, ...extra });
const texts = (list) => list.map((c) => c.text);

test('rangs des trouvailles et type d’étiquette', () => {
    const { base, stats } = setup();
    assert.deepEqual(Array.from(stats.cacheNth), [0, 1, 2, 0, 0, 0, 1, 2, 0, 0, 1]);
    assert.deepEqual(Array.from(stats.authorNth), [0, 1, 1, 0, 0, 0, 2, 2, 0, 0, 1]);
    assert.equal(nameKindOf(base, stats, 1, 3), 'ftf');
    assert.equal(nameKindOf(base, stats, 2, 3), 'favorite');
    assert.equal(nameKindOf(base, stats, 5, 3), 'dnf');
    assert.equal(nameKindOf(base, stats, 6, 3), 'ftf');
    assert.equal(nameKindOf(base, stats, 7, 3), 'find');
    assert.equal(nameKindOf(base, stats, 7, 2), 'loyal');
    assert.equal(nameKindOf(base, stats, 8, 3), 'note');
    assert.equal(nameKindOf(base, stats, 0, 3), null);
});

test('un lot fusionné par cache, la plus marquante en tête', () => {
    const { base, timeline, stats } = setup();
    const list = nameCandidates(base, timeline, 5, 5, enabled(), { stats });
    assert.deepEqual(texts(list), ['♛ Alice +1']);
    assert.equal(list[0].kind, 'ftf');
    assert.equal(list[0].code, 'GCB');
    assert.equal(list[0].extra, 1);
    // Notes cochées : une de plus dans le compte.
    const withNotes = nameCandidates(base, timeline, 5, 5, enabled({ kinds: { note: true } }), { stats });
    assert.deepEqual(texts(withNotes), ['♛ Alice +2']);
});

test('une étiquette par visiteur, décalées dans le groupe', () => {
    const { base, timeline, stats } = setup();
    const list = nameCandidates(base, timeline, 5, 5, enabled({ grouping: 'separate', loyal_min: 2, badges: false }), { stats });
    assert.deepEqual(texts(list), ['Alice', 'Bob']);
    assert.deepEqual(list.map((c) => c.kind), ['ftf', 'loyal']);
    assert.deepEqual(list.map((c) => c.group).sort(), [0, 1]);
    assert.ok(list.every((c) => c.groupSize === 2));
});

test('quels logs : familles, logs marquants, logs ramenés à l’apparition', () => {
    const { base, timeline, stats } = setup();
    // Jour 0 : la seule trouvaille est « folded » — jamais d'étiquette.
    assert.deepEqual(nameCandidates(base, timeline, 0, 0, enabled(), { stats }), []);
    assert.deepEqual(nameCandidates(base, timeline, 4, 4, enabled(), { stats }), []);
    assert.deepEqual(texts(nameCandidates(base, timeline, 4, 4, enabled({ kinds: { dnf: true } }), { stats })), ['✗ Chloé']);
    const notable = enabled({ only_notable: true, grouping: 'separate' });
    // Chloé est la première à trouver C (jour 13) ; Bob, favori ; le reste,
    // ordinaire, est écarté. Les plus marquants d'abord.
    const marks = texts(nameCandidates(base, timeline, 0, 13, notable, { stats }));
    assert.deepEqual(marks.slice(0, 2).sort(), ['♛ Alice', '♛ Chloé']);
    assert.equal(marks[2], 'Bob ♥');
    assert.equal(marks.length, 3);
    assert.deepEqual(nameCandidates(base, timeline, 0, 13, { ...enabled(), enabled: false }, { stats }), []);
});

test('archivées masquées : plus d’étiquette après l’archivage', () => {
    const { base, timeline, stats } = setup();
    const opts = enabled();
    assert.equal(nameCandidates(base, timeline, 13, 13, opts, { stats }).length, 1);
    const isHidden = (i, day) => stateAt(base, i, day) === STATE_ARCHIVED;
    assert.equal(nameCandidates(base, timeline, 13, 13, opts, { stats, isHidden }).length, 0);
    assert.notEqual(STATE_DISABLED, STATE_ARCHIVED);
});

test('confidentialité : initiales, masqués, exclus', () => {
    const { base, timeline, stats } = setup();
    const opts = enabled({ grouping: 'separate', badges: false });
    const run = (privacy) => texts(nameCandidates(base, timeline, 5, 5, opts, { stats, privacy, hiddenLabel: 'Un visiteur' }));
    assert.deepEqual(run({ mode: 'initials', exclude: [] }), ['A.', 'B.']);
    assert.deepEqual(run({ mode: 'hidden', exclude: [] }), ['Un visiteur', 'Un visiteur']);
    assert.deepEqual(run({ mode: 'show', exclude: ['ALICE'] }), ['Bob']);
    assert.equal(initialsOf('Jean-Pierre_42'), 'J.P.4.');
    assert.equal(displayPseudo('', { mode: 'show' }), null);
});

test('modèle de l’étiquette et plafond', () => {
    const { base, timeline, stats } = setup();
    const opts = enabled({ grouping: 'separate', badges: false, template: '{pseudo} · {n}ᵉ sur {code} ({visites})' });
    assert.deepEqual(texts(nameCandidates(base, timeline, 5, 5, opts, { stats })), ['Alice · 1ᵉ sur GCB (2)', 'Bob · 2ᵉ sur GCB (2)']);
    assert.equal(formatNameLabel('{pseudo} {inconnu} {n}', { pseudo: 'A', n: null }), 'A {inconnu}');
    const capped = nameCandidates(base, timeline, 5, 5, { ...opts, max_visible: 1 }, { stats });
    assert.deepEqual(capped.map((c) => c.kind), ['ftf']);
});

test('étiquette bornée en longueur, « +N » préservé', () => {
    const { base, timeline, stats } = setup();
    const opts = enabled({ grouping: 'separate', badges: false, template: 'Z'.repeat(NAME_TEMPLATE_MAX) });
    const list = nameCandidates(base, timeline, 5, 5, opts, { stats });
    assert.ok(list.length > 0);
    for (const c of list) {
        assert.equal(Array.from(c.text).length, NAME_TEXT_MAX);
        assert.ok(c.text.endsWith('…'));
    }
    // Le « +N » d'un lot fusionné est ajouté après la coupure.
    const merged = texts(nameCandidates(base, timeline, 5, 5, { ...opts, grouping: 'merge' }, { stats }));
    assert.ok(merged[0].endsWith('+1'));
    // Même borne pour l'aperçu.
    const preview = namePreviewCandidates(base, [{ k: 0, i: 0 }], opts, {});
    assert.ok(preview[0].text.endsWith('…'));
});

test('aperçu : pseudos réels, types variés, exclusions respectées', () => {
    const { base } = setup();
    const ks = [{ k: 0, i: 0 }, { k: 1, i: 1 }, { k: 2, i: 2 }];
    // Le relecteur et le poseur ne sont pas des visiteurs ; Bob est exclu.
    const list = namePreviewCandidates(base, ks, enabled(), { privacy: { mode: 'show', exclude: ['bob'] } });
    assert.equal(list.length, 3);
    for (const c of list) assert.ok(/Alice|Chloé/.test(c.text), c.text);
    assert.deepEqual(visitorNames(base), ['Alice', 'Bob', 'Chloé']);
    assert.ok(new Set(list.map((c) => c.kind)).size > 1);
});

test('aperçu : clé de couleur par visiteur alignée sur la lecture', () => {
    const { base, timeline, stats } = setup();
    const privacy = { mode: 'hidden', exclude: [] };
    const opts = enabled({ color_mode: 'finder', badges: false });
    // Lecture : indice de l'auteur, jamais le pseudo affiché (« Un visiteur »
    // pour tous donnerait une seule teinte).
    const read = new Set(nameCandidates(base, timeline, 0, 13, opts, { stats, privacy }).map((c) => c.finderKey));
    const ks = [{ k: 0, i: 0 }, { k: 1, i: 1 }, { k: 2, i: 2 }];
    const prev = new Set(namePreviewCandidates(base, ks, opts, { privacy }).map((c) => c.finderKey));
    assert.ok(prev.size > 1);
    assert.ok([...prev].every((k) => /^#\d+$/.test(k)));
    assert.deepEqual([...prev].sort(), [...read].sort());
    // En mode « show », la clé reste le pseudo réel (casse ignorée).
    const shown = namePreviewCandidates(base, ks, opts, { privacy: { mode: 'show', exclude: [] } });
    assert.ok(shown.every((c) => !c.finderKey.startsWith('#')));
});

// --- Animation et dessin ------------------------------------------------------------

function label(extra = {}) {
    return {
        coord: [0, 0], text: 'Alice', kind: 'find', priority: 2, notable: false, seed: 42, cacheSeed: 7,
        group: 0, groupSize: 1, start: 1000, duration: 2000, timeScale: 1, killAt: null, killDur: 0,
        nudge: [0, 0], metrics: null, ...extra,
    };
}

test('pose : attente, entrée, trajet, sortie', () => {
    const opts = enabled({ path: 'away', direction: 'up', distance: 60, offset_y: -10, entrance: 'fade', exit: 'fade' });
    const l = label();
    assert.equal(nameLabelPose(l, 500, opts).pending, true);
    assert.equal(nameLabelPose(l, 3000, opts).done, true);
    const start = nameLabelPose(l, 1000, opts);
    assert.equal(start.alpha, 0);
    assert.ok(Math.abs(start.dy + 10) < 1e-9);
    const mid = nameLabelPose(l, 2000, opts);
    assert.equal(mid.alpha, 1);
    assert.ok(mid.dy < -10 - 30, `${mid.dy} : monte`);
    assert.ok(Math.abs(mid.dx) < 1e-9);
    assert.ok(nameLabelPose(l, 2990, opts).alpha < 0.05);
    // Arrivée : part de loin, finit sur le point avant de sortir.
    const toward = { ...opts, path: 'toward' };
    assert.ok(nameLabelPose(l, 1000, toward).dy < -60);
    assert.ok(Math.abs(nameLabelPose(l, 2900, toward).dy + 10) < 1e-6);
    // Sur place : aucun déplacement.
    assert.equal(nameLabelPose(l, 2000, { ...opts, path: 'still' }).dx, 0);
});

test('pose : entrées et sorties spéciales', () => {
    const base = enabled({ path: 'still' });
    const l = label();
    assert.ok(nameLabelPose(l, 1050, { ...base, entrance: 'typewriter' }).reveal < 1);
    assert.ok(nameLabelPose(l, 1050, { ...base, entrance: 'zoom' }).scale > 1.5);
    assert.ok(nameLabelPose(l, 2900, { ...base, exit: 'scatter' }).scatter > 0.5);
    assert.ok(nameLabelPose(l, 2900, { ...base, exit: 'grow' }).scale > 1.5);
    assert.ok(nameLabelPose(l, 2900, { ...base, exit: 'shrink' }).scale < 0.5);
    // Directions « radial » : un groupe se répartit autour de la cache.
    const radial = { ...enabled(), direction: 'radial', distance: 50, offset_y: 0 };
    const a = nameLabelPose(label({ groupSize: 2, group: 0 }), 2000, radial);
    const b = nameLabelPose(label({ groupSize: 2, group: 1 }), 2000, radial);
    assert.ok(Math.abs(a.dx + b.dx) < 1e-6 && Math.abs(a.dy + b.dy) < 1e-6, 'opposées');
    // Déterministe : mêmes graines, même pose.
    assert.deepEqual(nameLabelPose(label(), 1700, { ...enabled(), direction: 'random', wobble: 50, tilt: 30 }),
        nameLabelPose(label(), 1700, { ...enabled(), direction: 'random', wobble: 50, tilt: 30 }));
});

function candidate(extra = {}) {
    return { text: 'Alice', pseudo: 'Alice', kind: 'find', priority: 2, notable: false, finderKey: 'alice',
        code: 'GCA', cacheType: '', seed: 1, cacheSeed: 2, group: 0, groupSize: 1, coord: [0, 0], ...extra };
}
const spawnOpts = (opts, extra = {}) => ({ opts, anchorOf: (c) => c.coord, ...extra });

test('file : plafond, éviction des moins marquants, décalage et ralentissement', () => {
    const state = createNameLabels();
    const opts = enabled({ max_visible: 2, avoid_overlap: false });
    spawnNameLabels(state, [candidate(), candidate({ seed: 2 })], spawnOpts(opts, { at: 0 }));
    assert.equal(state.labels.length, 2);
    // Plein : une trouvaille ordinaire est écartée…
    spawnNameLabels(state, [candidate({ seed: 3 })], spawnOpts(opts, { at: 100 }));
    assert.equal(state.dropped, 1);
    // … une première trouvaille écourte la plus ancienne des ordinaires.
    spawnNameLabels(state, [candidate({ kind: 'ftf', priority: 6, seed: 4 })], spawnOpts(opts, { at: 200 }));
    assert.equal(state.evicted, 1);
    assert.equal(state.labels[0].killAt, 200);
    pruneNameLabels(state, 500);
    assert.equal(state.labels.length, 2);
    // Ralentissement MediaRecorder et décalage des étiquettes séparées.
    const s2 = createNameLabels();
    const sep = enabled({ grouping: 'separate', stagger_ms: 100, duration_ms: 1000, avoid_overlap: false });
    spawnNameLabels(s2, [candidate({ group: 0 }), candidate({ group: 2 })], spawnOpts(sep, { at: 0, timeScale: 3 }));
    assert.deepEqual(s2.labels.map((l) => [l.start, l.duration]), [[0, 3000], [600, 3000]]);
    // Désactivé : rien (sauf aperçu).
    assert.equal(spawnNameLabels(createNameLabels(), [candidate()], spawnOpts({ ...opts, enabled: false }, { at: 0 })), 0);
});

test('placement : deux pseudos au même point ne se recouvrent pas', () => {
    const state = createNameLabels();
    const opts = enabled({ path: 'still', avoid_overlap: true });
    const extra = { at: 0, pixelOf: () => [100, 100], measure: (text) => text.length * 7 };
    spawnNameLabels(state, [candidate()], spawnOpts(opts, extra));
    spawnNameLabels(state, [candidate({ seed: 9 })], spawnOpts(opts, extra));
    assert.deepEqual(state.labels[0].nudge, [0, 0]);
    assert.notEqual(state.labels[1].nudge[1], 0);
});

function fakeCtx() {
    const calls = [];
    const ctx = {
        calls,
        font: '',
        measureText: (text) => ({ width: String(text).length * 8 }),
    };
    for (const name of ['save', 'restore', 'translate', 'rotate', 'scale', 'beginPath', 'moveTo', 'lineTo',
        'arcTo', 'closePath', 'fill', 'stroke']) ctx[name] = () => {};
    ctx.fillText = (text) => calls.push(['fill', text, ctx.fillStyle]);
    ctx.strokeText = (text) => calls.push(['stroke', text]);
    return ctx;
}

test('dessin : texte, contour, majuscules, lettre à lettre', () => {
    const state = createNameLabels();
    const opts = enabled({ uppercase: true, outline_width: 2, entrance: 'none', color: '#123456' });
    spawnNameLabels(state, [candidate()], spawnOpts(opts, { at: 0 }));
    const ctx = fakeCtx();
    const drawn = drawNameLabels(ctx, state, { now: 500, opts, toPixel: (c) => c });
    assert.equal(drawn, 1);
    assert.deepEqual(ctx.calls, [['stroke', 'ALICE'], ['fill', 'ALICE', '#123456']]);
    const typing = enabled({ path: 'still', entrance: 'typewriter', outline_width: 0 });
    const s2 = createNameLabels();
    spawnNameLabels(s2, [candidate()], spawnOpts(typing, { at: 0 }));
    const ctx2 = fakeCtx();
    drawNameLabels(ctx2, s2, { now: 120, opts: typing, toPixel: (c) => c });
    const written = ctx2.calls[0][1];
    assert.ok(written.length > 0 && written.length < 5, written);
    // Terminée : retirée au dessin.
    assert.equal(drawNameLabels(fakeCtx(), state, { now: 10000, opts, toPixel: (c) => c }), 0);
    assert.equal(state.labels.length, 0);
});

test('dessin : graphemes entiers, rappel au bord, bulle orientée', () => {
    // Emoji composé : un seul « caractère » à l'éparpillement.
    const scatter = enabled({ path: 'still', exit: 'scatter', entrance: 'none', outline_width: 0 });
    const s1 = createNameLabels();
    spawnNameLabels(s1, [candidate({ text: 'A👨‍👩‍👧B', duration: 0 })], spawnOpts(scatter, { at: 0 }));
    s1.labels[0].duration = 2000;
    const ctx1 = fakeCtx();
    drawNameLabels(ctx1, s1, { now: 1900, opts: scatter, toPixel: (c) => c });
    assert.deepEqual(ctx1.calls.map((c) => c[1]).sort(), ['A', 'B', '👨‍👩‍👧']);

    const calls = [];
    const ctx = fakeCtx();
    ctx.moveTo = (x, y) => calls.push(['m', x, y]);
    ctx.lineTo = (x, y) => calls.push(['l', x, y]);
    // Étiquette sous la cache : la queue de la bulle pointe vers le haut…
    const below = enabled({ path: 'still', offset_y: 40, background: 'bubble', entrance: 'none' });
    const s2 = createNameLabels();
    spawnNameLabels(s2, [candidate()], spawnOpts(below, { at: 0 }));
    drawNameLabels(ctx, s2, { now: 500, opts: below, toPixel: (c) => c });
    assert.ok(calls.some((c) => c[0] === 'l' && c[2] < -15), 'queue vers le haut');
    // … au-dessus : vers le bas.
    calls.length = 0;
    const above = { ...below, offset_y: -40 };
    const s3 = createNameLabels();
    spawnNameLabels(s3, [candidate()], spawnOpts(above, { at: 0 }));
    drawNameLabels(ctx, s3, { now: 500, opts: above, toPixel: (c) => c });
    assert.ok(calls.some((c) => c[0] === 'l' && c[2] > 15), 'queue vers le bas');
    // Trait de rappel : s'arrête au bord de l'étiquette, pas au centre (−50).
    calls.length = 0;
    const conn = enabled({ path: 'still', offset_y: -50, connector: true, entrance: 'none' });
    const s4 = createNameLabels();
    spawnNameLabels(s4, [candidate()], spawnOpts(conn, { at: 0 }));
    drawNameLabels(ctx, s4, { now: 500, opts: conn, toPixel: (c) => c });
    const end = calls.find((c) => c[0] === 'l');
    assert.ok(end && end[2] > -50 && end[2] < -40, `bord atteint (${end?.[2]})`);
});

test('couleurs : fixe, par événement, par visiteur, par type', () => {
    const opts = enabled({ color: '#111111' });
    const l = { kind: 'ftf', finderKey: 'alice', cacheType: 'Multi-cache' };
    assert.equal(nameLabelColor(l, opts), '#111111');
    assert.equal(nameLabelColor(l, { ...opts, color_mode: 'event' }), opts.kind_colors.ftf);
    assert.match(finderColor('alice'), /^#[0-9a-f]{6}$/);
    assert.equal(finderColor('alice'), finderColor('alice'));
    assert.notEqual(finderColor('alice'), finderColor('bob'));
    assert.equal(nameLabelColor(l, { ...opts, color_mode: 'cache_type' }, (t) => (t === 'Multi-cache' ? '#ffaa00' : null)), '#ffaa00');
    assert.equal(nameLabelColor(l, { ...opts, color_mode: 'cache_type' }, () => null), '#111111');
});
