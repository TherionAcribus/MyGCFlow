// Page Parcours : fiche des caches (static/js/parcours_info.mjs et
// parcours_info_draw.mjs), copie de parcours_info.py comparée via
// tests/fixtures/parcours/parcours_info.json (écrite par
// tests/test_parcours_info.py).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    PARCOURS_INFO_CHOICES,
    PARCOURS_INFO_FIELDS,
    PARCOURS_INFO_RANGES,
    createInfoVisibility,
    currentInfo,
    fixedInfoPosition,
    fixedInfoScale,
    formatRating,
    infoAlpha,
    infoContent,
    infoEnabled,
    normalizeParcoursInfo,
    parcoursInfoDefaults,
    placeInfoLabels,
    secondsToQuanta,
} from '../../static/js/parcours_info.mjs';
import { drawInfo, infoColors, infoLayout } from '../../static/js/parcours_info_draw.mjs';

const table = JSON.parse(readFileSync(new URL('../fixtures/parcours/parcours_info.json', import.meta.url), 'utf8'));
const plain = (value) => JSON.parse(JSON.stringify(value));

test('mêmes défauts, choix et bornes que le serveur', () => {
    assert.deepEqual(parcoursInfoDefaults(), table.defaults);
    assert.deepEqual([...PARCOURS_INFO_FIELDS], table.fields);
    assert.deepEqual(plain(PARCOURS_INFO_CHOICES), table.choices);
    assert.deepEqual(plain(PARCOURS_INFO_RANGES), table.ranges);
});

test('normalisation : bornes, choix, couleurs, valeurs courantes', () => {
    assert.deepEqual(normalizeParcoursInfo(undefined), parcoursInfoDefaults());
    const out = normalizeParcoursInfo({
        near: 'all', fixed: 'middle', duration: 99, size: '4', design: 'banner', font: 'comic',
        text_color: '#ABCDEF', background_color: 'white', background_opacity: -5, owner: true, dt: 'yes',
    });
    assert.equal(out.near, 'all');
    assert.equal(out.fixed, 'none');
    assert.equal(out.duration, 15);
    assert.equal(out.size, 9);
    assert.equal(out.design, 'banner');
    assert.equal(out.font, 'sans');
    assert.equal(out.text_color, '#abcdef');
    assert.equal(out.background_color, '#ffffff');
    assert.equal(out.background_opacity, 0);
    assert.equal(out.owner, true);
    assert.equal(out.dt, true);
    const current = normalizeParcoursInfo({ near: 'current', fixed: 'bottom', name: false });
    const next = normalizeParcoursInfo({ size: 20 }, current);
    assert.equal(next.near, 'current');
    assert.equal(next.fixed, 'bottom');
    assert.equal(next.name, false);
    assert.equal(next.size, 20);
});

test('affichée seulement avec un emplacement et un élément coché', () => {
    const on = normalizeParcoursInfo({ near: 'current' });
    assert.equal(infoEnabled(parcoursInfoDefaults()), false);
    assert.equal(infoEnabled(on), true);
    assert.equal(infoEnabled(normalizeParcoursInfo({ fixed: 'top' })), true);
    assert.equal(infoEnabled({ ...on, name: false, dt: false, owner: false, favorites: false }), false);
});

test('contenu : éléments cochés et connus, rien pour un lieu', () => {
    const info = normalizeParcoursInfo({ near: 'current', owner: true });
    const stop = {
        key: 'GC1', kind: 'find', name: ' Le moulin ', difficulty: 2.5, terrain: 3, owner: 'Famille', favoritePoints: 42,
    };
    const empty = { code: null, type: null, finds: null };
    assert.deepEqual(infoContent(stop, info), { name: 'Le moulin', dt: { d: 2.5, t: 3 }, owner: 'Famille', favorites: 42, ...empty });
    // PF inconnus (jamais collectés), D/T absents (Lab) : omis.
    assert.deepEqual(infoContent({ key: 'lab:1', kind: 'lab', name: 'Étape', difficulty: null, terrain: null }, info),
        { name: 'Étape', dt: null, owner: null, favorites: null, ...empty });
    assert.equal(infoContent({ ...stop, favoritePoints: 0 }, info).favorites, 0);
    // Rien de coché ne soit connu : pas de fiche.
    assert.equal(infoContent({ key: 'lab:2', kind: 'lab', name: '' }, info), null);
    assert.equal(infoContent({ key: 'p', kind: 'place', name: 'Parking' }, info), null);
    assert.equal(infoContent({ key: 'b', kind: 'base', name: 'Hôtel' }, info), null);
    // Éléments décochés.
    assert.deepEqual(infoContent(stop, { ...info, name: false, owner: false }), {
        name: null, dt: { d: 2.5, t: 3 }, owner: null, favorites: 42, ...empty,
    });
});

test('contenu additionnel : code GC, type, trouvailles — à la carte', () => {
    const info = normalizeParcoursInfo({ near: 'current', code: true, type: true, finds: true });
    const stop = {
        key: 'GC1', kind: 'find', name: 'Le moulin', code: ' GC9ABC ', type: 'Multi-cache',
        difficulty: 2.5, terrain: 3, foundCount: 137,
    };
    const content = infoContent(stop, info);
    assert.equal(content.code, 'GC9ABC');
    assert.equal(content.type, 'Multi-cache');
    assert.equal(content.finds, 137);
    // Décochés ou inconnus (jamais collectés) : omis.
    assert.deepEqual(infoContent(stop, { ...info, code: false, type: false, finds: false }),
        { name: 'Le moulin', dt: { d: 2.5, t: 3 }, owner: null, favorites: null, code: null, type: null, finds: null });
    assert.equal(infoContent({ ...stop, foundCount: null }, info).finds, null);
    assert.equal(infoContent({ ...stop, foundCount: 0 }, info).finds, 0);
    // Un Lab n'a pas de code, mais son type « Lab Cache » se montre.
    const lab = infoContent({ key: 'lab:1', kind: 'lab', name: null, code: null, type: 'Lab Cache' }, { ...info, name: false, dt: false });
    assert.equal(lab.type, 'Lab Cache');
    assert.equal(lab.code, null);
});

test('notes D/T au format de la langue', () => {
    assert.equal(formatRating(2.5, 'fr'), '2,5');
    assert.equal(formatRating(2.5, 'en'), '2.5');
    assert.equal(formatRating(3, 'fr'), '3');
    assert.equal(formatRating(null, 'fr'), '');
});

test('fenêtre temporaire : visite, durée minimale, étape suivante, fondus', () => {
    const stop = { q: 100, departQ: 105 };
    // Durée minimale 30 quanta > visite : jusqu'à 130.
    assert.equal(infoAlpha(stop, 99, { holdQ: 30 }), 0);
    assert.equal(infoAlpha(stop, 100, { holdQ: 30 }), 1);
    assert.equal(infoAlpha(stop, 129, { holdQ: 30 }), 1);
    assert.equal(infoAlpha(stop, 130, { holdQ: 30 }), 0);
    // Visite plus longue que la durée : jusqu'au départ.
    assert.equal(infoAlpha({ q: 100, departQ: 160 }, 150, { holdQ: 30 }), 1);
    // Coupée à l'arrivée de la suivante.
    assert.equal(infoAlpha(stop, 120, { holdQ: 30, untilQ: 115 }), 0);
    // Fondus d'entrée et de sortie.
    assert.equal(infoAlpha(stop, 101.5, { holdQ: 30, fadeQ: 3 }), 0.5);
    assert.equal(infoAlpha(stop, 128.5, { holdQ: 30, fadeQ: 3 }), 0.5);
    // Fenêtre courte (4 quanta < 2× le fondu de 3) : le fondu est borné au
    // quart de la fenêtre — opacité pleine sur la moitié centrale au lieu
    // d'un pic voilé à 0,67.
    const brief = { q: 100, departQ: 104 };
    assert.equal(infoAlpha(brief, 101, { fadeQ: 3 }), 1);
    assert.equal(infoAlpha(brief, 102, { fadeQ: 3 }), 1);
    assert.equal(infoAlpha(brief, 103, { fadeQ: 3 }), 1);
    assert.equal(infoAlpha(brief, 100.5, { fadeQ: 3 }), 0.5);
    assert.equal(infoAlpha(brief, 103.5, { fadeQ: 3 }), 0.5);
});

test('fiche en cours : dernière étape comptée atteinte, lieux ignorés', () => {
    const timeline = {
        stops: [
            { key: 'GC1', kind: 'find', q: 10, departQ: 15 },
            { key: 'p', kind: 'place', q: 20, departQ: 22 },
            { key: 'GC2', kind: 'find', q: 40, departQ: 45 },
        ],
    };
    assert.equal(currentInfo(timeline, 5, { holdQ: 10 }), null);
    assert.deepEqual(currentInfo(timeline, 12, { holdQ: 10 }), { index: 0, alpha: 1 });
    // Le lieu atteint ne remplace pas la fiche de GC1.
    assert.deepEqual(currentInfo(timeline, 21, { holdQ: 30 }), { index: 0, alpha: 1 });
    assert.equal(currentInfo(timeline, 25, { holdQ: 10 }), null);
    // L'arrivée de GC2 coupe celle de GC1 et prend la place.
    assert.deepEqual(currentInfo(timeline, 41, { holdQ: 100 }), { index: 2, alpha: 1 });
    assert.equal(secondsToQuanta(3, 100), 30);
    assert.equal(secondsToQuanta(3, 50), 60);
});

test('placement sans chevauchement, l’étape en cours toujours', () => {
    const size = { width: 400, height: 300 };
    const a = { x: 100, y: 100, w: 80, h: 20, gap: 10, force: true };
    const b = { x: 100, y: 100, w: 80, h: 20, gap: 10 };
    const [ra, rb] = placeInfoLabels([a, b], size);
    assert.equal(ra.side, 'right');
    assert.equal(rb.side, 'left');
    // Plus de place : masquée.
    const rects = placeInfoLabels([a, b, { ...b }, { ...b }, { ...b }], size);
    assert.equal(rects.filter(Boolean).length, 4);
    assert.equal(rects[4], null);
    // Bord droit : à gauche.
    const [edge] = placeInfoLabels([{ x: 390, y: 100, w: 80, h: 20, gap: 10 }], size);
    assert.equal(edge.side, 'left');
    // Obstacle (pastille d'une autre étape) à droite : à gauche.
    const [dodge] = placeInfoLabels([{ x: 100, y: 100, w: 80, h: 20, gap: 10 }],
        { ...size, obstacles: [{ x: 140, y: 95, w: 10, h: 10 }] });
    assert.equal(dodge.side, 'left');
    // Étape en cours sans place libre : posée quand même.
    const crowded = placeInfoLabels([b, b, b, b, { ...a }], size);
    assert.ok(crowded[4]);
});

test('placement stable : le côté est gardé tant qu\'il tient', () => {
    const size = { width: 400, height: 300 };
    const memory = new Map();
    // Un obstacle à droite pousse la fiche à gauche.
    const item = { key: 'GC1', x: 100, y: 100, w: 80, h: 20, gap: 10 };
    const obstacle = { x: 140, y: 95, w: 10, h: 10 };
    const [first] = placeInfoLabels([item], { ...size, obstacles: [obstacle], memory });
    assert.equal(first.side, 'left');
    assert.equal(memory.get('GC1'), 'left');
    // L'obstacle disparaît : la fiche garde son côté au lieu de revenir à
    // droite — pas d'aller-retour d'une image à l'autre.
    const [kept] = placeInfoLabels([item], { ...size, memory });
    assert.equal(kept.side, 'left');
    // Le côté gardé ne tient plus (hors cadre) : repli sur un autre, mémorisé.
    const near = { key: 'GC1', x: 8, y: 100, w: 80, h: 20, gap: 10 };
    const [moved] = placeInfoLabels([near], { ...size, memory });
    assert.notEqual(moved.side, 'left');
    assert.equal(memory.get('GC1'), moved.side);
    // Le côté gardé est recouvert par une fiche plus prioritaire : repli.
    const a = { key: 'GC0', x: 150, y: 100, w: 80, h: 20, gap: 10, force: true };
    const memory2 = new Map([['GC1', 'right']]);
    const rects = placeInfoLabels([a, { key: 'GC1', x: 150, y: 100, w: 80, h: 20, gap: 10 }], { ...size, memory: memory2 });
    assert.equal(rects[0].side, 'right');
    assert.equal(rects[1].side, 'left');
    // Sans clé, rien n'est mémorisé.
    const memory3 = new Map();
    placeInfoLabels([{ x: 100, y: 100, w: 80, h: 20, gap: 10 }], { ...size, memory: memory3 });
    assert.equal(memory3.size, 0);
});

test('placement : diagonales, recouvrement minimal, rabattement dans l\'image', () => {
    const size = { width: 400, height: 300 };
    // Les quatre côtés cardinaux bloqués par des obstacles près du point :
    // une diagonale libre prend le relais.
    const item = { x: 100, y: 100, w: 80, h: 20, gap: 10 };
    const obstacles = [
        { x: 118, y: 95, w: 6, h: 10 },    // droite
        { x: 80, y: 95, w: 6, h: 10 },     // gauche
        { x: 95, y: 80, w: 10, h: 6 },     // dessus
        { x: 95, y: 115, w: 10, h: 6 },    // dessous
    ];
    const [diag] = placeInfoLabels([item], { ...size, obstacles });
    assert.equal(diag.side, 'bottom_right');
    // Toutes les places strictes sont hors cadre ou recouvertes : la fiche
    // forcée prend celle qui recouvre le moins — ici le dessus, seul sans
    // recouvrement — plutôt que la première venue sur l'obstacle.
    const obstacle = { x: 295, y: 140, w: 105, h: 25 };
    const [forced] = placeInfoLabels([{ x: 390, y: 150, w: 80, h: 20, gap: 10, force: true }],
        { ...size, obstacles: [obstacle] });
    assert.equal(forced.side, 'top');
    // Plus aucune place dans l'image (image étroite) : la fiche forcée est
    // ramenée dans le cadre au lieu de sortir à droite.
    const tiny = { width: 100, height: 60 };
    const [clamped] = placeInfoLabels([{ x: 50, y: 30, w: 80, h: 20, gap: 10, force: true }], tiny);
    assert.ok(clamped);
    assert.ok(clamped.x >= 4 && clamped.y >= 4, `dans le cadre : ${clamped.x},${clamped.y}`);
    assert.ok(clamped.x + clamped.w <= tiny.width - 4 && clamped.y + clamped.h <= tiny.height - 4,
        `dans le cadre : ${clamped.x}+${clamped.w}, ${clamped.y}+${clamped.h}`);
    // Une fiche plus large que l'image reste visible par son bord gauche.
    const [wide] = placeInfoLabels([{ x: 50, y: 30, w: 200, h: 20, gap: 10, force: true }], tiny);
    assert.equal(wide.x, 4);
});

test('visibilité en fondu : apparition, disparition, saut en arrière', () => {
    const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
    const vis = createInfoVisibility();
    // Première image : la fiche apparaît à 0 puis monte.
    assert.equal(vis.step(0, ['GC1'], 1).get('GC1'), 0);
    assert.equal(vis.moving(), true);
    close(vis.step(0.5, ['GC1'], 1).get('GC1'), 0.5);
    close(vis.step(0.6, ['GC1'], 1).get('GC1'), 0.6);
    assert.equal(vis.step(1.5, ['GC1'], 1).get('GC1'), 1);
    assert.equal(vis.moving(), false);
    // GC2 apparaît à son tour : elle repart de bas.
    close(vis.step(1.6, ['GC1', 'GC2'], 1).get('GC2'), 0.1);
    // GC1 perd sa place : encore dessinée, en décroissant, puis oubliée.
    close(vis.step(1.7, ['GC2'], 1).get('GC1'), 0.9);
    close(vis.step(2.2, ['GC2'], 1).get('GC1'), 0.4);
    assert.equal(vis.moving(), true);   // GC1 descend, GC2 monte encore
    assert.equal(vis.step(2.7, ['GC2'], 1).has('GC1'), false);
    // Un trou de temps (onglet masqué) achève le fondu d'un coup.
    assert.equal(vis.step(20, [], 1).has('GC2'), false);
    assert.equal(vis.moving(), false);
    // Saut en arrière : tout est net, pas de fiche fantôme.
    vis.step(30, ['GC1'], 1);
    vis.step(29.9, [], 1);
    const out = vis.step(5, ['GC1'], 1);
    assert.equal(out.get('GC1'), 1);
    assert.equal(out.size, 1);
    // Lecture réduite (fadeS 0) : immédiat.
    const flat = createInfoVisibility();
    assert.equal(flat.step(0, ['GC1'], 0).get('GC1'), 1);
    assert.equal(flat.step(0.1, [], 0).has('GC1'), false);
    assert.equal(flat.moving(), false);
});

test('cartouche fixe : bords et coins', () => {
    assert.deepEqual(fixedInfoPosition('top', 100, 40, 1000, 500, { margin: 20 }), { x: 450, y: 20 });
    assert.deepEqual(fixedInfoPosition('bottom', 100, 40, 1000, 500, { margin: 20 }), { x: 450, y: 440 });
    assert.deepEqual(fixedInfoPosition('top_right', 100, 40, 1000, 500, { margin: 20 }), { x: 880, y: 20 });
    assert.deepEqual(fixedInfoPosition('bottom_left', 100, 40, 1000, 500, { margin: 20 }), { x: 20, y: 440 });
    assert.equal(fixedInfoPosition('none', 100, 40, 1000, 500), null);
    // Titre en haut à gauche : le cartouche passe dessous ; ligne d'infos en
    // bas : il passe dessus ; rien à éviter ailleurs.
    const title = { x: 10, y: 10, w: 150, h: 50 };
    assert.deepEqual(fixedInfoPosition('top_left', 100, 40, 1000, 500, { margin: 20, avoid: [title] }), { x: 20, y: 70 });
    const infos = { x: 400, y: 450, w: 200, h: 30 };
    assert.deepEqual(fixedInfoPosition('bottom', 100, 40, 1000, 500, { margin: 20, avoid: [infos] }), { x: 450, y: 400 });
    assert.deepEqual(fixedInfoPosition('top_right', 100, 40, 1000, 500, { margin: 20, avoid: [title, infos] }), { x: 880, y: 20 });
    // Décalé hors de l'image par un grand cartouche à éviter : borné dans
    // l'image, quitte à recouvrir — jamais hors cadre.
    const big = { x: 400, y: 20, w: 200, h: 470 };
    const clamped = fixedInfoPosition('top', 100, 40, 1000, 500, { margin: 20, avoid: [big] });
    assert.ok(clamped.y + 40 <= 500 - 20 && clamped.y >= 20, `dans le cadre : y = ${clamped.y}`);
    // Trop large pour l'image : au bord, pas de coordonnée négative.
    const wide = fixedInfoPosition('top', 1200, 40, 1000, 500, { margin: 20 });
    assert.equal(wide.x, 20);
    // Échelle : tant que le cartouche tient, l'agrandissement maximal ;
    // réduit pour tenir en largeur sinon, plancher à 0,1.
    assert.equal(fixedInfoScale(800, 200, 1.3), 1.3);
    assert.equal(fixedInfoScale(300, 400, 1.3), 0.75);
    assert.equal(fixedInfoScale(10, 400, 1.3), 0.1);
});

// Faux contexte : largeur = 0,6 em par caractère, appels de texte relevés.
function fakeContext() {
    const calls = [];
    const ctx = {
        font: '10px sans-serif',
        calls,
        measureText(text) {
            const px = Number(/(\d+)px/.exec(this.font)?.[1] || 10);
            return { width: String(text).length * px * 0.6 };
        },
        fillText(text) { calls.push(['fillText', text, this.fillStyle]); },
        strokeText(text) { calls.push(['strokeText', text]); },
    };
    for (const name of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'arcTo', 'arc', 'closePath', 'fill',
        'stroke', 'clip', 'fillRect']) {
        ctx[name] = () => calls.push([name]);
    }
    return ctx;
}

const CONTENT = { name: 'Le trésor du vieux moulin', dt: { d: 2.5, t: 3 }, owner: 'GeoFamille', favorites: 1234 };

test('mesure des quatre designs : une ligne pour l’étiquette, plusieurs sinon', () => {
    const ctx = fakeContext();
    const opts = { size: 12, locale: 'fr', strings: { by: (o) => `par ${o}` } };
    const tag = infoLayout(ctx, CONTENT, { ...opts, design: 'tag' });
    const card = infoLayout(ctx, CONTENT, { ...opts, design: 'card' });
    const banner = infoLayout(ctx, CONTENT, { ...opts, design: 'banner' });
    const text = infoLayout(ctx, CONTENT, { ...opts, design: 'text' });
    assert.equal(tag.rows.length, 1);
    assert.equal(card.rows.length, 3);          // nom, D/T + PF, propriétaire
    assert.equal(banner.rows.length, 2);        // nom, détails
    assert.equal(text.rows.length, 2);
    assert.ok(tag.w > card.w, 'étiquette plus large, sur une ligne');
    assert.ok(tag.h < card.h);
    // Pastilles D et T de la fiche, notes au format de la langue.
    assert.deepEqual(card.rows[1].items.filter((i) => i.kind === 'chip').map((i) => i.text), ['D 2,5', 'T 3']);
    assert.ok(tag.rows[0].items.some((i) => i.text === 'D2,5/T3'));
    assert.ok(tag.rows[0].items.some((i) => i.text === '1 234' || i.text === '1 234'));
    // Sans glyphe d'icône : « par X » ; avec : glyphe + nom.
    assert.ok(banner.rows[1].items.some((i) => i.text === 'par GeoFamille'));
    const glyph = infoLayout(ctx, CONTENT, { ...opts, design: 'banner', glyphs: { user: '' } });
    assert.ok(glyph.rows[1].items.some((i) => i.text === 'GeoFamille'));
    assert.equal(infoLayout(ctx, null, opts), null);
});

test('contenu additionnel au dessin : trouvailles avec les faits, code et type en discret', () => {
    const ctx = fakeContext();
    const full = { ...CONTENT, code: 'GC9ABC', type: 'Multi-cache', finds: 137 };
    const opts = { size: 12, locale: 'fr' };
    const card = infoLayout(ctx, full, { ...opts, design: 'card' });
    // Trouvailles sur la ligne des faits : coche puis nombre, collés.
    const facts = card.rows[1].items;
    const check = facts.findIndex((i) => i.text === '✓');
    assert.ok(check >= 0 && facts[check + 1].text === '137');
    assert.equal(facts[check].glue, true);
    // Code, type et propriétaire sur la ligne discrète, sans séparateur en tête.
    const meta = card.rows[2].items;
    assert.notEqual(meta[0].kind, 'sep');
    assert.deepEqual(meta.filter((i) => i.kind !== 'sep').map((i) => i.text).slice(0, 2), ['GC9ABC', 'Multi-cache']);
    assert.ok(meta.some((i) => i.kind === 'sep'), 'éléments séparés de « · »');
    // Ligne unique (étiquette) : un « · » entre groupes, jamais doublé ni en tête.
    const tag = infoLayout(ctx, full, { ...opts, design: 'tag' });
    const items = tag.rows[0].items;
    assert.notEqual(items[0].kind, 'sep');
    for (let i = 1; i < items.length; i++) {
        assert.ok(!(items[i].kind === 'sep' && items[i - 1].kind === 'sep'), 'pas de double séparateur');
    }
    assert.ok(items.some((i) => i.text === 'GC9ABC'));
    // Contenu réduit au code seul : pas de séparateur orphelin.
    const onlyCode = infoLayout(ctx, { name: null, dt: null, owner: null, favorites: null, code: 'GC1', type: null, finds: null }, { ...opts, design: 'text' });
    assert.notEqual(onlyCode.rows[0].items[0].kind, 'sep');
});

test('nom trop long tronqué, contenu partiel', () => {
    const ctx = fakeContext();
    const long = infoLayout(ctx, { ...CONTENT, name: 'x'.repeat(200) }, { size: 10, design: 'card' });
    assert.ok(long.rows[0].items[0].text.endsWith('…'));
    assert.ok(long.rows[0].items[0].w <= 10 * 1.08 * 22 + 1);
    const only = infoLayout(ctx, { name: null, dt: null, owner: null, favorites: 7 }, { size: 10, design: 'card' });
    assert.equal(only.rows.length, 1);
});

test('couleurs : bandeau à la couleur d’accent, texte contrasté', () => {
    const banner = infoColors('banner', { textColor: '#212529', backgroundColor: '#ffffff', backgroundOpacity: 100, accent: '#1971c2' });
    assert.equal(banner.text, '#ffffff');
    assert.equal(banner.fill, 'rgba(25, 113, 194, 1)');
    const light = infoColors('banner', { textColor: '#212529', backgroundColor: '#ffffff', backgroundOpacity: 100, accent: '#f59f00' });
    assert.equal(light.text, '#212529');
    const text = infoColors('text', { textColor: '#212529', backgroundColor: '#ffffff', backgroundOpacity: 0, accent: '#000000' });
    assert.equal(text.fill, null);
    assert.equal(text.halo, null);
    const card = infoColors('card', { textColor: '#212529', backgroundColor: '#ffffff', backgroundOpacity: 50, accent: '#000000' });
    assert.equal(card.fill, 'rgba(255, 255, 255, 0.5)');
});

test('dessin : textes de la fiche peints, liseré en texte seul', () => {
    const ctx = fakeContext();
    const layout = infoLayout(ctx, CONTENT, { size: 12, locale: 'fr', design: 'text', strings: { by: (o) => `par ${o}` } });
    drawInfo(ctx, layout, 10, 10, { accent: '#1971c2', backgroundOpacity: 80, leader: { fromX: 0, fromY: 0, radius: 4 } });
    const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
    assert.ok(texts.includes('Le trésor du vieux moulin'));
    assert.ok(texts.includes('par GeoFamille'));
    assert.ok(ctx.calls.some((c) => c[0] === 'strokeText'));
});
