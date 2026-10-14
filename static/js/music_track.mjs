// Musique choisie par l'utilisateur : source unique pour l'interface, l'aperçu
// et les exports.
//
// Auparavant chacun relisait `#inputAudioFile.files[0]`, et chaque export
// renvoyait le fichier complet au serveur. La musique est désormais copiée
// sur le serveur dès sa sélection ; les exports n'en transmettent plus que le
// nom. Cette copie se fait en tâche de fond : un export lancé avant sa fin
// l'attend, et un échec est retenté au prochain besoin plutôt que mémorisé.
//
// Module pur : l'envoi est injecté (cf. music_track.js pour le navigateur,
// test_music_track.mjs pour les tests).

export function createMusicTrack({ upload, onUploadError = () => {} }) {
    // Par fichier, { file, name, pending } : `name` est le nom sur le serveur
    // une fois la copie faite, `pending` la copie en cours. Indexé par le
    // fichier lui-même : la copie d'une musique remplacée entre-temps ne peut
    // rien écraser, et un export qui a figé l'ancienne la retrouve sans la
    // renvoyer. La WeakMap ne retient aucun fichier en mémoire.
    const entries = new WeakMap();
    let current = null;

    function entryFor(file) {
        let entry = entries.get(file);
        if (!entry) {
            entry = { file, name: null, pending: null };
            entries.set(file, entry);
        }
        return entry;
    }

    function startUpload(entry) {
        entry.pending = Promise.resolve()
            .then(() => upload(entry.file))
            .then((name) => {
                entry.name = name;
                return name;
            })
            .finally(() => { entry.pending = null; });
        return entry.pending;
    }

    function serverNameOf(entry) {
        if (entry.name) return Promise.resolve(entry.name);
        return entry.pending || startUpload(entry);
    }

    return {
        // Nouvelle musique : sa copie vers le serveur démarre aussitôt.
        // `serverName` : musique déjà sur le serveur (rechargée au démarrage),
        // rien à envoyer. Un échec de copie n'est signalé qu'à qui attend le
        // nom (serverName) : il n'est pas définitif.
        select(file, { serverName = null } = {}) {
            if (!file) { current = null; return; }
            current = entryFor(file);
            if (serverName) current.name = serverName;
            if (!current.name && !current.pending) {
                startUpload(current).catch(() => {});
            }
        },
        clear() {
            current = null;
        },
        file() {
            return current?.file || null;
        },
        hasFile() {
            return !!current;
        },
        // Nom de `file` sur le serveur, ou null si la copie échoue (à
        // l'appelant de se replier). Sans argument : la musique courante.
        // Ne change pas la musique courante (un export peut viser celle
        // qu'il a figée au départ).
        async serverName(file = current?.file) {
            if (!file) return null;
            try {
                return await serverNameOf(entryFor(file));
            } catch (err) {
                onUploadError(err, file);
                return null;
            }
        },
    };
}
