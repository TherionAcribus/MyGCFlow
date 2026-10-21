// Dessin d'une image posée sur la carte (onglet Images) : pur, sans DOM —
// utilisé tel quel par l'aperçu (un <canvas> par image) et par la vidéo
// (addImagePanelsToCanvas), comme stats_render.mjs pour les panneaux.
//
// Le dessin couvre la forme, le fond, la marge intérieure, l'ajustement,
// l'opacité et la bordure. L'ombre portée n'en fait pas partie : elle
// déborde de la boîte,
// donc du canvas de l'aperçu — CSS `filter: drop-shadow(...)` dans l'aperçu,
// cuite dans un second canvas élargi du cache vidéo (posée sur le canvas qui
// reçoit le panneau dessiné, pour l'ombre du composite comme `drop-shadow` ;
// un drawImage nu par frame), mêmes valeurs (IMAGE_SHADOW).

// Ombre portée : décalage vertical et flou en px CSS, couleur. Le flou d'un
// drop-shadow CSS et le shadowBlur du canvas ont la même échelle (écart type
// = moitié de la valeur), les deux rendus coïncident.
export const IMAGE_SHADOW = Object.freeze({ offsetY: 4, blur: 12, color: 'rgba(0, 0, 0, 0.35)' });

// Hauteur d'une image à sa largeur : imposée, sinon d'après les proportions
// de l'image (marge intérieure comprise). Rond : carré par défaut, pour un
// avatar bien circulaire. Proportions inconnues : carré (images_panels.js ne
// pose de toute façon une image qu'une fois décodée).
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
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (style.fit === 'cover' && pad > 0) {
            // Rogné à la zone intérieure : la marge reste visible. Ce clip
            // est isolé dans un save/restore : il ne doit pas rester actif
            // au moment de la bordure, qui serait rognée à la zone
            // intérieure — le clip de la forme suffit à la contenir.
            ctx.save();
            ctx.beginPath();
            ctx.rect(pad, pad, width - 2 * pad, height - 2 * pad);
            ctx.clip();
            ctx.drawImage(source, target.x, target.y, target.width, target.height);
            ctx.restore();
        } else {
            ctx.drawImage(source, target.x, target.y, target.width, target.height);
        }
    }
    // Bordure en dernier, à l'intérieur de la boîte : le trait est doublé et
    // sa moitié externe est rognée par le clip de la forme (toujours actif
    // depuis le début) — un liseré exact de border_width px, rien ne déborde.
    if (style.border_width > 0) {
        shapePath(ctx, style.shape, 0, 0, width, height, style.radius * scale);
        ctx.strokeStyle = style.border_color;
        ctx.lineWidth = style.border_width * 2 * scale;
        ctx.stroke();
    }
    ctx.restore();
}
