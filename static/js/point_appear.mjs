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

// --- Persistance des points récents ------------------------------------------
//
// Les caches des derniers jours restent plus claires et légèrement plus grosses,
// puis rejoignent progressivement le style normal : on lit ainsi d'un coup d'œil
// où l'activité se déplace. La fenêtre est exprimée en jours dans l'interface,
// convertie en durée d'animation (variable de style 'glowMs') par l'appelant,
// car un jour ne dure pas le même temps en lecture et en enregistrement.

// Fenêtres proposées, en jours.
export const RECENT_GLOW_DAYS = [7, 30, 90];

// Part de blanc mélangée à la couleur d'un point qui vient d'apparaître.
export const RECENT_GLOW_WHITE_MIX = 0.55;
// Grossissement d'un point qui vient d'apparaître, en plus de sa taille normale.
export const RECENT_GLOW_EXTRA_SCALE = 0.3;

// 1 juste après l'apparition, 0 une fois la fenêtre écoulée. La décroissance est
// accélérée (puissance 1,5) : l'éclat retombe vite, la queue s'étire doucement.
export function recentGlowFactorExpression(durationMs = POINT_APPEAR_MS) {
    // 'glowMs' est toujours >= 1 (garanti par l'appelant) : les expressions de
    // style n'ont pas d'opérateur max pour s'en prémunir elles-mêmes.
    const progress = ['clamp',
        ['/', ['-', AGE, durationMs], ['var', 'glowMs']],
        0, 1];
    return ['^', ['-', 1, progress], 1.5];
}

// Éclaircit une couleur (constante ou expression 'match' par type de cache) en
// fonction de l'ancienneté du point.
export function withRecentGlowColor(color, durationMs = POINT_APPEAR_MS) {
    return ['interpolate', ['linear'],
        ['*', recentGlowFactorExpression(durationMs), RECENT_GLOW_WHITE_MIX],
        0, color,
        1, [255, 255, 255, 1]];
}

// Grossit légèrement un point récent.
export function withRecentGlowScale(value, durationMs = POINT_APPEAR_MS) {
    return ['*', value,
        ['+', 1, ['*', recentGlowFactorExpression(durationMs), RECENT_GLOW_EXTRA_SCALE]]];
}
