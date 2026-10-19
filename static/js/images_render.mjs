// Dessin d'une image posée sur la carte (onglet Images) : pur, sans DOM —
// utilisé tel quel par l'aperçu (un <canvas> par image) et par la vidéo
// (addImagePanelsToCanvas), comme stats_render.mjs pour les panneaux.
//
// Le dessin couvre la forme, le fond, la marge intérieure, l'ajustement et
// l'opacité. L'ombre portée n'en fait pas partie : elle déborde de la boîte,
// donc du canvas de l'aperçu — CSS `filter: drop-shadow(...)` dans l'aperçu,
// `shadowBlur` du contexte dans la vidéo, mêmes valeurs (IMAGE_SHADOW).

// Ombre portée : décalage vertical et flou en px CSS, couleur. Le flou d'un
// drop-shadow CSS et le shadowBlur du canvas ont la même échelle (écart type
// = moitié de la valeur), les deux rendus coïncident.
export const IMAGE_SHADOW = Object.freeze({ offsetY: 4, blur: 12, color: 'rgba(0, 0, 0, 0.35)' });

// Hauteur d'une image à sa largeur : imposée, sinon d'après les proportions
// de l'image (marge intérieure comprise). Rond : carré par défaut, pour un
// avatar bien circulaire. Image pas encore décodée : carré provisoire.
export function imagePanelHeight(item, natural, width = item.position.width) {
    const imposed = item.position.height;
    if (imposed != null) return imposed;
    if (item.style.shape === 'circle') return width;
    if (!natural || !(natural.width > 0) || !(natural.height > 0)) return width;
    const pad = Math.min(item.style.padding, width / 2);
    const inner = Math.max(1, width - 2 * pad);
    return Math.max(1, Math.round(inner * (natural.height / natural.width) + 2 * pad));
}

// Rect de l'image dans sa zone (x, y, w, h) selon l'ajustement : `contain`
// montre toute l'image (bandes vides éventuelles), `cover` remplit la zone
// (l'excédent est rogné par la forme).
export function fitRect(fit, natural, x, y, w, h) {
    if (!natural || !(natural.width > 0) || !(natural.height > 0)) return { x, y, width: w, height: h };
    const scale = fit === 'cover'
        ? Math.max(w / natural.width, h / natural.height)
        : Math.min(w / natural.width, h / natural.height);
    const width = natural.width * scale;
    const height = natural.height * scale;
    return { x: x + (w - width) / 2, y: y + (h - height) / 2, width, height };
}

function shapePath(ctx, shape, x, y, w, h, radius) {
    ctx.beginPath();
    if (shape === 'circle') {
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        return;
    }
    const r = shape === 'rounded' ? Math.max(0, Math.min(radius, w / 2, h / 2)) : 0;
    if (r <= 0) {
        ctx.rect(x, y, w, h);
        return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function hexToRgba(hex, alpha) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return `rgba(255, 255, 255, ${alpha})`;
    return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

// Dessine l'image dans un contexte de `width` × `height` px réels, en (0, 0).
// `scale` : px réels par px CSS (rayon, marge intérieure). `source` : image
// décodée (naturalWidth/naturalHeight, ou width/height d'un bitmap) ; absente,
// seuls la forme et le fond sont dessinés.
export function drawImagePanel(ctx, width, height, item, source, scale = 1) {
    const style = item.style;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, style.opacity / 100));
    shapePath(ctx, style.shape, 0, 0, width, height, style.radius * scale);
    ctx.clip();
    if (style.background_opacity > 0) {
        ctx.fillStyle = hexToRgba(style.background, style.background_opacity / 100);
        ctx.fillRect(0, 0, width, height);
    }
    if (source) {
        const natural = {
            width: source.naturalWidth || source.width || 0,
            height: source.naturalHeight || source.height || 0,
        };
        const pad = Math.min(style.padding * scale, width / 2, height / 2);
        const target = fitRect(style.fit, natural, pad, pad, width - 2 * pad, height - 2 * pad);
        if (style.fit === 'cover' && pad > 0) {
            // Rogné à la zone intérieure : la marge reste visible.
            ctx.beginPath();
            ctx.rect(pad, pad, width - 2 * pad, height - 2 * pad);
            ctx.clip();
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, target.x, target.y, target.width, target.height);
    }
    ctx.restore();
}
