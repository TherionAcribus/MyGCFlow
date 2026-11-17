// Dessin des cartes photo d'un parcours (MyGCFlow_Plan_Parcours.md, § 14 ;
// lot 9) sur un contexte 2D : cadre, image recadrée, légende, trait vers
// l'étape. La mise en page vient de parcours_photo_layout.mjs
// (photoFrameAt) ; ce module ne fait que peindre.
//
// Appelé par le `postrender` de la couche de la tête (parcours_data.js) :
// ce qui est peint là est filmé tel quel par les deux pipelines
// d'enregistrement. Aucune dépendance au DOM ni à OpenLayers.

import { photoCropRect } from './parcours_photo_layout.mjs';

function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (radius === 0) {
        ctx.rect(x, y, w, h);
        return;
    }
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

// Texte tronqué (…) à `maxWidth`.
function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return `${text.slice(0, lo).trimEnd()}…`;
}

// Trait fin de l'étape vers la carte, avec un point sur l'étape.
export function drawPhotoLeader(ctx, card, ratio = 1) {
    if (!card.leader || card.alpha <= 0) return;
    const { from, to } = card.leader;
    ctx.save();
    ctx.globalAlpha = card.alpha;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 3.5 * ratio;
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0] + card.dx, to[1] + card.dy);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * ratio;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(from[0], from[1], 3.5 * ratio, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1 * ratio;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();
    ctx.restore();
}

// Une carte : `img` décodée, `photo` (cadrage), `font` (famille CSS).
export function drawPhotoCard(ctx, card, img, photo, { font = 'sans-serif', ratio = 1 } = {}) {
    if (!img || card.alpha <= 0) return;
    const natural = { width: img.naturalWidth || img.width || 0, height: img.naturalHeight || img.height || 0 };
    if (!natural.width || !natural.height) return;
    let src = photoCropRect(natural, photo);
    if (card.kenBurns && card.kenBurns > 1) {
        const w = src.width / card.kenBurns;
        const h = src.height / card.kenBurns;
        src = { x: src.x + (src.width - w) / 2, y: src.y + (src.height - h) / 2, width: w, height: h };
    }
    const { frame, w, h } = card;
    const cardW = w + 2 * frame.side;
    const cardH = h + frame.top + frame.bottom;
    const left = -cardW / 2;
    const top = -cardH / 2;
    const imageX = left + frame.side;
    const imageY = top + frame.top;

    ctx.save();
    ctx.globalAlpha = card.alpha;
    ctx.translate(card.x + card.dx, card.y + card.dy);
    if (card.rotation) ctx.rotate(card.rotation);
    const scale = card.scale * card.effectScale;
    if (scale !== 1) ctx.scale(scale, scale);

    // Fond du cadre (blanc) ou de l'image seule, avec son ombre.
    const paper = frame.kind === 'postcard' || frame.kind === 'polaroid';
    if (frame.shadow) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = 10 * ratio;
        ctx.shadowOffsetY = 3 * ratio;
    }
    if (paper || frame.shadow) {
        ctx.fillStyle = paper ? '#ffffff' : '#000000';
        roundRectPath(ctx, left, top, cardW, cardH, frame.radius);
        ctx.fill();
    }
    ctx.shadowColor = 'transparent';

    ctx.save();
    roundRectPath(ctx, imageX, imageY, w, h, paper ? 0 : frame.radius);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, src.x, src.y, src.width, src.height, imageX, imageY, w, h);

    const captionAlpha = card.captionAlpha ?? 1;
    const size = frame.captionSize;
    if (card.caption && captionAlpha > 0 && frame.captionIn === 'overlay') {
        // Bandeau dégradé en bas de l'image, texte blanc.
        const band = size * 2.2;
        const gradient = ctx.createLinearGradient(0, imageY + h - band, 0, imageY + h);
        gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0.65)');
        ctx.globalAlpha = card.alpha * captionAlpha;
        ctx.fillStyle = gradient;
        ctx.fillRect(imageX, imageY + h - band, w, band);
        ctx.font = `600 ${size}px ${font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(fitText(ctx, card.caption, w - size), imageX + w / 2, imageY + h - size * 0.9);
    }
    ctx.restore();

    if (card.caption && captionAlpha > 0 && frame.captionIn === 'margin') {
        // Dans la marge blanche du bas, texte sombre.
        ctx.globalAlpha = card.alpha * captionAlpha;
        ctx.font = `${frame.kind === 'polaroid' ? 500 : 400} ${size}px ${font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#343a40';
        ctx.fillText(fitText(ctx, card.caption, cardW - size * 1.2), 0, imageY + h + frame.bottom / 2);
    }
    ctx.restore();
}
