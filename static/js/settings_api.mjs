// Écriture des préférences globales de l'application (settings.json côté serveur).
//
// `PUT /api/settings` accepte un patch partiel : tout champ absent du corps de
// la requête conserve la valeur déjà enregistrée. Inutile donc de relire les
// paramètres avant d'écrire — on envoie uniquement ce qui change.
//
// « Préférence globale » s'oppose ici à « réglage de profil » : ces valeurs
// (langue, thème, enregistrement vidéo, centre de carte par défaut) suivent
// l'utilisateur quel que soit le profil chargé, et sont enregistrées
// automatiquement. Les réglages de style, eux, appartiennent au profil actif et
// n'existent sur disque qu'après un clic sur « Sauvegarder » (cf. profiles.js).

// Applique le patch sur le cache client des préférences (window.userSettings),
// pour que les lecteurs ultérieurs voient la valeur qui vient d'être écrite sans
// refaire un GET. Fusion à un niveau de profondeur : `recording` est toujours
// envoyé en bloc complet, ses sous-clés n'ont donc pas à être fusionnées.
function updateLocalCache(patch) {
    try {
        window.userSettings = Object.assign({}, window.userSettings || {}, patch);
    } catch (_) {}
}

// Enregistre un patch de préférences. Renvoie true si le serveur a accepté.
export async function saveSettingsPatch(patch) {
    if (!patch || typeof patch !== 'object') return true;
    try {
        const response = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        if (!response.ok) return false;
        updateLocalCache(patch);
        return true;
    } catch (_) {
        return false;
    }
}

// Variante débouncée : les champs numériques (FPS, bitrate…) émettent un
// événement par frappe. Sans regroupement, chaque caractère saisi provoquerait
// une écriture disque côté serveur.
export function makeDebouncedSettingsSaver(delayMs = 400) {
    let timer = null;
    let pending = {};
    let resolvers = [];

    return function saveDebounced(patch) {
        pending = Object.assign(pending, patch || {});
        clearTimeout(timer);
        return new Promise(resolve => {
            resolvers.push(resolve);
            timer = setTimeout(async () => {
                const toSave = pending;
                const toResolve = resolvers;
                pending = {};
                resolvers = [];
                timer = null;
                const ok = await saveSettingsPatch(toSave);
                toResolve.forEach(fn => fn(ok));
            }, delayMs);
        });
    };
}
