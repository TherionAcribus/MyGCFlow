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
// pose de toute façon une image qu'une fois décodée). Un quart de tour
// échange les proportions : l'image tournée de 90°/270° monte en portrait.
export function imagePanelHeight(item, natural, width = item.position.width) {
    const imposed = item.position.height;
    if (imposed != null) return imposed;
    if (item.style.shape === 'circle') return width;
    if (!natural || !(natural.width > 0) || !(natural.height > 0)) return width;
    const shown = naturalInDisplay(natural, item.style.rotate);
    const pad = Math.min(item.style.padding, width / 2);
    const inner = Math.max(1, width - 2 * pad);
    return Math.max(1, Math.round(inner * (shown.height / shown.width) + 2 * pad));
}

// Proportions de l'image telle qu'affichée : un quart de tour échange
// largeur et hauteur, le miroir n'y change rien.
export function naturalInDisplay(natural, rotate) {
    return (rotate === 90 || rotate === 270)
        ? { width: natural.height, height: natural.width }
        : natural;
}

// Point focal vu dans l'espace affiché : le réglage (`focus_x`/`focus_y`,
// en % de l'image SOURCE — celle montrée par le sélecteur du formulaire) y
// est transporté par la même transformée que le dessin : rotation d'abord,
// puis retournement horizontal du résultat (x, y ∈ [0, 1]).
export function focusInDisplay(style) {
    const x = (style.focus_x ?? 50) / 100;
    const y = (style.focus_y ?? 50) / 100;
    let rx = x;
    let ry = y;
    switch (style.rotate) {
        case 90: rx = 1 - y; ry = x; break;
        case 180: rx = 1 - x; ry = 1 - y; break;
        case 270: rx = y; ry = 1 - x; break;
    }
    return { x: style.mirror ? 1 - rx : rx, y: ry };
}

// Rect de l'image dans sa zone (x, y, w, h) selon l'ajustement : `contain`
// montre toute l'image (bandes vides éventuelles), `cover` remplit la zone
// (l'excédent est rogné par la forme). `focus` (fractions [0, 1] de l'image)
// place en `cover` le point focal à la même fraction de la zone — il reste
// donc dans la partie visible ; 0.5 = cadrage centré. Comme la fraction est
// bornée, l'image couvre toujours la zone, sans clampage.
export function fitRect(fit, natural, x, y, w, h, focus = null) {
    if (!natural || !(natural.width > 0) || !(natural.height > 0)) return { x, y, width: w, height: h };
    const scale = fit === 'cover'
        ? Math.max(w / natural.width, h / natural.height)
        : Math.min(w / natural.width, h / natural.height);
    const width = natural.width * scale;
    const height = natural.height * scale;
    if (fit === 'cover' && focus) {
        const fx = Number.isFinite(focus.x) ? Math.max(0, Math.min(1, focus.x)) : 0.5;
        const fy = Number.isFinite(focus.y) ? Math.max(0, Math.min(1, focus.y)) : 0.5;
        return { x: x + fx * (w - width), y: y + fy * (h - height), width, height };
    }
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
        const rotate = style.rotate || 0;
        const target = fitRect(style.fit, naturalInDisplay(natural, rotate),
            pad, pad, width - 2 * pad, height - 2 * pad, focusInDisplay(style));
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const draw = () => {
            if (rotate || style.mirror) {
                // L'image pivotée/miroir occupe le même rect : tournée autour
                // de son centre, ses dimensions avant rotation sont celles du
                // rect échangées. Le point focal (espace source) suit via
                // focusInDisplay — le point choisi reste dans le visible.
                const w = (rotate === 90 || rotate === 270) ? target.height : target.width;
                const h = (rotate === 90 || rotate === 270) ? target.width : target.height;
                ctx.save();
                ctx.translate(target.x + target.width / 2, target.y + target.height / 2);
                // Miroir dans l'espace affiché (avant rotate dans le code =
                // après dans la composée) : le bouton retourne toujours
                // horizontalement ce que l'on voit, à toute rotation.
                if (style.mirror) ctx.scale(-1, 1);
                ctx.rotate(rotate * Math.PI / 180);
                ctx.drawImage(source, -w / 2, -h / 2, w, h);
                ctx.restore();
            } else {
                ctx.drawImage(source, target.x, target.y, target.width, target.height);
            }
        };
        if (style.fit === 'cover' && pad > 0) {
            // Rogné à la zone intérieure : la marge reste visible. Ce clip
            // est isolé dans un save/restore : il ne doit pas rester actif
            // au moment de la bordure, qui serait rognée à la zone
            // intérieure — le clip de la forme suffit à la contenir.
            ctx.save();
            ctx.beginPath();
            ctx.rect(pad, pad, width - 2 * pad, height - 2 * pad);
            ctx.clip();
            draw();
            ctx.restore();
        } else {
            draw();
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

// ---------------------------------------------------------------------------
// Effets d'entrée et de sortie (planing d'apparition)
// ---------------------------------------------------------------------------
//
// Le fondu (opacité, linéaire) accompagne toujours l'effet. « slide » fait
// entrer l'image depuis le bord du cadre le plus proche, « zoom » la fait
// grandir depuis la moitié de sa taille avec un léger rebond. La même courbe
// de Bézier cubique sert à la transition CSS de l'aperçu (transform) et,
// évaluée par cubicBezier, à la vidéo : les deux mouvements coïncident.

export const IMAGE_EFFECT_EASINGS = Object.freeze({
    slide: Object.freeze([0.215, 0.61, 0.355, 1]),   // « ease-out » cubique
    zoom: Object.freeze([0.34, 1.56, 0.64, 1]),      // « ease-out » avec rebond
});
// Échelle de départ (image cachée) de l'effet « zoom ».
export const IMAGE_ZOOM_FROM = 0.5;

// Courbe CSS `cubic-bezier(x1, y1, x2, y2)` évaluée en JS : progression du
// temps x ∈ [0, 1] → avancement y (peut dépasser 1 : rebond). Résolution de
// x(t) par Newton, repli par dichotomie (même méthode que les navigateurs).
export function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    const solveX = (x) => {
        let t = x;
        for (let i = 0; i < 8; i++) {
            const error = sampleX(t) - x;
            if (Math.abs(error) < 1e-7) return t;
            const slope = slopeX(t);
            if (Math.abs(slope) < 1e-7) break;
            t -= error / slope;
        }
        let lo = 0;
        let hi = 1;
        t = x;
        for (let i = 0; i < 60 && hi - lo > 1e-7; i++) {
            const value = sampleX(t);
            if (Math.abs(value - x) < 1e-7) return t;
            if (x > value) lo = t;
            else hi = t;
            t = (lo + hi) / 2;
        }
        return t;
    };
    return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solveX(x)));
}

// Valeur CSS `transition-timing-function` d'un effet ('linear' pour le fondu).
export function effectTimingCss(effect) {
    const easing = IMAGE_EFFECT_EASINGS[effect];
    return easing ? `cubic-bezier(${easing.join(', ')})` : 'linear';
}

// Décalage vers l'extérieur du cadre, par le bord le plus proche de l'image
// (à égalité : gauche, droite, haut, bas) — juste assez pour qu'elle soit
// entièrement dehors.
function slideOffset(rect, container) {
    const gaps = [
        ['left', rect.x],
        ['right', container.width - rect.x - rect.width],
        ['top', rect.y],
        ['bottom', container.height - rect.y - rect.height],
    ];
    let [side] = gaps[0];
    let best = gaps[0][1];
    for (const [name, gap] of gaps) {
        if (gap < best) {
            best = gap;
            side = name;
        }
    }
    if (side === 'left') return { dx: -(rect.x + rect.width), dy: 0 };
    if (side === 'right') return { dx: container.width - rect.x, dy: 0 };
    if (side === 'top') return { dx: 0, dy: -(rect.y + rect.height) };
    return { dx: 0, dy: container.height - rect.y };
}

// Transformation de l'image à l'avancement `progress` (1 : à sa place,
// 0 : cachée ; au-delà de [0, 1] pendant un rebond) — décalage en px CSS du
// conteneur et échelle autour du centre de l'image. Fondu : identité.
export function effectTransform(effect, progress, rect, container) {
    const p = Number.isFinite(progress) ? progress : 1;
    if (effect === 'slide' && rect && container) {
        const offset = slideOffset(rect, container);
        return { dx: offset.dx * (1 - p), dy: offset.dy * (1 - p), scale: 1 };
    }
    if (effect === 'zoom') {
        return { dx: 0, dy: 0, scale: IMAGE_ZOOM_FROM + (1 - IMAGE_ZOOM_FROM) * p };
    }
    return { dx: 0, dy: 0, scale: 1 };
}
