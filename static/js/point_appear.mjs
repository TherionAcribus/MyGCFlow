// Apparition animée des points, calculée par la carte graphique.
//
// Chaque point reçoit, à son ajout, son instant d'apparition (attribut 'appear').
// Le style WebGL compare cet instant à une horloge commune (variable de style
// 'now', mise à jour une fois par rendu) : l'agrandissement avec léger rebond et
// le fondu d'entrée sont calculés dans le shader, pour tous les points à la fois,
// sans aucun travail processeur par point ni reconstruction de buffers.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

// Durée de l'apparition d'un point.
export const POINT_APPEAR_MS = 380;

// Instant d'apparition des points affichés sans animation (carte statique,
// points antérieurs à la date de départ) : si loin dans le passé qu'ils sont
// toujours dessinés à leur taille normale.
export const STATIC_APPEAR = -1e9;

// Horloge de l'animation, en ms. Deux sources possibles : le temps réel (lecture
// live, MediaRecorder) et le temps vidéo de la capture image par image
// (frames * 1000 / fps, déterministe). Passer de l'une à l'autre ne doit jamais
// faire reculer l'horloge : un point déjà apparu redeviendrait « à venir » et
// disparaîtrait. On raccorde donc chaque nouvelle source à la dernière valeur.
export function createAppearClock() {
    let source = null;
    let offset = 0;
    let last = 0;

    return {
        sample(sourceId, value) {
            const v = Number(value);
            if (!Number.isFinite(v)) return last;
            if (sourceId !== source) {
                source = sourceId;
                offset = last - v;
            }
            last = Math.max(last, v + offset);
            return last;
        },
        get last() { return last; },
    };
}

// Expressions de style WebGL (format « flat style » d'OpenLayers).
const AGE = ['-', ['var', 'now'], ['get', 'appear']];

// Facteur d'échelle : le point surgit à 40 % de sa taille, dépasse jusqu'à 135 %
// puis se pose à sa taille normale (effet d'atterrissage).
export function appearScaleExpression(durationMs = POINT_APPEAR_MS) {
    return ['interpolate', ['linear'], AGE,
        0, 0.4,
        0.55 * durationMs, 1.35,
        durationMs, 1];
}

// Opacité : invisible tant que son tour n'est pas venu (départ décalé), puis
// fondu d'entrée rapide.
export function appearOpacityExpression(durationMs = POINT_APPEAR_MS) {
    return ['interpolate', ['linear'], AGE,
        -1, 0,
        0, 0.6,
        0.3 * durationMs, 1];
}

// Multiplie une valeur de style (nombre ou expression) par l'échelle d'apparition.
export function withAppearScale(value, durationMs = POINT_APPEAR_MS) {
    return ['*', value, appearScaleExpression(durationMs)];
}
