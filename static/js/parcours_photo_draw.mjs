// Dessin des cartes photo d'un parcours (MyGCFlow_Plan_Parcours.md, § 14 ;
// lot 9) sur un contexte 2D : cadre, image recadrée, légende, trait vers
// l'étape. La mise en page vient de parcours_photo_layout.mjs
// (photoFrameAt) ; ce module ne fait que peindre.
//
// Appelé par le `postrender` de la couche de la tête (parcours_data.js) :
// ce qui est peint là est filmé tel quel par les deux pipelines
// d'enregistrement. Aucune dépendance au DOM ni à OpenLayers.

import { kenBurnsRect, panoramaRect, photoCropRect } from './parcours_photo_layout.mjs';

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

// Bord de timbre : rectangle dont chaque côté est creusé de demi-cercles de
// rayon `r` (les dents), tracés vers l'intérieur du papier — un chemin plein,
// rien n'est effacé du canevas de la carte.
function stampPath(ctx, x, y, w, h, r) {
    const count = (length) => Math.max(2, Math.round(length / (r * 2.6)));
    const nx = count(w);
    const ny = count(h);
    const sx = w / nx;
    const sy = h / ny;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let i = 0; i < nx; i++) ctx.arc(x + sx * (i + 0.5), y, r, Math.PI, 0, true);
    ctx.lineTo(x + w, y);
    for (let i = 0; i < ny; i++) ctx.arc(x + w, y + sy * (i + 0.5), r, -Math.PI / 2, Math.PI / 2, true);
    ctx.lineTo(x + w, y + h);
    for (let i = nx - 1; i >= 0; i--) ctx.arc(x + sx * (i + 0.5), y + h, r, 0, Math.PI, true);
    ctx.lineTo(x, y + h);
    for (let i = ny - 1; i >= 0; i--) ctx.arc(x, y + sy * (i + 0.5), r, Math.PI / 2, -Math.PI / 2, true);
    ctx.closePath();
}

// Pellicule : perforations claires dans les bandes du haut et du bas.
function drawSprockets(ctx, left, top, cardW, cardH, band) {
    const holeH = band * 0.42;
    const holeW = holeH * 1.3;
    const count = Math.max(2, Math.floor(cardW / (holeW * 2.2)));
    const step = cardW / count;
    ctx.fillStyle = 'rgba(236, 236, 228, 0.92)';
    for (const y of [top + (band - holeH) / 2, top + cardH - band + (band - holeH) / 2]) {
        for (let i = 0; i < count; i++) {
            roundRectPath(ctx, left + step * (i + 0.5) - holeW / 2, y, holeW, holeH, holeH * 0.25);
            ctx.fill();
        }
    }
}

// Carnet : deux bandes de scotch translucides, en travers des coins du haut.
function drawTape(ctx, left, top, cardW) {
    const length = cardW * 0.24;
    const thick = Math.max(8, cardW * 0.07);
    ctx.fillStyle = 'rgba(244, 236, 205, 0.78)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.lineWidth = 1;
    for (const [x, angle] of [[left + length * 0.3, -Math.PI / 5], [left + cardW - length * 0.3, Math.PI / 5]]) {
        ctx.save();
        ctx.translate(x, top + thick * 0.15);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.rect(-length / 2, -thick / 2, length, thick);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }
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

// Vignette ronde (`pin_shape: 'round'`) : la photo en médaillon, au
// cadrage carré de la photo (point focal), liseré blanc, cerclée de `ring`
// (couleur de la journée). Opacité : celle de la carte × `round` (fondu
// depuis la carte pendant la descente).
export function drawPhotoMedallion(ctx, card, img, photo, { ring = '#ffffff', ratio = 1 } = {}) {
    const alpha = card.alpha * (card.round ?? 1);
    if (!img || alpha <= 0 || !(card.pinSize > 0)) return;
    const natural = { width: img.naturalWidth || img.width || 0, height: img.naturalHeight || img.height || 0 };
    if (!natural.width || !natural.height) return;
    const src = photoCropRect(natural, { ...(photo || {}), aspect: '1:1' });
    const x = card.x + card.dx;
    const y = card.y + card.dy;
    const r = card.pinSize / 2;
    const ringW = Math.max(2 * ratio, r * 0.11);
    const inner = r - ringW - Math.max(1.5 * ratio, r * 0.05);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6 * ratio;
    ctx.shadowOffsetY = 2 * ratio;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = ring;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.arc(x, y, r - ringW, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, inner, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, src.x, src.y, src.width, src.height, x - inner, y - inner, inner * 2, inner * 2);
    ctx.restore();
}

// Nombre de photos d'une vignette (`badge`) : pastille au coin haut-droit
// (sur le cercle d'un médaillon), fond `color`, texte `text`, liseré blanc.
export function drawPinBadge(ctx, card, { color = '#212529', text = '#ffffff', font = 'sans-serif', ratio = 1 } = {}) {
    if (!card.badge || card.alpha <= 0) return;
    const label = card.badge > 99 ? '99+' : String(card.badge);
    const round = (card.round ?? 0) >= 1;
    const r = round ? card.pinSize / 2 : 0;
    const x = card.x + card.dx + (round ? r * Math.SQRT1_2 : card.cardW * card.scale / 2);
    const y = card.y + card.dy - (round ? r * Math.SQRT1_2 : card.cardH * card.scale / 2);
    const size = Math.max(10 * ratio, (round ? card.pinSize : Math.max(card.cardW, card.cardH) * card.scale) * 0.16);
    ctx.save();
    ctx.globalAlpha = card.alpha;
    ctx.font = `700 ${size}px ${font}`;
    const h = size * 1.5;
    const w = Math.max(h, ctx.measureText(label).width + size * 0.9);
    roundRectPath(ctx, x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.5 * ratio);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + size * 0.05);
    ctx.restore();
}

// Éclair de déclencheur sur l'étape (`flash`), à `progress` (0..1) : un
// halo blanc et une étoile à quatre branches effilées qui s'éteignent, et un
// anneau qui s'élargit.
export function drawShutterFlash(ctx, point, progress, ratio = 1) {
    const k = Math.min(1, Math.max(0, progress));
    const alpha = (1 - k) ** 1.4;
    if (!point || alpha <= 0) return;
    const [x, y] = point;
    const r = (14 + 22 * Math.sqrt(k)) * ratio;
    ctx.save();
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    glow.addColorStop(0.4, `rgba(255, 255, 255, ${0.6 * alpha})`);
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // Étoile : branches longues sur les axes, plus courtes en diagonale.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const long = r * 1.35;
    const short = r * 0.7;
    const waist = r * 0.13;
    for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI) / 4;
        const reach = i % 2 ? short : long;
        ctx.lineTo(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach);
        ctx.lineTo(x + Math.cos(angle + Math.PI / 8) * waist, y + Math.sin(angle + Math.PI / 8) * waist);
    }
    ctx.closePath();
    ctx.fill();
    // Anneau : part de l'étape, s'élargit et s'amincit.
    ctx.globalAlpha = alpha * 0.8;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, 3 * (1 - k)) * ratio;
    ctx.beginPath();
    ctx.arc(x, y, (8 + 40 * k) * ratio, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
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
    // Panorama (`pan` posé par photoFrameAt) : fenêtre aux proportions de la
    // carte, qui glisse le long de l'image.
    let src = card.pan != null ? panoramaRect(natural, card.w / card.h, card.pan) : photoCropRect(natural, photo);
    if (card.kenBurns && card.kenBurns > 1) {
        // Panorama : le point focal n'a pas cours, la fenêtre le parcourt déjà.
        src = kenBurnsRect(src, natural, card.pan != null ? null : photo, card.kenBurns, card.kenBurnsShift || 0);
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

    // Fond du cadre (blanc, noir pour la pellicule) ou de l'image seule,
    // avec son ombre.
    const film = frame.kind === 'film';
    const paper = film || ['postcard', 'polaroid', 'stamp', 'tape'].includes(frame.kind);
    if (frame.shadow) {
        // L'ombre ne suit pas ctx.scale : réduite avec la carte (vignettes).
        const shrink = Math.min(1, scale * 1.5);
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = 10 * ratio * shrink;
        ctx.shadowOffsetY = 3 * ratio * shrink;
    }
    if (paper || frame.shadow) {
        ctx.fillStyle = film ? '#141414' : paper ? '#ffffff' : '#000000';
        if (frame.kind === 'stamp' && frame.perforation > 0) {
            stampPath(ctx, left, top, cardW, cardH, frame.perforation);
        } else {
            roundRectPath(ctx, left, top, cardW, cardH, frame.radius);
        }
        ctx.fill();
    }
    ctx.shadowColor = 'transparent';
    if (film) drawSprockets(ctx, left, top, cardW, cardH, frame.top);

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
    // Le scotch passe par-dessus l'image et la marge.
    if (frame.kind === 'tape') {
        ctx.globalAlpha = card.alpha;
        drawTape(ctx, left, top, cardW);
    }
    ctx.restore();
}
