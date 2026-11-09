// Page Statistiques : tableau de bord actif — barre, menus de périodes,
// plusieurs tableaux, actualisation, filtres, renommer.

import { showActionToast, showConfirmation, showError, showToast, t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import { findsTable } from './chart_sources.mjs';
import { filterMask } from './chart_query.mjs';
import { activeFilterCount, describeFilters } from './chart_filters.mjs';
import { readFilterForm, renderFilterForm } from './stats_filters_ui.js';
import { filtersFromMapSelection } from './chart_map_link.mjs';
import {
    dashboardSources, defaultDashboard, duplicateDashboard, exportDashboard, importDashboard, MAX_DASHBOARDS,
    periodChoices, periodOfValue, periodValue,
} from './dashboard_model.mjs';
import { download, fileSafe } from './stats_page_card_actions.js';
import { menuButton, renderAllCharts, renderDashboard } from './stats_page_cards.js';
import {
    dashboardExtent, dashboardTables, ensureEvolution, fetchJson, loadDatasets, loadPersonalLoader,
    PERSONAL_LOADERS, setTable, tableOf,
} from './stats_page_data.js';
import { copyDashboardImage, saveDashboardImage } from './stats_page_exports.js';
import { scheduleSave } from './stats_page_save.js';
import { $, state } from './stats_page_state.js';
import { openDashboardVideo } from './stats_page_video.js';

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------

export function activeDashboard() {
    return state.doc.dashboards.find((d) => d.id === state.doc.active) || state.doc.dashboards[0];
}

export function attributeName(key) {
    const attr = (tableOf('finds').dicts.attribute || []).find((a) => a.key === key);
    return attr ? attr.name : key;
}

export function datasetName(id) {
    return state.datasets.find((d) => d.id === id)?.name || t('Jeu ${id}', { id });
}

export function chartTitle(spec) {
    return spec.title || state.labels.defaultTitle(spec);
}

// Menu de périodes. `choices` : la liste proposée ; `inherit` ajoute
// « Période du tableau de bord » (valeur vide).
export function fillPeriodSelect(select, current, { inherit = false, choices = null } = {}) {
    const list = choices || periodChoices(dashboardExtent(), state.today);
    select.replaceChildren();
    if (inherit) select.append(new Option(t('Période du tableau de bord'), ''));
    const values = new Set();
    for (const period of list) {
        const value = periodValue(period);
        values.add(value);
        select.append(new Option(state.labels.periodChoiceLabel(period), value));
    }
    // Période posée ailleurs (question, import) absente de la liste.
    const currentValue = periodValue(current);
    if (current && !values.has(currentValue)) {
        select.append(new Option(state.labels.periodChoiceLabel(current), currentValue));
    }
    select.value = currentValue;
}

// Pastille d'un graphique qui a ses propres périodes ou en compare
// plusieurs : « 2024 », « Cette année · La période précédente »…
export function periodsBadge(spec) {
    if (!Array.isArray(spec.periods)) return '';
    if (spec.periods.length > 2) return t('${n} périodes', { n: spec.periods.length });
    return spec.periods.map((p) => state.labels.periodChoiceLabel(p)).join(' · ');
}

export function renderToolbar() {
    const dashboard = activeDashboard();
    $('statsDashboardName').textContent = dashboard.name || t('Mon tableau de bord');
    const kind = $('statsDashboardKind');
    kind.hidden = dashboard.kind !== 'evolution';
    kind.textContent = dashboard.kind === 'evolution' ? t('Évolution · ${name}', { name: datasetName(dashboard.dataset) }) : '';
    renderDashboardMenu();
    fillPeriodSelect($('statsGlobalPeriod'), dashboard.period);
    $('statsDataNote').textContent = dataNote(dashboard);
    renderFiltersSummary(dashboard);
}

// Ce que contient le tableau : « 6 trouvailles · 2 DNF · 12 trouvailles
// reçues » ou, pour un jeu Évolution, ses publications et archivages.
export function dataNote(dashboard) {
    const nf = new Intl.NumberFormat(state.labels.locale);
    const parts = [];
    let main;
    if (dashboard.kind === 'evolution') {
        if (state.missingDatasets.has(dashboard.dataset)) return t("Ce jeu Évolution n'existe plus.");
        // Jeu en erreur : pas de comptes nuls trompeurs, l'état suffit.
        if (state.sourceErrors.has('evolution:' + dashboard.dataset)) {
            return t('Jeu « ${name} » : données indisponibles', { name: datasetName(dashboard.dataset) });
        }
        main = tableOf('evolution:' + dashboard.dataset);
        parts.push(t('${n} caches publiées', { n: nf.format(main.n) }));
        parts.push(t('${n} archivages datés', { n: nf.format(tableOf('evolution:' + dashboard.dataset + ':archived').n) }));
    } else {
        main = tableOf('finds');
        parts.push(t('${n} trouvailles', { n: nf.format(main.n) }));
        const others = [
            ['dnf', (n) => t('${n} DNF', { n })],
            ['owned', (n) => t('${n} caches posées', { n })],
            ['poses.received', (n) => t('${n} trouvailles reçues', { n })],
        ];
        for (const [source, text] of others) {
            const n = tableOf(source).n;
            if (n) parts.push(text(nf.format(n)));
        }
    }
    if (activeFilterCount(dashboard.filters)) {
        const kept = filterMask(main, dashboard.filters).reduce((sum, v) => sum + v, 0);
        parts.push(t('${n} avec les filtres', { n: nf.format(kept) }));
    }
    const undated = tableOf('finds').undated;
    if (dashboard.kind !== 'evolution' && undated) {
        parts.push(t('${n} sans date de trouvaille, non comptées', { n: nf.format(undated) }));
    }
    // Sources dont le chargement a échoué : signalées, pas confondues avec 0.
    const failed = dashboardSources(dashboard).filter((s) => state.sourceErrors.has(s));
    if (failed.length) {
        const names = [...new Set(failed.map((s) => s.startsWith('evolution:')
            ? t('Jeu « ${name} »', { name: datasetName(s.split(':')[1]) })
            : state.labels.sourceLabel(s)))];
        parts.push(t('${names} : données indisponibles', { names: names.join(', ') }));
    }
    return parts.join(' · ');
}

// ----- Plusieurs tableaux de bord

function renderDashboardMenu() {
    const menu = $('statsDashboardMenu');
    menu.replaceChildren();
    for (const dashboard of state.doc.dashboards) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dropdown-item' + (dashboard.id === state.doc.active ? ' active' : '');
        button.dataset.dashboardId = dashboard.id;
        const icon = document.createElement('i');
        icon.className = 'ti ' + (dashboard.kind === 'evolution' ? 'ti-stack' : 'ti-layout-dashboard') + ' me-2';
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon, document.createTextNode(dashboard.name || t('Mon tableau de bord')));
        if (dashboard.id === state.doc.active) button.setAttribute('aria-current', 'true');
        li.append(button);
        menu.append(li);
    }
    const divider = document.createElement('li');
    divider.innerHTML = '<hr class="dropdown-divider">';
    menu.append(divider);
    const full = state.doc.dashboards.length >= MAX_DASHBOARDS;
    menu.append(menuButton('new-dashboard', 'ti-plus', t('Nouveau tableau de bord…'), { disabled: full }));
    menu.append(menuButton('duplicate-dashboard', 'ti-copy', t('Dupliquer ce tableau de bord'), { disabled: full }));
    menu.append(menuButton('export-dashboard', 'ti-file-export', t('Exporter ce tableau de bord (fichier)')));
    menu.append(menuButton('import-dashboard', 'ti-file-import', t('Importer un tableau de bord…'), { disabled: full }));
    menu.append(menuButton('print-dashboard', 'ti-printer', t('Imprimer')));
    const noCards = !activeDashboard().items.length;
    menu.append(menuButton('image-dashboard', 'ti-photo', t('Enregistrer le tableau en image (PNG)'), { disabled: noCards }));
    menu.append(menuButton('copy-image-dashboard', 'ti-copy', t("Copier l'image du tableau"), { disabled: noCards }));
    menu.append(menuButton('video-dashboard', 'ti-movie', t('Créer la vidéo du tableau…')));
    const dangerDivider = document.createElement('li');
    dangerDivider.innerHTML = '<hr class="dropdown-divider">';
    menu.append(dangerDivider);
    menu.append(menuButton('delete-dashboard', 'ti-trash', t('Supprimer ce tableau de bord'),
        { danger: true, disabled: state.doc.dashboards.length < 2 }));
}

function duplicateActiveDashboard() {
    if (state.doc.dashboards.length >= MAX_DASHBOARDS) return;
    const source = activeDashboard();
    const copy = duplicateDashboard(source, { name: t('${name} (copie)', { name: source.name }) });
    state.doc.dashboards.push(copy);
    state.doc.active = copy.id;
    scheduleSave({ immediate: true });
    renderDashboard();
}

// Fichier d'un tableau de bord, à partager : sans identifiants ; un tableau
// Évolution emporte le NOM de son jeu.
function exportActiveDashboard() {
    const dashboard = activeDashboard();
    const file = exportDashboard(dashboard, {
        datasetName: dashboard.kind === 'evolution' ? datasetName(dashboard.dataset) : null,
    });
    download(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
        fileSafe(dashboard.name || t('Mon tableau de bord')) + '.json');
}

const IMPORT_ERRORS = {
    'not-a-dashboard': () => t("Ce fichier n'est pas un tableau de bord MyGCFlow."),
    'unknown-version': () => t('Ce tableau de bord vient d\'une version plus récente de MyGCFlow.'),
    'no-dataset': () => t("Ce tableau de bord porte sur une zone Évolution : importez d'abord un jeu sur la page Évolution."),
};

export async function importDashboardFile(file) {
    let raw;
    try {
        raw = JSON.parse(await file.text());
    } catch (_) {
        showError(IMPORT_ERRORS['not-a-dashboard'](), t('Importer un tableau de bord'));
        return;
    }
    if (state.doc.dashboards.length >= MAX_DASHBOARDS) return;
    const { dashboard, warning, error } = importDashboard(raw, {
        datasets: state.datasets,
        defaultName: t('Mon tableau de bord'),
    });
    if (error) {
        showError(IMPORT_ERRORS[error](), t('Importer un tableau de bord'));
        return;
    }
    state.doc.dashboards.push(dashboard);
    state.doc.active = dashboard.id;
    scheduleSave({ immediate: true });
    await ensureEvolution(dashboard.dataset);
    renderDashboard();
    if (warning === 'dataset-guessed') {
        showToast(t('Jeu Évolution d\'origine introuvable : le tableau porte sur « ${name} ».', { name: datasetName(dashboard.dataset) }),
            'warning', t('Importer un tableau de bord'));
    } else {
        showToast(t('Tableau de bord « ${name} » importé.', { name: dashboard.name }), 'success');
    }
}

async function switchDashboard(id) {
    if (!state.doc.dashboards.some((d) => d.id === id) || id === state.doc.active) return;
    state.doc.active = id;
    scheduleSave({ immediate: true });
    const { dataset } = activeDashboard();
    if (dataset) {
        await whileBusy(t('Chargement du jeu Évolution « ${name} »…', { name: datasetName(dataset) }),
            () => ensureEvolution(dataset));
        // Un autre tableau a été choisi pendant l'attente : il se dessinera
        // lui-même.
        if (state.doc.active !== id) return;
    }
    renderDashboard();
}

// Attente visible (changement de tableau, actualisation) : rien sous
// BUSY_DELAY_MS — un passage instantané ne clignote pas —, puis un message
// et la grille atténuée (non cliquable : elle montre encore l'ancien état).
const BUSY_DELAY_MS = 200;

async function whileBusy(text, work) {
    state.busy += 1;
    const timer = setTimeout(() => {
        $('statsBusyText').textContent = text;
        $('statsBusy').hidden = false;
        $('statsGrid').classList.add('is-busy');
        $('statsGrid').setAttribute('aria-busy', 'true');
    }, BUSY_DELAY_MS);
    try {
        return await work();
    } finally {
        clearTimeout(timer);
        state.busy -= 1;
        if (!state.busy) {
            $('statsBusy').hidden = true;
            $('statsGrid').classList.remove('is-busy');
            $('statsGrid').removeAttribute('aria-busy');
        }
    }
}

// « Actualiser » : relit toutes les sources sans recharger la page (un
// import fait sur la carte entre-temps). Les trouvailles et les jeux
// Évolution répondent 304 s'ils n'ont pas bougé. Un échec des trouvailles
// garde les données affichées ; les autres sources suivent la règle
// habituelle (échec = indisponible, pas zéro).
export async function refreshData() {
    const button = $('btnStatsRefresh');
    if (button.disabled || !state.ready) return;
    button.disabled = true;
    button.classList.add('is-running');
    try {
        await whileBusy(t('Actualisation des données…'), async () => {
            // Jeux Évolution : tous à relire, l'actif tout de suite, les
            // autres au prochain passage sur leur tableau.
            state.evolutionLoads.clear();
            state.missingDatasets.clear();
            const [finds] = await Promise.all([
                fetchJson('/api/stats/finds').then(findsTable),
                ...PERSONAL_LOADERS.map(loadPersonalLoader),
                loadDatasets(),
            ]);
            setTable('finds', finds);
            await ensureEvolution(activeDashboard().dataset);
        });
        renderDashboard();
        showToast(t('Données actualisées.'), 'success');
    } catch (e) {
        console.warn('[stats] Actualisation impossible :', e?.message || e);
        renderDashboard();
        showError(t("Les données n'ont pas pu être relues : les précédentes restent affichées."), t('Actualiser les données'));
    } finally {
        button.disabled = false;
        button.classList.remove('is-running');
    }
}

export function onDashboardMenuClick(event) {
    const pick = event.target.closest('[data-dashboard-id]');
    if (pick) {
        switchDashboard(pick.dataset.dashboardId);
        return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'new-dashboard') openNewDashboard();
    if (action === 'duplicate-dashboard') duplicateActiveDashboard();
    if (action === 'export-dashboard') exportActiveDashboard();
    if (action === 'import-dashboard') $('statsImportInput').click();
    if (action === 'print-dashboard') window.print();
    if (action === 'image-dashboard') saveDashboardImage();
    if (action === 'copy-image-dashboard') copyDashboardImage();
    if (action === 'video-dashboard') openDashboardVideo();
    if (action === 'delete-dashboard') deleteDashboard();
}

export function syncNewDashboardForm() {
    const evolution = $('statsNewKindEvolution').checked;
    const hasDatasets = state.datasets.length > 0;
    $('statsNewDatasetRow').hidden = !evolution || !hasDatasets;
    $('statsNewNoDataset').hidden = !evolution || hasDatasets;
    $('btnStatsNewDashboardCreate').disabled = evolution && !hasDatasets;
    const name = $('statsNewName');
    // Nom proposé tant que l'utilisateur n'a pas écrit le sien.
    if (!name.dataset.touched) {
        name.value = evolution && hasDatasets
            ? datasetName(Number($('statsNewDataset').value))
            : t('Mon tableau de bord');
    }
}

function openNewDashboard() {
    $('statsNewDataset').replaceChildren(...state.datasets.map((d) => new Option(d.name, String(d.id))));
    $('statsNewKindPersonal').checked = true;
    $('statsNewWithCharts').checked = true;
    delete $('statsNewName').dataset.touched;
    syncNewDashboardForm();
    getBsModal('statsNewDashboardModal')?.show();
}

export async function submitNewDashboard(event) {
    event.preventDefault();
    const evolution = $('statsNewKindEvolution').checked;
    const dataset = evolution ? Number($('statsNewDataset').value) : null;
    if (evolution && !dataset) return;
    const name = Array.from($('statsNewName').value.replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 60).join('');
    const dashboard = defaultDashboard({
        name: name || t('Mon tableau de bord'),
        kind: evolution ? 'evolution' : 'personal',
        dataset,
        withCharts: $('statsNewWithCharts').checked,
        titleOf: (id) => state.labels.question(id).title,
    });
    state.doc.dashboards.push(dashboard);
    state.doc.active = dashboard.id;
    scheduleSave({ immediate: true });
    getBsModal('statsNewDashboardModal')?.hide();
    await ensureEvolution(dataset);
    renderDashboard();
}

function deleteDashboard() {
    if (state.doc.dashboards.length < 2) return;
    const dashboard = activeDashboard();
    showConfirmation(
        t('Supprimer le tableau de bord « ${name} » et ses graphiques ?', { name: dashboard.name }),
        t('Supprimer'),
        async () => {
            state.doc.dashboards = state.doc.dashboards.filter((d) => d.id !== dashboard.id);
            state.doc.active = state.doc.dashboards[0].id;
            scheduleSave({ immediate: true });
            await ensureEvolution(activeDashboard().dataset);
            renderDashboard();
        },
        null,
        { danger: true, confirmText: t('Supprimer') },
    );
}

export const filterValueLabel = (field, value) => state.labels.filterValue(field, value, { attributeName });

// Pastilles des filtres du tableau de bord : « Type de cache : … » ×.
function renderFiltersSummary(dashboard) {
    const count = activeFilterCount(dashboard.filters);
    const badge = $('statsFiltersCount');
    badge.hidden = !count;
    badge.textContent = String(count);
    const summary = $('statsFiltersSummary');
    summary.replaceChildren();
    summary.hidden = !count;
    for (const { field, values } of describeFilters(dashboard.filters, filterValueLabel)) {
        const chip = document.createElement('span');
        chip.className = 'stats-filter-chip';
        const text = document.createElement('span');
        text.textContent = state.labels.filterField(field) + ' : ' + values.join(', ');
        text.title = text.textContent;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.removeFilter = field;
        remove.setAttribute('aria-label', t('Retirer le filtre ${field}', { field: state.labels.filterField(field) }));
        remove.innerHTML = '<i class="ti ti-x" aria-hidden="true"></i>';
        chip.append(text, remove);
        summary.append(chip);
    }
}

export function onFiltersSummaryClick(event) {
    const button = event.target.closest('[data-remove-filter]');
    if (!button) return;
    const dashboard = activeDashboard();
    const filters = { ...dashboard.filters };
    delete filters[button.dataset.removeFilter];
    dashboard.filters = filters;
    scheduleSave({ immediate: true });
    renderToolbar();
    renderAllCharts();
}

function renderDashboardFilterForm(filters) {
    renderFilterForm($('statsFiltersForm'), {
        tables: dashboardTables(),
        filters,
        labels: state.labels,
        attributeName,
        idPrefix: 'statsFilter-',
    });
}

export function openFilters() {
    const dashboard = activeDashboard();
    renderDashboardFilterForm(dashboard.filters);
    resetMapFiltersReport();
    // La carte filtre « Mes Géocaches » : rien à reprendre pour un tableau
    // Évolution, ni sans trouvailles.
    $('statsMapFilters').hidden = dashboard.kind === 'evolution' || !tableOf('finds').n;
    getBsModal('statsFiltersModal')?.show();
}

export function applyFilters() {
    const dashboard = activeDashboard();
    const take = state.mapTake;
    const before = { filters: structuredClone(dashboard.filters), period: structuredClone(dashboard.period) };
    dashboard.filters = readFilterForm($('statsFiltersForm'));
    if (take?.period && $('statsMapPeriod')?.checked) dashboard.period = take.period;
    state.mapTake = null;
    scheduleSave({ immediate: true });
    getBsModal('statsFiltersModal')?.hide();
    renderToolbar();
    renderAllCharts();
    // Filtres (et période) de la carte : ils remplacent les précédents,
    // « Annuler » les rend.
    if (take) {
        showActionToast(t('Filtres de la carte appliqués.'), { label: t('Annuler'), onClick: () => {
            const current = state.doc?.dashboards.find((d) => d.id === dashboard.id);
            if (!current) return;
            current.filters = before.filters;
            current.period = before.period;
            scheduleSave({ immediate: true });
            renderToolbar();
            renderAllCharts();
        } });
    }
}

export function resetMapFiltersReport() {
    state.mapTake = null;
    const report = $('statsMapFiltersReport');
    report.replaceChildren();
    report.hidden = true;
}

// Phrase de compte rendu d'un critère de la carte sans équivalent ici.
function mapFilterNote(note) {
    switch (note.code) {
        case 'search': return t('la recherche « ${text} »', { text: note.text });
        case 'published_dates':
            return t('les dates de pose ${range} : la page filtre par année entière', {
                range: state.labels.periodChoiceLabel({ kind: 'range', from: note.from, to: note.to }),
            });
        case 'unknown_country': return t('les trouvailles sans pays, que la carte garde');
        case 'unknown_state': return t('les trouvailles sans région, que la carte garde');
        case 'labs': return t('les Lab Caches, que la carte garde malgré les filtres propres aux géocaches');
        default: return '';
    }
}

// « Reprendre les filtres de la carte » : la sélection enregistrée par la
// carte (localStorage filtersSelection) remplit le formulaire ; ses dates de
// trouvaille sont proposées comme période. Rien n'est appliqué avant
// « Appliquer ».
export async function takeMapFilters() {
    let selection = null;
    try { selection = JSON.parse(localStorage.getItem('filtersSelection') || 'null'); } catch (_) { /* illisible : aucun filtre */ }
    // Géocaches / Labs : préférence de la carte, relue (elle a pu changer
    // depuis l'ouverture de la page).
    try {
        window.userSettings = await fetchJson('/api/settings');
    } catch (e) {
        console.warn('[stats] Préférences non relues :', e?.message || e);
    }
    const discovery = window.userSettings?.main_discovery_sources || 'geocaches';
    const out = filtersFromMapSelection(selection, { table: tableOf('finds'), discovery });
    resetMapFiltersReport();
    const report = $('statsMapFiltersReport');
    const line = (text, className = '') => {
        const p = document.createElement('p');
        p.className = 'mb-1 ' + className;
        p.textContent = text;
        report.append(p);
        return p;
    };
    report.hidden = false;
    if (out.empty) {
        report.dataset.state = 'empty';
        line(t("Avec ses filtres actuels, la carte n'affiche aucune trouvaille : rien n'est repris."), 'text-warning-emphasis');
        return;
    }
    renderDashboardFilterForm(out.filters);
    state.mapTake = { period: out.period };
    const nf = new Intl.NumberFormat(state.labels.locale);
    if (!Object.keys(out.filters).length && !out.period) {
        report.dataset.state = 'none';
        line(t('La carte montre toutes vos trouvailles : aucun filtre à reprendre.'));
    } else {
        report.dataset.state = 'taken';
        line(out.count === 1
            ? t('Filtres de la carte repris (1 trouvaille) : vérifiez-les, puis appliquez.')
            : t('Filtres de la carte repris (${n} trouvailles) : vérifiez-les, puis appliquez.', { n: nf.format(out.count) }));
    }
    if (out.period) {
        const row = document.createElement('div');
        row.className = 'form-check mb-1';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'form-check-input';
        input.id = 'statsMapPeriod';
        input.checked = true;
        const label = document.createElement('label');
        label.className = 'form-check-label';
        label.htmlFor = input.id;
        label.textContent = t('Période du tableau de bord : ${range} (dates de trouvaille de la carte)', {
            range: state.labels.periodChoiceLabel(out.period),
        });
        row.append(input, label);
        report.append(row);
    }
    const notes = out.notes.map(mapFilterNote).filter(Boolean);
    if (notes.length) {
        line(t('Sans équivalent ici :'), 'text-muted');
        const list = document.createElement('ul');
        list.className = 'text-muted mb-1';
        for (const text of notes) {
            const li = document.createElement('li');
            li.textContent = text;
            list.append(li);
        }
        report.append(list);
    }
}


// ---------------------------------------------------------------------------
// Renommer, période globale
// ---------------------------------------------------------------------------

export function openRename() {
    $('statsRenameInput').value = activeDashboard().name;
    getBsModal('statsRenameModal')?.show();
}

export function submitRename(event) {
    event.preventDefault();
    const name = $('statsRenameInput').value.replace(/[\r\n\t]+/g, ' ').trim();
    if (!name) return;
    activeDashboard().name = Array.from(name).slice(0, 60).join('');
    scheduleSave({ immediate: true });
    getBsModal('statsRenameModal')?.hide();
    renderToolbar();
}

export function onGlobalPeriodChange() {
    const period = periodOfValue($('statsGlobalPeriod').value);
    if (!period) return;
    activeDashboard().period = period;
    scheduleSave();
    renderAllCharts();
}

