// Pseudos flottants de Mes poses : quels logs d'un lot de jours deviennent
// des étiquettes, avec quel texte et quelle priorité (docs/mode-poses.md).
//
// Travaille sur les colonnes de poses_timeline.mjs (`base.ev`, `evFtf`,
// `evRound`) ; l'animation et le dessin des étiquettes vivent dans
// name_labels.mjs. Module pur (aucun DOM) : testé par node --test.

import { foldPseudo } from './poses_names.mjs';

// Priorité d'une étiquette : quand la place manque (plafond d'étiquettes
// visibles), la plus marquante l'emporte et peut écourter une moins
// marquante déjà affichée.
export const NAME_PRIORITY = Object.freeze({
    ftf: 6, milestone: 5, favorite: 4, loyal: 3, find: 2, dnf: 1, note: 0,
});

// Étiquettes « marquantes » (filtre « Seulement les logs marquants », taille
// accentuée).
export const NOTABLE_NAME_KINDS = Object.freeze(['ftf', 'milestone', 'favorite', 'loyal']);

// Borne du texte dessiné : un modèle riche ({pseudo} · {nom} + symboles) peut
// produire une étiquette de soixante caractères et plus, ingérable par
// l'anti-chevauchement et illisible à l'écran. Au-delà, ellipse — appliquée
// avant le « +N » d'un lot fusionné, pour que le compte survive.
export const NAME_TEXT_MAX = 48;

function clipNameText(text) {
    const chars = Array.from(String(text || ''));
    if (chars.length <= NAME_TEXT_MAX) return String(text || '');
    return `${chars.slice(0, NAME_TEXT_MAX - 1).join('').trimEnd()}…`;
}

// Rang de chaque trouvaille reçue : n-ième de sa cache (`cacheNth`) et
// n-ième du visiteur sur l'ensemble des caches posées (`authorNth`, toutes
// caches de la base, pas seulement la sélection : la fidélité d'un visiteur
// ne dépend pas d'un filtre). 0 pour un log qui n'est pas une trouvaille.
// `ev` est trié par jour : les rangs suivent la chronologie.
export function buildNameStats(base) {
    const n = base?.ev?.cache?.length || 0;
    const cacheNth = new Int32Array(n);
    const authorNth = new Int32Array(n);
    const findCode = base?.kindCode?.find;
    const perCache = new Int32Array(base?.count || 0);
    const perAuthor = new Int32Array((base?.authors?.length || 0) + 1);
    for (let j = 0; j < n; j++) {
        if (base.ev.kind[j] !== findCode) continue;
        cacheNth[j] = ++perCache[base.ev.cache[j]];
        const a = base.ev.author[j];
        if (a >= 0) authorNth[j] = ++perAuthor[a];
    }
    return { cacheNth, authorNth };
}

// Type d'étiquette d'un log : le plus marquant qui s'applique, null pour un
// log sans étiquette possible (publication, maintenance…).
export function nameKindOf(base, stats, j, loyalMin) {
    const logKind = base.logKinds[base.ev.kind[j]];
    if (logKind === 'find') {
        if (base.evFtf?.[j]) return 'ftf';
        if (base.evRound?.[j]) return 'milestone';
        if (base.ev.fav[j]) return 'favorite';
        if (stats && stats.authorNth[j] >= loyalMin) return 'loyal';
        return 'find';
    }
    if (logKind === 'dnf') return 'dnf';
    if (logKind === 'note') return 'note';
    return null;
}

// Famille de log (case « Quels logs ») d'un type d'étiquette.
export function nameFamilyOf(kind) {
    if (kind === 'dnf' || kind === 'note') return kind;
    return 'find';
}

// Initiales d'un pseudo : première lettre de chaque mot (espaces, tirets,
// soulignés, points), trois au plus — « Jean-Pierre_42 » → « J.P.4. ».
export function initialsOf(name) {
    const words = String(name || '').split(/[\s._-]+/).filter(Boolean).slice(0, 3);
    return words.map((w) => `${Array.from(w)[0].toUpperCase()}.`).join('');
}

// Pseudo tel qu'affiché selon la préférence de confidentialité, null s'il
// est exclu (ou inconnu).
export function displayPseudo(name, privacy, hiddenLabel = '…', excluded = null) {
    const raw = String(name || '').trim();
    if (!raw) return null;
    const set = excluded || excludedSet(privacy);
    if (set.has(foldPseudo(raw))) return null;
    const mode = privacy?.mode;
    if (mode === 'hidden') return hiddenLabel;
    if (mode === 'initials') return initialsOf(raw) || hiddenLabel;
    return raw;
}

// Mémoïsé sur l'identité de l'objet privacy (currentNamesPrivacy le
// memoïse aussi : même objet tant que la préférence n'a pas changé).
const excludedSetMemo = new WeakMap();
export function excludedSet(privacy) {
    if (privacy && typeof privacy === 'object') {
        let set = excludedSetMemo.get(privacy);
        if (!set) excludedSetMemo.set(privacy, (set = new Set((privacy.exclude || []).map(foldPseudo))));
        return set;
    }
    return new Set();
}

// Modèle de l'étiquette : {pseudo}, {code}, {nom}, {n} (rang de la
// trouvaille sur la cache), {visites} (rang du visiteur sur vos caches).
// Une balise inconnue reste telle quelle ; un rang absent (DNF, note) vaut
// une chaîne vide. Espaces en trop resserrés.
export function formatNameLabel(template, values) {
    const text = String(template || '{pseudo}').replace(/\{(\w+)\}/g, (all, tag) => {
        if (!Object.prototype.hasOwnProperty.call(values, tag)) return all;
        const v = values[tag];
        return v === null || v === undefined || v === 0 ? '' : String(v);
    });
    return text.replace(/\s+/g, ' ').trim();
}

// Petits symboles autour du pseudo (case « Symboles ») : couronne de la
// première trouvaille, palier, cœur du favori, étoile du visiteur fidèle,
// croix du DNF, crayon de la note.
export function nameBadges(kind, favorite) {
    const prefix = { ftf: '♛ ', milestone: '✦ ', dnf: '✗ ', note: '✎ ' }[kind] || '';
    let suffix = '';
    if (favorite) suffix = ' ♥';
    else if (kind === 'loyal') suffix = ' ★';
    return { prefix, suffix };
}

// Hachage entier déterministe (rendu identique d'un enregistrement à
// l'autre : directions, inclinaisons, éparpillement).
export function hash32(value) {
    let h = (Number(value) | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}

export function hashString(text) {
    let h = 2166136261;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
}

// Log j retenu pour une étiquette avec les réglages `opts` : son type, sa
// cache et son pseudo affichable ; null s'il n'en recevrait pas. Règle
// commune à nameCandidates (lecture) et nameDayCounts (densité).
function acceptedNameLog(base, s, j, opts, { privacy, hiddenLabel, excluded, isHidden }) {
    // Logs ramenés au jour d'apparition : jamais dessinés (cf. flashs).
    if (base.ev.folded[j]) return null;
    const kind = nameKindOf(base, s, j, opts.loyal_min);
    if (!kind || !opts.kinds[nameFamilyOf(kind)]) return null;
    const notable = NOTABLE_NAME_KINDS.includes(kind);
    if (opts.only_notable && !notable) return null;
    const i = base.ev.cache[j];
    if (isHidden && isHidden(i, base.ev.day[j])) return null;
    const author = base.ev.author[j];
    const realName = author >= 0 ? base.authors[author] : '';
    const pseudo = displayPseudo(realName, privacy, hiddenLabel, excluded);
    if (pseudo === null) return null;
    return { kind, notable, i, author, realName, pseudo };
}

// Étiquettes qui naîtraient chaque jour avec les réglages `opts` (familles,
// logs marquants, exclusions, archivées masquées ; une par cache et par
// jour en mode « regroupés ») → [[jour absolu, nombre]] triés, jours vides
// omis. Sert à l'estimation de densité (names_density.mjs) ; ignore
// `enabled` et le plafond, qu'elle sert justement à juger.
export function nameDayCounts(base, timeline, opts, {
    privacy = null, stats = null, hiddenLabel = '…', isHidden = null,
} = {}) {
    const out = [];
    if (!base || !timeline || !opts || timeline.count === 0) return out;
    const s = stats || buildNameStats(base);
    const filter = { privacy, hiddenLabel, excluded: excludedSet(privacy), isHidden };
    const merge = opts.grouping === 'merge';
    const seen = new Set();
    for (let d = 0; d < timeline.span; d++) {
        let n = 0;
        seen.clear();
        for (let e = timeline.evStart[d]; e < timeline.evStart[d + 1]; e++) {
            const log = acceptedNameLog(base, s, timeline.evOrder[e], opts, filter);
            if (!log) continue;
            if (merge) {
                const k = timeline.featureOf[log.i];
                if (seen.has(k)) continue;
                seen.add(k);
            }
            n++;
        }
        if (n > 0) out.push([base.originDay + timeline.firstDay + d, n]);
    }
    return out;
}

// Étiquettes candidates pour les jours fromDay..toDay (index de la base).
//   opts        bloc normalisé (poses_names.mjs)
//   privacy     préférence normalisée ({ mode, exclude })
//   stats       buildNameStats(base)
//   hiddenLabel texte d'un pseudo masqué (traduit par l'appelant)
//   isHidden(i, day)  la cache n'est pas affichée ce jour-là (archivée
//               masquée) : pas d'étiquette
// → [{ k, j, kind, priority, notable, text, pseudo, finderKey, favorite,
//      code, seed, group, groupSize, extra }], triées par priorité
// décroissante puis par graine, coupées au plafond `max_visible` : le reste
// ne pourrait jamais s'afficher.
export function nameCandidates(base, timeline, fromDay, toDay, opts, {
    privacy = null, stats = null, hiddenLabel = '…', isHidden = null,
} = {}) {
    if (!base || !timeline || !opts?.enabled || timeline.count === 0) return [];
    const a = Math.max(0, fromDay - timeline.firstDay);
    const b = Math.min(timeline.span - 1, toDay - timeline.firstDay);
    if (b < a) return [];
    const excluded = excludedSet(privacy);
    const s = stats || buildNameStats(base);
    const byCache = new Map();
    const filter = { privacy, hiddenLabel, excluded, isHidden };
    for (let e = timeline.evStart[a]; e < timeline.evStart[b + 1]; e++) {
        const j = timeline.evOrder[e];
        const log = acceptedNameLog(base, s, j, opts, filter);
        if (!log) continue;
        const { kind, notable, i, author, realName, pseudo } = log;
        const k = timeline.featureOf[i];
        let list = byCache.get(k);
        if (!list) byCache.set(k, (list = []));
        list.push({
            k, j, i, kind, notable, pseudo,
            priority: NAME_PRIORITY[kind],
            // Couleur « par visiteur » : stable pour un même pseudo, même
            // abrégé (le pseudo réel n'est pas exposé quand il est masqué).
            finderKey: privacy?.mode === 'show' ? foldPseudo(realName) : `#${author}`,
            favorite: base.ev.fav[j] === 1,
            seed: hash32(j),
        });
    }

    const out = [];
    for (const list of byCache.values()) {
        // Plusieurs logs sur une cache dans le lot : une étiquette « Pseudo
        // +2 » (la plus marquante, à priorité égale la première), ou une
        // étiquette par log, décalées d'un `stagger_ms` (`group`).
        if (opts.grouping === 'merge') {
            let best = list[0];
            for (const c of list) if (c.priority > best.priority) best = c;
            out.push(finishCandidate(base, s, best, opts, 0, 1, list.length - 1));
        } else {
            list.forEach((c, idx) => out.push(finishCandidate(base, s, c, opts, idx, list.length, 0)));
        }
    }
    out.sort((x, y) => (y.priority - x.priority) || (x.seed - y.seed));
    if (out.length > opts.max_visible) out.length = opts.max_visible;
    return out;
}

function finishCandidate(base, stats, c, opts, group, groupSize, extra) {
    const values = {
        pseudo: c.pseudo,
        code: base.code[c.i] || '',
        nom: base.name?.[c.i] || '',
        n: stats.cacheNth[c.j] || null,
        visites: stats.authorNth[c.j] || null,
    };
    let text = formatNameLabel(opts.template, values) || c.pseudo;
    if (opts.badges) {
        const { prefix, suffix } = nameBadges(c.kind, c.favorite);
        text = `${prefix}${text}${suffix}`;
    }
    text = clipNameText(text);
    if (extra > 0) text = `${text} +${extra}`;
    return {
        k: c.k,
        j: c.j,
        kind: c.kind,
        priority: c.priority,
        notable: c.notable,
        text,
        pseudo: c.pseudo,
        finderKey: c.finderKey,
        favorite: c.favorite,
        code: values.code,
        cacheType: base.types?.[base.type?.[c.i]] || '',
        seed: c.seed,
        // Graine de la cache : les étiquettes « radial » d'un même lot se
        // répartissent autour d'un angle propre à la cache.
        cacheSeed: hash32(c.i + 0x5bd1e995),
        group,
        groupSize,
        extra,
    };
}

// Pseudos des visiteurs : auteurs d'au moins une trouvaille, un DNF ou une
// note reçus (ni le relecteur, ni le poseur, dont les logs sont d'autres
// types). Ordre de première apparition. Mémoïsé sur l'identité de `base` :
// la liste ne dépend que des données (parcourue à chaque vague d'aperçu).
const visitorNamesMemo = new WeakMap();
export function visitorNames(base) {
    if (!base || typeof base !== 'object') return [];
    let out = visitorNamesMemo.get(base);
    if (!out) visitorNamesMemo.set(base, (out = computeVisitorNames(base)));
    return out;
}

function computeVisitorNames(base) {
    const out = [];
    const seen = new Set();
    const n = base?.ev?.cache?.length || 0;
    for (let j = 0; j < n; j++) {
        const kind = base.logKinds[base.ev.kind[j]];
        if (kind !== 'find' && kind !== 'dnf' && kind !== 'note') continue;
        const a = base.ev.author[j];
        if (a < 0 || seen.has(a) || !base.authors[a]) continue;
        seen.add(a);
        out.push(base.authors[a]);
    }
    return out;
}

// Échantillon pour l'aperçu (onglet Style, carte au repos) : des pseudos
// réels de la base, sur des types variés, pour juger couleurs et symboles.
// `count` étiquettes, une par cache donnée.
export function namePreviewCandidates(base, ks, opts, { privacy = null, hiddenLabel = '…', round = 0 } = {}) {
    const kinds = ['ftf', 'find', 'favorite', 'loyal', 'milestone', 'find', 'dnf', 'note'];
    // Seules les familles cochées sont représentées — sinon l'aperçu montre
    // des étiquettes que la lecture ne produirait jamais ; si aucune n'est
    // cochée, on garde l'échantillon complet (l'aperçu sert au réglage).
    const pool = kinds.filter((kind) => opts.kinds?.[nameFamilyOf(kind)]);
    const cycle = pool.length ? pool : kinds;
    const authors = visitorNames(base);
    const excluded = excludedSet(privacy);
    const out = [];
    let pick = hash32(round + 17) % Math.max(1, authors.length);
    for (let idx = 0; idx < ks.length; idx++) {
        const { k, i } = ks[idx];
        let pseudo = null;
        let realName = '';
        for (let tries = 0; tries < 12 && pseudo === null; tries++) {
            realName = authors.length ? authors[(pick++) % authors.length] : `Geocacheur${idx + 1}`;
            pseudo = displayPseudo(realName, privacy, hiddenLabel, excluded);
        }
        if (pseudo === null) continue;
        const kind = cycle[(idx + round) % cycle.length];
        const favorite = kind === 'favorite';
        const values = { pseudo, code: base?.code?.[i] || '', nom: base?.name?.[i] || '', n: idx + 1, visites: idx + 2 };
        let text = formatNameLabel(opts.template, values) || pseudo;
        if (opts.badges) {
            const { prefix, suffix } = nameBadges(kind, favorite);
            text = `${prefix}${text}${suffix}`;
        }
        text = clipNameText(text);
        // Même clé de couleur « par visiteur » qu'en lecture : indice de
        // l'auteur dans la base (sinon deux visiteurs aux mêmes initiales —
        // ou tous en mode « hidden » — auraient la même teinte ; repli
        // distinct pour les pseudos factices, hors base).
        const authorIndex = base?.authors?.indexOf(realName) ?? -1;
        out.push({
            k, j: -1, kind, priority: NAME_PRIORITY[kind], notable: NOTABLE_NAME_KINDS.includes(kind),
            text, pseudo, finderKey: privacy?.mode === 'show' ? foldPseudo(realName) : (authorIndex >= 0 ? `#${authorIndex}` : `#f${idx}`),
            favorite, code: values.code, cacheType: base?.types?.[base?.type?.[i]] || '',
            seed: hash32(round * 131 + idx), cacheSeed: hash32(i + 0x5bd1e995),
            group: 0, groupSize: 1, extra: 0,
        });
    }
    return out;
}
