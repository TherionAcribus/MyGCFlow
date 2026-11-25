// Moteur des ajustements du parcours ouvert : écritures mises en file (un
// envoi à la fois, dans l'ordre des gestes), fusion locale identique à
// `parcours_store.patch_overrides`, historique Annuler/Rétablir (déplacements
// d'étapes et de lieux, créations et suppressions de lieux recréés avec un
// nouvel id recollé par `remapPlaceId`), gestes de rang/journée et CRUD des
// lieux.
//
// L'état du parcours ouvert arrive par `getState()` ; `inputs` est muté en
// place (même référence que parcours_data.js). Reconstruction, liste, plan et
// chronologie sont injectés — pas d'import de parcours_data.js.
import { KIND_BASE } from './parcours_reconstruct.mjs';

const el = (id) => document.getElementById(id);

// deps : { getState, fetchJson, rebuild, renderStops, applyTimeline,
//          renderLayer, linkPhoto, clockRunning, showToast, t }
// getState() → { selectedId, inputs, ordered }
export function createParcoursAdjust(deps) {
    const s = () => deps.getState() || {};
    const { showToast, t } = deps;

    let adjustmentRevision = 0;

    function locked() {
        if (!deps.clockRunning()) return false;
        showToast(t('Arrêtez la lecture avant d’ajuster le parcours.'), 'info', t('Parcours'));
        return true;
    }

    // Les ajustements renvoyés par le serveur remplacent ceux en mémoire, puis le
    // parcours est reconstruit (pur, donc immédiat) et rejoué tel quel.
    // `forId` : parcours à qui vient la réponse — arrivée après l'ouverture d'un
    // autre parcours, elle est ignorée plutôt qu'appliquée à ses entrées.
    // Vrai si le relevé renvoyé par le serveur est identique à l'état local :
    // la réponse d'une écriture déjà fusionnée n'a alors pas à tout redessiner.
    // Les ajustements sont triés par clé (le serveur les trie, la fusion locale
    // ajoute les nouvelles lignes en fin).
    function adjustmentsMatchLocal(payload) {
        const { inputs } = s();
        if (Array.isArray(payload?.overrides)) {
            const byKey = (rows) => (rows || []).slice().sort((a, b) => String(a.key).localeCompare(String(b.key)));
            if (JSON.stringify(byKey(inputs.overrides)) !== JSON.stringify(byKey(payload.overrides))) return false;
        }
        for (const field of ['places', 'photos', 'cameras', 'tracks']) {
            if (Array.isArray(payload?.[field])
                && JSON.stringify(inputs[field] ?? null) !== JSON.stringify(payload[field])) return false;
        }
        return true;
    }

    function receive(payload, forId) {
        const { inputs, selectedId } = s();
        if (!inputs || forId !== selectedId) return;
        // Des écritures d'ajustements locales sont en avance sur le serveur :
        // ne pas les écraser par une vue datée — le dernier envoi refera foi.
        if (Array.isArray(payload?.overrides) && overridesQueued === 0) inputs.overrides = payload.overrides;
        if (Array.isArray(payload?.places)) inputs.places = payload.places;
        if (Array.isArray(payload?.photos)) inputs.photos = payload.photos;
        if (Array.isArray(payload?.cameras)) inputs.cameras = payload.cameras;
        if (Array.isArray(payload?.tracks)) inputs.tracks = payload.tracks;
        deps.rebuild();
        deps.renderStops();
        deps.applyTimeline();
        adjustmentRevision++;
    }

    // Écritures d'ajustements mises en file : elles partent dans l'ordre des
    // gestes. La fusion locale fait qu'un second clic (descendre deux fois de
    // suite, par exemple) compose sur l'état à jour au lieu de repartir de
    // l'état d'avant le premier — sans elle, les deux envois porteraient le
    // même déplacement et l'un serait perdu.
    let overridesChain = Promise.resolve();
    let overridesQueued = 0;
    // Chaque écriture emporte l'entrée d'historique de son geste (même ordre) :
    // un envoi refusé la fait sortir, sinon Ctrl+Z rejouerait un geste jamais
    // enregistré (et l'entrée dépilée revient, comme pour les lieux).
    let pendingHistory = [];
    // Un envoi refusé laisse l'état local (fusionné avant l'envoi) en avance
    // sur le serveur : une relecture /adjustments le resynchronise en fin de
    // file. Son propre échec est absorbé — la laisser rejeter figerait la
    // file rejetée et les gestes suivants ne partiraient jamais ; le drapeau
    // reste alors posé et la tentative se refait au geste suivant.
    let resyncNeeded = false;
    // Écritures en file ou en vol : si la page se ferme avant leur envoi, la
    // sauvegarde de secours (closingWrites) les renvoie par un fetch
    // keepalive. Une écriture en sort à sa réponse — appliquée ou refusée,
    // elle n'est plus « en attente ».
    let pendingWrites = [];

    // Fusion identique au serveur (parcours_store.patch_overrides) : champ
    // présent → remplacé (null l'efface), absent → gardé ; ligne vidée → retirée.
    function mergeOverrides(patches) {
        const { inputs } = s();
        const rows = new Map((inputs.overrides || []).map((o) => [o.key, { ...o }]));
        for (const patch of patches) {
            const row = rows.get(patch.key) || {
                key: patch.key, rank: null, pinnedTime: null, day: null, excluded: false, legMode: null, visitMin: null,
                position: null,
            };
            for (const field of ['rank', 'pinnedTime', 'day', 'excluded', 'legMode', 'visitMin', 'position']) {
                if (field in patch) row[field] = patch[field];
            }
            if (row.rank === null && row.pinnedTime === null && row.day === null && !row.excluded
                    && row.legMode === null && row.visitMin === null && (row.position ?? null) === null) {
                rows.delete(patch.key);
            } else {
                rows.set(patch.key, row);
            }
        }
        inputs.overrides = [...rows.values()];
    }

    // Historique des ajustements : une entrée = la liste des ajustements telle
    // qu'elle était AVANT le geste (JSON — copie et comparaison en une fois),
    // la position d'un lieu avant son déplacement (`{ place, lat, lon }`), sa
    // création (`{ placeCreate }`, annulée en le supprimant) ou sa suppression
    // (`{ placeDelete }`, annulée en le recréant — nouvel id : les références
    // sont recollées par remapPlaceId). L'annulation rejoue l'état précédent
    // comme des patches, ou applique l'opération inverse du geste lieu.
    const UNDO_LIMIT = 50;
    let undoStack = [];
    let redoStack = [];

    function snapshotOverrides() {
        return JSON.stringify((s().inputs?.overrides || []).map((o) => ({ ...o })));
    }

    // Patches transformant les ajustements actuels en `target` : chaque ligne
    // voulue est posée entière, chaque ligne disparue est vidée (ce qui la
    // retire, même sémantique de fusion que le serveur).
    function patchesTo(target) {
        const fields = { rank: null, pinnedTime: null, day: null, excluded: false, legMode: null, visitMin: null, position: null };
        // `position` est un objet : comparée par valeur.
        const same = (f, a, b) => (f === 'position' ? JSON.stringify(a ?? null) === JSON.stringify(b ?? null) : a === b);
        const current = new Map((s().inputs.overrides || []).map((o) => [o.key, o]));
        const wanted = new Map(target.map((o) => [o.key, o]));
        const patches = [];
        for (const [key, row] of wanted) {
            const next = { key };
            for (const field of Object.keys(fields)) {
                next[field] = field === 'excluded' ? !!row[field] : (row[field] ?? null);
            }
            const cur = current.get(key);
            if (!cur || Object.keys(fields).some((f) => !same(f, next[f], f === 'excluded' ? !!cur[f] : (cur[f] ?? null)))) {
                patches.push(next);
            }
        }
        for (const key of current.keys()) {
            if (!wanted.has(key)) patches.push({ key, ...fields });
        }
        return patches;
    }

    // Écrit les patches : fusion locale, reconstruction, envoi en file — sans
    // enregistrer dans l'historique (utilisé par l'annulation elle-même).
    // `historySlot` : { history? } rempli par l'appelant quand il empile une
    // entrée ; en cas de refus, l'entrée sort de sa pile (et `restore` remet
    // l'entrée dépilée par un annuler/rétablir).
    function writeOverrides(patches, historySlot = null) {
        if (!patches.length) return;
        const pid = s().selectedId;
        mergeOverrides(patches);
        deps.rebuild();
        deps.renderStops();
        deps.applyTimeline();
        pendingHistory.push(historySlot);
        const pending = { pid, patches };
        pendingWrites.push(pending);
        overridesQueued++;
        overridesChain = overridesChain.then(async () => {
            overridesQueued--;
            const slot = pendingHistory.shift();
            try {
                const payload = await deps.fetchJson(`/api/parcours/${pid}/overrides`, {
                    method: 'PATCH',
                    body: JSON.stringify({ overrides: patches }),
                    // Survit à la fermeture de la page (les patches sont
                    // minuscules, loin de la limite keepalive de 64 Kio).
                    keepalive: true,
                });
                // Une écriture plus récente attend encore : l'état local la
                // précède déjà, et le serveur renvoie toujours l'ensemble — la
                // réponse du dernier envoi refera foi. Réponse identique à
                // l'état local (geste déjà fusionné) : rien à redessiner, la
                // révision signale seulement la réponse traitée.
                if (overridesQueued === 0) {
                    if (adjustmentsMatchLocal(payload)) adjustmentRevision++;
                    else receive(payload, pid);
                }
            } catch (error) {
                showToast(error.message, 'error');
                const history = slot?.history;
                if (history) {
                    const index = history.stack.lastIndexOf(history.value);
                    if (index >= 0) history.stack.splice(index, 1);
                    if (history.restore) history.restore.stack.push(history.restore.entry);
                    updateButtons();
                }
                resyncNeeded = true;
            } finally {
                pendingWrites = pendingWrites.filter((w) => w !== pending);
            }
            // File écoulée et état à resynchroniser : la relecture est
            // absorbée (voir `resyncNeeded` ci-dessus).
            if (overridesQueued === 0 && resyncNeeded) {
                try {
                    await reload(pid);
                    resyncNeeded = false;
                } catch (resyncError) {
                    console.warn('[PARCOURS] Relecture des ajustements impossible :', resyncError);
                }
            }
        });
    }

    function save(patches) {
        const { selectedId, inputs } = s();
        if (!selectedId || locked() || !inputs) return;
        const before = snapshotOverrides();
        const historySlot = {};
        writeOverrides(patches, historySlot);
        // Le geste n'entre dans l'historique que s'il a changé quelque chose ;
        // l'entrée suit l'écriture : un refus du serveur la fait sortir.
        if (snapshotOverrides() !== before) {
            push(before);
            historySlot.history = { stack: undoStack, value: before };
        }
    }

    function push(entry) {
        undoStack.push(entry);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack = [];
        updateButtons();
    }

    function placeById(id) {
        return (s().inputs?.places || []).find((p) => p.id === id) || null;
    }

    // Le lieu recréé par une annulation de suppression a un nouvel id : ce qui
    // citait l'ancien est recollé dessus — entrées d'historique (déplacements,
    // créations en attente) et références serveur (ajustements, photos) restées
    // orphelines sous la clé « place:oldId ».
    function remapPlaceId(oldId, newId) {
        // SQLite peut réattribuer le même id à la recréation : les références
        // « place:oldId » redeviennent valides d'elles-mêmes, rien à recoller.
        if (oldId === newId) return;
        const stale = `"place:${oldId}"`;
        const fresh = `"place:${newId}"`;
        for (const stack of [undoStack, redoStack]) {
            stack.forEach((entry, index) => {
                if (typeof entry === 'string') {
                    if (entry.includes(stale)) stack[index] = entry.replaceAll(stale, fresh);
                } else {
                    if (entry.place === oldId) entry.place = newId;
                    if (entry.placeCreate === oldId) entry.placeCreate = newId;
                    if (entry.placeDelete?.id === oldId) entry.placeDelete.id = newId;
                }
            });
        }
        const oldKey = `place:${oldId}`;
        const newKey = `place:${newId}`;
        const patches = (s().inputs?.overrides || []).filter((o) => o.key === oldKey).map((o) => ({
            key: newKey,
            rank: o.rank ?? null,
            pinnedTime: o.pinnedTime ?? null,
            day: o.day ?? null,
            excluded: !!o.excluded,
            legMode: o.legMode ?? null,
            visitMin: o.visitMin ?? null,
            position: o.position ?? null,
        }));
        if (patches.length) {
            patches.push({ key: oldKey, rank: null, pinnedTime: null, day: null, excluded: false, legMode: null, visitMin: null, position: null });
            writeOverrides(patches);
        }
        for (const photo of s().inputs?.photos || []) {
            if (photo.stopKey === oldKey) deps.linkPhoto(photo.id, newKey);
        }
    }

    // Dépile `from` vers `to` : l'état actuel passe dans `to`, l'entrée dépilée
    // est rejouée. Une entrée d'un lieu disparu est sautée.
    function stepHistory(from, to) {
        const { selectedId, inputs } = s();
        if (!selectedId || locked() || !inputs) return;
        while (from.length) {
            const entry = from.pop();
            if (typeof entry === 'string') {
                const back = snapshotOverrides();
                to.push(back);
                writeOverrides(patchesTo(JSON.parse(entry)), { history: {
                    stack: to, value: back, restore: { stack: from, entry } } });
                break;
            }
            if (entry.placeCreate) {
                // Annuler une création : supprimer le lieu, qui repartira au
                // rétablissement avec les données capturées ici.
                const place = placeById(entry.placeCreate);
                if (!place) continue;
                const back = { placeDelete: { ...place } };
                to.push(back);
                deletePlace(place.id, { record: false }).then((ok) => {
                    if (ok) return;
                    const index = to.lastIndexOf(back);
                    if (index >= 0) to.splice(index, 1);
                    from.push(entry);
                    updateButtons();
                    deps.renderLayer();
                });
                break;
            }
            if (entry.placeDelete) {
                // Annuler une suppression : recréer le lieu. Le serveur donne
                // un nouvel id — ce qui citait l'ancien est recollé dessus.
                const data = { ...entry.placeDelete };
                const oldId = data.id;
                delete data.id;
                createPlace(data, { record: false }).then((place) => {
                    if (!place?.id) {
                        from.push(entry);
                        updateButtons();
                        return;
                    }
                    to.push({ placeCreate: place.id });
                    remapPlaceId(oldId, place.id);
                    updateButtons();
                });
                break;
            }
            const place = placeById(entry.place);
            if (!place) continue;
            const back = { place: place.id, lat: place.lat, lon: place.lon };
            to.push(back);
            updatePlace(place.id, { lat: entry.lat, lon: entry.lon }).then((ok) => {
                if (ok) return;
                // Refusé : l'entrée retourne d'où elle venait.
                const index = to.lastIndexOf(back);
                if (index >= 0) to.splice(index, 1);
                from.push(entry);
                updateButtons();
                deps.renderLayer();
            });
            break;
        }
        updateButtons();
    }

    function updateButtons() {
        const undo = el('btnParcoursUndo');
        const redo = el('btnParcoursRedo');
        if (undo) undo.disabled = undoStack.length === 0;
        if (redo) redo.disabled = redoStack.length === 0;
    }

    // Nouvel ordre d'une journée : un rang pour chacune de ses étapes.
    function reorderDay(keys) {
        save(keys.map((key, rank) => ({ key, rank })));
    }

    function moveStop(day, key, delta) {
        const keys = day.stops.filter((stop) => stop.kind !== KIND_BASE).map((stop) => stop.key);
        const from = keys.indexOf(key);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= keys.length) return;
        keys.splice(to, 0, keys.splice(from, 1)[0]);
        reorderDay(keys);
    }

    // Déplacer une étape vers une autre journée, au rang où elle est lâchée :
    // sa clé rejoint les rangs de la journée cible ; revenue à sa journée
    // d'origine, l'ajustement « journée » disparaît (comme le panneau).
    function moveStopToDay(day, key, index) {
        const sourceDay = s().ordered?.days.find((d) => d.stops.some((stop) => stop.key === key));
        const source = sourceDay?.stops.find((stop) => stop.key === key);
        const original = source?.movedFrom || sourceDay?.date;
        const keys = day.stops.filter((stop) => stop.kind !== KIND_BASE).map((stop) => stop.key);
        keys.splice(Math.min(index, keys.length), 0, key);
        save(keys.map((k, rank) => (k === key
            ? { key: k, day: day.date === original ? null : day.date, rank }
            : { key: k, rank })));
    }

    function resetDayOrder(day) {
        save(day.stops.filter((stop) => stop.kind !== KIND_BASE).map((stop) => ({ key: stop.key, rank: null })));
    }

    // Écritures encore en file ou en vol quand la page se ferme : renvoyées
    // par un fetch keepalive, qui survit au déchargement (parcours_data.js
    // les écoute sur `pagehide`). Concaténées par parcours dans l'ordre des
    // gestes — le serveur les applique pareil, et une écriture déjà reçue
    // est appliquée une seconde fois sans effet.
    function closingWrites() {
        const byPid = new Map();
        for (const write of pendingWrites) {
            const list = byPid.get(write.pid) || [];
            byPid.set(write.pid, list.concat(write.patches));
        }
        return [...byPid.entries()].map(([pid, patches]) => ({
            url: `/api/parcours/${pid}/overrides`,
            body: JSON.stringify({ overrides: patches }),
        }));
    }

    function resetAll() {
        // Même file que les PATCH : un déplacement encore en vol doit être
        // écrit AVANT la remise à zéro, sinon il ressusciterait ses ajustements.
        // Le vidage par lignes nulles retire chaque ajustement — et entre dans
        // l'historique comme les autres gestes.
        save(patchesTo([]));
    }

    // Relecture légère après un geste : /adjustments renvoie les ajustements,
    // lieux, photos et caméras — pas les journées reconstruites ni, sauf
    // `tracks` (envoi ou retrait d'une trace), les points GPS des traces.
    async function reload(forId, { tracks = false } = {}) {
        // Le parcours a changé pendant la requête : rien à appliquer.
        if (forId !== s().selectedId) return;
        const fresh = await deps.fetchJson(`/api/parcours/${forId}/adjustments${tracks ? '?tracks=1' : ''}`);
        receive(fresh, forId);
    }

    async function createPlace(data, { record = true } = {}) {
        const pid = s().selectedId;
        if (!pid || locked()) return false;
        try {
            const { place } = await deps.fetchJson(`/api/parcours/${pid}/places`, { method: 'POST', body: JSON.stringify(data), keepalive: true });
            await reload(pid);
            if (record && place?.id != null) push({ placeCreate: place.id });
            return place || false;
        } catch (error) {
            showToast(error.message, 'error');
            return false;
        }
    }

    async function updatePlace(id, data) {
        const pid = s().selectedId;
        if (!pid || locked()) return false;
        try {
            await deps.fetchJson(`/api/parcours/${pid}/places/${id}`, { method: 'PATCH', body: JSON.stringify(data), keepalive: true });
            await reload(pid);
            return true;
        } catch (error) {
            showToast(error.message, 'error');
            return false;
        }
    }

    async function deletePlace(id, { record = true } = {}) {
        const pid = s().selectedId;
        if (!pid || locked()) return false;
        // Données capturées avant la requête : une suppression annulée recrée
        // le lieu tel qu'il était.
        const place = placeById(id);
        try {
            await deps.fetchJson(`/api/parcours/${pid}/places/${id}`, { method: 'DELETE', keepalive: true });
            // Les déplacements et créations citant le lieu deviennent morts ;
            // les entrées « suppression », elles, restent rejouables.
            const kept = (entry) => typeof entry === 'string'
                || (entry.place !== id && entry.placeCreate !== id);
            undoStack = undoStack.filter(kept);
            redoStack = redoStack.filter(kept);
            if (record && place) push({ placeDelete: { ...place } });
            else updateButtons();
            await reload(pid);
            return true;
        } catch (error) {
            showToast(error.message, 'error');
            return false;
        }
    }

    return {
        locked,
        receive,
        save,
        reload,
        createPlace,
        updatePlace,
        deletePlace,
        placeById,
        push,
        reorderDay,
        moveStop,
        moveStopToDay,
        resetDayOrder,
        resetAll,
        updateButtons,
        undo: () => stepHistory(undoStack, redoStack),
        redo: () => stepHistory(redoStack, undoStack),
        resetHistory: () => { undoStack = []; redoStack = []; },
        depths: () => ({ undo: undoStack.length, redo: redoStack.length }),
        queued: () => overridesQueued,
        closingWrites,
        revision: () => adjustmentRevision,
    };
}
