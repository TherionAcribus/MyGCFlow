// Panneaux de statistiques : dessin Canvas 2D.
//
// Une seule fonction de dessin par type de panneau, utilisée telle quelle par
// l'aperçu (un <canvas> par panneau) et par la vidéo (addStatsPanelsToCanvas) :
// les deux affichent exactement la même chose.
//
// Aucune lecture du DOM ici. Le panneau reçoit une « vue » préparée par
// stats_panels.js (modèle de stats_model.mjs + libellés traduits + couleurs) ;
// la géométrie se calcule en px CSS à partir de la seule largeur, ce qui
// permet de connaître la hauteur (measure) avant de dessiner, puis de
// dessiner à n'importe quelle échelle (DPR de l'écran, facteur de la vidéo).
//
// Registre STATS_RENDERERS : ajouter un type de panneau = ajouter une entrée.

import { highlightLevel, OTHERS_KEY } from './stats_model.mjs';

const OTHERS_COLOR = '#8a94a6';

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

export function hexToRgba(hex, alpha = 1) {
    const value = String(hex || '').replace('#', '');
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    const n = Number.parseInt(full, 16);
    if (full.length !== 6 || !Number.isFinite(n)) return `rgba(0,0,0,${alpha})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function roundedRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

const font = (weight, size, family) => `${weight} ${size}px ${family || 'sans-serif'}`;

// Texte tronqué avec « … » pour tenir dans `maxWidth`.
function fitText(ctx, text, maxWidth) {
    const value = String(text ?? '');
    if (maxWidth <= 0) return '';
    if (ctx.measureText(value).width <= maxWidth) return value;
    const glyphs = Array.from(value);
    let lo = 0;
    let hi = glyphs.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(`${glyphs.slice(0, mid).join('')}…`).width <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return lo > 0 ? `${glyphs.slice(0, lo).join('')}…` : '';
}

// Cadre commun : marges, titre, pied. Toutes les valeurs en px CSS.
function frameMetrics(view, style) {
    const fontSize = style.font_size;
    const pad = Math.round(fontSize * 0.85);
    const titleSize = Math.round(fontSize * 1.2);
    const titleH = view.title ? Math.round(titleSize * 1.5) : 0;
    const footSize = Math.max(8, Math.round(fontSize * 0.85));
    const footLines = (view.footer || []).filter(Boolean);
    const footH = footLines.length ? Math.round(footSize * 1.35 * footLines.length + fontSize * 0.4) : 0;
    return { fontSize, pad, titleSize, titleH, footSize, footLines, footH };
}

function drawFrame(ctx, view, style, width, height, frame) {
    roundedRect(ctx, 0, 0, width, height, style.radius);
    ctx.fillStyle = hexToRgba(style.background, style.background_opacity / 100);
    ctx.fill();

    ctx.textBaseline = 'middle';
    if (view.title) {
        ctx.font = font(700, frame.titleSize, view.fontFamily);
        ctx.fillStyle = style.text_color;
        ctx.textAlign = 'left';
        ctx.fillText(fitText(ctx, view.title, width - frame.pad * 2),
            frame.pad, frame.pad + frame.titleH / 2 - frame.titleSize * 0.1);
    }
    if (frame.footLines.length) {
        ctx.font = font(400, frame.footSize, view.fontFamily);
        ctx.fillStyle = hexToRgba(style.text_color, 0.75);
        ctx.textAlign = 'left';
        const lineH = frame.footSize * 1.35;
        let y = height - frame.pad - frame.footLines.length * lineH + lineH / 2;
        for (const line of frame.footLines) {
            ctx.fillText(fitText(ctx, line, width - frame.pad * 2), frame.pad, y);
            y += lineH;
        }
    }
}

function highlightFor(view, keys, now) {
    const hl = view.highlight;
    if (!hl || hl.mode === 'none' || !hl.hits) return 0;
    let level = 0;
    for (const key of keys) {
        level = Math.max(level, highlightLevel(hl.hits.get(key), now, hl.durationMs, hl.mode));
    }
    return level;
}

// ---------------------------------------------------------------------------
// Grille (D/T, Jasmer, calendrier)
// ---------------------------------------------------------------------------

// Largeur réservée aux libellés de ligne, en multiples de la taille de police :
// fixe par métrique pour que measure() n'ait pas besoin de mesurer du texte.
const GRID_ROW_LABEL_EM = { dt: 2.4, jasmer: 2.6, calendar: 3 };

function gridLayout(view, style, width) {
    const frame = frameMetrics(view, style);
    const model = view.model;
    const rowLabelW = Math.round(frame.fontSize * (GRID_ROW_LABEL_EM[view.metric] || 2));
    const headerH = Math.round(frame.fontSize * 1.5);
    const innerW = Math.max(1, width - frame.pad * 2 - rowLabelW);
    const cell = innerW / Math.max(1, model.cols);
    const gridTop = frame.pad + frame.titleH;
    const gridH = headerH + cell * model.rows;
    const height = Math.ceil(gridTop + gridH + frame.footH + frame.pad);
    return { ...frame, rowLabelW, headerH, cell, gridTop, height };
}

function drawGrid(ctx, view, style, width, now) {
    const L = gridLayout(view, style, width);
    const model = view.model;
    drawFrame(ctx, view, style, width, L.height, L);

    const left = L.pad + L.rowLabelW;
    const top = L.gridTop + L.headerH;
    const gap = L.cell >= 10 ? 1.5 : 0.75;
    const labelSize = Math.min(L.fontSize * 0.85, Math.max(7, L.cell * 0.9));

    // En-têtes de colonnes : on saute des libellés si la case est trop étroite.
    ctx.font = font(600, labelSize, view.fontFamily);
    ctx.fillStyle = hexToRgba(style.text_color, 0.85);
    ctx.textAlign = 'center';
    const colStep = Math.max(1, Math.ceil((labelSize * 1.6) / L.cell));
    for (let c = 0; c < model.cols; c += colStep) {
        ctx.fillText(view.colLabels[c] ?? '', left + (c + 0.5) * L.cell, L.gridTop + L.headerH / 2);
    }
    if (view.corner) {
        ctx.textAlign = 'left';
        ctx.fillStyle = hexToRgba(style.text_color, 0.6);
        ctx.fillText(fitText(ctx, view.corner, L.rowLabelW), L.pad, L.gridTop + L.headerH / 2);
    }

    // En-têtes de lignes.
    ctx.textAlign = 'right';
    ctx.fillStyle = hexToRgba(style.text_color, 0.85);
    const rowStep = Math.max(1, Math.ceil((labelSize * 1.2) / L.cell));
    for (let r = 0; r < model.rows; r += rowStep) {
        ctx.fillText(view.rowLabels[r] ?? '', left - L.fontSize * 0.35, top + (r + 0.5) * L.cell);
    }

    const mode = view.cellMode;
    const valueSize = Math.min(L.fontSize * 0.85, L.cell * 0.5);
    const showValues = mode === 'count' && view.showValues && valueSize >= 7;
    const empty = hexToRgba(style.text_color, 0.07);
    for (let r = 0; r < model.rows; r++) {
        for (let c = 0; c < model.cols; c++) {
            const cell = model.cells[r * model.cols + c];
            if (cell.disabled) continue;
            const x = left + c * L.cell + gap / 2;
            const y = top + r * L.cell + gap / 2;
            const size = L.cell - gap;
            const radius = Math.min(3, size / 4);
            if (cell.count > 0) {
                const intensity = mode === 'filled' || model.max <= 0
                    ? 1
                    : 0.3 + 0.7 * Math.min(1, cell.count / model.max);
                roundedRect(ctx, x, y, size, size, radius);
                ctx.fillStyle = hexToRgba(style.accent_color, intensity);
                ctx.fill();
            } else {
                roundedRect(ctx, x, y, size, size, radius);
                ctx.fillStyle = empty;
                ctx.fill();
            }
            const level = highlightFor(view, [cell.key], now);
            if (level > 0) {
                roundedRect(ctx, x, y, size, size, radius);
                ctx.fillStyle = `rgba(255,255,255,${0.55 * level})`;
                ctx.fill();
                ctx.lineWidth = Math.max(1, size * 0.08);
                ctx.strokeStyle = `rgba(255,255,255,${level})`;
                ctx.stroke();
            }
            if (showValues && cell.count > 0) {
                ctx.font = font(600, valueSize, view.fontFamily);
                ctx.textAlign = 'center';
                ctx.fillStyle = style.text_color;
                ctx.fillText(view.formatNumber(cell.count), x + size / 2, y + size / 2 + 0.5);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Histogramme
// ---------------------------------------------------------------------------

function barLayout(view, style, width) {
    const frame = frameMetrics(view, style);
    const rows = view.model.rows.length;
    const top = frame.pad + frame.titleH;
    let chartH;
    if (view.orientation === 'vertical') {
        // Valeurs au-dessus, libellés dessous : la hauteur suit la largeur.
        chartH = Math.round(Math.max(frame.fontSize * 6, (width - frame.pad * 2) * 0.5) + frame.fontSize * 3);
    } else {
        chartH = Math.max(1, rows) * Math.round(frame.fontSize * 1.75);
    }
    const height = Math.ceil(top + chartH + frame.footH + frame.pad);
    return { ...frame, top, chartH, height };
}

function barColor(view, style, row, max) {
    if (row.key === OTHERS_KEY) return OTHERS_COLOR;
    if (view.palette === 'gc') return view.colorOf?.(row.key) || style.accent_color;
    if (view.palette === 'heat' && max > 0) {
        return hexToRgba(style.accent_color, 0.35 + 0.65 * Math.min(1, row.refCount / max));
    }
    return style.accent_color;
}

function valueText(view, row) {
    const value = view.formatNumber(row.count);
    if (!view.showPercent || !(view.sum > 0)) return value;
    return `${value} (${view.formatPercent(row.count / view.sum)})`;
}

function drawBars(ctx, view, style, width, now) {
    const L = barLayout(view, style, width);
    drawFrame(ctx, view, style, width, L.height, L);
    const { rows, max } = view.model;
    const scale = max > 0 ? 1 / max : 0;
    const track = hexToRgba(style.text_color, 0.08);
    const innerW = width - L.pad * 2;

    if (view.orientation === 'vertical') {
        const labelSize = Math.max(7, L.fontSize * 0.85);
        const slot = innerW / Math.max(1, rows.length);
        // Plafonnée : avec une ou deux colonnes (une seule année), une barre
        // pleine largeur ressemblerait à un bloc plutôt qu'à un histogramme.
        const barW = Math.max(1, Math.min(slot * 0.7, L.fontSize * 2.5));
        const valueH = view.showValues ? L.fontSize * 1.3 : 0;
        const labelH = L.fontSize * 1.5;
        const baseY = L.top + L.chartH - labelH;
        const fullH = Math.max(1, L.chartH - labelH - valueH);
        const labelStep = Math.max(1, Math.ceil((labelSize * 2.4) / slot));
        rows.forEach((row, i) => {
            const x = L.pad + i * slot + (slot - barW) / 2;
            const h = row.count * scale * fullH;
            roundedRect(ctx, x, baseY - fullH, barW, fullH, Math.min(3, barW / 4));
            ctx.fillStyle = track;
            ctx.fill();
            if (h > 0) {
                roundedRect(ctx, x, baseY - h, barW, h, Math.min(3, barW / 4, h / 2));
                ctx.fillStyle = barColor(view, style, row, max);
                ctx.fill();
            }
            const level = highlightFor(view, row.keys, now);
            if (level > 0 && h > 0) {
                roundedRect(ctx, x, baseY - h, barW, h, Math.min(3, barW / 4, h / 2));
                ctx.fillStyle = `rgba(255,255,255,${0.5 * level})`;
                ctx.fill();
            }
            ctx.textAlign = 'center';
            if (view.showValues && row.count > 0 && slot >= L.fontSize * 1.4) {
                ctx.font = font(600, Math.min(L.fontSize * 0.85, slot * 0.45), view.fontFamily);
                ctx.fillStyle = style.text_color;
                ctx.fillText(view.formatNumber(row.count), x + barW / 2, baseY - h - valueH / 2);
            }
            if (i % labelStep === 0) {
                ctx.font = font(500, labelSize, view.fontFamily);
                ctx.fillStyle = hexToRgba(style.text_color, 0.85);
                ctx.fillText(fitText(ctx, view.labelOf(row.key), slot * labelStep),
                    x + barW / 2, baseY + labelH / 2);
            }
        });
        return;
    }

    const rowH = L.chartH / Math.max(1, rows.length);
    ctx.font = font(500, L.fontSize, view.fontFamily);
    const labels = rows.map((row) => view.labelOf(row.key));
    const labelW = Math.min(innerW * 0.42, Math.max(...labels.map((l) => ctx.measureText(l).width), 0));
    ctx.font = font(600, L.fontSize * 0.9, view.fontFamily);
    const valueW = view.showValues
        ? Math.min(innerW * 0.3, Math.max(...rows.map((row) => ctx.measureText(valueText(view, row)).width), 0))
        : 0;
    const gapX = L.fontSize * 0.5;
    const barX = L.pad + labelW + gapX;
    const barMax = Math.max(1, innerW - labelW - gapX - (valueW ? valueW + gapX : 0));
    const barH = Math.max(2, rowH * 0.62);

    rows.forEach((row, i) => {
        const cy = L.top + (i + 0.5) * rowH;
        ctx.font = font(500, L.fontSize, view.fontFamily);
        ctx.fillStyle = style.text_color;
        ctx.textAlign = 'left';
        ctx.fillText(fitText(ctx, labels[i], labelW), L.pad, cy);

        const w = row.count * scale * barMax;
        roundedRect(ctx, barX, cy - barH / 2, barMax, barH, Math.min(4, barH / 2));
        ctx.fillStyle = track;
        ctx.fill();
        if (w > 0) {
            roundedRect(ctx, barX, cy - barH / 2, w, barH, Math.min(4, barH / 2, w / 2));
            ctx.fillStyle = barColor(view, style, row, max);
            ctx.fill();
            const level = highlightFor(view, row.keys, now);
            if (level > 0) {
                ctx.fillStyle = `rgba(255,255,255,${0.5 * level})`;
                ctx.fill();
            }
        }
        if (view.showValues) {
            ctx.font = font(600, L.fontSize * 0.9, view.fontFamily);
            ctx.textAlign = 'right';
            ctx.fillStyle = style.text_color;
            ctx.fillText(valueText(view, row), width - L.pad, cy);
        }
    });
}

// ---------------------------------------------------------------------------
// Registre
// ---------------------------------------------------------------------------

export const STATS_RENDERERS = Object.freeze({
    grid: {
        measure: (view, style, width) => gridLayout(view, style, width).height,
        draw: drawGrid,
    },
    bar: {
        measure: (view, style, width) => barLayout(view, style, width).height,
        draw: drawBars,
    },
});

// Hauteur en px CSS d'un panneau de largeur `width`.
export function measureStatsPanel(view, style, width) {
    const renderer = STATS_RENDERERS[view?.kind];
    return renderer ? renderer.measure(view, style, width) : 0;
}

// Dessine un panneau dans `rect` (px du canvas cible). `cssWidth` est la
// largeur logique : le dessin se fait en px CSS, mis à l'échelle de `rect`.
export function drawStatsPanel(ctx, rect, view, style, now, cssWidth) {
    const renderer = STATS_RENDERERS[view?.kind];
    if (!renderer || !(rect.width > 0) || !(cssWidth > 0)) return;
    const scale = rect.width / cssWidth;
    ctx.save();
    ctx.translate(rect.x, rect.y);
    ctx.scale(scale, scale);
    try {
        renderer.draw(ctx, view, style, cssWidth, now);
    } finally {
        ctx.restore();
    }
}
