// Cache des styles de flash et discrétisation de leur progression.
//
// Un style de flash (ol.style.RegularShape) rastérise sa forme dans un canvas
// qui lui est propre. En recréer un par flash et par frame revenait à redessiner
// chaque forme de zéro, pour chaque point en cours de flash, à chaque rendu :
// le premier poste de coût des journées denses. Or le style ne dépend que de la
// forme, de la taille, de la couleur et de l'avancement du flash : en ramenant
// l'avancement à un nombre fini de pas, deux flashs identiques (ou le même flash
// à deux instants équivalents) partagent le même style déjà rastérisé.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

// En lecture live, l'avancement est un temps continu : on le ramène à un pas par
// frame d'un écran 60 Hz. L'écart avec le temps exact reste inférieur à une
// frame, donc invisible, et le nombre de styles d'un flash est borné par sa durée.
export const LIVE_FLASH_STEPS_PER_SECOND = 60;

// Budget mémoire des canvas rastérisés. Les flashs courants (quelques pixels de
// rayon) en consomment très peu ; le plafond ne sert qu'à borner les grandes
// tailles combinées au mode « couleur GC » (un jeu de styles par type de cache).
export const DEFAULT_FLASH_CACHE_BYTES = 32 * 1024 * 1024;

// Pas courant d'un flash live : { step, steps } avec 0 <= step < steps tant que
// elapsedMs < durationMs. Arrondi à l'inférieur pour ne jamais atteindre la fin
// (opacité nulle) avant l'expiration réelle du flash.
export function liveFlashStep(elapsedMs, durationMs) {
    const duration = Math.max(1, Number(durationMs) || 0);
    const steps = Math.max(1, Math.ceil(duration * LIVE_FLASH_STEPS_PER_SECOND / 1000));
    const ratio = Math.min(1, Math.max(0, Number(elapsedMs) / duration));
    return { step: Math.min(steps - 1, Math.floor(ratio * steps)), steps };
}

// Cache LRU borné en octets. build() renvoie { value, bytes } ; bytes est une
// estimation de la mémoire tenue par la valeur (canvas rastérisé).
export function createFlashStyleCache({ maxBytes = DEFAULT_FLASH_CACHE_BYTES } = {}) {
    const entries = new Map(); // ordre d'insertion = ordre LRU (le plus ancien en tête)
    let totalBytes = 0;

    return {
        get(key, build) {
            const hit = entries.get(key);
            if (hit) {
                entries.delete(key);
                entries.set(key, hit);
                return hit.value;
            }
            const built = build();
            const bytes = Math.max(0, Number(built.bytes) || 0);
            entries.set(key, { value: built.value, bytes });
            totalBytes += bytes;
            // L'entrée qui vient d'être créée est toujours conservée, même seule
            // au-delà du budget : c'est elle qu'on est en train de dessiner.
            for (const [oldKey, old] of entries) {
                if (totalBytes <= maxBytes || entries.size <= 1) break;
                entries.delete(oldKey);
                totalBytes -= old.bytes;
            }
            return built.value;
        },
        clear() {
            entries.clear();
            totalBytes = 0;
        },
        get size() { return entries.size; },
        get bytes() { return totalBytes; },
    };
}
