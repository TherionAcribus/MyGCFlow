// Vignettes animées des styles de pseudos (onglet Style › Pseudos de Mes
// poses) : chaque carte de style dessine, avec le vrai moteur
// (name_labels.mjs), un pseudo fictif dans ce style — une image figée au
// repos, la boucle de l'animation au survol.
//
// Une vignette fait ~80 × 56 px quand un trajet en fait plusieurs centaines :
// le mouvement est réduit d'un facteur `k` pour tenir dans le cadre, le texte
// garde une taille lisible. Le moteur dessine positions ET texte à l'échelle
// `ratio` : on lui passe ratio = k × dpr et un texte grossi de 1/k, qui
// ressort donc à sa taille de vignette.
//
// Module pur (aucun DOM) : testé par node --test.

import { nameLabelPose } from './name_labels.mjs';

// Pseudos fictifs : jamais de vrai visiteur dans une vignette.
export const THUMB_PSEUDOS = Object.freeze(['Alice', 'Bob', 'Chloé']);
// Couleurs « par événement » parcourues d'une vague à l'autre.
const THUMB_KINDS = Object.freeze(['find', 'ftf', 'favorite']);
// Taille du texte dans la vignette : réduite, bornée pour rester lisible.
const TEXT_SCALE = 0.78;
const TEXT_MIN = 9;
const TEXT_MAX = 13;
// Pause entre deux vagues de la boucle (ms).
export const THUMB_WAVE_GAP_MS = 450;

// Candidats d'une vague (forme de spawnNameLabels) : un visiteur, trois quand
// le style donne une étiquette par visiteur. `wave` fait varier pseudos,
// directions au hasard et couleurs d'une vague à l'autre.
export function thumbCandidates(opts, wave = 0) {
    const count = opts?.grouping === 'separate' ? THUMB_PSEUDOS.length : 1;
    const out = [];
    for (let group = 0; group < count; group++) {
        const pseudo = THUMB_PSEUDOS[(wave + group) % THUMB_PSEUDOS.length];
        out.push({
            text: pseudo,
            pseudo,
            finderKey: pseudo,
            kind: THUMB_KINDS[(wave + group) % THUMB_KINDS.length],
            priority: 1,
            notable: false,
            cacheType: null,
            code: '',
            seed: 7919 * (wave * 3 + group + 1),
            cacheSeed: 104729 * (wave + 1),
            group,
            groupSize: count,
        });
    }
    return out;
}

// Durée d'une vague : vie de la dernière étiquette (décalées si séparées).
export function thumbWaveMs(opts) {
    const count = opts?.grouping === 'separate' ? THUMB_PSEUDOS.length : 1;
    return opts.duration_ms + (count - 1) * opts.stagger_ms;
}

const estimateWidth = (text, size) => String(text).length * size * 0.62;

// Cadrage d'une vignette de `width` × `height` px CSS pour le style `opts`.
//   measure(text, sizePx) → largeur du texte (px CSS), estimation sinon
// → { k, anchor: [x, y] px CSS, textSize, opts } : `opts` est à passer au
//   moteur avec ratio = k × dpr (texte, contour et halo grossis de 1/k).
export function thumbLayout(opts, { width, height, pad = 4, measure = null, waves = 3 } = {}) {
    const textSize = Math.min(TEXT_MAX, Math.max(TEXT_MIN, opts.size * TEXT_SCALE));
    const textScale = textSize / Math.max(1, opts.size);
    // Étendue du trajet (unités du réglage) sur quelques vagues : directions
    // au hasard et éventails différents d'une vague à l'autre.
    let minX = 0; let maxX = 0; let minY = 0; let maxY = 0;
    let widest = 0;
    const noKill = { killAt: null, killDur: 0, timeScale: 1, start: 0, duration: opts.duration_ms, nudge: [0, 0] };
    for (let wave = 0; wave < waves; wave++) {
        for (const c of thumbCandidates(opts, wave)) {
            const label = { ...c, ...noKill };
            for (let i = 0; i <= 24; i++) {
                const pose = nameLabelPose(label, (opts.duration_ms * i) / 24.0001, opts);
                if (pose.pending || pose.done || pose.alpha < 0.05) continue;
                minX = Math.min(minX, pose.dx); maxX = Math.max(maxX, pose.dx);
                minY = Math.min(minY, pose.dy); maxY = Math.max(maxY, pose.dy);
            }
            const text = opts.uppercase ? c.text.toLocaleUpperCase() : c.text;
            widest = Math.max(widest, measure ? measure(text, textSize) : estimateWidth(text, textSize));
        }
    }
    const hasBg = opts.background !== 'none' && opts.background_opacity > 0;
    const textW = widest + (hasBg ? textSize * 0.9 : 0);
    const textH = textSize * (hasBg ? 1.6 : 1.15);
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const room = (avail, span) => (span > 1e-6 ? Math.max(0, avail) / span : Infinity);
    // Le texte peut déborder un peu sur les côtés : seul son centre doit
    // rester dans le cadre en largeur, tout le texte en hauteur.
    let k = Math.min(1, room(width - 2 * pad - textW * 0.5, spanX), room(height - 2 * pad - textH, spanY));
    k = Math.max(0.05, Number.isFinite(k) ? k : 1);
    const anchor = [width / 2 - (k * (minX + maxX)) / 2, height / 2 - (k * (minY + maxY)) / 2];
    const scaled = {
        ...opts,
        size: textSize / k,
        outline_width: (opts.outline_width * textScale) / k,
        glow: (opts.glow * textScale) / k,
    };
    return { k, anchor, textSize, opts: scaled };
}
