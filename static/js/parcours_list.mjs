// Liste des parcours enregistrés, formulaire de création/modification et
// parcours suggérés (séjours loin de chez soi, grosses journées) de la page
// Parcours.
//
// L'état partagé arrive par `getState()` ; l'état du panneau (parcours en
// cours d'édition, suggestions reçues) est interne. `refreshParcoursList`,
// `openParcours` et l'effacement de la sélection restent orchestrés par
// parcours_data.js et arrivent en deps — pas d'import de parcours_data.js.
import { showConfirmation, showToast, t } from './notifications.js';
import { formatRange, stopsCountText, suggestionName } from './parcours_labels.mjs';
import { buildParcoursGpx } from './parcours_gpx.mjs';
import { rangeDayCount } from './parcours_model.mjs';

const el = (id) => document.getElementById(id);

// deps : { getState, fetchJson, openParcours, refreshParcoursList,
//   clearSelection }
export function createParcoursList(deps) {
    const S = () => deps.getState();

    // Le formulaire sert aux deux : le crayon d'un parcours le remplit et son
    // envoi devient un PATCH — modifier ne perd ni ajustements, ni photos, ni
    // traces (contrairement à supprimer puis recréer).
    let editingParcoursId = null;

    // Formulaire de création ouvert par « Nouveau parcours ». Sans parcours
    // enregistré ou en modification, il s'affiche de toute façon ; sinon il
    // reste replié — il occupait le haut de l'onglet, au-dessus des étapes.
    let formOpen = false;

    // Séjours loin de chez soi et grosses journées (parcours_suggest.py),
    // hors plages déjà enregistrées.
    let suggestions = [];
    let suggestionsSeq = 0;
    let suggestionsTotal = 0;   // total côté serveur (la réponse est plafonnée)
    let suggestionsExpanded = false;

    function renderListError() {
        const list = el('parcoursList');
        if (!list) return;
        const item = document.createElement('div');
        item.className = 'text-danger small d-flex align-items-center gap-2 p-3';
        const text = document.createElement('span');
        text.textContent = t('Impossible de charger les parcours');
        // Nouvel essai sans recharger la page : un nouvel échec recrée ce
        // bouton (renderListError est rappelée par refreshParcoursList).
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-sm btn-outline-secondary parcours-retry';
        retry.textContent = t('Réessayer');
        retry.addEventListener('click', async () => {
            retry.disabled = true;
            retry.textContent = t('Chargement…');
            await deps.refreshParcoursList({ select: S().selectedId });
        });
        item.append(text, retry);
        list.replaceChildren(item);
    }

    function renderList(activeId) {
        const { listing, selectedId } = S();
        const list = el('parcoursList');
        if (!list) return;
        if (listing.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'text-muted small p-3';
            empty.id = 'parcoursListEmpty';
            empty.textContent = t('Aucun parcours pour l’instant : créez-en un ci-dessous.');
            list.replaceChildren(empty);
            syncParcoursForm();
            return;
        }
        syncParcoursForm();
        list.replaceChildren(...listing.map((item) => {
            const row = document.createElement('div');
            row.className = 'list-group-item d-flex align-items-center gap-2 parcours-list-item';
            row.classList.toggle('active', item.id === activeId);
            row.dataset.parcoursId = String(item.id);

            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'btn btn-link p-0 text-start flex-grow-1 parcours-open';
            open.setAttribute('aria-current', item.id === activeId ? 'true' : 'false');
            const name = document.createElement('div');
            name.className = 'fw-medium';
            name.textContent = item.name;
            const range = document.createElement('div');
            range.className = 'small text-muted';
            const days = rangeDayCount(item.date_start, item.date_end);
            range.textContent = days > 0
                ? `${formatRange(item.date_start, item.date_end)} · `
                    + (days === 1 ? t('Une journée') : t('${n} jours', { n: days }))
                : formatRange(item.date_start, item.date_end);
            open.append(name, range, listCounts(item));
            open.addEventListener('click', () => {
                if (item.id !== selectedId) deps.openParcours(item.id);
            });

            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'btn btn-sm btn-ghost-secondary parcours-edit';
            edit.setAttribute('aria-label', t('Modifier le parcours'));
            edit.title = t('Modifier le parcours');
            edit.innerHTML = '<i class="ti ti-pencil" aria-hidden="true"></i>';
            edit.addEventListener('click', () => startEditParcours(item));

            // Actions secondaires dans un menu « ⋯ » : la ligne reste lisible
            // quand la liste est longue. `strategy: "fixed"` : le menu n'est
            // pas rogné par le défilement de .parcours-list.
            const wrap = document.createElement('div');
            wrap.className = 'dropdown';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'btn btn-sm btn-ghost-secondary parcours-menu';
            toggle.setAttribute('data-bs-toggle', 'dropdown');
            toggle.setAttribute('data-bs-popper-config', '{"strategy":"fixed"}');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.setAttribute('aria-label', t('Actions du parcours'));
            toggle.title = t('Actions du parcours');
            toggle.innerHTML = '<i class="ti ti-dots" aria-hidden="true"></i>';
            const menu = document.createElement('ul');
            menu.className = 'dropdown-menu dropdown-menu-end';
            const menuItem = (cls, icon, label, title, danger, action) => {
                const li = document.createElement('li');
                const entry = document.createElement('button');
                entry.type = 'button';
                entry.className = `dropdown-item ${cls}${danger ? ' text-danger' : ''}`;
                entry.title = title;
                entry.innerHTML = `<i class="ti ${icon} me-2" aria-hidden="true"></i>`;
                entry.append(document.createTextNode(label));
                entry.addEventListener('click', action);
                li.append(entry);
                return li;
            };
            menu.append(
                menuItem('parcours-duplicate', 'ti-copy', t('Dupliquer'),
                    t('Dupliquer le parcours'), false, () => duplicateParcours(item.id)),
                menuItem('parcours-export', 'ti-download', t('Exporter'),
                    t('Exporter le parcours (sélection, ajustements, lieux)'), false,
                    () => exportParcours(item)),
                menuItem('parcours-export-zip', 'ti-archive', t('Exporter tout'),
                    t('Exporter le parcours complet : JSON, photos et traces (ZIP)'), false,
                    () => exportZip(item)),
            );
            const divider = document.createElement('li');
            divider.innerHTML = '<hr class="dropdown-divider">';
            menu.append(divider, menuItem('parcours-delete', 'ti-trash', t('Supprimer'),
                t('Supprimer le parcours'), true, () => confirmDelete(item)));
            wrap.append(toggle, menu);

            row.append(open, edit, wrap);
            return row;
        }));
    }

    // Pastilles de la ligne : toujours les étapes, puis les autres comptes
    // quand ils ne sont pas nuls (rien d'autre à dire d'un parcours vide).
    function listCounts(item) {
        const box = document.createElement('div');
        box.className = 'small text-muted d-flex flex-wrap gap-2 parcours-item-counts';
        const counts = item.counts || {};
        const n = (key) => counts[key] ?? 0;
        // Libellé en clair, accordé : l'icône suivie d'un nombre seul ne se
        // lisait pas (« 5 » à côté de deux repères qui ressemblaient à « % »).
        const entries = [
            ['ti-map-pins', 'stops', stopsCountText(n('stops')), true],
            ['ti-photo', 'photos', n('photos') === 1 ? t('1 photo') : t('${n} photos', { n: n('photos') }), n('photos') > 0],
            ['ti-route', 'tracks', n('tracks') === 1 ? t('1 trace') : t('${n} traces', { n: n('tracks') }), n('tracks') > 0],
            ['ti-map-pin', 'places', n('places') === 1 ? t('1 lieu ou base') : t('${n} lieux ou bases', { n: n('places') }),
                n('places') > 0],
            ['ti-adjustments', 'overrides', n('overrides') === 1 ? t('1 ajustement') : t('${n} ajustements', { n: n('overrides') }),
                n('overrides') > 0],
        ];
        for (const [icon, key, label, show] of entries) {
            if (!show) continue;
            const span = document.createElement('span');
            span.className = `parcours-count parcours-count-${key}`;
            const glyph = document.createElement('i');
            glyph.className = `ti ${icon} me-1`;
            glyph.setAttribute('aria-hidden', 'true');
            span.append(glyph, document.createTextNode(label));
            box.append(span);
        }
        return box;
    }

    // Copie côté serveur : sélection, ajustements, lieux et bases — jamais les
    // photos ni les traces (fichiers lourds, ré-envoyables).
    async function duplicateParcours(id) {
        try {
            await deps.fetchJson(`/api/parcours/${id}/duplicate`, { method: 'POST' });
        } catch (error) {
            showToast(error.message, 'error');
            return;
        }
        await deps.refreshParcoursList({ select: S().selectedId });
        showToast(t('Parcours dupliqué — les photos et traces ne sont pas copiées'), 'info');
    }

    function parcoursSlug(name) {
        return (name || '').toLowerCase().normalize('NFD')
            .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'parcours';
    }

    function downloadText(filename, mime, text) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([text], { type: mime }));
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    // Export JSON réimportable : sélection, ajustements, lieux et bases.
    async function exportParcours(item) {
        let payload;
        try {
            payload = await deps.fetchJson(`/api/parcours/${item.id}/export`);
        } catch (error) {
            showToast(error.message, 'error');
            return;
        }
        downloadText(`parcours-${parcoursSlug(item.name)}.json`,
            'application/json', JSON.stringify(payload, null, 2));
    }

    // Sauvegarde complète (JSON enrichi + photos + traces) : le nom du
    // fichier arrive par Content-Disposition, un lien suffit.
    function exportZip(item) {
        const link = document.createElement('a');
        link.href = `/api/parcours/${item.id}/export.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    // Export GPX pour le GPS : l'itinéraire reconstruit (étapes dans l'ordre,
    // heures d'arrivée prévues), une route par journée.
    function exportGpx() {
        const { ordered, inputs, utcOffset } = S();
        if (!ordered || !inputs?.parcours) return;
        downloadText(`parcours-${parcoursSlug(inputs.parcours.name)}.gpx`,
            'application/gpx+xml',
            buildParcoursGpx({ name: inputs.parcours.name, days: ordered.days, utcOffsetMinutes: utcOffset.minutes }));
    }

    // Import d'un export JSON : le serveur valide le format, la plage, les
    // ajustements et les lieux — tout ou rien.
    async function importParcoursFile(file) {
        let payload;
        try {
            payload = JSON.parse(await file.text());
        } catch {
            showToast(t('Ce fichier n\'est pas un JSON lisible'), 'error');
            return;
        }
        try {
            await deps.fetchJson('/api/parcours/import', { method: 'POST', body: JSON.stringify(payload) });
        } catch (error) {
            showToast(error.message, 'error');
            return;
        }
        formOpen = false;
        await deps.refreshParcoursList({ select: S().selectedId });
        showToast(t('Parcours importé'), 'success');
    }

    // Ce qui part avec le parcours : comptes lus dans les entrées quand il
    // est ouvert, une relecture légère sinon — sans réponse, le message de
    // confirmation reste générique (pas de chiffres).
    async function deleteCounts(item) {
        const toCounts = (src) => ({
            places: (src?.places || []).length,
            overrides: (src?.overrides || []).length,
            photos: (src?.photos || []).length,
            tracks: (src?.tracks || []).length,
        });
        const { selectedId, inputs } = S();
        if (item.id === selectedId && inputs) return toCounts(inputs);
        try {
            return toCounts(await deps.fetchJson(`/api/parcours/${item.id}/adjustments?tracks=1`));
        } catch (_) {
            return null;
        }
    }

    async function confirmDelete(item) {
        const counts = await deleteCounts(item);
        const parts = [];
        if (counts?.places) parts.push(t('${n} lieux ou bases', { n: counts.places }));
        if (counts?.overrides) parts.push(t('${n} ajustements', { n: counts.overrides }));
        if (counts?.photos) parts.push(t('${n} photos', { n: counts.photos }));
        if (counts?.tracks) parts.push(t('${n} traces', { n: counts.tracks }));
        const detail = parts.length
            ? t('Supprimés avec lui : ${items}.', { items: parts.join(', ') })
            : t('Ses lieux, ajustements, photos et traces seront supprimés avec lui.');
        showConfirmation(
            t('Supprimer le parcours « ${name} » ? ${detail} Les trouvailles ne sont pas touchées.',
                { name: item.name, detail }),
            t('Supprimer le parcours'),
            () => deleteParcours(item.id),
            null,
            { danger: true, confirmText: t('Supprimer') },
        );
    }

    async function deleteParcours(id) {
        try {
            await deps.fetchJson(`/api/parcours/${id}`, { method: 'DELETE' });
        } catch (error) {
            showToast(error.message, 'error');
            return;
        }
        if (id === S().selectedId) deps.clearSelection();
        // Le parcours supprimé était en cours de modification : le
        // formulaire repasse en création, sinon « Enregistrer » ciblait un
        // id disparu.
        if (id === editingParcoursId) cancelEditParcours();
        await deps.refreshParcoursList({ select: S().selectedId });
    }

    function startEditParcours(item) {
        editingParcoursId = item.id;
        el('parcoursName').value = item.name;
        el('parcoursStart').value = item.date_start;
        el('parcoursEnd').value = item.date_end;
        el('parcoursIncludeLabs').checked = item.include_labs !== false;
        el('parcoursIncludeDnf').checked = item.include_dnf !== false;
        updateRangeHint();
        syncParcoursForm();
        el('parcoursName')?.focus();
    }

    // Fin d'une modification : le formulaire se replie (il ne reste ouvert
    // que s'il n'y a aucun parcours).
    function cancelEditParcours() {
        if (editingParcoursId === null) return;
        editingParcoursId = null;
        formOpen = false;
        syncParcoursForm();
    }

    function openCreateForm() {
        cancelEditParcours();
        formOpen = true;
        syncParcoursForm();
        el('parcoursName')?.focus();
    }

    // « Annuler la modification » ou « Fermer » (création, des parcours
    // existent déjà).
    function closeForm() {
        if (editingParcoursId !== null) cancelEditParcours();
        formOpen = false;
        syncParcoursForm();
    }

    // Libellés du formulaire selon le mode (création ou modification), et
    // visibilité : replié derrière « Nouveau parcours » dès qu'un parcours
    // existe.
    function syncParcoursForm() {
        const editing = editingParcoursId !== null;
        const hasParcours = S().listing.length > 0;
        const shown = !hasParcours || editing || formOpen;
        const section = el('parcoursFormSection');
        if (section) section.hidden = !shown;
        const newBtn = el('btnParcoursNew');
        if (newBtn) newBtn.hidden = shown;
        const title = el('parcoursFormTitle');
        if (title) title.textContent = editing ? t('Modifier le parcours') : t('Nouveau parcours');
        const submit = el('btnParcoursCreate');
        if (submit) {
            submit.innerHTML = `<i class="ti ${editing ? 'ti-check' : 'ti-plus'} me-1" aria-hidden="true"></i>`
                + (editing ? t('Enregistrer') : t('Créer le parcours'));
        }
        const cancel = el('btnParcoursEditCancel');
        if (cancel) {
            cancel.hidden = !editing && !hasParcours;
            cancel.textContent = editing ? t('Annuler la modification') : t('Fermer');
        }
    }

    function fillFormDefaults() {
        const { findsExtent } = S();
        const start = el('parcoursStart');
        const end = el('parcoursEnd');
        if (!start || !end) return;
        for (const input of [start, end]) {
            if (findsExtent.first) input.min = findsExtent.first;
            if (findsExtent.last) input.max = findsExtent.last;
        }
        // Proposition : le dernier jour de trouvailles (la sortie la plus
        // récente).
        if (!start.value && findsExtent.last) start.value = findsExtent.last;
        if (!end.value && findsExtent.last) end.value = findsExtent.last;
        updateRangeHint();
    }

    function updateRangeHint() {
        const { maxDays } = S();
        const hint = el('parcoursRangeHint');
        if (!hint) return;
        const startValue = el('parcoursStart')?.value;
        const endValue = el('parcoursEnd')?.value;
        // Date manquante (base sans trouvailles, saisie en cours) : rien à
        // signaler, le champ requis le dira à l'envoi.
        const days = startValue && endValue ? rangeDayCount(startValue, endValue) : null;
        const invalid = days === 0 || days > maxDays;
        // text-muted l'emporte sur text-danger : retiré pendant l'erreur.
        hint.classList.toggle('text-danger', invalid);
        hint.classList.toggle('text-muted', !invalid);
        if (days === null) hint.textContent = '';
        else if (days === 0) hint.textContent = t('La date de fin précède la date de début');
        else if (days > maxDays) hint.textContent = t('Un parcours couvre ${max} jours au plus', { max: maxDays });
        else hint.textContent = days === 1 ? t('Une journée') : t('${n} jours', { n: days });
    }

    function bindForm() {
        const form = el('parcoursCreateForm');
        if (!form || form.dataset.bound) return;
        form.dataset.bound = '1';
        const start = el('parcoursStart');
        const end = el('parcoursEnd');
        start?.addEventListener('change', () => {
            // Une journée par défaut : la fin suit le début tant qu'elle le
            // précède.
            if (end && (!end.value || end.value < start.value)) end.value = start.value;
            updateRangeHint();
        });
        end?.addEventListener('change', updateRangeHint);
        el('btnParcoursEditCancel')?.addEventListener('click', closeForm);
        el('btnParcoursNew')?.addEventListener('click', openCreateForm);
        el('btnParcoursImport')?.addEventListener('click', () => el('parcoursImportInput')?.click());
        el('parcoursImportInput')?.addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';        // ré-import du même fichier possible
            if (file) importParcoursFile(file);
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const submit = el('btnParcoursCreate');
            if (submit) submit.disabled = true;
            const payload = {
                name: el('parcoursName')?.value || '',
                date_start: start?.value || '',
                date_end: end?.value || '',
                include_labs: el('parcoursIncludeLabs')?.checked !== false,
                include_dnf: el('parcoursIncludeDnf')?.checked !== false,
            };
            const updateParcours = async (id, extra = {}) => {
                const body = await deps.fetchJson(`/api/parcours/${id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ ...payload, ...extra }),
                });
                cancelEditParcours();
                // Rechargement complet : dates, Labs et DNF changent les
                // entrées du parcours.
                await deps.refreshParcoursList({ select: body.parcours.id });
            };
            let editedId = null;
            try {
                if (editingParcoursId !== null) {
                    editedId = editingParcoursId;
                    await updateParcours(editedId);
                } else {
                    const body = await deps.fetchJson('/api/parcours', {
                        method: 'POST',
                        body: JSON.stringify(payload),
                    });
                    el('parcoursName').value = '';
                    formOpen = false;
                    await deps.refreshParcoursList({ select: body.parcours.id });
                }
            } catch (error) {
                // 'out-of-range' : le rétrécissement laisserait des lieux ou
                // des ajustements dehors — confirmation puis renvoi avec
                // drop_orphans.
                if (error.code === 'out-of-range' && editedId !== null) {
                    const detail = error.detail || {};
                    const parts = [];
                    if (detail.places) parts.push(t('${n} lieux ou bases seront supprimés', { n: detail.places }));
                    if (detail.days) parts.push(t('${n} étapes retrouveront leur journée d’origine', { n: detail.days }));
                    const id = editedId;
                    showConfirmation(
                        t('La nouvelle plage laisse des éléments dehors : ${items}.', { items: parts.join(' ; ') }),
                        t('Raccourcir le parcours'),
                        () => updateParcours(id, { drop_orphans: true })
                            .catch((err) => showToast(err.message, 'error')),
                        null,
                        { danger: true, confirmText: t('Raccourcir quand même') },
                    );
                } else {
                    showToast(error.message, 'error');
                }
            } finally {
                if (submit) submit.disabled = false;
            }
        });
    }

    // Les suggestions arrivent avec la liste (GET /api/parcours) : le relevé
    // des journées de trouvailles n'est calculé qu'une fois côté serveur.
    // « … et N autres » garde son appel à part (limit=0).
    function loadSuggestions(body) {
        suggestionsSeq++;
        suggestions = Array.isArray(body?.suggestions) ? body.suggestions : [];
        suggestionsTotal = typeof body?.suggestionsTotal === 'number'
            ? body.suggestionsTotal : suggestions.length;
        suggestionsExpanded = false;
        renderSuggestions();
    }

    // « … et N autres » : le serveur a plafonné la réponse, on la redemande
    // entière (limit=0) pour tout afficher.
    async function expandSuggestions() {
        const seq = ++suggestionsSeq;
        try {
            const body = await deps.fetchJson('/api/parcours/suggestions?limit=0');
            if (seq !== suggestionsSeq) return;
            suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
            suggestionsTotal = suggestions.length;
            suggestionsExpanded = true;
            renderSuggestions();
        } catch (error) {
            console.warn('[PARCOURS] Suggestions complètes indisponibles :', error);
        }
    }

    function renderSuggestions() {
        const box = el('parcoursSuggestions');
        const list = el('parcoursSuggestionList');
        if (!box || !list) return;
        box.hidden = suggestions.length === 0;
        const children = suggestions.map((item) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'btn btn-sm btn-outline-secondary parcours-suggestion';
            chip.dataset.start = item.start;
            chip.dataset.end = item.end;
            const icon = document.createElement('i');
            icon.className = `ti ${item.kind === 'trip' ? 'ti-plane' : 'ti-walk'} me-1`;
            icon.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.textContent = suggestionName(item);
            const detail = document.createElement('span');
            detail.className = 'text-muted ms-1';
            const finds = t('${n} trouvailles', { n: item.finds });
            detail.textContent = `· ${finds}`;
            chip.append(icon, label, detail);
            chip.addEventListener('click', () => applySuggestion(item));
            return chip;
        });
        const remaining = suggestionsTotal - suggestions.length;
        if (!suggestionsExpanded && remaining > 0) {
            const more = document.createElement('button');
            more.type = 'button';
            more.id = 'btnParcoursSuggestionsMore';
            more.className = 'btn btn-sm btn-link parcours-suggestion-more';
            more.textContent = t('… et ${n} autres', { n: remaining });
            more.addEventListener('click', () => expandSuggestions());
            children.push(more);
        }
        list.replaceChildren(...children);
    }

    function applySuggestion(item) {
        // Une suggestion remplit le formulaire de création, pas une
        // modification ; il reste ouvert.
        cancelEditParcours();
        formOpen = true;
        syncParcoursForm();
        const name = el('parcoursName');
        const start = el('parcoursStart');
        const end = el('parcoursEnd');
        if (name) name.value = suggestionName(item);
        if (start) start.value = item.start;
        if (end) end.value = item.end;
        updateRangeHint();
        el('btnParcoursCreate')?.focus();
    }

    return {
        renderList,
        renderListError,
        bindForm,
        fillFormDefaults,
        updateRangeHint,
        syncParcoursForm,
        startEdit: startEditParcours,
        openCreateForm,
        cancelEdit: cancelEditParcours,
        editingId: () => editingParcoursId,
        loadSuggestions,
        expandSuggestions,
        renderSuggestions,
        suggestions: () => suggestions,
        totalSuggestions: () => suggestionsTotal,
        exportGpx,
        importFile: importParcoursFile,
        confirmDelete,
        duplicate: duplicateParcours,
        exportItem: exportParcours,
        deleteItem: deleteParcours,
    };
}
