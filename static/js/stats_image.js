// Image d'un tableau de bord entier (page Statistiques) : le tableau tel
// qu'il est affiché — même disposition des cartes, mêmes couleurs, même
// thème — redessiné dans un canvas, avec un en-tête (nom, période, filtres)
// et un pied de page.
//
// Les cartes sont relues dans le DOM : fonds et bordures, textes (au
// pixel de leurs lignes, coupures et « … » compris), icônes Tabler (glyphe
// de leur ::before). Les graphiques ECharts sont redessinés hors écran sans
// animation, à la netteté de l'image (`chartCanvas`, fourni par la page).
// Les commandes (poignée, menu, boutons) ne sont pas reprises.
import {
    applyTextTransform, colorVisible, ellipsize, iconGlyph, imageRatio, splitLines, wrapText,
} from './dashboard_image.mjs';

const PAD = 24;
const TITLE_SIZE = 24;
const LINE_SIZE = 14;
const LINE_HEIGHT = 20;
const FOOTER_HEIGHT = 34;
const SKIP = '.stats-card-grip, .stats-card-resize, .stats-card-menu, button, .dropdown-menu';

const cssFont = (style) => [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
const px = (value) => Number.parseFloat(value) || 0;

function roundedRect(g, x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r);
    else g.rect(x, y, w, h);
}

// Fond et bordure d'un élément (couleurs pleines ; un bord uniforme suit
// l'arrondi, des bords différents sont tracés côté par côté).
function paintBox(g, rect, style, origin) {
    const x = rect.left - origin.x;
    const y = rect.top - origin.y;
    const radius = Math.min(px(style.borderTopLeftRadius), rect.width / 2, rect.height / 2);
    if (colorVisible(style.backgroundColor)) {
        roundedRect(g, x, y, rect.width, rect.height, radius);
        g.fillStyle = style.backgroundColor;
        g.fill();
    }
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((side) => ({
        width: style['border' + side + 'Style'] === 'none' ? 0 : px(style['border' + side + 'Width']),
        color: style['border' + side + 'Color'],
    }));
    const visible = sides.filter((s) => s.width > 0 && colorVisible(s.color));
    if (!visible.length) return;
    const uniform = visible.length === 4 && sides.every((s) => s.width === sides[0].width && s.color === sides[0].color);
    if (uniform) {
        const w = sides[0].width;
        roundedRect(g, x + w / 2, y + w / 2, rect.width - w, rect.height - w, Math.max(0, radius - w / 2));
        g.lineWidth = w;
        g.strokeStyle = sides[0].color;
        g.stroke();
        return;
    }
    const [top, right, bottom, left] = sides;
    const line = (s, x1, y1, x2, y2) => {
        if (!(s.width > 0 && colorVisible(s.color))) return;
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.lineWidth = s.width;
        g.strokeStyle = s.color;
        g.stroke();
    };
    line(top, x, y + top.width / 2, x + rect.width, y + top.width / 2);
    line(bottom, x, y + rect.height - bottom.width / 2, x + rect.width, y + rect.height - bottom.width / 2);
    line(left, x + left.width / 2, y, x + left.width / 2, y + rect.height);
    line(right, x + rect.width - right.width / 2, y, x + rect.width - right.width / 2, y + rect.height);
}

// Un nœud texte, ligne par ligne, aux positions mises en page par le
// navigateur : chaque ligne est centrée sur son fragment (une police de
// canvas peut différer d'un pixel : rien ne dérive), ou coupée par « … »
// quand l'élément la coupe à l'écran.
function paintText(g, node, parent, style, origin) {
    const raw = node.textContent;
    if (!raw.trim()) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    range.detach?.();
    if (!rects.length) return;
    g.font = cssFont(style);
    g.fillStyle = style.color;
    if ('letterSpacing' in g) g.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    const text = applyTextTransform(raw.replace(/\s+/g, ' ').trim(), style.textTransform);
    const measure = (s) => g.measureText(s).width;
    const lines = rects.length === 1 ? [text] : splitLines(text, rects.map((r) => r.width), measure);
    const metrics = g.measureText('Hg');
    const ascent = metrics.fontBoundingBoxAscent ?? px(style.fontSize) * 0.8;
    const descent = metrics.fontBoundingBoxDescent ?? px(style.fontSize) * 0.2;
    let maxRight = Infinity;
    if (style.textOverflow === 'ellipsis' && style.overflowX !== 'visible') {
        const box = parent.getBoundingClientRect();
        maxRight = box.right - px(style.paddingRight) - px(style.borderRightWidth);
    }
    g.textBaseline = 'alphabetic';
    rects.forEach((r, i) => {
        const line = lines[i];
        if (!line) return;
        const y = r.top - origin.y + (r.height - (ascent + descent)) / 2 + ascent;
        if (r.right > maxRight + 0.5) {
            g.textAlign = 'left';
            g.fillText(ellipsize(line, maxRight - r.left, measure), r.left - origin.x, y);
        } else {
            g.textAlign = 'center';
            g.fillText(line, r.left - origin.x + r.width / 2, y);
        }
    });
    if ('letterSpacing' in g) g.letterSpacing = '0px';
}

function paintIcon(g, el, rect, origin) {
    const before = getComputedStyle(el, '::before');
    const glyph = iconGlyph(before.content);
    if (!glyph) return;
    g.font = cssFont(before);
    g.fillStyle = before.color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(glyph, rect.left - origin.x + rect.width / 2, rect.top - origin.y + rect.height / 2);
    g.textBaseline = 'alphabetic';
}

function paintElement(g, el, ctx) {
    if (el.hidden || el.matches(SKIP)) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const opacity = px(style.opacity);
    if (style.opacity !== '' && opacity === 0) return;
    const rect = el.getBoundingClientRect();
    g.save();
    if (style.opacity !== '') g.globalAlpha *= opacity;
    paintBox(g, rect, style, ctx.origin);
    if (el.classList.contains('stats-chart')) {
        const id = el.closest('.stats-card')?.dataset.chartId;
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        const image = id && width > 0 && height > 0 ? ctx.chartCanvas(id, width, height, ctx.ratio) : null;
        if (image) {
            g.drawImage(image, rect.left - ctx.origin.x, rect.top - ctx.origin.y, rect.width, rect.height);
            ctx.charts += 1;
        }
        g.restore();
        return;
    }
    if (el.classList.contains('ti')) {
        paintIcon(g, el, rect, ctx.origin);
        g.restore();
        return;
    }
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        g.beginPath();
        g.rect(rect.left - ctx.origin.x, rect.top - ctx.origin.y, rect.width, rect.height);
        g.clip();
    }
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) paintText(g, node, el, style, ctx.origin);
        else if (node.nodeType === Node.ELEMENT_NODE) paintElement(g, node, ctx);
    }
    g.restore();
}

// `lines` : lignes de l'en-tête sous le titre (période, filtres…), coupées
// à la largeur ; `colors` : background, heading, text, muted, font.
export async function paintDashboardImage({ grid, title, lines = [], footer = '', colors, chartCanvas }) {
    await document.fonts?.ready;
    const gridRect = grid.getBoundingClientRect();
    const width = Math.ceil(gridRect.width + PAD * 2);
    const inner = width - PAD * 2;
    const scratch = document.createElement('canvas').getContext('2d');
    scratch.font = '400 ' + LINE_SIZE + 'px ' + colors.font;
    const measureLine = (s) => scratch.measureText(s).width;
    const headerLines = lines.filter(Boolean).flatMap((line) => wrapText(line, inner, measureLine));
    const headerHeight = PAD + TITLE_SIZE + 10 + headerLines.length * LINE_HEIGHT + 14;
    const height = Math.ceil(headerHeight + gridRect.height + FOOTER_HEIGHT);
    const ratio = imageRatio(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const g = canvas.getContext('2d');
    g.scale(ratio, ratio);
    g.fillStyle = colors.background;
    g.fillRect(0, 0, width, height);

    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = '600 ' + TITLE_SIZE + 'px ' + colors.font;
    g.fillStyle = colors.heading;
    g.fillText(ellipsize(title, inner, (s) => g.measureText(s).width), PAD, PAD + TITLE_SIZE * 0.85);
    g.font = '400 ' + LINE_SIZE + 'px ' + colors.font;
    g.fillStyle = colors.muted;
    headerLines.forEach((line, i) => g.fillText(line, PAD, PAD + TITLE_SIZE + 10 + LINE_SIZE + i * LINE_HEIGHT));

    const ctx = {
        origin: { x: gridRect.left - PAD, y: gridRect.top - headerHeight },
        ratio, chartCanvas, charts: 0,
    };
    let cards = 0;
    for (const card of grid.querySelectorAll('.stats-card')) {
        const rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        g.save();
        roundedRect(g, rect.left - ctx.origin.x, rect.top - ctx.origin.y, rect.width, rect.height,
            px(getComputedStyle(card).borderTopLeftRadius));
        g.clip();
        paintElement(g, card, ctx);
        g.restore();
        cards += 1;
    }

    if (footer) {
        g.font = '400 12px ' + colors.font;
        g.fillStyle = colors.muted;
        g.textAlign = 'right';
        g.fillText(footer, width - PAD, height - 13);
    }
    return { canvas, ratio, width, height, cards, charts: ctx.charts };
}
