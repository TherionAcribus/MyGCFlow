// Rendu des overlays (titre, infos) sur un canvas d'enregistrement.
//
// Extrait de mapgl.js. Réimplémente en Canvas 2D le rendu CSS des deux boîtes
// #titleFrame et #infosFrame : styles, bordures, dégradés, opacité de groupe,
// retour à la ligne et transformation du texte.
//
// Les propriétés statiques (styles CSS, positions) sont mises en cache pour
// éviter un reflow à chaque frame ; seul le contenu textuel dynamique est relu.
// Le cache est invalidé au redimensionnement, au chargement des polices et par
// frames.js à chaque modification de style (via pkg.invalidateOverlayCache).
import * as pkg from './index.js';
import { digitAdvance, isTabularNums, layoutTabularText } from './tabular_text.mjs';
import { INFOS_SEPARATOR } from './infos_reserve.mjs';
import { isEvolutionPage } from './app_mode.mjs';

// Largeur commune des chiffres par police (font-variant-numeric: tabular-nums).
// Mesurer les dix chiffres à chaque frame serait inutile : la police ne change
// qu'avec le cache d'overlays.
const digitLayoutByFont = new Map();

function tabularDigitLayout(ctx, font) {
    if (digitLayoutByFont.has(font)) return digitLayoutByFont.get(font);
    const widths = Array.from('0123456789', glyph => ctx.measureText(glyph).width);
    const width = digitAdvance((glyph) => ctx.measureText(glyph).width);
    const layout = {
        // Beaucoup de polices de l'application ont déjà des chiffres tabulaires
        // par défaut. Dans ce cas, garder fillText sur la ligne complète préserve
        // le crénage et la mise en forme du navigateur.
        requiresManualLayout: Math.max(...widths) - Math.min(...widths) > 0.01,
        width,
    };
    digitLayoutByFont.set(font, layout);
    return layout;
}

// Cache des overlays : calculé une seule fois au démarrage de chaque session
// pour éviter getElementById / getBoundingClientRect / getComputedStyle à chaque frame
let overlayCache = null;
let overlayCacheRevision = 0;
let overlayLayerCanvas = null;

export function invalidateOverlayCache() {
    overlayCache = null;
    overlayCacheRevision += 1;
    digitLayoutByFont.clear();
}

// Exposé pour la signature de contenu du pipeline MediaRecorder : une
// invalidation du cache doit compter comme un changement d'overlay.
export function getOverlayCacheRevision() {
    return overlayCacheRevision;
}

if (typeof window !== 'undefined') {
    window.addEventListener('resize', invalidateOverlayCache, { passive: true });
    try { document.fonts?.ready?.then(invalidateOverlayCache); } catch(_) {}
}

function acquireOverlayLayerCanvas(width, height) {
    if (!overlayLayerCanvas) overlayLayerCanvas = document.createElement('canvas');
    if (overlayLayerCanvas.width !== width || overlayLayerCanvas.height !== height) {
        overlayLayerCanvas.width = width;
        overlayLayerCanvas.height = height;
    } else {
        overlayLayerCanvas.getContext('2d')?.clearRect(0, 0, width, height);
    }
    return overlayLayerCanvas;
}
export function buildOverlayCache(scaleFactor) {
    overlayCache = null;
    const container = document.getElementById('mapWithFrames');
    if (!container) return;
    const containerRect = container.getBoundingClientRect();

    const cacheElement = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        const x = (rect.left - containerRect.left) * scaleFactor;
        const y = (rect.top - containerRect.top) * scaleFactor;
        const w = rect.width * scaleFactor;
        const h = rect.height * scaleFactor;
        const rightGap = Math.max(0, (containerRect.right - rect.right) * scaleFactor);
        const bottomGap = Math.max(0, (containerRect.bottom - rect.bottom) * scaleFactor);

        const bg = style.backgroundColor || 'rgba(255,255,255,1)';
        const color = style.color || '#000';
        const radius = (parseFloat(style.borderRadius) || 0) * scaleFactor;
        const padL = (parseFloat(style.paddingLeft) || 0) * scaleFactor;
        const padR = (parseFloat(style.paddingRight) || 0) * scaleFactor;
        const padT = (parseFloat(style.paddingTop) || 0) * scaleFactor;
        const fontSizePx = parseFloat(style.fontSize) || 16;
        const fontPx = fontSizePx * scaleFactor;
        const font = `${style.fontStyle || 'normal'} ${style.fontWeight || 'normal'} ${fontPx}px ${style.fontFamily || 'Arial'}`;
        const textAlignCss = style.textAlign || 'left';

        const shadowRaw = style.boxShadow && style.boxShadow !== 'none' ? style.boxShadow : null;
        let shColor = 'rgba(0,0,0,0)', shBlur = 0, shSpread = 0, shOffX = 0, shOffY = 0;
        if (shadowRaw) {
            const parts = shadowRaw.match(/(rgba?\([^\)]+\))\s+([-0-9.]+)px\s+([-0-9.]+)px\s+([-0-9.]+)px(?:\s+([-0-9.]+)px)?/);
            if (parts) {
                shColor = parts[1];
                shOffX = parseFloat(parts[2]) * scaleFactor;
                shOffY = parseFloat(parts[3]) * scaleFactor;
                shBlur = parseFloat(parts[4]) * scaleFactor;
                shSpread = (parseFloat(parts[5]) || 0) * scaleFactor;
            }
        }

        const padB = (parseFloat(style.paddingBottom) || 0) * scaleFactor;
        const lineHeightCss = parseFloat(style.lineHeight);

        const borderFor = (side) => ({
            width: (parseFloat(style[`border${side}Width`]) || 0) * scaleFactor,
            style: style[`border${side}Style`] || 'none',
            color: style[`border${side}Color`] || 'rgba(0,0,0,0)',
        });
        const borders = {
            top: borderFor('Top'), right: borderFor('Right'),
            bottom: borderFor('Bottom'), left: borderFor('Left'),
        };
        const inlineLeft = el.style.left && el.style.left !== 'auto';
        const inlineRight = el.style.right && el.style.right !== 'auto';
        const inlineTop = el.style.top && el.style.top !== 'auto';
        const inlineBottom = el.style.bottom && el.style.bottom !== 'auto';
        const horizontalAnchor = inlineLeft && inlineRight ? 'both'
            : inlineRight ? 'right'
            : inlineLeft ? 'left'
            : (rightGap < x ? 'right' : 'left');
        const verticalAnchor = inlineTop && inlineBottom ? 'both'
            : inlineBottom ? 'bottom'
            : inlineTop ? 'top'
            : (bottomGap < y ? 'bottom' : 'top');

        const parsedOpacity = parseFloat(style.opacity);
        return {
            el, x, y, w, h, bg, color, radius, padL, padR: (parseFloat(style.paddingRight) || 0) * scaleFactor,
            padT, padB, font, fontPx, textAlignCss, hasShadow: !!shadowRaw,
            shColor, shBlur, shSpread, shOffX, shOffY,
            borders,
            opacity: Number.isFinite(parsedOpacity) ? Math.max(0, Math.min(1, parsedOpacity)) : 1,
            letterSpacing: (parseFloat(style.letterSpacing) || 0) * scaleFactor,
            // Chiffres à largeur fixe : le navigateur l'applique au texte HTML,
            // pas à fillText() — c'est à nous de le refaire (cf. tabular_text.mjs).
            tabularNums: isTabularNums(style.fontVariantNumeric),
            textTransform: style.textTransform || 'none',
            backgroundImage: style.backgroundImage || 'none',
            zIndex: Number.isFinite(parseInt(style.zIndex, 10)) ? parseInt(style.zIndex, 10) : 0,
            leftGap: Math.max(0, x), rightGap,
            topGap: Math.max(0, y), bottomGap,
            horizontalAnchor, verticalAnchor,
            lineGap: (Number.isFinite(lineHeightCss) ? lineHeightCss : fontSizePx * 1.2) * scaleFactor,
        };
    };

    overlayCache = {
        revision: overlayCacheRevision,
        scaleFactor,
        title: cacheElement('titleFrame'),
        infos: cacheElement('infosFrame'),
    };
}

// Ajoute les overlays (titre, date, nb caches) au canvas d'enregistrement.
// Les propriétés statiques (styles CSS, positions) sont lues depuis overlayCache
// pour éviter des reflows à chaque frame. Seul le contenu textuel dynamique est relu.
export function getOverlayTextContent() {
    const opts = pkg.options?.infos;
    const title = opts?.title?.display === true
        ? (document.getElementById('titleFrame')?.textContent || '')
        : '';
    const infoParts = [];
    if (isEvolutionPage()) {
        // Ligne à balises : le span du modèle est tenu à jour par mapgl.js ;
        // les spans classiques existent mais sont masqués dans ce mode.
        infoParts.push(document.getElementById('spanInfosTemplate')?.textContent || '');
    } else {
        if (opts?.numberOfCaches?.display === true) {
            infoParts.push(document.getElementById('spanNbCaches')?.textContent || '0');
        }
        if (opts?.currentDate?.display === true) {
            infoParts.push(document.getElementById('spanCurrentDate')?.textContent || '--/--/----');
        }
    }
    // Même séparateur que le DOM (#spanInfosSep) : l'aperçu et la vidéo doivent
    // afficher exactement la même ligne.
    return { title, infos: infoParts.join(INFOS_SEPARATOR) };
}

export function addOverlaysToCanvas(ctx, canvasWidth, canvasHeight, scaleFactor = 1) {
    if (!overlayCache || overlayCache.scaleFactor !== scaleFactor || overlayCache.revision !== overlayCacheRevision) {
        buildOverlayCache(scaleFactor);
    }
    if (!overlayCache) return;

    try {
        const renderFromCache = (cached, text) => {
            if (!cached || !cached.el) return;
            if (!text || !text.trim()) return;

            const { x, y, w, h, bg, color, radius, padL, padR, padT, padB, font, fontPx, textAlignCss, tabularNums,
                    hasShadow, shColor, shBlur, shSpread, shOffX, shOffY, lineGap,
                    borders, opacity, letterSpacing, textTransform, backgroundImage,
                    leftGap, rightGap, topGap, bottomGap,
                    horizontalAnchor, verticalAnchor } = cached;

            // CSS applique opacity au groupe complet. Dessiner directement chaque primitive
            // avec globalAlpha cumulerait l'alpha aux intersections texte/fond/bordure.
            const layer = opacity < 1 ? acquireOverlayLayerCanvas(canvasWidth, canvasHeight) : null;
            const paintCtx = layer?.getContext('2d') || ctx;
            paintCtx.save();
            paintCtx.imageSmoothingEnabled = true;
            paintCtx.imageSmoothingQuality = 'high';
            paintCtx.font = font;
            paintCtx.textBaseline = 'alphabetic';
            const tabularLayout = tabularNums ? tabularDigitLayout(paintCtx, font) : null;
            const digitWidth = tabularLayout?.requiresManualLayout ? tabularLayout.width : 0;
            // Chromium sait appliquer letter-spacing directement au texte Canvas.
            // On peut alors dessiner la ligne d'un bloc et conserver crénage,
            // ligatures et largeur d'avance CSS. Le repli manuel reste nécessaire
            // pour un navigateur ancien ou des chiffres réellement proportionnels.
            const nativeLetterSpacing = 'letterSpacing' in paintCtx && !digitWidth;
            if (nativeLetterSpacing) paintCtx.letterSpacing = `${letterSpacing}px`;
            const layoutLetterSpacing = nativeLetterSpacing ? 0 : letterSpacing;

            const transformedText = transformOverlayText(String(text), textTransform);
            const leftMargin = horizontalAnchor === 'right' ? 0 : leftGap;
            const rightMargin = horizontalAnchor === 'left' ? 0 : rightGap;
            const availableBoxWidth = Math.max(1, canvasWidth - leftMargin - rightMargin);
            const horizontalBorders = borders.left.width + borders.right.width;
            const availableTextWidth = Math.max(1, Math.min(w, availableBoxWidth) - horizontalBorders - padL - padR);
            const lines = transformedText
                .split(/\r?\n/)
                .flatMap(line => wrapOverlayText(paintCtx, line, availableTextWidth, layoutLetterSpacing, digitWidth));

            // CSS aligne le texte dans une boîte de ligne basée sur les métriques de
            // la police, et non sur la seule encre visible de "Mg". Utiliser les
            // actualBoundingBox* recentrait les glyphes différemment de l'aperçu.
            const fm = paintCtx.measureText('Mg');
            const ascent = Number.isFinite(fm.fontBoundingBoxAscent)
                ? fm.fontBoundingBoxAscent
                : fontPx * 0.8;
            const descent = Number.isFinite(fm.fontBoundingBoxDescent)
                ? fm.fontBoundingBoxDescent
                : fontPx * 0.2;
            const fontBoxHeight = ascent + descent;
            const lh = lineGap > 0 ? lineGap : fontBoxHeight;

            // La taille mesurée du DOM est la source de vérité. Le cartouche Infos
            // réserve déjà dans le DOM sa largeur maximale (frames.js) et chaque
            // changement de titre invalide le cache : faire grandir la boîte ici
            // créerait une géométrie différente de la preview.
            const drawW = Math.min(availableBoxWidth, w);
            const drawH = Math.min(canvasHeight, h);
            let drawX = x;
            let drawY = y;
            if (horizontalAnchor === 'right') drawX = canvasWidth - rightGap - drawW;
            else if (horizontalAnchor === 'both') drawX = leftGap;
            if (verticalAnchor === 'bottom') drawY = canvasHeight - bottomGap - drawH;
            else if (verticalAnchor === 'both') drawY = topGap;
            drawX = Math.max(0, Math.min(canvasWidth - drawW, drawX));
            drawY = Math.max(0, Math.min(canvasHeight - drawH, drawY));

            if (hasShadow) {
                paintCtx.shadowColor = shColor;
                paintCtx.shadowBlur = shBlur + Math.max(0, shSpread * 2);
                paintCtx.shadowOffsetX = shOffX;
                paintCtx.shadowOffsetY = shOffY;
            }
            const fillStyle = createOverlayFillStyle(paintCtx, backgroundImage, bg, drawX, drawY, drawW, drawH);
            drawRoundedRect(paintCtx, drawX, drawY, drawW, drawH, radius, fillStyle);
            paintCtx.shadowColor = 'rgba(0,0,0,0)';
            drawOverlayBorders(paintCtx, drawX, drawY, drawW, drawH, radius, borders);

            paintCtx.fillStyle = color;
            if (textAlignCss === 'center') paintCtx.textAlign = 'center';
            else if (textAlignCss === 'right' || textAlignCss === 'end') paintCtx.textAlign = 'right';
            else paintCtx.textAlign = 'left';

            // Comme un bloc CSS, la première boîte de ligne commence après la
            // bordure et le padding supérieurs. Une hauteur explicite laisse donc
            // l'espace supplémentaire sous le texte au lieu de le recentrer.
            const contentLeft = drawX + borders.left.width + padL;
            const contentRight = drawX + drawW - borders.right.width - padR;
            const contentTop = drawY + borders.top.width + padT;
            let curY = contentTop + ((lh - fontBoxHeight) / 2) + ascent;
            lines.forEach(line => {
                if (!line) { curY += lh; return; }
                let xText = contentLeft;
                if (paintCtx.textAlign === 'center') xText = (contentLeft + contentRight) / 2;
                else if (paintCtx.textAlign === 'right') xText = contentRight;
                drawOverlayText(paintCtx, line, xText, curY, layoutLetterSpacing, digitWidth);
                curY += lh;
            });
            paintCtx.restore();
            if (layer) {
                ctx.save();
                ctx.globalAlpha = opacity;
                ctx.drawImage(layer, 0, 0);
                ctx.restore();
            }
        };

        const content = getOverlayTextContent();
        const overlays = [];
        if (content.title) overlays.push({ cached: overlayCache.title, text: content.title });
        if (content.infos) overlays.push({ cached: overlayCache.infos, text: content.infos });

        overlays
            .filter(item => item.cached)
            .sort((a, b) => a.cached.zIndex - b.cached.zIndex)
            .forEach(item => renderFromCache(item.cached, item.text));

    } catch (error) {
        console.warn('Erreur lors du rendu des overlays:', error);
    }
}

function wrapOverlayText(ctx, text, maxWidth, letterSpacing = 0, digitWidth = 0) {
    if (!text || measureOverlayText(ctx, text, letterSpacing, digitWidth) <= maxWidth) return [text];
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    const pushLongToken = (token) => {
        let chunk = '';
        for (const glyph of Array.from(token)) {
            const candidate = chunk + glyph;
            if (chunk && measureOverlayText(ctx, candidate, letterSpacing, digitWidth) > maxWidth) {
                lines.push(chunk);
                chunk = glyph;
            } else {
                chunk = candidate;
            }
        }
        return chunk;
    };
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (measureOverlayText(ctx, candidate, letterSpacing, digitWidth) <= maxWidth) {
            current = candidate;
        } else {
            if (current) lines.push(current);
            current = measureOverlayText(ctx, word, letterSpacing, digitWidth) <= maxWidth
                ? word
                : pushLongToken(word);
        }
    }
    if (current || !lines.length) lines.push(current);
    return lines;
}

function transformOverlayText(text, transform) {
    if (transform === 'uppercase') return text.toLocaleUpperCase();
    if (transform === 'lowercase') return text.toLocaleLowerCase();
    if (transform === 'capitalize') return text.replace(/(^|\s)\S/g, value => value.toLocaleUpperCase());
    return text;
}

function measureOverlayText(ctx, text, letterSpacing = 0, digitWidth = 0) {
    if (!letterSpacing && !digitWidth) return ctx.measureText(text || '').width;
    return layoutTabularText(text, (glyph) => ctx.measureText(glyph).width,
        { letterSpacing, digitWidth }).width;
}

function drawOverlayText(ctx, text, x, y, letterSpacing = 0, digitWidth = 0) {
    if (!letterSpacing && !digitWidth) {
        ctx.fillText(text, x, y);
        return;
    }
    const { positions, width } = layoutTabularText(text, (glyph) => ctx.measureText(glyph).width,
        { letterSpacing, digitWidth });
    let origin = x;
    if (ctx.textAlign === 'center') origin -= width / 2;
    else if (ctx.textAlign === 'right') origin -= width;
    ctx.save();
    ctx.textAlign = 'left';
    for (const { glyph, x: offset } of positions) {
        ctx.fillText(glyph, origin + offset, y);
    }
    ctx.restore();
}

function splitCssArguments(value) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
        if (value[i] === '(') depth += 1;
        else if (value[i] === ')') depth -= 1;
        else if (value[i] === ',' && depth === 0) {
            parts.push(value.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(value.slice(start).trim());
    return parts;
}

function createOverlayFillStyle(ctx, backgroundImage, fallback, x, y, width, height) {
    const match = String(backgroundImage || '').match(/^linear-gradient\((.*)\)$/i);
    if (!match) return fallback;
    const args = splitCssArguments(match[1]);
    let degrees = 180;
    if (/^-?[\d.]+deg$/i.test(args[0])) degrees = parseFloat(args.shift());
    const radians = degrees * Math.PI / 180;
    const dx = Math.sin(radians);
    const dy = -Math.cos(radians);
    const extent = Math.abs(width * dx) + Math.abs(height * dy);
    const cx = x + width / 2;
    const cy = y + height / 2;
    const gradient = ctx.createLinearGradient(
        cx - dx * extent / 2, cy - dy * extent / 2,
        cx + dx * extent / 2, cy + dy * extent / 2,
    );
    args.forEach((stop, index) => {
        const positioned = stop.match(/^(.*)\s+(-?[\d.]+)%$/);
        const color = (positioned?.[1] || stop).trim();
        if (!color) return;
        const offset = positioned?.[2] == null
            ? (args.length <= 1 ? 0 : index / (args.length - 1))
            : Math.max(0, Math.min(1, parseFloat(positioned[2]) / 100));
        try { gradient.addColorStop(offset, color); } catch(_) {}
    });
    return gradient;
}

function setOverlayLineDash(ctx, style, width) {
    if (style === 'dashed') ctx.setLineDash([Math.max(2, width * 3), Math.max(2, width * 2)]);
    else if (style === 'dotted') { ctx.setLineDash([Math.max(1, width), Math.max(2, width * 2)]); ctx.lineCap = 'round'; }
    else ctx.setLineDash([]);
}

function drawOverlayBorders(ctx, x, y, width, height, radius, borders) {
    if (!borders) return;
    const sides = Object.values(borders);
    const active = sides.filter(border => border.width > 0 && border.style !== 'none');
    if (!active.length) return;
    const uniform = active.length === 4 && sides.every(border =>
        border.width === sides[0].width && border.style === sides[0].style && border.color === sides[0].color
    );
    ctx.save();
    if (uniform) {
        const border = sides[0];
        const inset = border.width / 2;
        setOverlayLineDash(ctx, border.style, border.width);
        roundedRectPath(ctx, x + inset, y + inset, width - border.width, height - border.width, Math.max(0, radius - inset));
        ctx.lineWidth = border.width;
        ctx.strokeStyle = border.color;
        ctx.stroke();
    } else {
        const definitions = [
            ['top', x, y, x + width, y], ['right', x + width, y, x + width, y + height],
            ['bottom', x + width, y + height, x, y + height], ['left', x, y + height, x, y],
        ];
        definitions.forEach(([side, x1, y1, x2, y2]) => {
            const border = borders[side];
            if (!border || border.width <= 0 || border.style === 'none') return;
            ctx.beginPath();
            setOverlayLineDash(ctx, border.style, border.width);
            ctx.lineWidth = border.width;
            ctx.strokeStyle = border.color;
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        });
    }
    ctx.restore();
}

function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius || 0, Math.min(width, height) / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle, strokeStyle = null, lineWidth = 0) {
    roundedRectPath(ctx, x, y, width, height, radius);
    if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }

    if (strokeStyle && lineWidth > 0) {
        // La bordure CSS est dessinée à l'intérieur de la border-box : on trace le contour
        // en retrait d'une demi-épaisseur pour que le trait reste dans la boîte.
        const inset = lineWidth / 2;
        // Pas d'ombre sur le trait de bordure (l'ombre vient déjà du fond)
        ctx.shadowColor = 'rgba(0,0,0,0)';
        roundedRectPath(ctx, x + inset, y + inset, width - lineWidth, height - lineWidth, Math.max(0, radius - inset));
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = strokeStyle;
        ctx.stroke();
    }
}
