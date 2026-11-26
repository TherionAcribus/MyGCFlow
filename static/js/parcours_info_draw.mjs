// Dessin de la fiche des caches de la page Parcours (parcours_info.mjs) sur
// un canevas 2D : sur la carte et dans la vidéo (couche `parcours-head` en
// lecture, couche du plan au repos), et dans les vignettes des designs de
// l'onglet Style.
//
// Quatre designs (`design` du thème) :
// - `tag`    : étiquette d'une ligne, en pilule, pastille d'accent à gauche ;
// - `card`   : fiche — nom en gras, D et T en pastilles, PF, propriétaire,
//              barre d'accent à gauche, ombre portée ;
// - `banner` : bandeau plein à la couleur d'accent, texte contrasté ;
// - `text`   : texte seul, liseré de la couleur du fond.
//
// En deux temps : `infoLayout` mesure (taille de la fiche, utile au
// placement), `drawInfo` dessine à une position. Les textes traduits et les
// glyphes d'icônes sont fournis par l'appelant : aucun DOM ici (testable
// sous Node avec un faux contexte).
import { FONT_STACKS } from './name_labels.mjs';
import { contrastTextColor, hexToRgba } from './parcours_style.mjs';
import { formatRating } from './parcours_info.mjs';

export const INFO_HEART_COLOR = '#e03131';
const HEART = '♥';
const NAME_MAX_EM = 22;

export function infoFontFamily(font, pageFamily = null) {
    if (font === 'sans' && pageFamily) return pageFamily;
    return FONT_STACKS[font] || FONT_STACKS.sans;
}

function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return `${text.slice(0, Math.max(1, lo)).trimEnd()}…`;
}

function measured(ctx, font, text, extra = {}) {
    ctx.font = font;
    return { text, font, w: ctx.measureText(text).width, ...extra };
}

// Mesure d'une fiche : `content` (infoContent), `opts` :
//   design, family (pile CSS), size (px à l'échelle de l'image),
//   locale, strings.by(owner) (« par X », sans glyphe), glyphs.user
//   (glyphe Tabler ou null).
// Renvoie { w, h, design, rows, pad, radius, ... } pour drawInfo, ou null.
export function infoLayout(ctx, content, opts = {}) {
    if (!ctx || !content) return null;
    const design = opts.design || 'card';
    const size = Math.max(6, Number(opts.size) || 13);
    const family = opts.family || FONT_STACKS.sans;
    const locale = opts.locale;
    const userGlyph = opts.glyphs?.user || null;
    const by = opts.strings?.by || ((owner) => owner);
    const bold = (px) => `700 ${Math.round(px)}px ${family}`;
    const regular = (px) => `400 ${Math.round(px)}px ${family}`;
    const icon = (px) => `${Math.round(px)}px "tabler-icons"`;
    const single = design === 'tag';
    const titlePx = single ? size : size * 1.08;
    const detailPx = single ? size : size * 0.9;
    const gap = Math.round(size * 0.45);

    const dtText = content.dt ? `D${formatRating(content.dt.d, locale)}/T${formatRating(content.dt.t, locale)}` : null;
    const favText = content.favorites !== null && content.favorites !== undefined
        ? content.favorites.toLocaleString(locale) : null;

    // Éléments de détail, dans l'ordre : D/T, PF, propriétaire.
    const detail = (px, chips) => {
        const items = [];
        if (content.dt) {
            if (chips) {
                const chipFont = bold(px * 0.92);
                for (const [letter, value] of [['D', content.dt.d], ['T', content.dt.t]]) {
                    items.push(measured(ctx, chipFont, `${letter} ${formatRating(value, locale)}`, { kind: 'chip', px }));
                }
            } else items.push(measured(ctx, regular(px), dtText, { kind: 'text', role: 'text' }));
        }
        if (favText !== null) {
            items.push(measured(ctx, bold(px), HEART, { kind: 'text', role: 'heart', glue: true }));
            items.push(measured(ctx, regular(px), favText, { kind: 'text', role: 'text' }));
        }
        if (content.owner) {
            if (userGlyph) {
                items.push(measured(ctx, icon(px), userGlyph, { kind: 'text', role: 'muted', glue: true }));
                items.push(measured(ctx, regular(px), content.owner, { kind: 'text', role: 'muted' }));
            } else items.push(measured(ctx, regular(px), by(content.owner), { kind: 'text', role: 'muted' }));
        }
        return items;
    };

    const name = (px) => {
        if (!content.name) return null;
        ctx.font = bold(px);
        return measured(ctx, bold(px), fitText(ctx, content.name, px * NAME_MAX_EM), { kind: 'text', role: 'title' });
    };

    // Lignes : liste d'éléments posés de gauche à droite ; `glue` colle
    // l'élément au suivant (cœur et nombre, icône et nom).
    let rows;
    if (single) {
        const items = [];
        const title = name(titlePx);
        if (title) items.push(title);
        for (const item of detail(detailPx, false)) {
            if (items.length && !items[items.length - 1].glue) items.push({ kind: 'sep', w: 0, text: ' · ', font: regular(detailPx) });
            items.push(item);
        }
        rows = [{ items, px: titlePx }];
    } else if (design === 'card') {
        rows = [];
        const title = name(titlePx);
        if (title) rows.push({ items: [title], px: titlePx });
        const facts = detail(detailPx, true).filter((item) => item.role !== 'muted');
        if (facts.length) rows.push({ items: facts, px: detailPx });
        const owner = detail(detailPx, false).filter((item) => item.role === 'muted');
        if (owner.length) rows.push({ items: owner, px: detailPx * 0.95 });
    } else {
        rows = [];
        const title = name(titlePx);
        if (title) rows.push({ items: [title], px: titlePx });
        const items = [];
        for (const item of detail(detailPx, false)) {
            if (items.length && !items[items.length - 1].glue) items.push({ kind: 'sep', w: 0, text: ' · ', font: regular(detailPx) });
            items.push(item);
        }
        if (items.length) rows.push({ items, px: detailPx });
    }
    rows = rows.filter((row) => row.items.length);
    if (!rows.length) return null;

    // Largeurs : séparateur « · » entre groupes, petit espace après un
    // élément collé, espace entre pastilles.
    ctx.font = regular(detailPx);
    const sepW = ctx.measureText(' · ').width;
    const glueW = Math.round(size * 0.25);
    const chipPad = Math.round(size * 0.35);
    for (const row of rows) {
        let w = 0;
        row.items.forEach((item, i) => {
            if (item.kind === 'sep') item.w = sepW;
            if (item.kind === 'chip') item.box = item.w + 2 * chipPad;
            item.x = w;
            w += item.kind === 'chip' ? item.box : item.w;
            const next = row.items[i + 1];
            if (next && next.kind !== 'sep' && item.kind !== 'sep') w += item.glue ? glueW : (item.kind === 'chip' ? gap * 0.6 : gap);
        });
        row.w = w;
        row.h = Math.round(row.px * (row.items.some((item) => item.kind === 'chip') ? 1.55 : 1.3));
    }

    const padX = Math.round(size * (design === 'text' ? 0.2 : 0.7));
    const padY = Math.round(size * (design === 'text' ? 0.15 : single ? 0.35 : 0.5));
    const dot = single ? Math.round(size * 0.32) : 0;
    const bar = design === 'card' ? Math.max(3, Math.round(size * 0.28)) : 0;
    const inner = Math.max(...rows.map((row) => row.w));
    const lead = bar + (dot ? dot * 2 + gap * 0.8 : 0);
    let y = padY;
    for (const row of rows) {
        row.y = y;
        y += row.h;
    }
    const h = Math.round(y + padY);
    const w = Math.round(lead + inner + 2 * padX);
    const radius = single ? h / 2 : design === 'card' ? Math.round(size * 0.45) : design === 'banner' ? Math.round(size * 0.15) : 0;
    return { design, w, h, rows, padX, padY, dot, bar, lead, radius, size, chipPad };
}

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

// Couleurs effectives d'une fiche selon son design.
export function infoColors(design, { textColor, backgroundColor, backgroundOpacity, accent }) {
    const opacity = Math.max(0, Math.min(100, Number(backgroundOpacity))) / 100;
    if (design === 'banner') {
        const text = contrastTextColor(accent);
        return {
            fill: hexToRgba(accent, Math.max(opacity, 0.15)), text, muted: hexToRgba(text, 0.85),
            heart: text, accent: text, chipText: text, halo: null,
        };
    }
    if (design === 'text') {
        return {
            fill: null, text: textColor, muted: hexToRgba(textColor, 0.8), heart: INFO_HEART_COLOR,
            accent, chipText: accent, halo: opacity > 0 ? hexToRgba(backgroundColor, opacity) : null,
        };
    }
    return {
        fill: opacity > 0 ? hexToRgba(backgroundColor, opacity) : null, text: textColor,
        muted: hexToRgba(textColor, 0.72), heart: INFO_HEART_COLOR, accent, chipText: accent, halo: null,
    };
}

// Trait de rappel du point de l'étape au bord le plus proche de la fiche.
function drawLeader(ctx, layout, x, y, leader, color, ratio) {
    const { fromX, fromY, radius = 0 } = leader;
    const tx = Math.max(x, Math.min(fromX, x + layout.w));
    const ty = Math.max(y, Math.min(fromY, y + layout.h));
    const dx = tx - fromX;
    const dy = ty - fromY;
    const length = Math.hypot(dx, dy);
    if (length <= radius + 2 * ratio) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 1.5 * ratio);
    ctx.globalAlpha *= 0.8;
    ctx.beginPath();
    ctx.moveTo(fromX + (dx / length) * radius, fromY + (dy / length) * radius);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.restore();
}

// Dessine une fiche mesurée par infoLayout en (`x`, `y`) — coin haut gauche,
// px du canevas. `opts` : textColor, backgroundColor, backgroundOpacity,
// accent, alpha (fondu), ratio (densité de pixels), leader
// ({ fromX, fromY, radius } : point de l'étape) ou null.
export function drawInfo(ctx, layout, x, y, opts = {}) {
    if (!ctx || !layout) return;
    const ratio = Number(opts.ratio) || 1;
    const accent = opts.accent || '#0072c6';
    const colors = infoColors(layout.design, {
        textColor: opts.textColor || '#212529',
        backgroundColor: opts.backgroundColor || '#ffffff',
        backgroundOpacity: opts.backgroundOpacity ?? 92,
        accent,
    });
    const { w, h, radius, design } = layout;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, opts.alpha ?? 1));
    if (opts.leader) drawLeader(ctx, layout, x, y, opts.leader, design === 'banner' ? accent : colors.accent, ratio);
    if (colors.fill) {
        ctx.save();
        if (design === 'card' || design === 'tag') {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
            ctx.shadowBlur = 8 * ratio;
            ctx.shadowOffsetY = 2 * ratio;
        }
        ctx.fillStyle = colors.fill;
        roundRect(ctx, x, y, w, h, radius);
        ctx.fill();
        ctx.restore();
    }
    if (layout.bar) {
        ctx.save();
        roundRect(ctx, x, y, w, h, radius);
        ctx.clip();
        ctx.fillStyle = accent;
        ctx.fillRect(x, y, layout.bar, h);
        ctx.restore();
    }
    if (layout.dot) {
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(x + layout.padX + layout.dot, y + h / 2, layout.dot, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const left = x + layout.padX + layout.lead;
    for (const row of layout.rows) {
        const cy = y + row.y + row.h / 2;
        for (const item of row.items) {
            const ix = left + item.x;
            if (item.kind === 'sep') {
                ctx.font = item.font;
                ctx.fillStyle = colors.muted;
                ctx.fillText(' · ', ix, cy);
                continue;
            }
            ctx.font = item.font;
            if (item.kind === 'chip') {
                const chipH = Math.round(row.h * 0.78);
                ctx.save();
                ctx.lineWidth = Math.max(1, ratio);
                ctx.strokeStyle = colors.chipText;
                ctx.fillStyle = design === 'banner' ? 'rgba(255, 255, 255, 0.12)' : hexToRgba(accent, 0.1);
                roundRect(ctx, ix, cy - chipH / 2, item.box, chipH, chipH / 2);
                ctx.fill();
                ctx.stroke();
                ctx.restore();
                ctx.fillStyle = colors.chipText;
                ctx.fillText(item.text, ix + layout.chipPad, cy);
                continue;
            }
            const color = item.role === 'heart' ? colors.heart : item.role === 'muted' ? colors.muted : colors.text;
            if (colors.halo) {
                ctx.save();
                ctx.lineJoin = 'round';
                ctx.strokeStyle = colors.halo;
                ctx.lineWidth = Math.max(2, layout.size * 0.3);
                ctx.strokeText(item.text, ix, cy);
                ctx.restore();
            }
            ctx.fillStyle = color;
            ctx.fillText(item.text, ix, cy);
        }
    }
    ctx.restore();
}
