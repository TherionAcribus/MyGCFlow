// Requête HTTP bornée en durée.
//
// Même en local, un fetch suspendu (serveur saturé, réponse qui ne termine
// jamais) ne se résout ni ne rejette : la chaîne de promesses resterait en
// attente indéfiniment — modale ouverte, enregistrement invisible. Ce wrapper
// ajoute un AbortController piloté par un délai, et convertit l'AbortError en
// erreur lisible pour l'utilisateur.
//
// Module pur : fetch, les timers et la fonction de traduction sont injectables
// pour les tests node (cf. test_fetch_with_timeout.mjs).

export const DEFAULT_FETCH_TIMEOUT_MS = 30000;

// Délais par type d'appel. Localhost est rapide, mais les requêtes ne sont pas
// égales : un sondage de tâche renvoie quelques centaines d'octets alors qu'un
// upload vidéo peut transporter plusieurs centaines de Mo.
export const FETCH_TIMEOUTS = Object.freeze({
    status: 15_000,        // GET /tasks/<id> : réponse minuscule
    control: 60_000,       // actions serveur (nettoyage captured/, lancement)
    upload: 120_000,       // lots d'images, piste audio
    videoUpload: 300_000,  // .webm complets (centaines de Mo possibles)
});

export async function fetchWithTimeout(url, options = {}, {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    fetchImpl = null,
    setTimer = null,
    clearTimer = null,
    t = (s) => s,
} = {}) {
    const _fetch = fetchImpl || fetch;
    const _setTimer = setTimer || setTimeout;
    const _clearTimer = clearTimer || clearTimeout;

    const controller = new AbortController();
    const timer = _setTimer(() => controller.abort(), timeoutMs);
    try {
        return await _fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err && err.name === 'AbortError') {
            throw new Error(t('Le serveur local ne répond pas (délai dépassé)'));
        }
        throw err;
    } finally {
        _clearTimer(timer);
    }
}
