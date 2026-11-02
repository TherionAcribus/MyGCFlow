// Étiquettes flottantes (pseudos des visiteurs de Mes poses) : file des
// étiquettes actives, mouvement, placement et dessin sur le canvas d'une
// couche OpenLayers (docs/mode-poses.md, « Pseudos des visiteurs »).
//
// Le temps est celui de l'horloge des points de mapgl.js (sampleAppearClock) :
// temps vidéo en capture image par image, temps actif en MediaRecorder,
// figé pendant une pause. Une étiquette garde son départ et sa durée ; son
// apparence (couleurs, police, fond…) est relue à chaque image, pour que
// l'aperçu suive les réglages en direct.
//
// Module pur : le canvas et la conversion carte → pixels sont fournis par
// l'appelant (testé par node --test avec un faux contexte).

import { hash32, hashString } from './poses_names_model.mjs';

// La première police de chaque pile est servie en local (style.css,
// static/fonts) : même rendu vidéo sur toutes les machines. Les replis
// système ne servent qu'en cas de problème de chargement.
export const FONT_STACKS = Object.freeze({
    sans: '"Inter", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif',
    serif: '"Merriweather", Georgia, "Times New Roman", "DejaVu Serif", serif',
    mono: '"JetBrains Mono", "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Courier New", monospace',
    rounded: '"Nunito", "Arial Rounded MT Bold", "Varela Round", "Segoe UI", sans-serif',
    condensed: '"Oswald", "Arial Narrow", "Roboto Condensed", "Liberation Sans Narrow", sans-serif',
    handwritten: '"Caveat", "Segoe Print", "Comic Sans MS", "Bradley Hand", "Chalkboard SE", cursive',
});

const EVICT_MS = 250;
const TAU = Math.PI * 2;

// Découpage en graphemes (entrée « lettre à lettre », sortie « lettres
// éparpillées ») : un emoji composé ou une lettre + diacritique combinant
// reste un seul caractère. Repli sur les points de code sans Segmenter.
const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function graphemes(text) {
    const s = String(text ?? '');
    if (!graphemeSegmenter) return Array.from(s);
    return [...graphemeSegmenter.segment(s)].map((seg) => seg.segment);
}

export function createNameLabels() {
    return { labels: [], spawned: 0, dropped: 0, evicted: 0, history: [] };
}

export function clearNameLabels(state) {
    state.labels.length = 0;
}

// --- Mouvement ---------------------------------------------------------------

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const easeInQuad = (x) => x * x;
function easeOutBack(x) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}
function easeOutElastic(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * (TAU / 3)) + 1;
}
function easeOutBounce(x) {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
    return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

export function easeName(easing, x) {
    const t = clamp01(x);
    if (easing === 'linear') return t;
    if (easing === 'accelerate') return easeInQuad(t);
    if (easing === 'elastic') return easeOutElastic(t);
    return easeOutCubic(t);
}

// Graine → [0, 1[ et → signe ±1.
const unit = (seed, salt = 0) => hash32(seed + salt * 0x27d4eb2d) / 4294967296;
const signOf = (seed, salt = 0) => (unit(seed, salt) < 0.5 ? -1 : 1);

// Angle de départ (radians, 0 = vers la droite, π/2 = vers le bas).
export function nameDirectionAngle(label, direction) {
    switch (direction) {
    case 'down': return Math.PI / 2;
    case 'left': return Math.PI;
    case 'right': return 0;
    case 'radial': {
        const size = Math.max(1, label.groupSize || 1);
        return unit(label.cacheSeed ?? label.seed, 1) * TAU + (label.group || 0) * (TAU / size);
    }
    case 'random': return unit(label.seed, 2) * TAU;
    default: return -Math.PI / 2;
    }
}

// Parts de la vie de l'étiquette consacrées à l'entrée et à la sortie : en
// millisecondes à peu près fixes (une entrée de 350 ms reste vive sur une
// étiquette de 6 s), bornées en proportion.
export function nameShares(label) {
    const ms = label.duration / Math.max(1e-6, label.timeScale || 1);
    return {
        inShare: Math.min(0.35, Math.max(0.08, 380 / ms)),
        outShare: Math.min(0.4, Math.max(0.12, 650 / ms)),
    };
}

// Pose d'une étiquette à l'instant `now` :
// { pending, done, dx, dy (px CSS depuis le point), alpha, scale, rotation,
//   reveal (part du texte écrite, typewriter), scatter (0..1) }.
export function nameLabelPose(label, now, opts) {
    const pose = { pending: false, done: false, dx: 0, dy: 0, alpha: 1, scale: 1, rotation: 0, reveal: 1, scatter: 0 };
    if (now < label.start) {
        pose.pending = true;
        return pose;
    }
    const u = (now - label.start) / label.duration;
    if (u >= 1 || (label.killAt !== null && label.killAt !== undefined && now >= label.killAt + label.killDur)) {
        pose.done = true;
        return pose;
    }
    const { inShare, outShare } = nameShares(label);
    const ts = label.timeScale || 1;
    const tMs = (now - label.start) / ts;

    // Trajet.
    const angle0 = nameDirectionAngle(label, opts.direction);
    const travel = opts.path === 'toward' ? clamp01(u / (1 - outShare)) : opts.path === 'away' ? u : 0;
    const p = easeName(opts.easing, travel);
    const dist = opts.path === 'still' ? 0 : opts.distance;
    const r = opts.path === 'toward' ? dist * (1 - p) : dist * p;
    const turn = opts.trajectory === 'spiral' ? signOf(label.seed, 3) * (opts.path === 'toward' ? 1 - p : p) * Math.PI * 1.2 : 0;
    const angle = angle0 + turn;
    let dx = r * Math.cos(angle);
    let dy = r * Math.sin(angle);
    const px = -Math.sin(angle0);
    const py = Math.cos(angle0);
    if (opts.trajectory === 'arc' && dist > 0) {
        const bulge = signOf(label.seed, 4) * dist * 0.3 * Math.sin(Math.PI * p);
        dx += px * bulge;
        dy += py * bulge;
    } else if (opts.trajectory === 'wave' && dist > 0) {
        const amp = Math.min(22, Math.max(4, dist * 0.12 + 4));
        const wave = amp * Math.sin(p * 4 * Math.PI + unit(label.seed, 5) * TAU);
        dx += px * wave;
        dy += py * wave;
    }
    let rotation = signOf(label.seed, 6) * unit(label.seed, 7) * opts.tilt * Math.PI / 180;
    if (opts.wobble > 0) {
        const w = opts.wobble / 100;
        const phase = unit(label.seed, 8) * TAU;
        dx += w * 6 * Math.sin(TAU * tMs / 1100 + phase);
        rotation += w * 0.12 * Math.sin(TAU * tMs / 1300 + phase);
    }
    dy += opts.offset_y;

    // Entrée.
    let alpha = 1;
    let scale = 1;
    if (u < inShare) {
        const a = u / inShare;
        switch (opts.entrance) {
        case 'fade': alpha *= a; break;
        case 'pop': scale *= Math.max(0, easeOutBack(a)); alpha *= Math.min(1, a * 2); break;
        case 'zoom': scale *= 2.2 - 1.2 * easeOutCubic(a); alpha *= a; break;
        case 'typewriter': pose.reveal = a; break;
        case 'drop': dy -= 36 * (1 - easeOutBounce(a)); alpha *= Math.min(1, a * 3); break;
        default: break;
        }
    }
    // Sortie.
    if (u > 1 - outShare) {
        const b = clamp01((u - (1 - outShare)) / outShare);
        switch (opts.exit) {
        case 'fade': alpha *= 1 - b; break;
        case 'shrink': scale *= 1 - b; alpha *= 1 - b * 0.3; break;
        case 'grow': scale *= 1 + 0.9 * b; alpha *= 1 - b; break;
        case 'scatter': pose.scatter = b; alpha *= 1 - b; break;
        case 'blink': alpha *= (Math.floor(b * 8) % 2 === 0 ? 1 : 0.15) * (1 - b * 0.5); break;
        default: break;
        }
    }
    // Étiquette écourtée pour céder la place à une plus marquante.
    if (label.killAt !== null && label.killAt !== undefined && now >= label.killAt) {
        alpha *= 1 - clamp01((now - label.killAt) / label.killDur);
    }
    pose.dx = dx;
    pose.dy = dy;
    pose.alpha = alpha;
    pose.scale = scale;
    pose.rotation = rotation;
    return pose;
}

// --- Apparence ----------------------------------------------------------------

export function nameFont(opts, emphasis = 1, ratio = 1) {
    const size = Math.max(1, opts.size * emphasis * ratio);
    return `${opts.italic ? 'italic ' : ''}${opts.bold ? '700' : '400'} ${size.toFixed(2)}px ${FONT_STACKS[opts.font] || FONT_STACKS.sans}`;
}

export function nameText(label, opts) {
    return opts.uppercase ? label.text.toLocaleUpperCase() : label.text;
}

const emphasisOf = (label, opts) => (label.notable ? opts.emphasis : 1);

// Couleur d'un pseudo, stable d'une image à l'autre : teinte tirée du
// pseudo (mode « par visiteur »), saturée et claire pour rester lisible.
export function finderColor(key) {
    const hue = hashString(key) % 360;
    return hslToHex(hue, 72, 68);
}

function hslToHex(h, s, l) {
    const sat = s / 100;
    const lig = l / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = sat * Math.min(lig, 1 - lig);
    const f = (n) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const hex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

export function nameLabelColor(label, opts, cacheTypeColor = null) {
    switch (opts.color_mode) {
    case 'event': return opts.kind_colors?.[label.kind] || opts.color;
    case 'finder': return finderColor(label.finderKey || label.pseudo || label.text);
    case 'cache_type': return (cacheTypeColor && cacheTypeColor(label.cacheType)) || opts.color;
    default: return opts.color;
    }
}

function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const v = m ? parseInt(m[1], 16) : 0;
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

// --- File des étiquettes --------------------------------------------------------

// Boîte (px CSS, centre et demi-tailles) d'une étiquette posée en `anchorPx`
// avec la pose `pose`.
function labelBox(anchorPx, label, pose, size) {
    const s = Math.max(0.01, pose.scale);
    return {
        x: anchorPx[0] + pose.dx + label.nudge[0],
        y: anchorPx[1] + pose.dy + label.nudge[1],
        hw: (size.w * s) / 2,
        hh: (size.h * s) / 2,
    };
}

function overlapArea(a, b) {
    const w = Math.min(a.x + a.hw, b.x + b.hw) - Math.max(a.x - a.hw, b.x - b.hw);
    const h = Math.min(a.y + a.hh, b.y + b.hh) - Math.max(a.y - a.hh, b.y - b.hh);
    return w > 0 && h > 0 ? w * h : 0;
}

// Ajoute les étiquettes d'un lot.
//   candidates  nameCandidates / namePreviewCandidates, triées par priorité
//   at          horloge des points au moment du lot
//   timeScale   ralentissement MediaRecorder (durées étirées comme la vidéo)
//   anchorOf(c) coordonnées carte du point de l'étiquette (null : ignorée)
//   pixelOf(coord) → [x, y] px CSS (placement anti-chevauchement), null hors écran
//   measure(text, font) → largeur en px CSS
// → nombre d'étiquettes ajoutées.
export function spawnNameLabels(state, candidates, {
    at, opts, timeScale = 1, anchorOf, pixelOf = null, measure = null,
} = {}) {
    if (!opts?.enabled && !state.previewing) return 0;
    pruneNameLabels(state, at);
    const ts = Math.max(1, Number(timeScale) || 1);
    let live = state.labels.filter((l) => l.killAt === null).length;
    let added = 0;
    const separate = opts.grouping === 'separate';
    for (const c of candidates) {
        const coord = anchorOf(c);
        if (!coord) continue;
        if (live >= opts.max_visible) {
            // Plus de place : la plus marquante écourte la moins marquante
            // encore entière (la plus ancienne à priorité égale).
            let victim = null;
            for (const l of state.labels) {
                if (l.killAt !== null || l.priority >= c.priority) continue;
                if (!victim || l.priority < victim.priority || (l.priority === victim.priority && l.start < victim.start)) victim = l;
            }
            if (!victim) {
                state.dropped++;
                continue;
            }
            victim.killAt = at;
            victim.killDur = EVICT_MS * ts;
            state.evicted++;
            live--;
        }
        const label = {
            coord,
            text: c.text,
            pseudo: c.pseudo,
            kind: c.kind,
            priority: c.priority,
            notable: c.notable,
            finderKey: c.finderKey,
            cacheType: c.cacheType,
            code: c.code,
            seed: c.seed,
            cacheSeed: c.cacheSeed,
            group: c.group,
            groupSize: c.groupSize,
            start: at + (separate ? c.group * opts.stagger_ms * ts : 0),
            duration: opts.duration_ms * ts,
            timeScale: ts,
            killAt: null,
            killDur: 0,
            nudge: [0, 0],
            metrics: null,
        };
        if (opts.avoid_overlap && pixelOf && measure) placeLabel(state, label, opts, at, pixelOf, measure);
        state.labels.push(label);
        live++;
        added++;
        state.spawned++;
        state.history.push({ text: c.text, kind: c.kind, code: c.code, at });
        if (state.history.length > 200) state.history.splice(0, state.history.length - 200);
    }
    return added;
}

// Décale verticalement une étiquette qui chevaucherait une étiquette à
// l'écran. Comparées à trois instants de la vie de la nouvelle (début,
// milieu, fin), là où l'autre est encore visible : une étiquette qui
// s'éteint ne bloque pas la place, une qui attend son tour (décalage) si.
const PLACE_SAMPLES = [0.15, 0.45, 0.75];
const PLACE_SHIFTS = [0, -1, 1, -2, 2, -3, 3];

function placeLabel(state, label, opts, at, pixelOf, measure) {
    const anchor = pixelOf(label.coord);
    if (!anchor) return;
    const em = emphasisOf(label, opts);
    const size = { w: measure(nameText(label, opts), nameFont(opts, em)) + opts.size * em * 0.9, h: opts.size * em * 1.5 };
    label.metricsCss = size;
    const others = [];
    for (const l of state.labels) {
        if (l.killAt !== null || !l.metricsCss) continue;
        const pa = pixelOf(l.coord);
        if (pa) others.push({ l, pa });
    }
    if (others.length === 0) return;
    // Boîtes des autres à chaque instant (indépendantes du décalage testé).
    const samples = PLACE_SAMPLES.map((f) => {
        const t = label.start + label.duration * f;
        const boxes = [];
        for (const { l, pa } of others) {
            const pose = nameLabelPose(l, t, opts);
            if (pose.pending || pose.done || pose.alpha < 0.05) continue;
            boxes.push(labelBox(pa, l, pose, l.metricsCss));
        }
        return { pose: nameLabelPose(label, t, opts), boxes };
    });
    const step = size.h * 1.05;
    let best = null;
    for (const shift of PLACE_SHIFTS) {
        label.nudge = [0, shift * step];
        let area = 0;
        for (const { pose, boxes } of samples) {
            const box = labelBox(anchor, label, pose, size);
            for (const o of boxes) area += overlapArea(box, o);
        }
        if (area === 0) return;
        if (!best || area < best.area) best = { area, nudge: label.nudge };
    }
    label.nudge = best.nudge;
}

// Retire les étiquettes terminées.
export function pruneNameLabels(state, now) {
    let kept = 0;
    for (const l of state.labels) {
        const ended = now >= l.start + l.duration
            || (l.killAt !== null && now >= l.killAt + l.killDur);
        if (!ended) state.labels[kept++] = l;
    }
    state.labels.length = kept;
}

// --- Dessin ---------------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
}

function labelMetrics(ctx, label, text, font) {
    const m = label.metrics;
    if (m && m.font === font && m.text === text) return m;
    ctx.font = font;
    const chars = graphemes(text);
    const charX = new Array(chars.length);
    let prefix = '';
    for (let i = 0; i < chars.length; i++) {
        charX[i] = ctx.measureText(prefix).width;
        prefix += chars[i];
    }
    label.metrics = { font, text, chars, charX, width: ctx.measureText(text).width };
    return label.metrics;
}

// Dessine les étiquettes actives (et retire les terminées).
//   ctx       contexte 2D du canvas de la couche
//   toPixel(coord) → [x, y] px du canvas
//   ratio     pixels du canvas par px CSS
//   cacheTypeColor(type) couleur GC d'un type (mode « type de cache »)
// → nombre d'étiquettes dessinées.
export function drawNameLabels(ctx, state, { now, opts, ratio = 1, toPixel, cacheTypeColor = null }) {
    pruneNameLabels(state, now);
    let drawn = 0;
    for (const label of state.labels) {
        const pose = nameLabelPose(label, now, opts);
        if (pose.pending || pose.done) continue;
        const alpha = pose.alpha * (opts.opacity / 100);
        if (alpha <= 0.004 || pose.scale <= 0.01) continue;
        const anchor = toPixel(label.coord);
        if (!anchor) continue;
        drawLabel(ctx, label, pose, alpha, anchor, opts, ratio, cacheTypeColor);
        drawn++;
    }
    return drawn;
}

function drawLabel(ctx, label, pose, alpha, anchor, opts, ratio, cacheTypeColor) {
    const em = emphasisOf(label, opts);
    const font = nameFont(opts, em, ratio);
    const text = nameText(label, opts);
    const color = nameLabelColor(label, opts, cacheTypeColor);
    const m = labelMetrics(ctx, label, text, font);
    const fontPx = opts.size * em * ratio;
    const x = anchor[0] + (pose.dx + label.nudge[0]) * ratio;
    const y = anchor[1] + (pose.dy + label.nudge[1]) * ratio;

    ctx.save();
    // Trait de rappel : du point au bord de l'étiquette — jusqu'au centre
    // auparavant, le trait traversait le texte. Boîte non tournée
    // (inclinaisons faibles, approximation suffisante) ; rien à relier
    // quand le point est déjà dans la boîte.
    if (opts.connector) {
        const sc = Math.abs(pose.scale);
        const hasBg = opts.background !== 'none' && opts.background_opacity > 0;
        const hw = sc * (m.width / 2 + (hasBg ? fontPx * 0.45 : 0)) + 2 * ratio;
        const hh = sc * (fontPx * 0.4 + (hasBg ? fontPx * 0.3 : 0)) + 2 * ratio;
        const dxL = x - anchor[0];
        const dyL = y - anchor[1];
        let t = 0;
        if (Math.abs(dxL) > 1e-6) t = Math.max(t, 1 - hw / Math.abs(dxL));
        if (Math.abs(dyL) > 1e-6) t = Math.max(t, 1 - hh / Math.abs(dyL));
        t = Math.min(t, 1);
        if (t > 0) {
            ctx.globalAlpha = alpha * 0.55;
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(1, ratio);
            ctx.beginPath();
            ctx.moveTo(anchor[0], anchor[1]);
            ctx.lineTo(anchor[0] + dxL * t, anchor[1] + dyL * t);
            ctx.stroke();
        }
    }
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    if (pose.rotation) ctx.rotate(pose.rotation);
    if (pose.scale !== 1) ctx.scale(pose.scale, pose.scale);
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const left = -m.width / 2;

    if (opts.background !== 'none' && opts.background_opacity > 0) {
        const padX = fontPx * 0.45;
        const padY = fontPx * 0.28;
        const w = m.width + padX * 2;
        const h = fontPx + padY * 2;
        ctx.fillStyle = hexToRgba(opts.background_color, opts.background_opacity / 100);
        const radius = opts.background === 'box' ? fontPx * 0.18 : h / 2;
        roundRect(ctx, -w / 2, -h / 2, w, h, opts.background === 'bubble' ? fontPx * 0.45 : radius);
        ctx.fill();
        if (opts.background === 'bubble') {
            // Queue de la bulle, vers le point : vers le bas quand
            // l'étiquette flotte au-dessus, vers le haut quand elle est en
            // dessous (offset_y positif, direction « vers le bas »…).
            const dir = pose.dy + label.nudge[1] > 0 ? -1 : 1;
            const tail = fontPx * 0.45;
            ctx.beginPath();
            ctx.moveTo(-tail * 0.7, dir * (h / 2 - 0.5));
            ctx.lineTo(0, dir * (h / 2 + tail));
            ctx.lineTo(tail * 0.7, dir * (h / 2 - 0.5));
            ctx.closePath();
            ctx.fill();
        }
    }

    const reveal = pose.reveal < 1 ? Math.ceil(m.chars.length * pose.reveal) : m.chars.length;
    const strokeW = opts.outline_width > 0 ? opts.outline_width * 2 * ratio : 0;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = opts.outline_color;
    ctx.fillStyle = color;
    const paint = (str, px, py) => {
        if (strokeW > 0) {
            ctx.lineWidth = strokeW;
            ctx.strokeText(str, px, py);
        }
        if (opts.glow > 0) {
            ctx.shadowColor = opts.glow_color;
            ctx.shadowBlur = opts.glow * ratio;
        }
        ctx.fillText(str, px, py);
        if (opts.glow > 0) {
            ctx.shadowBlur = 0;
            ctx.shadowColor = 'transparent';
        }
    };
    if (pose.scatter > 0) {
        // Éparpillement : chaque lettre s'envole dans sa direction.
        const spread = fontPx * 3 * pose.scatter;
        for (let i = 0; i < m.chars.length; i++) {
            const ang = unit(label.seed, 20 + i) * TAU;
            ctx.save();
            ctx.translate(left + m.charX[i] + Math.cos(ang) * spread, Math.sin(ang) * spread);
            ctx.rotate((unit(label.seed, 60 + i) - 0.5) * 2 * pose.scatter);
            paint(m.chars[i], 0, 0);
            ctx.restore();
        }
    } else if (reveal > 0) {
        paint(reveal >= m.chars.length ? text : m.chars.slice(0, reveal).join(''), left, 0);
    }
    ctx.restore();
}

// État observable (tests navigateur, diagnostic).
export function nameLabelsSnapshot(state, now, opts) {
    return {
        active: state.labels.length,
        spawned: state.spawned,
        dropped: state.dropped,
        evicted: state.evicted,
        labels: state.labels.map((l) => {
            const pose = opts ? nameLabelPose(l, now, opts) : null;
            return {
                text: l.text, kind: l.kind, code: l.code, start: l.start, duration: l.duration,
                nudge: l.nudge.slice(), pose,
            };
        }),
        history: state.history.slice(),
    };
}
