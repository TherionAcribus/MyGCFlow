// Panneaux de statistiques : dessin Canvas 2D.
//
// Une seule fonction de dessin par type de panneau, utilisée telle quelle par
// l'aperçu (un <canvas> par panneau) et par la vidéo (addStatsPanelsToCanvas) :
// les deux affichent exactement la même chose.
//
// Aucune lecture du DOM ici. Le panneau reçoit une « vue » préparée par
// stats_panels.js (modèle de stats_model.mjs + libellés traduits + couleurs) ;
// la géométrie se calcule en px CSS à partir de la largeur — et d'une hauteur
// optionnelle imposée (position.height) — ce qui permet de connaître la
// hauteur (measure) avant de dessiner, puis de dessiner à n'importe quelle
// échelle (DPR de l'écran, facteur de la vidéo).
//
// Registre STATS_RENDERERS : ajouter un type de panneau = ajouter une entrée
// (grille, histogramme, anneau, courbe, compteurs).

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

// Cache de mesure des libellés : clé = le TABLEAU (identité stable tant que
// la révision de l'accumulateur ne change pas — `allLabels` de barModel),
// valeur = largeur en px par signature de police. Les tableaux éphémères
// (libellés des lignes affichées, refaits à chaque frame) n'y entrent pas :
// ils rendraient la mémoïsation inutile.
const labelWidthCache = new WeakMap();

// Largeur du plus long libellé du tableau, mémoïsée par (tableau, police).
export function labelsMaxWidth(ctx, labels, fontSig) {
    let byFont = labelWidthCache.get(labels);
    if (!byFont) { byFont = new Map(); labelWidthCache.set(labels, byFont); }
    let width = byFont.get(fontSig);
    if (width === undefined) {
        width = 0;
        for (const label of labels) width = Math.max(width, ctx.measureText(label).width);
        byFont.set(fontSig, width);
    }
    return width;
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
// Grille (D/T, Jasmer, calendrier, année d'activité)
// ---------------------------------------------------------------------------

// Largeur réservée aux libellés de ligne, en multiples de la taille de police :
// fixe par métrique pour que measure() n'ait pas besoin de mesurer du texte.
const GRID_ROW_LABEL_EM = { dt: 2.4, jasmer: 2.6, calendar: 3, activity: 2.6 };

// La hauteur imposée (targetH, px CSS de la hauteur TOTALE du panneau) est
// optionnelle : chaque layout la convertit en hauteur de zone graphique,
// bornée à un plancher de lisibilité — on peut étirer ET compresser, jamais
// sous le plancher. Les grilles l'ignorent (cases carrées).
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

function drawGrid(ctx, view, style, width, _targetH, now) {
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
    if (view.sparseColLabels) {
        // Peu de libellés (un mois par semaine qui le voit commencer) : chacun
        // aligné à gauche sur sa colonne, sauté s'il chevauche le précédent.
        ctx.textAlign = 'left';
        let lastRight = -Infinity;
        for (let c = 0; c < model.cols; c++) {
            const label = view.colLabels[c];
            if (!label) continue;
            const x = left + c * L.cell;
            const w = ctx.measureText(label).width;
            if (x < lastRight + 2 || x + w > width - L.pad) continue;
            ctx.fillText(label, x, L.gridTop + L.headerH / 2);
            lastRight = x + w;
        }
    } else {
        const colStep = Math.max(1, Math.ceil((labelSize * 1.6) / L.cell));
        for (let c = 0; c < model.cols; c += colStep) {
            ctx.fillText(view.colLabels[c] ?? '', left + (c + 0.5) * L.cell, L.gridTop + L.headerH / 2);
        }
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
    const showValues = mode === 'count' && valueSize >= 7;
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
// Couleurs des catégories
// ---------------------------------------------------------------------------

// Palette « multi » : dix teintes distinctes, lisibles sur fond sombre comme
// clair (Tableau 10). L'indice vient de la RÉFÉRENCE (view.colorIndex), pas
// du rang courant : une catégorie garde sa couleur quand elle change de place.
export const MULTI_PALETTE = Object.freeze([
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
]);

function categoryColor(view, style, row, index, max) {
    if (row.key === OTHERS_KEY) return OTHERS_COLOR;
    if (view.palette === 'gc') return view.colorOf?.(row.key) || style.accent_color;
    if (view.palette === 'multi') {
        const i = view.colorIndex?.(row.key) ?? index;
        return MULTI_PALETTE[((i % MULTI_PALETTE.length) + MULTI_PALETTE.length) % MULTI_PALETTE.length];
    }
    if (view.palette === 'heat' && max > 0) {
        return hexToRgba(style.accent_color, 0.35 + 0.65 * Math.min(1, row.refCount / max));
    }
    return style.accent_color;
}

// Valeur affichée d'une ligne : animée (stats_panels.js pose `shown`) ou exacte.
const shownOf = (row) => (Number.isFinite(row.shown) ? row.shown : row.count);

function valueText(view, row) {
    const value = view.formatNumber(Math.round(shownOf(row)));
    if (!view.showPercent || !(view.sum > 0)) return value;
    return `${value} (${view.formatPercent(shownOf(row) / view.sum)})`;
}

// ---------------------------------------------------------------------------
// Histogramme
// ---------------------------------------------------------------------------

function barLayout(view, style, width, targetH) {
    const frame = frameMetrics(view, style);
    // Course de barres : un nombre de places fixe (model.slots), pour que la
    // hauteur ne change pas quand des catégories entrent dans le classement.
    const rows = view.model.slots ?? view.model.rows.length;
    const top = frame.pad + frame.titleH;
    let chartH;
    if (view.orientation === 'vertical') {
        // Valeurs au-dessus, libellés dessous : la hauteur suit la largeur.
        chartH = Math.round(Math.max(frame.fontSize * 6, (width - frame.pad * 2) * 0.5) + frame.fontSize * 3);
        if (Number.isFinite(targetH)) {
            // Plancher : barres plus hautes que large ne seraient plus lisibles.
            chartH = Math.max(frame.fontSize * 5, Math.round(targetH - top - frame.footH - frame.pad));
        }
    } else {
        chartH = Math.max(1, rows) * Math.round(frame.fontSize * 1.75);
        if (Number.isFinite(targetH)) {
            // Plancher : une ligne par rang, assez haute pour y lire le libellé.
            chartH = Math.max(rows * frame.fontSize * 1.3, Math.round(targetH - top - frame.footH - frame.pad));
        }
    }
    const height = Math.ceil(top + chartH + frame.footH + frame.pad);
    return { ...frame, top, chartH, height, rows };
}

function drawBars(ctx, view, style, width, targetH, now) {
    const L = barLayout(view, style, width, targetH);
    drawFrame(ctx, view, style, width, L.height, L);
    const { rows, max } = view.model;
    const scaleMax = Number.isFinite(view.model.shownMax) && view.model.shownMax > 0 ? view.model.shownMax : max;
    const scale = scaleMax > 0 ? 1 / scaleMax : 0;
    const track = hexToRgba(style.text_color, 0.08);
    const innerW = width - L.pad * 2;

    if (view.orientation === 'vertical') {
        const labelSize = Math.max(7, L.fontSize * 0.85);
        const slot = innerW / Math.max(1, L.rows);
        // Plafonnée : avec une ou deux colonnes (une seule année), une barre
        // pleine largeur ressemblerait à un bloc plutôt qu'à un histogramme.
        const barW = Math.max(1, Math.min(slot * 0.7, L.fontSize * 2.5));
        const valueH = view.showValues ? L.fontSize * 1.3 : 0;
        const labelH = L.fontSize * 1.5;
        const baseY = L.top + L.chartH - labelH;
        const fullH = Math.max(1, L.chartH - labelH - valueH);
        const labelStep = Math.max(1, Math.ceil((labelSize * 2.4) / slot));
        rows.forEach((row, i) => {
            const position = Number.isFinite(row.slot) ? row.slot : i;
            const x = L.pad + position * slot + (slot - barW) / 2;
            const shown = shownOf(row);
            const h = Math.min(fullH, Math.max(0, shown * scale * fullH));
            roundedRect(ctx, x, baseY - fullH, barW, fullH, Math.min(3, barW / 4));
            ctx.fillStyle = track;
            ctx.fill();
            if (h > 0.5) {
                roundedRect(ctx, x, baseY - h, barW, h, Math.min(3, barW / 4, h / 2));
                ctx.fillStyle = categoryColor(view, style, row, i, max);
                ctx.fill();
                const level = highlightFor(view, row.keys, now);
                if (level > 0) {
                    ctx.fillStyle = `rgba(255,255,255,${0.5 * level})`;
                    ctx.fill();
                }
            }
            ctx.textAlign = 'center';
            if (view.showValues && shown >= 0.5 && slot >= L.fontSize * 1.4) {
                ctx.font = font(600, Math.min(L.fontSize * 0.85, slot * 0.45), view.fontFamily);
                ctx.fillStyle = style.text_color;
                ctx.fillText(view.formatNumber(Math.round(shown)), x + barW / 2, baseY - h - valueH / 2);
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

    const rowH = L.chartH / Math.max(1, L.rows);
    ctx.font = font(500, L.fontSize, view.fontFamily);
    const labels = rows.map((row) => view.labelOf(row.key));
    // Course de barres : la colonne d'étiquettes se mesure sur TOUTES les
    // catégories (allLabels, stable par révision) — un nom long qui entre
    // dans le top-N ne décale plus les barres en pleine animation.
    const labelW = Math.min(innerW * 0.42, view.model.allLabels
        ? labelsMaxWidth(ctx, view.model.allLabels, `500|${L.fontSize}|${view.fontFamily || ''}`)
        : Math.max(...labels.map((l) => ctx.measureText(l).width), 0));
    ctx.font = font(600, L.fontSize * 0.9, view.fontFamily);
    // Largeur réservée aux valeurs : celle des valeurs FINALES (référence),
    // pour que les barres ne raccourcissent pas quand un nombre gagne un chiffre.
    const widest = rows.map((row) => valueText(view, { ...row, shown: Math.max(row.refCount, row.count) }));
    const valueW = view.showValues
        ? Math.min(innerW * 0.3, Math.max(...widest.map((text) => ctx.measureText(text).width), 0))
        : 0;
    const gapX = L.fontSize * 0.5;
    const barX = L.pad + labelW + gapX;
    const barMax = Math.max(1, innerW - labelW - gapX - (valueW ? valueW + gapX : 0));
    const barH = Math.max(2, rowH * 0.62);

    // Course : les lignes glissent d'une place à l'autre ; celles qui sortent du
    // classement disparaissent sous le bas de la zone, rognée.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, L.top, width, L.chartH);
    ctx.clip();
    rows.forEach((row, i) => {
        const position = Number.isFinite(row.slot) ? row.slot : i;
        const cy = L.top + (position + 0.5) * rowH;
        ctx.font = font(500, L.fontSize, view.fontFamily);
        ctx.fillStyle = style.text_color;
        ctx.textAlign = 'left';
        ctx.fillText(fitText(ctx, labels[i], labelW), L.pad, cy);

        const w = Math.min(barMax, Math.max(0, shownOf(row) * scale * barMax));
        roundedRect(ctx, barX, cy - barH / 2, barMax, barH, Math.min(4, barH / 2));
        ctx.fillStyle = track;
        ctx.fill();
        if (w > 0.5) {
            roundedRect(ctx, barX, cy - barH / 2, w, barH, Math.min(4, barH / 2, w / 2));
            ctx.fillStyle = categoryColor(view, style, row, i, max);
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
    ctx.restore();
}

// ---------------------------------------------------------------------------
// Anneau (camembert si le trou vaut 0)
// ---------------------------------------------------------------------------

function donutLayout(view, style, width, targetH) {
    const frame = frameMetrics(view, style);
    const innerW = Math.max(1, width - frame.pad * 2);
    const rows = view.model.rows.length;
    const legend = view.showLegend && rows > 0;
    const top = frame.pad + frame.titleH;
    const rowH = Math.round(frame.fontSize * 1.55);
    const legendH = legend ? rows * rowH : 0;
    // Plafond naturel du diamètre (220 avec légende, 320 sans) : dépassé
    // quand une hauteur imposée laisse plus de place — l'anneau s'étire mais
    // ne se compresse jamais sous sa taille naturelle (60 px minimum). La
    // légende plus haute que l'anneau commande comme d'habitude.
    const widthCap = legend ? innerW * 0.46 : innerW;
    const cap = legend ? 220 : 320;
    const diameter = Math.round(Math.max(60, Math.min(widthCap,
        Math.max(cap, Number.isFinite(targetH) ? targetH - top - frame.footH - frame.pad : cap))));
    const chartH = Math.max(diameter, legendH);
    const height = Math.ceil(top + chartH + frame.footH + frame.pad);
    return { ...frame, top, innerW, diameter, legend, rowH, legendH, chartH, height };
}

function ringPath(ctx, cx, cy, outer, inner, start, end) {
    ctx.beginPath();
    ctx.arc(cx, cy, outer, start, end);
    if (inner > 0) ctx.arc(cx, cy, inner, end, start, true);
    else ctx.lineTo(cx, cy);
    ctx.closePath();
}

function drawDonut(ctx, view, style, width, targetH, now) {
    const L = donutLayout(view, style, width, targetH);
    drawFrame(ctx, view, style, width, L.height, L);
    const { rows, max } = view.model;
    const cx = L.legend ? L.pad + L.diameter / 2 : width / 2;
    const cy = L.top + L.chartH / 2;
    // Marge pour l'éclatement d'une part surlignée.
    const outer = L.diameter / 2 - 4;
    const inner = outer * (view.hole / 100);
    const sum = rows.reduce((s, row) => s + Math.max(0, shownOf(row)), 0);

    ringPath(ctx, cx, cy, outer, inner, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(style.text_color, 0.08);
    ctx.fill();

    if (sum > 0) {
        let angle = -Math.PI / 2;
        rows.forEach((row, i) => {
            const value = Math.max(0, shownOf(row));
            if (value <= 0) return;
            const sweep = (value / sum) * Math.PI * 2;
            const level = highlightFor(view, row.keys, now);
            // Part surlignée : légèrement sortie de l'anneau.
            const mid = angle + sweep / 2;
            const shift = level * 4;
            const ox = Math.cos(mid) * shift;
            const oy = Math.sin(mid) * shift;
            ringPath(ctx, cx + ox, cy + oy, outer, inner, angle, angle + sweep);
            ctx.fillStyle = categoryColor(view, style, row, i, max);
            ctx.fill();
            if (level > 0) {
                ctx.fillStyle = `rgba(255,255,255,${0.45 * level})`;
                ctx.fill();
            }
            // Séparation entre parts, couleur du fond.
            if (rows.length > 1 && sweep < Math.PI * 2 - 1e-6) {
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = style.background;
                ctx.stroke();
            }
            angle += sweep;
        });
    }

    // Total au centre si le trou le permet.
    if (inner >= L.fontSize * 2.2) {
        ctx.textAlign = 'center';
        ctx.fillStyle = style.text_color;
        const totalSize = Math.min(inner * 0.55, L.fontSize * 2);
        ctx.font = font(700, totalSize, view.fontFamily);
        ctx.fillText(view.formatNumber(Math.round(sum)), cx, cy - totalSize * 0.15);
        if (view.centerLabel) {
            ctx.font = font(500, Math.max(7, L.fontSize * 0.75), view.fontFamily);
            ctx.fillStyle = hexToRgba(style.text_color, 0.75);
            ctx.fillText(fitText(ctx, view.centerLabel, inner * 1.6), cx, cy + totalSize * 0.6);
        }
    }

    if (!L.legend) return;
    const legendX = L.pad + L.diameter + L.fontSize;
    const legendW = width - L.pad - legendX;
    const legendTop = L.top + (L.chartH - L.legendH) / 2;
    const swatch = Math.round(L.fontSize * 0.8);
    rows.forEach((row, i) => {
        const y = legendTop + (i + 0.5) * L.rowH;
        roundedRect(ctx, legendX, y - swatch / 2, swatch, swatch, 2);
        ctx.fillStyle = categoryColor(view, style, row, i, max);
        ctx.fill();
        let valueW = 0;
        if (view.showValues) {
            const shown = Math.max(0, shownOf(row));
            const text = view.showPercent && sum > 0
                ? view.formatPercent(shown / sum)
                : view.formatNumber(Math.round(shown));
            ctx.font = font(600, L.fontSize * 0.9, view.fontFamily);
            ctx.textAlign = 'right';
            ctx.fillStyle = style.text_color;
            ctx.fillText(text, width - L.pad, y);
            valueW = ctx.measureText(text).width + L.fontSize * 0.5;
        }
        ctx.font = font(500, L.fontSize, view.fontFamily);
        ctx.textAlign = 'left';
        ctx.fillStyle = style.text_color;
        const labelX = legendX + swatch + L.fontSize * 0.45;
        ctx.fillText(fitText(ctx, view.labelOf(row.key), legendW - (labelX - legendX) - valueW), labelX, y);
    });
}

// ---------------------------------------------------------------------------
// Courbe de progression
// ---------------------------------------------------------------------------

function lineLayout(view, style, width, targetH) {
    const frame = frameMetrics(view, style);
    const innerW = Math.max(1, width - frame.pad * 2);
    const axisH = Math.round(frame.fontSize * 1.5);
    const top = frame.pad + frame.titleH;
    // Plancher : en dessous, la courbe n'est plus qu'un trait illisible.
    const plotH = Number.isFinite(targetH)
        ? Math.max(frame.fontSize * 3.5, Math.round(targetH - top - axisH - frame.footH - frame.pad))
        : Math.round(Math.max(frame.fontSize * 6, innerW * 0.38));
    const height = Math.ceil(top + plotH + axisH + frame.footH + frame.pad);
    return { ...frame, top, innerW, plotH, axisH, height };
}

function drawLine(ctx, view, style, width, targetH, now) {
    const L = lineLayout(view, style, width, targetH);
    drawFrame(ctx, view, style, width, L.height, L);
    const model = view.model;
    // Marge haute pour la valeur posée au-dessus de la tête.
    const valueRoom = view.showValues ? L.fontSize * 1.4 : L.fontSize * 0.4;
    const left = L.pad;
    const right = width - L.pad;
    const bottom = L.top + L.plotH;
    const plotTop = L.top + valueRoom;
    const span = Math.max(1, model.last - model.first);
    const xOf = (day) => left + ((day - model.first) / span) * (right - left);
    const yOf = (total) => bottom - (model.max > 0 ? total / model.max : 0) * (bottom - plotTop);

    // Ligne de base et repère du maximum.
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexToRgba(style.text_color, 0.2);
    ctx.beginPath();
    ctx.moveTo(left, bottom + 0.5);
    ctx.lineTo(right, bottom + 0.5);
    ctx.stroke();
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(left, plotTop + 0.5);
    ctx.lineTo(right, plotTop + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // Axe : années de début et de fin, maximum.
    ctx.font = font(500, Math.max(7, L.fontSize * 0.85), view.fontFamily);
    ctx.fillStyle = hexToRgba(style.text_color, 0.75);
    const axisY = bottom + L.axisH / 2;
    const wStart = ctx.measureText(view.startLabel || '').width;
    const wEnd = ctx.measureText(view.endLabel || '').width;
    ctx.textAlign = 'left';
    ctx.fillText(view.startLabel || '', left, axisY);
    ctx.textAlign = 'right';
    ctx.fillText(view.endLabel || '', right, axisY);

    // Jalons annuels : un trait sous la ligne de base pour chacun ; l'année
    // centrée dessous, sauf collision avec les libellés de bord ou le jalon
    // précédent (éclaircissage — l'axe peut être court en Évolution).
    const ticks = view.ticks || [];
    if (ticks.length) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = hexToRgba(style.text_color, 0.2);
        ctx.beginPath();
        for (const tick of ticks) {
            const x = xOf(tick.day);
            ctx.moveTo(x, bottom);
            ctx.lineTo(x, bottom + 3);
        }
        ctx.stroke();
        ctx.textAlign = 'center';
        let lastRight = left + wStart;
        for (const tick of ticks) {
            const x = xOf(tick.day);
            const w = ctx.measureText(tick.label).width;
            if (x - w / 2 >= lastRight + 4 && x + w / 2 <= right - wEnd - 4) {
                ctx.fillText(tick.label, x, axisY);
                lastRight = x + w / 2;
            }
        }
    }
    if (!model.empty) {
        ctx.textAlign = 'left';
        ctx.fillText(view.formatNumber(model.max), left + 2, plotTop - L.fontSize * 0.55);
    }
    if (model.empty) return;

    // Tracé : un sommet par jour, en sautant ceux qui tombent sur le même pixel.
    const headTotal = Number.isFinite(model.shownTotal) ? model.shownTotal : model.total;
    const headDay = Number.isFinite(model.shownHeadDay) ? model.shownHeadDay : model.headDay;
    const pts = [[xOf(model.first), bottom]];
    let lastX = -Infinity;
    const lastIndex = model.points.length - 1;
    model.points.forEach((point, i) => {
        // Le dernier sommet suit la valeur animée : la courbe monte en douceur.
        const total = i === lastIndex ? Math.min(point.total, headTotal) : point.total;
        const x = xOf(point.day);
        if (x - lastX < 0.75 && i !== lastIndex) return;
        // Escalier : la valeur ne change qu'au jour de la trouvaille.
        pts.push([x, pts[pts.length - 1][1]]);
        pts.push([x, yOf(total)]);
        lastX = x;
    });
    const headX = Math.max(pts[pts.length - 1][0], xOf(headDay));
    const headY = pts[pts.length - 1][1];
    pts.push([headX, headY]);

    // Paliers franchis (100ᵉ, 500ᵉ… trouvaille) : pointillé depuis le bord
    // gauche jusqu'au jour du franchissement, nombre au bord comme un axe —
    // sauf s'il chevauche le maximum ou le palier précédent. Seuls les
    // paliers déjà atteints par la valeur animée : la courbe ne trahit pas
    // la suite.
    const milestones = (view.milestones || []).filter((m) => m.day !== null && m.value <= headTotal);
    if (milestones.length) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = hexToRgba(style.text_color, 0.3);
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        for (const m of milestones) {
            const y = Math.round(yOf(m.value)) + 0.5;
            ctx.moveTo(left, y);
            ctx.lineTo(xOf(m.day), y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = font(600, Math.max(7, L.fontSize * 0.8), view.fontFamily);
        ctx.fillStyle = hexToRgba(style.text_color, 0.75);
        ctx.textAlign = 'left';
        const maxLabelY = plotTop - L.fontSize * 0.55;
        let lastLabelY = Infinity;
        for (const m of milestones) {
            const labelY = yOf(m.value) - L.fontSize * 0.6;
            if (Math.abs(labelY - maxLabelY) < L.fontSize || lastLabelY - labelY < L.fontSize) continue;
            ctx.fillText(m.label, left + 2, labelY);
            lastLabelY = labelY;
        }
    }

    if (view.showArea) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], bottom);
        for (const [x, y] of pts) ctx.lineTo(x, y);
        ctx.lineTo(headX, bottom);
        ctx.closePath();
        const gradient = ctx.createLinearGradient(0, plotTop, 0, bottom);
        gradient.addColorStop(0, hexToRgba(style.accent_color, 0.45));
        gradient.addColorStop(1, hexToRgba(style.accent_color, 0.04));
        ctx.fillStyle = gradient;
        ctx.fill();
    }
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = style.accent_color;
    ctx.stroke();

    // Repères des paliers sur la courbe, halo au franchissement.
    for (const m of milestones) {
        const x = xOf(m.day);
        const y = yOf(m.value);
        if (m.level > 0) {
            ctx.beginPath();
            ctx.arc(x, y, 4 + m.level * 10, 0, Math.PI * 2);
            ctx.fillStyle = hexToRgba(style.accent_color, 0.45 * m.level);
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = style.accent_color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = style.text_color;
        ctx.stroke();
    }

    // Tête : point, halo tant que la dernière trouvaille est fraîche.
    const level = view.headLevel || 0;
    if (level > 0) {
        ctx.beginPath();
        ctx.arc(headX, headY, 4 + level * 6, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(style.accent_color, 0.35 * level);
        ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(headX, headY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = style.text_color;
    ctx.fill();
    if (view.showValues) {
        ctx.font = font(700, L.fontSize, view.fontFamily);
        ctx.fillStyle = style.text_color;
        const text = view.formatNumber(Math.round(headTotal));
        const textW = ctx.measureText(text).width;
        ctx.textAlign = 'left';
        const tx = Math.max(left, Math.min(right - textW, headX - textW / 2));
        ctx.fillText(text, tx, Math.max(plotTop - L.fontSize * 0.55, headY - L.fontSize * 0.9));
    }
}

// ---------------------------------------------------------------------------
// Compteurs
// ---------------------------------------------------------------------------

function counterLayout(view, style, width, targetH) {
    const frame = frameMetrics(view, style);
    const tiles = view.tiles.length;
    const columns = Math.max(1, Math.min(view.columns || 1, tiles || 1));
    const rows = Math.max(1, Math.ceil(tiles / columns));
    const gap = Math.round(frame.fontSize * 0.5);
    const top = frame.pad + frame.titleH;
    let tileH = Math.round(frame.fontSize * 4.4);
    if (Number.isFinite(targetH)) {
        // Les tuiles se répartissent la hauteur disponible ; plancher : le
        // chiffre (×1,9 la police) et son libellé restent lisibles.
        const avail = targetH - top - frame.footH - frame.pad;
        tileH = Math.max(frame.fontSize * 3.4, (avail - (rows - 1) * gap) / rows);
    }
    const chartH = rows * tileH + (rows - 1) * gap;
    const height = Math.ceil(top + chartH + frame.footH + frame.pad);
    return { ...frame, top, columns, rows, gap, tileH, chartH, height };
}

function drawCounters(ctx, view, style, width, targetH) {
    const L = counterLayout(view, style, width, targetH);
    drawFrame(ctx, view, style, width, L.height, L);
    const tileW = (width - L.pad * 2 - (L.columns - 1) * L.gap) / L.columns;
    view.tiles.forEach((tile, i) => {
        const col = i % L.columns;
        const row = Math.floor(i / L.columns);
        const x = L.pad + col * (tileW + L.gap);
        const y = L.top + row * (L.tileH + L.gap);
        roundedRect(ctx, x, y, tileW, L.tileH, Math.min(8, style.radius));
        ctx.fillStyle = hexToRgba(style.text_color, 0.07);
        ctx.fill();
        if (tile.level > 0) {
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = hexToRgba(style.accent_color, tile.level);
            ctx.stroke();
            ctx.fillStyle = hexToRgba(style.accent_color, 0.18 * tile.level);
            ctx.fill();
        }
        ctx.textAlign = 'center';
        const cx = x + tileW / 2;
        // Valeur trop large (coordonnée, grand nombre sur tuile étroite) : la
        // police rétrécit jusqu'à ×1,1 avant que fitText ne tronque.
        ctx.font = font(700, L.fontSize * 1.9, view.fontFamily);
        const valueW = ctx.measureText(tile.value).width;
        if (valueW > tileW - 6) {
            const size = Math.max(L.fontSize * 1.1, (L.fontSize * 1.9 * (tileW - 6)) / valueW);
            ctx.font = font(700, size, view.fontFamily);
        }
        ctx.fillStyle = tile.level > 0 ? style.accent_color : style.text_color;
        ctx.fillText(fitText(ctx, tile.value, tileW - 6), cx, y + L.tileH * 0.36);
        ctx.font = font(500, Math.max(7, L.fontSize * 0.8), view.fontFamily);
        ctx.fillStyle = hexToRgba(style.text_color, 0.85);
        ctx.fillText(fitText(ctx, tile.label, tileW - 6), cx, y + L.tileH * 0.68);
        if (tile.detail) {
            ctx.font = font(400, Math.max(7, L.fontSize * 0.7), view.fontFamily);
            ctx.fillStyle = hexToRgba(style.text_color, 0.6);
            ctx.fillText(fitText(ctx, tile.detail, tileW - 6), cx, y + L.tileH * 0.86);
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
        measure: (view, style, width, height) => barLayout(view, style, width, height).height,
        draw: drawBars,
    },
    donut: {
        measure: (view, style, width, height) => donutLayout(view, style, width, height).height,
        draw: drawDonut,
    },
    line: {
        measure: (view, style, width, height) => lineLayout(view, style, width, height).height,
        draw: drawLine,
    },
    counter: {
        measure: (view, style, width, height) => counterLayout(view, style, width, height).height,
        draw: drawCounters,
    },
});

// Hauteur en px CSS d'un panneau de largeur `width` ; `height` (optionnelle)
// impose la hauteur totale — étirée ou compressée jusqu'au plancher de
// lisibilité de chaque type (les grilles l'ignorent : cases carrées).
export function measureStatsPanel(view, style, width, height) {
    const renderer = STATS_RENDERERS[view?.kind];
    return renderer ? renderer.measure(view, style, width, height) : 0;
}

// Dessine un panneau dans `rect` (px du canvas cible). `cssWidth` est la
// largeur logique : le dessin se fait en px CSS, mis à l'échelle de `rect`.
// La hauteur logique est déduite du même rapport et re-résolue par le layout
// comme une hauteur imposée — max(x, plancher) est idempotent, le dessin
// remplit donc exactement `rect`, en aperçu comme en vidéo.
export function drawStatsPanel(ctx, rect, view, style, now, cssWidth) {
    const renderer = STATS_RENDERERS[view?.kind];
    if (!renderer || !(rect.width > 0) || !(cssWidth > 0)) return;
    const scale = rect.width / cssWidth;
    const cssHeight = rect.height > 0 ? rect.height / scale : null;
    ctx.save();
    ctx.translate(rect.x, rect.y);
    ctx.scale(scale, scale);
    try {
        renderer.draw(ctx, view, style, cssWidth, cssHeight, now);
    } finally {
        ctx.restore();
    }
}
