// Résolution de sortie du pipeline « images ».
//
// Par défaut, une capture fait la taille de la carte à l'écran multipliée par la
// densité de l'écran : sur un portable classique, une fenêtre de 1280 px donne
// une vidéo de 1280 px de large, quoi qu'on fasse. Agrandir l'image après coup
// n'ajouterait aucun détail.
//
// La vraie solution est de faire RENDRE la carte à une densité plus élevée :
// OpenLayers choisit alors des tuiles d'un niveau de zoom plus fin, redessine
// les vecteurs et les textes à pleine finesse, et met tout à l'échelle (taille
// des points, épaisseurs de trait). C'est exactement ce qui se passe sur un
// écran HiDPI. Le cadrage, lui, ne change pas d'un pixel.
//
// Ce module ne fait que le calcul : quel facteur appliquer, et quelle taille de
// sortie en résulte. Aucune dépendance au DOM ni à OpenLayers : testable.

// Hauteurs de sortie proposées. 'window' = comportement historique (la fenêtre).
export const CAPTURE_RESOLUTIONS = Object.freeze({
    window: 0,
    '1080p': 1080,
    '1440p': 1440,
    '2160p': 2160,
});

export const DEFAULT_CAPTURE_RESOLUTION = 'window';

// Garde-fous : au-delà, la mémoire vidéo et le temps de capture explosent pour
// un gain invisible. 4 correspond déjà à une fenêtre 1280 rendue en 5120.
export const MAX_CAPTURE_RATIO = 4;
// ~35 mégapixels : au-delà, certains navigateurs refusent d'allouer le canvas.
export const MAX_CAPTURE_PIXELS = 35_000_000;

export function normalizeCaptureResolution(value) {
    return Object.hasOwn(CAPTURE_RESOLUTIONS, value) ? value : DEFAULT_CAPTURE_RESOLUTION;
}

// Facteur de rendu et taille de sortie pour une carte de `cssWidth` x `cssHeight`
// pixels CSS sur un écran de densité `devicePixelRatio`.
//
// `multiplier` est le « facteur d'échelle » du mode MediaRecorder : il agrandit
// la sortie par rapport à la fenêtre, indépendamment de la hauteur visée. Les
// deux pipelines passent donc par le même calcul.
//
// `limited` signale que la demande a dû être rabotée (plafond de facteur ou de
// pixels) : l'appelant peut alors prévenir l'utilisateur plutôt que de laisser
// croire à une sortie 4K qui n'en est pas une.
export function captureRatioFor({
    cssWidth = 0,
    cssHeight = 0,
    devicePixelRatio = 1,
    resolution = DEFAULT_CAPTURE_RESOLUTION,
    multiplier = 1,
} = {}) {
    const width = Math.max(1, Math.floor(Number(cssWidth) || 0));
    const height = Math.max(1, Math.floor(Number(cssHeight) || 0));
    // Densité de l'écran : plancher, jamais un plafond. Descendre en dessous
    // dégraderait ce que l'utilisateur obtient déjà aujourd'hui.
    const safeMultiplier = Math.max(1, Number(multiplier) || 1);
    const screenRatio = clampRatio((Number(devicePixelRatio) || 1) * safeMultiplier);
    const targetHeight = CAPTURE_RESOLUTIONS[normalizeCaptureResolution(resolution)] || 0;

    let ratio = targetHeight > 0
        ? Math.max(screenRatio, targetHeight / height)
        : screenRatio;
    const requested = ratio;

    ratio = clampRatio(ratio);
    const pixelLimitRatio = Math.sqrt(MAX_CAPTURE_PIXELS / (width * height));
    if (ratio > pixelLimitRatio) ratio = Math.max(screenRatio, pixelLimitRatio);

    return {
        ratio,
        // Mêmes arrondis que la composition de la frame (floor), pour que la
        // taille annoncée soit celle réellement produite.
        width: Math.max(1, Math.floor(width * ratio)),
        height: Math.max(1, Math.floor(height * ratio)),
        limited: ratio < requested - 1e-9,
    };
}

function clampRatio(value) {
    return Math.max(1, Math.min(MAX_CAPTURE_RATIO, value));
}
