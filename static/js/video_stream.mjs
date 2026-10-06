// Délestage mémoire des enregistrements MediaRecorder.
//
// Sans flux, les fragments .webm s'accumulent en mémoire jusqu'à la fin de la
// capture (~225 Mo/min à 30 Mbit/s) avant d'être relus, corrigés puis envoyés
// au serveur. Avec le flux, chaque fragment part vers le serveur local dès sa
// disponibilité : la mémoire ne retient plus que le fragment courant.
//
// L'ordre est garanti par une file strictement séquentielle — la validité du
// conteneur EBML exige que les fragments arrivent dans l'ordre d'émission.
// En fin de capture, finish() demande au serveur un remux sans ré-encodage,
// qui répare au passage l'élément « Duration » absent des flux MediaRecorder.
//
// Module pur : fetch et traduction injectables pour les tests node.

export function createVideoStream({ baseUrl = '', fetchImpl = null, t = (s) => s } = {}) {
    const _fetch = fetchImpl || fetch;
    let streamId = null;
    let index = 0;
    let chain = Promise.resolve();
    let failure = null;

    async function post(url, options = {}) {
        const response = await _fetch(url, { method: 'POST', ...options });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || data.success === false) {
            const err = new Error(data?.message || `HTTP ${response.status}`);
            err.status = response.status;
            throw err;
        }
        return data;
    }

    async function drain() {
        await chain;
        if (failure) throw failure;
    }

    return {
        // Ouvre le fichier côté serveur. À appeler avant le premier fragment ;
        // en cas d'échec, l'appelant replie sur l'accumulation en mémoire.
        async begin() {
            const data = await post(`${baseUrl}/video_stream_begin`);
            streamId = data.stream_id;
            if (!streamId) throw new Error(t('Ouverture du flux vidéo impossible'));
            return streamId;
        },

        // Enfile un fragment pour envoi. Séquentiel : deux appels ne partent
        // jamais en parallèle, l'index côté serveur vérifie l'ordre.
        push(blob) {
            if (!streamId || failure) return;
            const idx = index++;
            const fd = new FormData();
            fd.append('stream_id', streamId);
            fd.append('index', String(idx));
            fd.append('chunk', blob, `chunk_${idx}.webm`);
            chain = chain
                .then(() => {
                    // Un fragment perdu rend les suivants inutiles : le serveur
                    // refuserait de toute façon leur index hors séquence.
                    if (failure) return null;
                    return post(`${baseUrl}/video_stream_append`, { body: fd });
                })
                .catch(err => { failure = err; });
        },

        // Attend la fin des envois en file ; rejette si un fragment a été perdu.
        drain,

        // Referme le flux : le serveur le remuxe en un enregistrement brut dans
        // son dossier de travail et renvoie son nom ({ success, file }). Le flux
        // ne peut plus recevoir de fragment.
        async finish() {
            if (!streamId) throw new Error(t('Aucun flux vidéo ouvert'));
            await drain();
            const data = await post(`${baseUrl}/video_stream_finish`, {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stream_id: streamId }),
            });
            streamId = null;
            return data;
        },

        // Abandonne le flux (annulation) : supprime le fichier serveur.
        // Silencieux par conception — appelé depuis des chemins de nettoyage.
        async abort() {
            const id = streamId;
            streamId = null;
            if (!id) return;
            try {
                await post(`${baseUrl}/video_stream_abort`, {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stream_id: id }),
                });
            } catch (_) { /* nettoyage best-effort */ }
        },

        get active() { return !!streamId; },
        get error() { return failure; },
        get pendingCount() { return index; },
    };
}
