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

async function sendPatch(patch) {
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

// Écritures en file d'attente : une seule requête en vol à la fois, dans
// l'ordre des appels. Deux `fetch` lancés ensemble peuvent arriver au serveur
// dans le désordre — deux enregistrements rapprochés du même champ (blur puis
// Entrée sur le centre de carte) écriraient alors l'ancienne valeur en dernier.
// La sérialisation garantit aussi que `window.userSettings` reflète la dernière
// valeur réellement envoyée.
let writeQueue = Promise.resolve();

// Enregistre un patch de préférences. Renvoie true si le serveur a accepté.
export function saveSettingsPatch(patch) {
    if (!patch || typeof patch !== 'object') return Promise.resolve(true);
    // `.then` est enregistré ici, de façon synchrone : c'est l'ordre des appels
    // à saveSettingsPatch() qui fixe l'ordre des requêtes.
    const result = writeQueue.then(() => sendPatch(patch));
    // La file avance sur un maillon qui n'échoue jamais : un rejet inattendu
    // bloquerait sinon définitivement toutes les écritures suivantes.
    writeQueue = result.catch(() => {});
    return result;
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
