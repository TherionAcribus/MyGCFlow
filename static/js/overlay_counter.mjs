// Compteur de caches animé : le nombre affiché rejoint sa nouvelle valeur au
// lieu de sauter d'un coup.
//
// L'avancement est mesuré avec l'horloge des points (point_appear.mjs) : temps
// réel en lecture, temps vidéo pendant une capture image par image, donc un
// enregistrement reste reproductible à l'identique.
//
// La durée est bornée à un jour d'animation par l'appelant : le compteur atteint
// toujours sa valeur exacte avant le jour suivant, et le nombre final affiché
// est le vrai total, jamais une valeur en cours de route.
//
// Aucune dépendance au DOM : logique pure, testable.

export const COUNTER_ANIMATION_MS = 350;

// Fin rapide puis ralentissement (cubique sortante) : le compteur « attrape »
// sa valeur au lieu de la rejoindre linéairement.
function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
}

export function createCountAnimator() {
    let from = 0;
    let to = 0;
    let startClock = 0;
    let durationMs = 0;

    return {
        // Fixe la valeur sans animation (chargement d'une base, remise à zéro).
        set(value) {
            from = to = Number(value) || 0;
            durationMs = 0;
        },

        // Nouvelle cible : l'animation repart de la valeur affichée à cet instant.
        setTarget(value, clock, duration = COUNTER_ANIMATION_MS) {
            const target = Number(value) || 0;
            const safeDuration = Math.max(0, Number(duration) || 0);
            if (target === to && durationMs > 0) return;
            from = this.valueAt(clock);
            to = target;
            startClock = Number(clock) || 0;
            durationMs = safeDuration;
        },

        // Valeur entière à afficher pour cet instant d'horloge.
        valueAt(clock) {
            if (durationMs <= 0) return to;
            const elapsed = (Number(clock) || 0) - startClock;
            if (elapsed >= durationMs) return to;
            if (elapsed <= 0) return Math.round(from);
            const value = from + (to - from) * easeOut(elapsed / durationMs);
            // Arrondi vers la cible : le compteur ne dépasse jamais le total réel.
            return to >= from ? Math.floor(value) : Math.ceil(value);
        },

        isAnimating(clock) {
            return durationMs > 0 && ((Number(clock) || 0) - startClock) < durationMs;
        },
    };
}
