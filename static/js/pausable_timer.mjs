// Minuteur suspendable : ne s'écoule que tant que la session est « active ».
//
// Quand l'onglet est masqué, le navigateur fige requestAnimationFrame et bride
// les timers — mais un setTimeout finit quand même par se déclencher (au plus
// une fois par minute en arrière-plan). Pendant une pause d'enregistrement
// MediaRecorder, un tel déclenchement arrêterait la capture au milieu de la
// pause, ou écoulerait le gel de fin alors que rien n'est enregistré.
// Ce minuteur conserve donc le temps restant à la pause et ne reprend le
// décompte qu'à la reprise.
//
// Module pur : timers et horloge injectables pour les tests node.

export function createPausableTimeout(callback, {
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = () => performance.now(),
} = {}) {
    let timeoutId = null;   // id du setTimeout courant, null si en pause/inactif
    let remainingMs = 0;    // temps actif restant à écouler
    let armedAt = 0;        // instant now() où le décompte courant a repris

    const api = {
        // Arme le rappel dans ms millisecondes de temps actif. Remplace toute
        // programmation en cours. ms <= 0 : rappel immédiat (synchrone).
        arm(ms) {
            api.clear();
            remainingMs = Math.max(0, Number(ms) || 0);
            if (remainingMs === 0) { callback(); return; }
            api.resume();
        },
        // Fige le temps restant. Sans effet si déjà en pause ou non armé.
        pause() {
            if (timeoutId === null) return;
            clearTimer(timeoutId);
            timeoutId = null;
            remainingMs = Math.max(0, remainingMs - (now() - armedAt));
        },
        // Relance le décompte du temps restant.
        resume() {
            if (timeoutId !== null || remainingMs <= 0) return;
            armedAt = now();
            timeoutId = setTimer(() => {
                timeoutId = null;
                remainingMs = 0;
                callback();
            }, remainingMs);
        },
        // Annule définitivement.
        clear() {
            if (timeoutId !== null) { clearTimer(timeoutId); timeoutId = null; }
            remainingMs = 0;
        },
        get pending() { return timeoutId !== null || remainingMs > 0; },
    };
    return api;
}
