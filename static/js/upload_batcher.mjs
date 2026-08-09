// Regroupement des envois d'images en lots (« batching »).
//
// Le mode « images » produit une frame par capture, soit potentiellement plusieurs
// milliers de requêtes POST pour un seul enregistrement. Chaque requête coûte un
// aller-retour HTTP + un passage complet dans Flask ; avec le serveur de dev
// (mono-thread par défaut) cet overhead domine largement le temps d'écriture des
// fichiers. Regrouper N images dans un seul multipart divise ce coût par N.
//
// Module volontairement pur (aucune dépendance DOM/réseau) : l'envoi réel est
// injecté via `send`, ce qui le rend testable sous node (cf. test_upload_batcher.mjs).

export const DEFAULT_BATCH_SIZE = 12;
export const MAX_BATCH_SIZE = 50;
// Délai maximal d'attente d'un lot incomplet. Sans lui, une capture lente (ou la
// toute fin d'un enregistrement) laisserait des images en tampon indéfiniment ;
// avec lui, le recouvrement capture/upload reste effectif même à faible cadence.
export const DEFAULT_BATCH_MAX_WAIT_MS = 500;

/** Borne une taille de lot fournie par la configuration utilisateur. */
export function normalizeBatchSize(value, fallback = DEFAULT_BATCH_SIZE) {
    const size = Number(value);
    if (!Number.isFinite(size)) return fallback;
    return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(size)));
}

/**
 * Crée un accumulateur qui déclenche `send(payloads)` dès que `batchSize` éléments
 * sont en attente, ou après `maxWaitMs` si le lot reste incomplet.
 *
 * @param {(payloads: any[]) => Promise<any>} options.send  envoi réel d'un lot
 * @param {number} [options.batchSize]      nombre d'éléments par lot (1 = pas de regroupement)
 * @param {number} [options.maxWaitMs]      délai avant envoi d'un lot incomplet (0 = jamais)
 * @param {Function} [options.scheduleTimer] injectable pour les tests (setTimeout)
 * @param {Function} [options.cancelTimer]   injectable pour les tests (clearTimeout)
 */
export function createUploadBatcher({
    send,
    batchSize = DEFAULT_BATCH_SIZE,
    maxWaitMs = DEFAULT_BATCH_MAX_WAIT_MS,
    scheduleTimer = setTimeout,
    cancelTimer = clearTimeout,
} = {}) {
    if (typeof send !== 'function') {
        throw new TypeError('createUploadBatcher: `send` est obligatoire');
    }

    const size = normalizeBatchSize(batchSize);
    let buffer = [];
    let timerId = null;
    const inFlight = new Set();

    function cancelScheduledFlush() {
        if (timerId !== null) {
            cancelTimer(timerId);
            timerId = null;
        }
    }

    function flush() {
        cancelScheduledFlush();
        if (buffer.length === 0) return Promise.resolve(null);

        const items = buffer;
        buffer = [];

        const task = (async () => {
            try {
                const result = await send(items.map(item => item.payload));
                items.forEach(item => item.resolve(result));
                return result;
            } catch (error) {
                // L'erreur est propagée à chaque élément du lot : côté appelant,
                // une frame perdue reste identifiable individuellement.
                items.forEach(item => item.reject(error));
                throw error;
            }
        })();

        inFlight.add(task);
        // Ce handler sert aussi de « filet » : il marque `task` comme gérée, donc
        // un appelant qui ignore la valeur de retour de flush() ne déclenche pas
        // d'unhandledrejection (les erreurs restent visibles sur chaque élément).
        const done = () => { inFlight.delete(task); };
        task.then(done, done);

        return task;
    }

    /** Ajoute un élément ; la promesse se résout quand son lot est parti avec succès. */
    function add(payload) {
        return new Promise((resolve, reject) => {
            buffer.push({ payload, resolve, reject });
            if (buffer.length >= size) {
                flush();
            } else if (timerId === null && maxWaitMs > 0) {
                timerId = scheduleTimer(() => {
                    timerId = null;
                    flush();
                }, maxWaitMs);
            }
        });
    }

    /** Vide le tampon puis attend la fin de tous les lots en vol. */
    async function drain() {
        // Boucle : un lot en vol ne peut pas produire de nouvel élément, mais un
        // appelant concurrent peut en ajouter pendant l'attente.
        while (buffer.length > 0 || inFlight.size > 0) {
            const pending = [flush(), ...inFlight];
            await Promise.allSettled(pending);
        }
    }

    /**
     * Abandonne le tampon (fin/annulation d'enregistrement). Les lots déjà partis
     * ne sont pas annulés — leurs requêtes sont en cours côté serveur — mais ils ne
     * sont plus suivis ici.
     */
    function reset(reason) {
        cancelScheduledFlush();
        const dropped = buffer;
        buffer = [];
        const error = reason instanceof Error ? reason : new Error(reason || 'Upload annulé');
        dropped.forEach(item => item.reject(error));
        inFlight.clear();
    }

    return {
        add,
        flush,
        drain,
        reset,
        get batchSize() { return size; },
        get bufferedCount() { return buffer.length; },
        get batchesInFlight() { return inFlight.size; },
    };
}
