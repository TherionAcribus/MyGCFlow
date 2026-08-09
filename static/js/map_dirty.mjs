// Suivi « carte sale » du compositing MediaRecorder.
//
// La boucle de capture tourne à fps fixe, mais la carte, elle, ne change pas à
// chaque tick : dès que timePerDay dépasse la durée d'une frame, plusieurs
// frames consécutives sont strictement identiques. Forcer un map.renderSync()
// complet + une recomposition des canvas pour chacune est le poste de coût
// principal du pipeline. Ce compteur d'état permet de ne payer ce rendu que
// lorsque quelque chose a réellement bougé.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

// Intervalle maximal entre deux dessins, même carte inchangée. Indispensable :
// canvas.captureStream() n'émet une frame que lorsque le canvas est modifié.
// Sans ce rafraîchissement de sécurité, un long plan fixe (le gel de fin
// d'animation, typiquement) n'enverrait plus rien au MediaRecorder et la vidéo
// s'arrêterait avant l'heure. 250 ms = 4 images/s suffisent à garder le flux
// vivant tout en supprimant l'essentiel des rendus redondants.
export const DEFAULT_KEEPALIVE_MS = 250;

export function createMapDirtyTracker({ keepAliveMs = DEFAULT_KEEPALIVE_MS } = {}) {
    const safeKeepAlive = Number.isFinite(Number(keepAliveMs)) ? Math.max(0, Number(keepAliveMs)) : DEFAULT_KEEPALIVE_MS;
    let dirty = true;            // la première frame est toujours dessinée
    let animations = 0;          // flashs en cours : la carte change à chaque rendu
    let lastDrawMs = null;
    let lastSignature = null;    // contenu textuel des overlays au dernier dessin

    return {
        // Un changement de contenu de la carte a eu lieu (nouveaux points, rendu
        // naturel d'OpenLayers déclenché par une tuile chargée, un déplacement
        // de vue, une reprise après pause...).
        markDirty() { dirty = true; },

        // Les flashs sont animés par le rendu lui-même : tant qu'il en reste un,
        // chaque frame diffère de la précédente, il n'y a rien à économiser.
        beginAnimation() { animations += 1; dirty = true; },
        endAnimation() { animations = Math.max(0, animations - 1); },
        resetAnimations() { animations = 0; },
        get animationCount() { return animations; },

        // signature = texte des overlays (date, compteur, titre) + révision du
        // cache de style : ils sont redessinés à chaque frame et peuvent changer
        // sans que la carte elle-même soit modifiée.
        shouldDraw(nowMs, signature = lastSignature) {
            if (dirty || animations > 0) return true;
            if (signature !== lastSignature) return true;
            if (lastDrawMs === null) return true;
            return (nowMs - lastDrawMs) >= safeKeepAlive;
        },

        // À appeler seulement quand la frame a effectivement été composée : une
        // composition interrompue par une erreur laisse la carte sale et sera
        // retentée au tick suivant.
        noteDraw(nowMs, signature = lastSignature) {
            dirty = false;
            lastDrawMs = nowMs;
            lastSignature = signature;
        },

        reset() {
            dirty = true;
            animations = 0;
            lastDrawMs = null;
            lastSignature = null;
        },
    };
}
