// File d'écriture du document des tableaux de bord (/api/dashboards).
//
// Sans elle, deux enregistrements pouvaient partir en parallèle : le plus
// ancien, réponse arrivée en dernier, écrasait le plus récent sur le disque.
// Ici une seule requête est en vol ; toute modification pendant le vol est
// renvoyée ensuite — c'est la version la plus récente qui gagne.
//
// `send(doc, rev)` est fourni par l'appelant et résout :
//   { ok: true, rev }      écrit ; `rev` devient la base des envois suivants
//   { ok: 'conflict' }     révision serveur différente (autre onglet) —
//                          le document reste en file, l'appelant arbitre
//   { ok: false }          réseau ou refus — le document reste en file
//
// En cas d'échec ou de conflit, `push` résout avec ce résultat et le
// document n'est PAS perdu : il reste `queued`, renvoyé au `push` suivant.

export function createSaveQueue(send) {
    let queued = null;   // document en attente (le plus récent)
    let baseRev = null;  // révision du fichier connue au moment du push
    let running = null;  // promesse de vidange en cours

    async function drain() {
        while (queued !== null) {
            const doc = queued;
            queued = null;
            const result = await send(doc, baseRev);
            if (result && result.ok === true) {
                baseRev = result.rev;
                continue;
            }
            queued = doc;
            return result;
        }
        return { ok: true, rev: baseRev };
    }

    return {
        // Enfile `doc` ; `rev` est la base de comparaison envoyée au serveur.
        // Résout quand la file est vide, ou dès le premier échec/conflit.
        push(doc, rev = baseRev) {
            queued = doc;
            baseRev = rev;
            if (!running) running = drain().finally(() => { running = null; });
            return running;
        },
        // Un document est-il encore à écrire (en file ou en vol) ?
        get pending() {
            return queued !== null || running !== null;
        },
        // Révision adoptée sans écriture (après un GET ou un conflit).
        setRev(rev) {
            baseRev = rev;
        },
    };
}
