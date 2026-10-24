// Onglet « Stats » : liste des panneaux, modèles, formulaire du panneau choisi.
//
// Préférence globale : chaque modification s'applique aussitôt à l'aperçu
// (applyStatsSettings) puis part au serveur en bloc complet `{ stats }`,
// regroupée par un debounce comme les autres préférences globales.
import * as pkg from './index.js';
import { isEvolutionPage } from './app_mode.mjs';
import { makeDebouncedSettingsSaver } from './settings_api.mjs';
import { reportSave } from './saved_indicator.mjs';
import { bindPanelDrag } from './panel_interactions.js';
import { hideBsModal, showBsModal } from './ui_bootstrap.js';
import {
    CATEGORICAL_METRICS,
    EVOLUTION_COUNTER_ITEMS,
    EVOLUTION_METRICS_BY_KIND,
    STATS_COUNTER_ITEMS,
    STATS_MAX_CONFIGS,
    STATS_MAX_PANELS,
    STATS_METRICS_BY_KIND,
    STATS_PRESET_STYLE_KEYS,
    createStatsPanel,
    matchingStatsStylePreset,
    normalizeStatsConfig,
    normalizeStatsPanel,
    offsetFreeCopy,
    statsPanelsKey,
    statsStylePreset,
} from './stats_model.mjs';

const saveStatsDebounced = makeDebouncedSettingsSaver(500);

// Élément du titre « Panneaux » qui porte le retour « Enregistré ✓ » des
// actions sans champ dédié (ajout, suppression, réordonnancement, dépôt).
const STATS_SAVE_STATUS = 'statsSaveStatus';

let selectedId = null;
let initialized = false;

// Page /evolution : métriques, modèles et chiffres des compteurs différent.
// Chaque mode a sa liste de panneaux (`stats.panels` / `stats.evolution_panels`),
// indépendante : ajouter ou retirer un panneau ici ne touche pas l'autre page.
const evolutionMode = isEvolutionPage();
const panelsKey = () => statsPanelsKey(evolutionMode);
const modePanels = (s) => s[panelsKey()] || [];
const metricRegistry = evolutionMode ? EVOLUTION_METRICS_BY_KIND : STATS_METRICS_BY_KIND;
const counterItems = evolutionMode ? EVOLUTION_COUNTER_ITEMS : STATS_COUNTER_ITEMS;
// Tuiles du compteur « Chiffres clés » créé en Évolution : les chiffres de la
// chronologie, pas ceux des trouvailles.
const COUNTER_DEFAULT_ITEMS = evolutionMode ? ['actives', 'placees', 'archivees', 'peak'] : null;

// Modèles : un clic pose un ou deux panneaux pré-réglés et pré-placés. Les
// piles de coin contournent d'elles-mêmes le titre et les infos.
const PRESETS = {
    dt: [['grid', 'dt', { position: { anchor: 'bottom-left', width: 300 } }]],
    'types-sizes': [
        ['bar', 'cache_type', { position: { anchor: 'top-right', width: 260 } }],
        ['bar', 'container', { position: { anchor: 'top-right', width: 260 } }],
    ],
    'summary-progress': [
        ['counter', 'summary', { position: { anchor: 'top-left' } }],
        ['line', 'cumulative', { position: { anchor: 'bottom-left', width: 340 } }],
    ],
    race: [['bar', 'country', { position: { anchor: 'top-right' }, options: { sort: 'race', max_items: 6 } }]],
    'difficulty-terrain': [
        ['bar', 'difficulty', { position: { anchor: 'bottom-right', width: 240 } }],
        ['bar', 'terrain', { position: { anchor: 'bottom-right', width: 240 } }],
    ],
    jasmer: [['grid', 'jasmer', { position: { anchor: 'bottom-left', width: 220 } }]],
    finds_ym: [['grid', 'finds_ym', { position: { anchor: 'bottom-center', width: 320 } }]],
    calendar: [['grid', 'calendar', { position: { anchor: 'bottom-center', width: 440 } }]],
    activity: [['grid', 'activity', { position: { anchor: 'bottom-center' } }]],
    age: [
        ['bar', 'age', { position: { anchor: 'top-right', width: 280 } }],
        ['counter', 'summary', { position: { anchor: 'top-right', width: 280 }, options: { items: ['oldest', 'same_day'] } }],
    ],
    extremes: [['counter', 'summary', {
        position: { anchor: 'top-left', width: 340 },
        options: { items: ['north', 'south', 'west', 'east'], columns: 2 },
    }]],
    'evo-overview': [
        ['counter', 'summary', { position: { anchor: 'top-left' }, options: { items: ['actives', 'placees', 'archivees', 'peak'] } }],
        ['line', 'actives', { position: { anchor: 'bottom-left', width: 340 } }],
    ],
    'evo-geo': [
        ['bar', 'country', { position: { anchor: 'top-right', width: 260 } }],
        ['bar', 'county', { position: { anchor: 'top-right', width: 260 } }],
    ],
};

const KIND_ICONS = {
    grid: 'ti-layout-grid',
    bar: 'ti-chart-bar',
    donut: 'ti-chart-donut',
    line: 'ti-chart-line',
    counter: 'ti-123',
};

// Libellés du select « Forme » (options reconstruites comme la métrique).
const KIND_LABELS = {
    grid: () => pkg.t('Grille'),
    bar: () => pkg.t('Histogramme'),
    donut: () => pkg.t('Anneau'),
    line: () => pkg.t('Courbe'),
    counter: () => pkg.t('Chiffres clés'),
};

const $ = (id) => document.getElementById(id);

// Repère « (Trouvailles) » / « (Évolution) » d'un panneau ou d'une
// configuration de l'autre mode. t() hors du template literal : pybabel
// n'extrait pas les appels qui s'y trouvent.
function otherModeBadge() {
    const mode = evolutionMode ? pkg.t('Trouvailles') : pkg.t('Évolution');
    return `(${mode})`;
}

function currentSettings() {
    return pkg.getStatsSettings();
}

function selectedPanel() {
    return modePanels(currentSettings()).find((panel) => panel.id === selectedId) || null;
}

// Applique puis enregistre. `field` : élément qui porte l'indicateur
// « Enregistré ✓ ». `immediate` vide la file sans attendre le debounce :
// les actions discrètes (ajout, suppression, dépôt) ne doivent pas rester
// dans le minuteur si la page est quittée ou rechargée entre-temps — et le
// patch envoyé emporte alors l'état complet, champ en cours de saisie inclus.
function commit(next, field = null, { immediate = false } = {}) {
    const applied = pkg.applyStatsSettings(next);
    if (window.userSettings) window.userSettings.stats = applied;
    const saving = saveStatsDebounced({ stats: applied });
    if (immediate) saveStatsDebounced.flush();
    if (field) reportSave(field, saving);
    return applied;
}

function updatePanels(mutate, field = null, options = {}) {
    const settings = currentSettings();
    const key = panelsKey();
    const panels = (settings[key] || []).map((panel) => structuredClone(panel));
    const result = mutate(panels);
    commit({ ...settings, [key]: result || panels }, field, options);
}

// `mutate(panel, panels)` : la liste entière est fournie pour les réglages
// partagés par une pile (marges de coin).
function updateSelected(mutate, field) {
    updatePanels((panels) => {
        const panel = panels.find((p) => p.id === selectedId);
        if (panel) mutate(panel, panels);
        return panels;
    }, field);
}

// Autres panneaux de la pile du coin de `panel` (même ancre, mode ancré).
function cornerMates(panels, panel) {
    return panels.filter((p) => p !== panel && p.position.mode === 'anchor'
        && p.position.anchor === panel.position.anchor);
}

// Un panneau qui rejoint un coin prend les marges de sa pile, communes à
// tous ses panneaux (shareCornerMargins, stats_model.mjs) — sans quoi, placé
// avant eux dans la liste, il imposerait les siennes et déplacerait la pile.
// Un coin vide garde les marges du panneau.
function adoptCornerMargins(panel, panels) {
    const mate = cornerMates(panels, panel)[0];
    if (!mate) return;
    panel.position.dx = mate.position.dx;
    panel.position.dy = mate.position.dy;
}

// ---------------------------------------------------------------------------
// Galerie « Ajouter » (#statsGalleryModal, menu_stats.html)
// ---------------------------------------------------------------------------

const GALLERY_MODAL = 'statsGalleryModal';

// Cartes et variantes de description selon la page : chaque élément porte
// data-stats-modes (« main », « evolution », les deux). Le mode ne change
// pas au fil de la page : filtrage unique à l'init ; la recherche
// (filterGallery) n'agit ensuite que sur les cartes du mode.
function syncGalleryMode() {
    const mode = evolutionMode ? 'evolution' : 'main';
    document.querySelectorAll('#statsAddMenu [data-stats-modes]').forEach((el) => {
        const inMode = el.dataset.statsModes.split(' ').includes(mode);
        el.hidden = !inMode;
        if (el.classList.contains('stats-gallery-card')) el.dataset.inMode = inMode ? '1' : '';
    });
    filterGallery('');
}

// Panneaux posés par une carte : ceux du modèle, ou le panneau seul (compteur
// Évolution : tuiles de la chronologie).
function gallerySpecs(card) {
    if (card.dataset.statsPreset) return PRESETS[card.dataset.statsPreset] || [];
    const [kind, metric] = (card.dataset.statsAdd || '').split(':');
    if (!kind || !metric) return [];
    const overrides = kind === 'counter' && COUNTER_DEFAULT_ITEMS
        ? { options: { items: COUNTER_DEFAULT_ITEMS } }
        : {};
    return [[kind, metric, overrides]];
}

// Recherche sans accents ni casse, sur le titre, la description du mode et
// le nom des formes (« anneau », « histogramme », « courbe »…).
const foldText = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function galleryText(card) {
    if (card.dataset.searchText === undefined) {
        const visible = [...card.querySelectorAll('.stats-gallery-title, .stats-gallery-desc')]
            .filter((el) => !el.hidden)
            .map((el) => el.textContent);
        const kinds = gallerySpecs(card).map(([kind]) => KIND_LABELS[kind]?.() || '');
        card.dataset.searchText = foldText([...visible, ...kinds].join(' '));
    }
    return card.dataset.searchText;
}

function filterGallery(query) {
    const words = foldText(query).split(/\s+/).filter(Boolean);
    let any = false;
    document.querySelectorAll('#statsAddMenu .stats-gallery-section').forEach((section) => {
        let visible = 0;
        section.querySelectorAll('.stats-gallery-card').forEach((card) => {
            const text = card.dataset.inMode ? galleryText(card) : '';
            card.hidden = !card.dataset.inMode || !words.every((word) => text.includes(word));
            if (!card.hidden) visible += 1;
        });
        section.hidden = visible === 0;
        if (visible) any = true;
    });
    const empty = $('statsGalleryEmpty');
    if (empty) empty.hidden = any;
}

// Vignettes : chaque carte du mode dessine ses panneaux tels qu'ils
// apparaîtraient au repos, avec les données de la sélection. Redessinées à
// chaque ouverture (les données ont pu changer). Sans données dessinables
// (Évolution sans base), l'icône de la forme reste.
function drawGalleryThumbs() {
    const entries = [];
    document.querySelectorAll('#statsAddMenu .stats-gallery-card').forEach((card) => {
        const thumb = card.querySelector('.stats-gallery-thumb');
        if (!thumb) return;
        thumb.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
        thumb.classList.remove('has-preview');
        if (!card.dataset.inMode) return;
        for (const spec of gallerySpecs(card)) {
            const canvas = document.createElement('canvas');
            thumb.appendChild(canvas);
            entries.push({ spec, canvas });
        }
    });
    const drawn = pkg.drawStatsGalleryPreviews?.(entries) || new Set();
    for (const { canvas } of entries) {
        if (!drawn.has(canvas)) canvas.remove();
        else canvas.parentElement.classList.add('has-preview');
    }
}

function openGallery() {
    const search = $('inputStatsGallerySearch');
    if (search) search.value = '';
    filterGallery('');
    drawGalleryThumbs();
    showBsModal(GALLERY_MODAL);
}

// Clic sur une carte : pose le panneau ou le modèle, puis referme la galerie
// — le nouveau panneau est sélectionné, son formulaire ouvert.
function onGalleryClick(event) {
    const card = event.target.closest('.stats-gallery-card');
    if (!card || card.disabled) return;
    if (card.dataset.statsPreset) addPanels(PRESETS[card.dataset.statsPreset] || []);
    else addPanels(gallerySpecs(card));
    hideBsModal(GALLERY_MODAL);
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

function iconButton(icon, label, action, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline-secondary';
    button.dataset.action = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    const i = document.createElement('i');
    i.className = `ti ${icon}`;
    i.setAttribute('aria-hidden', 'true');
    button.appendChild(i);
    return button;
}

function renderList() {
    const list = $('statsPanelList');
    if (!list) return;
    const panels = modePanels(currentSettings());
    list.replaceChildren();
    panels.forEach((panel, index) => {
        const item = document.createElement('li');
        item.className = `list-group-item${panel.id === selectedId ? ' is-selected' : ''}`;
        item.dataset.panelId = panel.id;
        item.draggable = true;

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'form-check-input m-0';
        toggle.checked = panel.enabled;
        toggle.dataset.action = 'toggle';
        toggle.setAttribute('aria-label', pkg.t('Afficher ce panneau'));

        const icon = document.createElement('i');
        icon.className = `ti ${KIND_ICONS[panel.kind] || 'ti-chart-bar'} text-muted`;
        icon.setAttribute('aria-hidden', 'true');

        const name = document.createElement('button');
        name.type = 'button';
        name.className = `btn btn-link p-0 text-reset text-start text-decoration-none stats-panel-name${panel.enabled ? '' : ' is-disabled'}`;
        name.dataset.action = 'select';
        name.textContent = panel.title || pkg.defaultStatsPanelTitle(panel);
        name.setAttribute('aria-pressed', String(panel.id === selectedId));
        // Un panneau dont la métrique n'existe pas dans le mode courant
        // (réglages bidouillés, configuration appliquée d'un mode à l'autre)
        // est marqué : il reste éditable, juste non dessiné.
        if (!(metricRegistry[panel.kind] || []).includes(panel.metric)) {
            const badge = document.createElement('span');
            badge.className = 'text-muted small ms-1';
            badge.textContent = otherModeBadge();
            badge.title = pkg.t('Pas affiché dans ce mode');
            name.appendChild(badge);
        }

        const actions = document.createElement('div');
        actions.className = 'btn-group btn-group-sm';
        actions.append(
            iconButton('ti-arrow-up', pkg.t('Monter'), 'up', index === 0),
            iconButton('ti-arrow-down', pkg.t('Descendre'), 'down', index === panels.length - 1),
            iconButton('ti-copy', pkg.t('Dupliquer'), 'duplicate', panels.length >= STATS_MAX_PANELS),
            iconButton('ti-trash', pkg.t('Supprimer'), 'delete'),
        );

        item.append(toggle, icon, name, actions);
        list.appendChild(item);
    });
    const empty = $('statsEmpty');
    if (empty) {
        empty.hidden = panels.length > 0;
        empty.textContent = evolutionMode
            ? pkg.t('Aucun panneau. Commencez par un modèle : les chiffres de la chronologie, par exemple, comptent actives, poses et archivages.')
            : pkg.t('Aucun panneau. Commencez par un modèle : la matrice D/T, par exemple, se remplit case par case au fil de vos trouvailles.');
    }
    const full = panels.length >= STATS_MAX_PANELS;
    const limit = $('statsLimitHint');
    if (limit) limit.hidden = !full;
    const available = STATS_MAX_PANELS - panels.length;
    // Places libres, en tête de la galerie « Ajouter ».
    const slots = $('statsGallerySlots');
    if (slots) {
        slots.textContent = available > 0
            ? pkg.t('Places libres : ${n} sur ${max}', { n: available, max: STATS_MAX_PANELS })
            : pkg.t('Plus de place : six panneaux au maximum. Supprimez-en un pour en ajouter un autre.');
    }
    document.querySelectorAll('#statsAddMenu [data-stats-preset], #statsAddMenu [data-stats-add]')
        .forEach((button) => {
            // Modèles atomiques : celui qui demande plus de places qu'il n'en
            // reste est désactivé, avec la raison affichée (une entrée
            // désactivée ne montre pas d'infobulle).
            const needed = button.dataset.statsPreset
                ? (PRESETS[button.dataset.statsPreset] || []).length || 1
                : 1;
            const missing = needed > available;
            button.disabled = missing;
            let hint = button.querySelector('.stats-slots-hint');
            if (missing && needed > 1) {
                if (!hint) {
                    hint = document.createElement('span');
                    hint.className = 'stats-slots-hint d-block small fst-italic';
                    button.appendChild(hint);
                }
                hint.textContent = pkg.t('${n} places requises', { n: needed });
            } else {
                hint?.remove();
            }
        });
}

function onListClick(event) {
    const target = event.target.closest('[data-action]');
    const item = event.target.closest('[data-panel-id]');
    if (!target || !item) return;
    runListAction(item.dataset.panelId, target.dataset.action);
}

// Action de ligne partagée : clic sur un bouton ou touche Suppr sur la
// sélection (remove de bindPanelDrag). `select`/`toggle` viennent du clic.
function runListAction(id, action) {
    if (action === 'select') {
        selectedId = id;
        renderStatsTab();
        return;
    }
    if (action === 'toggle') return;   // géré par « change »
    let removed = null;
    let removedIndex = -1;
    updatePanels((panels) => {
        const index = panels.findIndex((panel) => panel.id === id);
        if (index < 0) return panels;
        if (action === 'up' && index > 0) {
            [panels[index - 1], panels[index]] = [panels[index], panels[index - 1]];
        } else if (action === 'down' && index < panels.length - 1) {
            [panels[index + 1], panels[index]] = [panels[index], panels[index + 1]];
        } else if (action === 'duplicate' && panels.length < STATS_MAX_PANELS) {
            // Ancrée, la copie s'empile dans le coin ; libre, elle est
            // décalée pour ne pas cacher l'original.
            const original = panels[index];
            const copy = createStatsPanel(original.kind, original.metric, {
                ...original,
                position: offsetFreeCopy(original.position, pkg.getStatsPanelRect?.(original.id) || null),
            });
            panels.splice(index + 1, 0, copy);
            selectedId = copy.id;
        } else if (action === 'delete') {
            [removed] = panels.splice(index, 1);
            removedIndex = index;
            if (selectedId === id) selectedId = panels[Math.min(index, panels.length - 1)]?.id || null;
        }
        return panels;
    }, STATS_SAVE_STATUS, { immediate: true });
    renderStatsTab();
    // La suppression est réversible tant que le toast est visible.
    if (removed) showUndoForDelete(removed, removedIndex);
}

// « Annuler » du toast de suppression : le panneau revient à sa place.
function showUndoForDelete(panel, index) {
    pkg.showActionToast?.(
        pkg.t('« ${name} » supprimé', { name: panel.title || pkg.defaultStatsPanelTitle(panel) }),
        { label: 'Annuler', onClick: () => {
            updatePanels((panels) => {
                panels.splice(Math.min(index, panels.length), 0, structuredClone(panel));
                return panels;
            }, STATS_SAVE_STATUS, { immediate: true });
            selectedId = panel.id;
            renderStatsTab();
        } },
    );
}

// Réordonnancement de la liste à la souris (HTML5 DnD — les flèches restent
// pour le clavier et le tactile). Commit immédiat, comme les flèches.
let draggedPanelId = null;

function clearDropMarks(list) {
    list.querySelectorAll('.drop-before, .drop-after')
        .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    list.querySelector('.is-drag-source')?.classList.remove('is-drag-source');
}

function bindListReorder(list) {
    list.addEventListener('dragstart', (event) => {
        const item = event.target.closest('li[data-panel-id]');
        if (!item) return;
        draggedPanelId = item.dataset.panelId;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggedPanelId);
        item.classList.add('is-drag-source');
    });
    list.addEventListener('dragover', (event) => {
        if (!draggedPanelId) return;
        event.preventDefault();   // indispensable pour autoriser le drop
        event.dataTransfer.dropEffect = 'move';
        clearDropMarks(list);
        const item = event.target.closest('li[data-panel-id]');
        list.querySelector(`li[data-panel-id="${draggedPanelId}"]`)?.classList.add('is-drag-source');
        if (item && item.dataset.panelId !== draggedPanelId) {
            const r = item.getBoundingClientRect();
            item.classList.add(event.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
        }
    });
    list.addEventListener('drop', (event) => {
        if (!draggedPanelId) return;
        event.preventDefault();
        const item = event.target.closest('li[data-panel-id]');
        // Sans item sous le curseur (fond de liste) : déposer en fin.
        const after = item ? event.clientY > item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2 : true;
        const targetId = item?.dataset.panelId;
        updatePanels((panels) => {
            const from = panels.findIndex((p) => p.id === draggedPanelId);
            let to = targetId
                ? panels.findIndex((p) => p.id === targetId) + (after ? 1 : 0)
                : panels.length;
            if (from < 0 || to === from || to === from + 1) return panels;
            const [moved] = panels.splice(from, 1);
            if (to > from) to -= 1;
            panels.splice(to, 0, moved);
            return panels;
        }, STATS_SAVE_STATUS, { immediate: true });
        renderStatsTab();
    });
    list.addEventListener('dragend', () => {
        draggedPanelId = null;
        clearDropMarks(list);
    });
}

function onListChange(event) {
    const toggle = event.target.closest('[data-action="toggle"]');
    const item = event.target.closest('[data-panel-id]');
    if (!toggle || !item) return;
    const id = item.dataset.panelId;
    updatePanels((panels) => {
        const panel = panels.find((p) => p.id === id);
        if (panel) panel.enabled = toggle.checked;
        return panels;
    }, STATS_SAVE_STATUS, { immediate: true });
    renderList();
}

function addPanels(specs) {
    let lastId = null;
    updatePanels((panels) => {
        // Modèle atomique : s'il ne rentre pas entier, on ne pose rien.
        if (specs.length > STATS_MAX_PANELS - panels.length) return panels;
        for (const [kind, metric, overrides] of specs) {
            const panel = createStatsPanel(kind, metric, overrides);
            if (!panel) continue;
            panels.push(panel);
            lastId = panel.id;
        }
        return panels;
    }, STATS_SAVE_STATUS, { immediate: true });
    if (lastId) selectedId = lastId;
    renderStatsTab();
}

// ---------------------------------------------------------------------------
// Formulaire
// ---------------------------------------------------------------------------

function setValue(id, value) {
    const el = $(id);
    if (!el || value === undefined || document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
}

function renderForm() {
    const form = $('statsPanelForm');
    if (!form) return;
    const panel = selectedPanel();
    form.hidden = !panel;
    if (!panel) return;

    const metricSelect = $('selectStatsMetric');
    if (metricSelect) {
        // Métriques du mode courant ; un type sans registre ici (grilles en
        // Évolution) retombe sur celui du mode principal.
        const offered = metricRegistry[panel.kind]?.length
            ? metricRegistry[panel.kind]
            : STATS_METRICS_BY_KIND[panel.kind];
        const wanted = offered.join(',');
        if (metricSelect.dataset.kind !== wanted) {
            metricSelect.replaceChildren(...offered.map((metric) => {
                const option = document.createElement('option');
                option.value = metric;
                option.textContent = pkg.defaultStatsPanelTitle({ metric });
                return option;
            }));
            metricSelect.dataset.kind = wanted;
        }
        metricSelect.value = panel.metric;
    }

    // Types capables de dessiner la métrique (registre du mode ; panneau
    // étranger au mode : registre principal en secours, comme la métrique).
    // Une seule possibilité (grille, courbe, compteurs…) : le champ se masque.
    const kindSelect = $('selectStatsKind');
    const kindField = $('statsKindField');
    if (kindSelect && kindField) {
        let kinds = Object.keys(metricRegistry)
            .filter((kind) => (metricRegistry[kind] || []).includes(panel.metric));
        if (!kinds.length) {
            kinds = Object.keys(STATS_METRICS_BY_KIND)
                .filter((kind) => STATS_METRICS_BY_KIND[kind].includes(panel.metric));
        }
        const wanted = kinds.join(',');
        if (kindSelect.dataset.kinds !== wanted) {
            kindSelect.replaceChildren(...kinds.map((kind) => {
                const option = document.createElement('option');
                option.value = kind;
                option.textContent = KIND_LABELS[kind] ? KIND_LABELS[kind]() : kind;
                return option;
            }));
            kindSelect.dataset.kinds = wanted;
        }
        kindSelect.value = panel.kind;
        kindField.hidden = kinds.length < 2;
    }

    const titleInput = $('inputStatsTitle');
    if (titleInput) titleInput.placeholder = pkg.defaultStatsPanelTitle(panel);
    setValue('inputStatsTitle', panel.title);
    setValue('switchStatsShowTitle', panel.show_title);
    if (titleInput) titleInput.disabled = !panel.show_title;
    // Export PNG : tailles en pixels de chaque échelle ; un panneau masqué
    // s'exporte aussi (redessiné à sa largeur réglée).
    renderPngScales(panel);

    // Options : seules celles du type du panneau existent (les autres restent
    // indéfinies, setValue les ignore).
    const o = panel.options;
    setValue('switchStatsValues', o.show_values);
    // « Les nouveautés » n'a de sens que là où un déblocage diffère d'un
    // incrément (grille, barres, anneau) : la courbe et les compteurs le
    // traitent comme « Chaque trouvaille » — l'option est retirée.
    const highlightSelect = $('selectStatsHighlight');
    const offersNew = ['grid', 'bar', 'donut'].includes(panel.kind);
    const newOption = highlightSelect?.querySelector('option[value="new"]');
    if (newOption) {
        newOption.hidden = !offersNew;
        newOption.disabled = !offersNew;
    }
    setValue('selectStatsHighlight', !offersNew && o.highlight === 'new' ? 'every' : o.highlight);
    // Sans effet du tout (Évolution : statut, courbes) : le champ se masque.
    const highlightField = $('statsHighlightField');
    if (highlightField) highlightField.hidden = evolutionMode && (panel.metric === 'status' || panel.kind === 'line');
    setValue('selectStatsCellMode', o.cell_mode);
    setValue('switchStatsCoverage', o.show_coverage);
    setValue('switchStatsLoops', o.show_loops);
    setValue('selectStatsSort', o.sort);
    setValue('selectStatsOrientation', o.orientation);
    setValue('inputStatsMaxItems', o.max_items);
    setValue('switchStatsHideEmpty', o.hide_empty);
    setValue('switchStatsPercent', o.show_percent);
    setValue('rangeStatsHole', o.hole);
    const holeValue = $('valueStatsHole');
    if (holeValue && o.hole !== undefined) holeValue.textContent = `${o.hole} %`;
    setValue('switchStatsLegend', o.show_legend);
    setValue('switchStatsArea', o.show_area);
    setValue('switchStatsMilestones', o.show_milestones);
    setValue('selectStatsCounted', o.counted || 'active');
    if (o.columns !== undefined) setValue('selectStatsColumns', String(o.columns));
    // Tuiles : seules celles du mode courant sont proposées (les autres restent
    // dans options.items, préservées à l'enregistrement).
    const mode = evolutionMode ? 'evolution' : 'main';
    document.querySelectorAll('#statsCounterItems [data-counter-item]').forEach((box) => {
        const wrap = box.closest('[data-stats-modes]');
        if (wrap) wrap.hidden = !(wrap.dataset.statsModes || '').split(' ').includes(mode);
        box.checked = (o.items || []).includes(box.dataset.counterItem);
    });
    document.querySelectorAll('#statsPanelForm [data-stats-kind]').forEach((el) => {
        const kindOk = el.dataset.statsKind.split(' ').includes(panel.kind);
        // Marqueur data-stats-evo : contrôle du mode Évolution (univers
        // « Compter » — sans objet pour la métrique « statut », qui ignore
        // l'univers).
        const evoOk = !el.hasAttribute('data-stats-evo')
            || (evolutionMode && panel.metric !== 'status');
        // Marqueur data-stats-metric : contrôle réservé à certaines
        // métriques (même syntaxe « séparé par espaces » que kind).
        const metricOk = !el.hasAttribute('data-stats-metric')
            || (el.dataset.statsMetric || '').split(' ').includes(panel.metric);
        el.hidden = !kindOk || !evoOk || !metricOk;
    });
    // Nombre de lignes : catégories des histogrammes, et anneaux.
    // Top-N : uniquement les métriques catégorielles qui peuvent le dépasser
    // — « status » (actives/archivées) n'a jamais que deux lignes.
    const categorical = CATEGORICAL_METRICS.includes(panel.metric) && panel.metric !== 'status';
    document.querySelectorAll('#statsPanelForm [data-stats-categorical]').forEach((el) => {
        el.hidden = !(panel.kind === 'donut' || (panel.kind === 'bar' && categorical));
    });

    const p = panel.position;
    const free = p.mode === 'free';
    document.querySelectorAll('input[name="statsAnchor"]').forEach((radio) => {
        radio.checked = !free && radio.value === p.anchor;
    });
    const freeBox = $('statsFreePosition');
    if (freeBox) {
        freeBox.hidden = !free;
        freeBox.classList.toggle('d-flex', free);
    }
    // Position libre : le sous-libellé du summary reflète le mode courant, la
    // section reste repliée (l'alerte se retrouve en l'ouvrant).
    const hintAnchored = $('statsPositionHintAnchored');
    if (hintAnchored) hintAnchored.hidden = free;
    const hintFree = $('statsPositionHintFree');
    if (hintFree) hintFree.hidden = !free;
    setValue('inputStatsDx', p.dx);
    setValue('inputStatsDy', p.dy);
    setValue('inputStatsWidth', p.width);
    // Hauteur imposée : vide quand automatique (null). Le champ porte
    // data-stats-kind sans « grid » — cases carrées, il est masqué.
    setValue('inputStatsHeight', p.height ?? '');
    // Colonne centrale : le panneau est centré, la marge horizontale ne sert
    // pas ; ligne médiane : la pile est centrée, la marge verticale non plus ;
    // position libre : aucune marge ne sert.
    const dx = $('inputStatsDx');
    if (dx) dx.disabled = free || p.anchor.endsWith('-center');
    const dy = $('inputStatsDy');
    if (dy) dy.disabled = free || p.anchor.startsWith('middle-');

    const s = panel.style;
    setValue('inputStatsBackground', s.background);
    setValue('inputStatsText', s.text_color);
    setValue('inputStatsAccent', s.accent_color);
    setValue('rangeStatsOpacity', s.background_opacity);
    const opacityValue = $('valueStatsOpacity');
    if (opacityValue) opacityValue.textContent = `${s.background_opacity} %`;
    // « gc » = couleurs Groundspeak des types de caches : sans équivalent
    // pour les autres métriques (categoryColor retombe sur l'accent), elle
    // n'est proposée qu'à la métrique « type de cache » — hidden, et disabled
    // en secours pour Safari qui ignore hidden sur les options. Un « gc »
    // stocké s'affiche « accent » — le rendu effectif — sans réécrire le
    // réglage : repasser à « type de cache » retrouve le choix de l'utilisateur.
    const offersGc = panel.metric === 'cache_type';
    const gcOption = $('selectStatsPalette')?.querySelector('option[value="gc"]');
    if (gcOption) {
        gcOption.hidden = !offersGc;
        gcOption.disabled = !offersGc;
    }
    setValue('selectStatsPalette', !offersGc && s.palette === 'gc' ? 'accent' : s.palette);
    setValue('inputStatsFontSize', s.font_size);
    setValue('inputStatsRadius', s.radius);
    setValue('switchStatsInheritFont', s.inherit_font);
    // Rien à quoi l'appliquer tant que le panneau est seul dans la liste.
    const styleToAll = $('btnStatsStyleToAll');
    if (styleToAll) styleToAll.disabled = modePanels(currentSettings()).length < 2;
    renderPresetButtons(panel);

    drawFormPreview(panel);
}

// Mini-aperçu : le panneau dessiné à sa taille réelle — utile quand la
// carte est hors vue (écran étroit). Masqué si non dessinable. Hors du
// formulaire, stats_panels le redessine quand les comptes changent (onglet
// ouvert) ; l'ouverture de l'onglet le remet à jour (syncFormPreview).
function drawFormPreview(panel) {
    const preview = $('statsPanelPreview');
    if (!preview) return;
    const drawn = pkg.drawStatsPanelPreview?.(panel.id, preview);
    preview.hidden = !drawn;
    preview.style.opacity = panel.enabled ? '' : '0.45';
    if (drawn) preview.style.width = `${Math.round(panel.position.width)}px`;
}

// Case d'une vignette de préréglage, en px CSS (.image-preset-thumb, marge
// intérieure déduite — mêmes classes que les préréglages de l'onglet Images).
const PRESET_THUMB_BOX = Object.freeze({ width: 56, height: 38 });

// Cartes des préréglages d'apparence : le panneau dessiné dans chaque style,
// réduit proportionnellement (même pipeline que la carte, stats_panels.js ›
// drawStatsStylePresetPreview) ; celui qu'il porte exactement est enfoncé
// (matchingStatsStylePreset). Panneau indessinable : l'icône tient la place.
function renderPresetButtons(panel) {
    const preset = matchingStatsStylePreset(panel.style);
    document.querySelectorAll('[data-stats-style-preset]').forEach((button) => {
        const name = button.dataset.statsStylePreset;
        const active = name === preset;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
        const canvas = button.querySelector('canvas');
        const icon = button.querySelector('.image-preset-thumb .ti');
        const drawn = !!canvas && !!pkg.drawStatsStylePresetPreview?.(
            panel.id, name, canvas, PRESET_THUMB_BOX);
        if (canvas) canvas.hidden = !drawn;
        if (icon) icon.hidden = drawn;
    });
}

// Nom affiché d'un préréglage (sans le texte éventuel de la vignette).
function presetLabel(button) {
    return button?.querySelector('.image-preset-label')?.textContent.trim() || '';
}

function syncFormPreview(event) {
    if (event?.target?.getAttribute?.('href') !== '#stats') return;
    const panel = selectedPanel();
    if (panel) drawFormPreview(panel);
}

// Champ du formulaire → chemin dans le panneau. `number` : valeur numérique
// (bornée ensuite par la normalisation).
const FIELDS = [
    ['inputStatsTitle', 'title', 'text'],
    ['switchStatsShowTitle', 'show_title', 'bool'],
    ['switchStatsValues', 'options.show_values', 'bool'],
    ['selectStatsHighlight', 'options.highlight', 'text'],
    ['selectStatsCellMode', 'options.cell_mode', 'text'],
    ['switchStatsCoverage', 'options.show_coverage', 'bool'],
    ['switchStatsLoops', 'options.show_loops', 'bool'],
    ['switchStatsMilestones', 'options.show_milestones', 'bool'],
    ['selectStatsSort', 'options.sort', 'text'],
    ['selectStatsOrientation', 'options.orientation', 'text'],
    ['inputStatsMaxItems', 'options.max_items', 'number'],
    ['switchStatsHideEmpty', 'options.hide_empty', 'bool'],
    ['switchStatsPercent', 'options.show_percent', 'bool'],
    ['rangeStatsHole', 'options.hole', 'number'],
    ['switchStatsLegend', 'options.show_legend', 'bool'],
    ['switchStatsArea', 'options.show_area', 'bool'],
    ['selectStatsColumns', 'options.columns', 'number'],
    ['inputStatsDx', 'position.dx', 'number'],
    ['inputStatsDy', 'position.dy', 'number'],
    ['inputStatsWidth', 'position.width', 'number'],
    ['inputStatsBackground', 'style.background', 'text'],
    ['inputStatsText', 'style.text_color', 'text'],
    ['inputStatsAccent', 'style.accent_color', 'text'],
    ['rangeStatsOpacity', 'style.background_opacity', 'number'],
    ['selectStatsPalette', 'style.palette', 'text'],
    ['inputStatsFontSize', 'style.font_size', 'number'],
    ['inputStatsRadius', 'style.radius', 'number'],
    ['switchStatsInheritFont', 'style.inherit_font', 'bool'],
];

const MARGIN_PATHS = ['position.dx', 'position.dy'];

function readField(el, type) {
    if (type === 'bool') return el.checked;
    if (type === 'number') return el.value === '' ? undefined : Number(el.value);
    return el.value;
}

function writePath(panel, path, value) {
    const keys = path.split('.');
    let target = panel;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = value;
}

function bindFormFields() {
    for (const [id, path, type] of FIELDS) {
        const el = $(id);
        if (!el) continue;
        // Saisie : aperçu en direct, sans réécrire le champ (une valeur hors
        // bornes en cours de frappe serait sinon corrigée sous les doigts).
        // Sortie du champ : le formulaire reprend la valeur normalisée.
        const live = type === 'number' || type === 'text' ? 'input' : 'change';
        el.addEventListener(live, () => {
            const value = readField(el, type);
            if (value === undefined) return;
            updateSelected((panel, panels) => {
                writePath(panel, path, value);
                // Marges de coin : communes à la pile, écrites sur chacun
                // de ses panneaux.
                if (MARGIN_PATHS.includes(path) && panel.position.mode === 'anchor') {
                    for (const mate of cornerMates(panels, panel)) writePath(mate, path, value);
                }
            }, el);
            if (type !== 'number' && el.tagName !== 'INPUT') renderForm();
            if (path === 'title' || path === 'show_title') renderList();
            if (type === 'bool') renderForm();
            if (path === 'style.background_opacity') {
                const out = $('valueStatsOpacity');
                if (out) out.textContent = `${value} %`;
            }
            if (path === 'options.hole') {
                const out = $('valueStatsHole');
                if (out) out.textContent = `${value} %`;
            }
        });
        if (live === 'input') el.addEventListener('change', () => renderForm());
    }

    // Hauteur imposée : un champ vide vaut « automatique » (null) — le
    // binder générique ne produit pas null, d'où ce handler dédié. La
    // normalisation borne la valeur à l'écriture.
    const heightInput = $('inputStatsHeight');
    if (heightInput) {
        heightInput.addEventListener('input', () => {
            const raw = heightInput.value.trim();
            const height = Number(raw);
            updateSelected((panel) => {
                panel.position.height = raw === '' || !Number.isFinite(height) ? null : height;
            }, heightInput);
        });
        heightInput.addEventListener('change', () => renderForm());
    }

    $('selectStatsMetric')?.addEventListener('change', (event) => {
        const metric = event.target.value;
        updateSelected((panel) => {
            // Nouvelle métrique : ses options par défaut (ordre, orientation…),
            // en gardant titre, position et apparence.
            const fresh = createStatsPanel(panel.kind, metric, {});
            panel.metric = metric;
            panel.options = fresh.options;
            if (panel.kind === 'bar' || panel.kind === 'donut') panel.style.palette = fresh.style.palette;
        }, event.target);
        renderStatsTab();
    });

    $('selectStatsKind')?.addEventListener('change', (event) => {
        updateSelected((panel) => {
            // Nouvelle forme : ses options par défaut (trou, légende, ordre…),
            // en gardant titre, position, apparence et métrique.
            const fresh = createStatsPanel(event.target.value, panel.metric, {});
            if (!fresh) return;
            panel.kind = event.target.value;
            panel.options = fresh.options;
        }, event.target);
        renderStatsTab();
    });

    // Choisir un coin ramène un panneau glissé à la souris dans sa pile.
    document.querySelectorAll('input[name="statsAnchor"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            updateSelected((panel, panels) => {
                panel.position.anchor = radio.value;
                panel.position.mode = 'anchor';
                adoptCornerMargins(panel, panels);
            }, radio.closest('.stats-anchor-grid'));
            renderForm();
        });
    });
    $('btnStatsBackToAnchor')?.addEventListener('click', (event) => {
        updateSelected((panel, panels) => {
            panel.position.mode = 'anchor';
            adoptCornerMargins(panel, panels);
        }, event.currentTarget);
        renderForm();
    });

    // Compteurs : au moins un chiffre ; l'ordre affiché suit celui de la liste.
    // Les tuiles de l'autre mode (invisibles ici) ne sont pas perdues.
    $('statsCounterItems')?.addEventListener('change', (event) => {
        const checked = [...document.querySelectorAll('#statsCounterItems [data-counter-item]')]
            .filter((box) => box.checked)
            .map((box) => box.dataset.counterItem);
        const items = counterItems.filter((item) => checked.includes(item));
        if (!items.length) {
            event.target.checked = true;
            return;
        }
        updateSelected((panel) => {
            const kept = (panel.options.items || []).filter((item) => !counterItems.includes(item));
            panel.options.items = [...kept, ...items];
        }, event.target);
    });

    // Univers compté (Évolution) : 'active' est le défaut — la clé est ôtée
    // plutôt que sérialisée (les panneaux principaux ne la portent pas).
    $('selectStatsCounted')?.addEventListener('change', (event) => {
        updateSelected((panel) => {
            if (event.target.value === 'active') delete panel.options.counted;
            else panel.options.counted = event.target.value;
        }, event.target);
    });
}

// ---------------------------------------------------------------------------
// Glisser-déposer
// ---------------------------------------------------------------------------

// Tant que l'onglet Stats est ouvert et qu'aucune animation ne tourne, les
// panneaux de la carte se saisissent à la souris : déposés, ils passent en
// position libre (x, y normalisés dans l'espace restant du cadre, donc
// valables à toute taille d'aperçu et de vidéo).
function syncDragMode() {
    const host = $('mapWithFrames');
    if (!host) return;
    const tabOpen = !!$('stats')?.classList.contains('active');
    const idle = !(pkg.isAnimationInProgress?.() ?? false);
    host.classList.toggle('stats-editing', tabOpen && idle);
}

function withFreePosition(id, x, y) {
    const settings = currentSettings();
    return {
        ...settings,
        [panelsKey()]: modePanels(settings).map((panel) => (panel.id === id
            ? { ...panel, position: { ...panel.position, mode: 'free', x, y } }
            : panel)),
    };
}

function withPositionPatch(id, patch) {
    const settings = currentSettings();
    return {
        ...settings,
        [panelsKey()]: modePanels(settings).map((panel) => (panel.id === id
            ? { ...panel, position: { ...panel.position, ...patch } }
            : panel)),
    };
}

// Dépôt aimanté : le panneau rejoint la pile du coin, avec ses marges.
function withSnappedAnchor(id, anchor) {
    const settings = currentSettings();
    const panels = modePanels(settings).map((panel) => structuredClone(panel));
    const panel = panels.find((p) => p.id === id);
    if (panel) {
        panel.position.mode = 'anchor';
        panel.position.anchor = anchor;
        adoptCornerMargins(panel, panels);
    }
    return { ...settings, [panelsKey()]: panels };
}

// État ouvert/fermé des sections repliables du formulaire : préférence
// d'interface locale au navigateur (localStorage), non synchronisée serveur.
const FORM_SECTIONS_KEY = 'statsFormSections';

function readFormSections() {
    try {
        const parsed = JSON.parse(localStorage.getItem(FORM_SECTIONS_KEY));
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
        return {};
    }
}

function bindFormSections() {
    // Onglet Stats seulement : l'onglet Images reprend ces classes avec son
    // propre état (images_ui.js › bindFormSections).
    const sections = document.querySelectorAll('#stats details.stats-form-section[id]');
    const saved = readFormSections();
    sections.forEach((section) => {
        section.open = !!saved[section.id];
        section.addEventListener('toggle', () => {
            const state = readFormSections();
            state[section.id] = section.open;
            try { localStorage.setItem(FORM_SECTIONS_KEY, JSON.stringify(state)); } catch (_) { /* quota */ }
        });
    });
}

// Glisser-déposer, aimantation et poignées : panel_interactions.js, avec les
// rappels propres aux panneaux (aperçu en direct par stats_panels.js,
// enregistrement par commit). Les grilles, à cases carrées, n'ont pas de
// poignée de hauteur.
function bindDragAndDrop() {
    const commitNow = (next) => commit(next, STATS_SAVE_STATUS, { immediate: true });
    bindPanelDrag({
        host: $('mapWithFrames'),
        selector: 'canvas.stats-panel',
        idOf: (el) => el.dataset.panelId,
        editingClass: 'stats-editing',
        ghostClass: 'panel-snap-ghost stats-snap-ghost',
        isBusy: () => !!pkg.isAnimationInProgress?.(),
        getRect: (id) => {
            const rect = pkg.getStatsPanelRect?.(id);
            return rect ? { ...rect, resizableHeight: rect.kind !== 'grid' } : null;
        },
        getSnapTargets: (id) => pkg.getStatsSnapTargets?.(id) || [],
        previewPosition: (id, x, y) => pkg.previewStatsPanelPosition?.(id, x, y),
        previewWidth: (id, width) => pkg.previewStatsPanelWidth?.(id, width),
        previewHeight: (id, height) => pkg.previewStatsPanelHeight?.(id, height),
        pinCorner: (id) => pkg.pinStatsPanelCorner?.(id),
        unpinCorner: () => pkg.unpinStatsPanelCorner?.(),
        onGrab: (id) => {
            selectedId = id;
            renderStatsTab();
        },
        commitFree: (id, x, y) => commitNow(withFreePosition(id, x, y)),
        commitSnap: (id, anchor) => commitNow(withSnappedAnchor(id, anchor)),
        commitResize: (id, patch) => commitNow(withPositionPatch(id, patch)),
        onRelease: () => renderForm(),
        selectedId: () => selectedId,
        // Flèches : 1 px (10 avec Maj) depuis la place affichée — un
        // panneau ancré devient libre là où il est. Debounce (PAS
        // immediate) : les répétitions de la touche se regroupent en un
        // seul PUT ; le formulaire suit (mode libre, marges désactivées).
        nudge: (id, dxPx, dyPx, rect) => {
            const clamp01 = (v) => Math.max(0, Math.min(1, v));
            const freeW = rect.container.width - rect.width;
            const freeH = rect.container.height - rect.height;
            const x = freeW > 0 ? clamp01((rect.x + dxPx) / freeW) : 0;
            const y = freeH > 0 ? clamp01((rect.y + dyPx) / freeH) : 0;
            commit(withFreePosition(id, x, y), STATS_SAVE_STATUS);
            renderForm();
        },
        // Suppr : même chemin que le bouton « Supprimer » de la ligne —
        // toast « Annuler » compris.
        remove: (id) => runListAction(id, 'delete'),
    });
}

// ---------------------------------------------------------------------------
// Infobulle de survol (case, ligne, part, tuile, jour de courbe)
// ---------------------------------------------------------------------------
//
// Le pointeur repose sur un panneau (mode édition seulement : hors de
// l'onglet Stats, les canvas laissent passer les événements vers la carte) :
// la bulle dit ce qu'il affiche là — le même texte que l'équivalent
// accessible (stats_panels.js › statsPanelHoverText). Un seul élément,
// partagé, repositionné à chaque mouvement.
let hoverTip = null;

function hideHoverTip() {
    hoverTip?.remove();
    hoverTip = null;
}

function onHoverTipMove(event) {
    const canvas = event.target.closest?.('canvas.stats-panel');
    // Un bouton enfoncé = glisser, redimensionner ou balayer la carte.
    if (!canvas || event.buttons) { hideHoverTip(); return; }
    const host = $('mapWithFrames');
    const rect = canvas.getBoundingClientRect();
    const text = pkg.statsPanelHoverText?.(canvas.dataset.panelId,
        event.clientX - rect.left, event.clientY - rect.top);
    if (!text) { hideHoverTip(); return; }
    if (!hoverTip) {
        hoverTip = document.createElement('div');
        hoverTip.className = 'stats-hover-tip';
        host.appendChild(hoverTip);
    }
    if (hoverTip.textContent !== text) hoverTip.textContent = text;
    // Sous le pointeur, recalée dans le cadre quand elle en sortirait.
    const hostRect = host.getBoundingClientRect();
    const maxLeft = Math.max(0, hostRect.width - hoverTip.offsetWidth - 4);
    const maxTop = Math.max(0, hostRect.height - hoverTip.offsetHeight - 4);
    hoverTip.style.left = `${Math.min(event.clientX - hostRect.left + 14, maxLeft)}px`;
    hoverTip.style.top = `${Math.min(event.clientY - hostRect.top + 14, maxTop)}px`;
}

function bindHoverTip() {
    const host = $('mapWithFrames');
    if (!host) return;
    host.addEventListener('pointermove', onHoverTipMove);
    host.addEventListener('pointerdown', hideHoverTip);
    host.addEventListener('pointerleave', hideHoverTip);
    // Changer d'onglet ou lancer la lecture ne change rien aux zones
    // survolables, mais un pointeur resté sur le canvas masqué garderait sa
    // bulle sans événement pour l'enlever.
    document.addEventListener('hidden.bs.tab', hideHoverTip);
}

// ---------------------------------------------------------------------------
// Export du panneau sélectionné (instantané PNG, valeurs CSV)
// ---------------------------------------------------------------------------

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// Nom de fichier d'export : le titre du panneau (ou son titre par défaut)
// en slug ASCII — « Ma D/T ! » → « stats-ma-dt.png » ; repli sur
// « stats-bar-cache_type » quand le slug est vide (titre non latin…).
// `ext` : extension (\u00ab csv \u00bb) ou suffixe complet commen\u00e7ant par \u00ab . \u00bb ou
// \u00ab @ \u00bb (\u00ab @2x.png \u00bb).
function exportFileName(panel, ext) {
    const label = (panel.title || pkg.defaultStatsPanelTitle(panel) || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const suffix = /^[.@]/.test(ext) ? ext : `.${ext}`;
    return `stats-${label || `${panel.kind}-${panel.metric}`}${suffix}`;
}

// Échelle de l'export PNG (1×, 2×, 4×) : préférence d'interface locale au
// navigateur, comme l'état des sections repliables. 2× par défaut — net
// dans une vidéo 1080p, et sur un écran haute densité.
const PNG_SCALE_KEY = 'statsPngScale';
const PNG_SCALES = [1, 2, 4];

function pngScale() {
    const value = Number($('selectStatsPngScale')?.value);
    return PNG_SCALES.includes(value) ? value : 2;
}

function restorePngScale() {
    const select = $('selectStatsPngScale');
    if (!select) return;
    try {
        const saved = Number(localStorage.getItem(PNG_SCALE_KEY));
        if (PNG_SCALES.includes(saved)) select.value = String(saved);
    } catch (_) { /* stockage indisponible : défaut du gabarit */ }
    select.addEventListener('change', () => {
        try { localStorage.setItem(PNG_SCALE_KEY, String(pngScale())); } catch (_) { /* quota */ }
    });
    // La taille sur la carte suit la fenêtre : libellés relus à l'ouverture.
    select.addEventListener('pointerdown', () => renderPngScales(selectedPanel()));
    select.addEventListener('focus', () => renderPngScales(selectedPanel()));
}

// « 2× — 560 × 620 px » : la taille de l'image produite par chaque échelle.
function renderPngScales(panel) {
    const select = $('selectStatsPngScale');
    const button = $('btnStatsExportPng');
    const size = panel ? pkg.statsPanelExportSize?.(panel.id) : null;
    if (button) button.disabled = !size;
    if (select) {
        select.disabled = !size;
        for (const option of select.options) {
            const scale = Number(option.value);
            option.textContent = size
                ? `${scale}× — ${Math.round(size.width * scale)} × ${Math.round(size.height * scale)} px`
                : `${scale}×`;
        }
    }
}

async function exportPanelPng() {
    const panel = selectedPanel();
    if (!panel) return;
    const scale = pngScale();
    const blob = await pkg.statsPanelPngBlob?.(panel.id, scale);
    // « stats-ma-dt@2x.png » : la convention des images haute densité.
    if (blob) downloadBlob(blob, exportFileName(panel, scale > 1 ? `@${scale}x.png` : '.png'));
}

function exportPanelCsv() {
    const panel = selectedPanel();
    const csv = panel ? pkg.statsPanelCsv?.(panel.id) : null;
    if (csv) downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }),
        exportFileName(panel, 'csv'));
}

// Export/import de la liste du mode courant — pour qui veut la copier
// ailleurs : la normalisation reprend tout à l'import (métriques
// incompatibles filtrées, ids en doublon régénérés), comme l'application
// d'une configuration nommée.
function exportPanels() {
    const settings = currentSettings();
    const payload = {
        mode: evolutionMode ? 'evolution' : 'finds',
        panels: modePanels(settings),
    };
    const json = JSON.stringify(payload, null, 2);
    downloadBlob(new Blob([json], { type: 'application/json;charset=utf-8' }),
        `stats-panneaux-${payload.mode}.json`);
}

// Accepte : un tableau de panneaux, { panels: [...] }, { evolution_panels:
// [...] } ou un bloc { stats: {...} } complet — la liste du mode courant est
// lue dedans dans cet ordre de priorité.
function importedPanels(data) {
    if (Array.isArray(data)) return data;
    const key = panelsKey();
    if (Array.isArray(data?.[key])) return data[key];
    if (Array.isArray(data?.panels)) return data.panels;
    if (Array.isArray(data?.stats?.[key])) return data.stats[key];
    if (Array.isArray(data?.stats?.panels)) return data.stats.panels;
    return null;
}

async function importPanels(file) {
    let panels = null;
    try {
        panels = importedPanels(JSON.parse(await file.text()));
    } catch (e) { /* JSON illisible → toast d'erreur plus bas */ }
    if (!panels) {
        pkg.showToast?.(pkg.t('Import impossible : fichier de panneaux invalide'));
        return;
    }
    // Un fichier lisible mais sans panneau exploitable est refusé sans
    // toucher la liste courante (sinon l'import la viderait).
    if (!panels.some((raw) => normalizeStatsPanel(raw))) {
        pkg.showToast?.(pkg.t('Import impossible : fichier de panneaux invalide'));
        return;
    }
    const key = panelsKey();
    const previous = modePanels(currentSettings());
    const applied = commit({ ...currentSettings(), [key]: panels },
        STATS_SAVE_STATUS, { immediate: true });
    selectedId = applied[key][0]?.id || null;
    renderStatsTab();
    pkg.showActionToast?.(
        pkg.t('${count} panneau(x) importé(s)', { count: applied[key].length }),
        { label: 'Annuler', onClick: () => {
            commit({ ...currentSettings(), [key]: previous },
                STATS_SAVE_STATUS, { immediate: true });
            selectedId = previous[0]?.id || null;
            renderStatsTab();
        } });
}

// ---------------------------------------------------------------------------
// Configurations nommées : instantané de la liste de panneaux, ré-applicable.
// ---------------------------------------------------------------------------

// Entrées du menu entre l'en-tête « Enregistrées » et le séparateur ; chaque
// ligne porte le nom (clic = appliquer) et une croix de suppression.
function renderConfigMenu() {
    const menu = $('statsConfigMenu');
    if (!menu) return;
    const settings = currentSettings();
    const configs = settings.configs || [];
    menu.querySelectorAll('[data-config-entry]').forEach((el) => el.remove());
    const header = $('statsConfigHeader');
    if (header) header.hidden = configs.length === 0;
    const empty = $('statsConfigEmpty');
    if (empty) empty.hidden = configs.length > 0;
    const sep = $('statsConfigSep');
    for (const config of configs) {
        const item = document.createElement('li');
        item.className = 'd-flex align-items-center';
        item.dataset.configEntry = '';

        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dropdown-item text-truncate flex-grow-1';
        apply.dataset.configApply = config.name;
        apply.textContent = config.name;
        const count = document.createElement('span');
        count.className = 'text-muted ms-1';
        count.textContent = `(${config.panels.length})`;
        apply.appendChild(count);
        // Enregistrée dans l'autre mode : ses panneaux rempliraient la liste
        // du mauvais mode — marquée et non applicable, la suppression reste.
        if (config.mode !== (evolutionMode ? 'evolution' : 'finds')) {
            const badge = document.createElement('span');
            badge.className = 'text-muted small ms-1';
            badge.textContent = otherModeBadge();
            apply.appendChild(badge);
            apply.disabled = true;
            apply.title = pkg.t('Pas affiché dans ce mode');
        }

        const del = iconButton('ti-trash', pkg.t('Supprimer'), 'config-delete');
        del.classList.add('btn-sm', 'px-2');
        del.dataset.configDelete = config.name;
        item.append(apply, del);
        sep?.before(item);
    }
    const save = menu.querySelector('[data-stats-config-save]');
    // Sans panneau rien à enregistrer ; la liste est bornée à STATS_MAX_CONFIGS.
    if (save) save.disabled = !modePanels(settings).length || configs.length >= STATS_MAX_CONFIGS;
}

function showConfigSave() {
    const row = $('statsConfigSave');
    if (!row) return;
    row.hidden = false;
    $('inputStatsConfigName')?.focus();
}

function hideConfigSave() {
    const row = $('statsConfigSave');
    if (row) row.hidden = true;
    const input = $('inputStatsConfigName');
    if (input) input.value = '';
}

function saveCurrentConfig() {
    const settings = currentSettings();
    const entry = normalizeStatsConfig({
        name: $('inputStatsConfigName')?.value,
        mode: evolutionMode ? 'evolution' : 'finds',
        panels: modePanels(settings),
    });
    if (!entry) return;
    // À nom égal, la configuration est remplacée — la mise à jour passe par là.
    const configs = (settings.configs || []).filter((c) => c.name !== entry.name);
    configs.push(entry);
    commit({ ...settings, configs }, STATS_SAVE_STATUS, { immediate: true });
    hideConfigSave();
    renderStatsTab();
    pkg.showToast?.(pkg.t('Configuration « ${name} » enregistrée', { name: entry.name }));
}

function applyConfig(name) {
    const settings = currentSettings();
    const config = (settings.configs || []).find((c) => c.name === name);
    if (!config) return;
    const key = panelsKey();
    const previous = modePanels(settings);
    const applied = commit({ ...settings, [key]: config.panels },
        STATS_SAVE_STATUS, { immediate: true });
    selectedId = applied[key][0]?.id || null;
    renderStatsTab();
    pkg.showActionToast?.(
        pkg.t('Configuration « ${name} » appliquée', { name }),
        { label: 'Annuler', onClick: () => {
            commit({ ...currentSettings(), [key]: previous },
                STATS_SAVE_STATUS, { immediate: true });
            selectedId = previous[0]?.id || null;
            renderStatsTab();
        } });
}

function deleteConfig(name) {
    const settings = currentSettings();
    const configs = settings.configs || [];
    const index = configs.findIndex((c) => c.name === name);
    if (index < 0) return;
    const removed = configs[index];
    commit({ ...settings, configs: configs.filter((c) => c.name !== name) },
        STATS_SAVE_STATUS, { immediate: true });
    renderStatsTab();
    pkg.showActionToast?.(
        pkg.t('« ${name} » supprimée', { name }),
        { label: 'Annuler', onClick: () => {
            const current = currentSettings();
            const list = (current.configs || []).slice();
            list.splice(Math.min(index, list.length), 0, removed);
            commit({ ...current, configs: list }, STATS_SAVE_STATUS, { immediate: true });
            renderStatsTab();
        } });
}

// « Réorganiser » de l'alerte de mise en page : seuls les panneaux en conflit
// bougent, vers l'emplacement qui gêne le moins compte tenu de leur taille,
// du titre et des infos (arrangePanels, stats_model.mjs). Les panneaux
// masqués ne sont pas touchés. Si la place manque pour tout le monde, le
// toast le dit au lieu de prétendre avoir réglé le problème.
// « Appliquer cette apparence à tous les panneaux » (section Apparence) : le
// style du panneau sélectionné est copié sur les autres panneaux de la liste
// du mode, masqués compris — sauf la palette, liée à la métrique (« couleurs
// des types » n'a de sens que pour les types). Réversible par « Annuler » :
// seuls ces champs reviennent, par id — un réglage fait entre-temps sur un
// autre aspect n'est pas perdu.
const SHARED_STYLE_KEYS = Object.freeze([
    'background', 'background_opacity', 'text_color', 'accent_color',
    'font_size', 'radius', 'inherit_font',
]);

// Préréglage d'apparence (cartes de la section « Apparence »), annulable :
// seuls les champs qu'il fixe reviennent (STATS_PRESET_STYLE_KEYS) — une
// taille de texte ou une palette retouchée entre-temps n'est pas perdue.
function applyStylePreset(name, button) {
    const panel = selectedPanel();
    const patch = panel ? statsStylePreset(name) : null;
    if (!patch) return;
    const id = panel.id;
    const before = Object.fromEntries(
        STATS_PRESET_STYLE_KEYS.map((key) => [key, panel.style[key]]));
    const write = (patch_) => {
        updatePanels((panels) => {
            const target = panels.find((p) => p.id === id);
            if (target) Object.assign(target.style, patch_);
            return panels;
        }, STATS_SAVE_STATUS, { immediate: true });
        renderForm();
    };
    write(patch);
    pkg.showActionToast?.(
        pkg.t('Préréglage « ${name} » appliqué', { name: presetLabel(button) || name }),
        { label: 'Annuler', onClick: () => write(before) },
    );
}

function applyStyleToAll(event) {
    const source = selectedPanel();
    if (!source) return;
    const previous = new Map();
    updatePanels((panels) => {
        for (const panel of panels) {
            if (panel.id === source.id) continue;
            if (SHARED_STYLE_KEYS.every((key) => panel.style[key] === source.style[key])) continue;
            previous.set(panel.id, Object.fromEntries(SHARED_STYLE_KEYS.map((key) => [key, panel.style[key]])));
            for (const key of SHARED_STYLE_KEYS) panel.style[key] = source.style[key];
        }
        return panels;
    }, event?.currentTarget || STATS_SAVE_STATUS, { immediate: true });
    renderStatsTab();
    if (previous.size === 0) {
        pkg.showToast?.(pkg.t('Les autres panneaux ont déjà cette apparence.'), 'info');
        return;
    }
    const message = previous.size === 1
        ? pkg.t('Apparence appliquée à un autre panneau')
        : pkg.t('Apparence appliquée à ${n} autres panneaux', { n: previous.size });
    pkg.showActionToast?.(message, { label: 'Annuler', onClick: () => {
        updatePanels((panels) => {
            for (const panel of panels) {
                const style = previous.get(panel.id);
                if (style) panel.style = { ...panel.style, ...style };
            }
            return panels;
        }, STATS_SAVE_STATUS, { immediate: true });
        renderStatsTab();
    } });
}

function reorganizePanels() {
    const arrangement = pkg.arrangeStatsPanels?.();
    if (!arrangement) return;
    const previous = structuredClone(modePanels(currentSettings()));
    updatePanels((panels) => {
        for (const panel of panels) {
            const placement = arrangement.placements.get(panel.id);
            if (placement) panel.position = { ...panel.position, ...placement };
        }
        return panels;
    }, STATS_SAVE_STATUS, { immediate: true });
    renderStatsTab();
    // Réversible, comme une suppression : la liste d'avant revient entière.
    const message = arrangement.conflict > 0
        ? pkg.t('Panneaux réorganisés, mais la place manque : réduisez-en la taille ou masquez-en un.')
        : pkg.t('Panneaux réorganisés');
    pkg.showActionToast?.(
        message,
        { label: 'Annuler', onClick: () => {
            commit({ ...currentSettings(), [panelsKey()]: previous },
                STATS_SAVE_STATUS, { immediate: true });
            renderStatsTab();
        } });
}

function renderWarnings(warnings = pkg.getStatsLayoutWarnings?.() || []) {
    const box = $('statsLayoutWarnings');
    if (!box) return;
    const panels = modePanels(currentSettings());
    const name = (id) => {
        const panel = panels.find((p) => p.id === id);
        return panel ? (panel.title || pkg.defaultStatsPanelTitle(panel)) : '';
    };
    const lines = [];
    for (const warning of warnings) {
        if (warning.kind === 'overflow') {
            lines.push(pkg.t('« ${name} » dépasse de la carte : réduisez sa largeur ou changez de coin.', { name: name(warning.id) }));
        } else if (warning.kind === 'overlap') {
            const other = warning.with === 'titleFrame' ? pkg.t('le titre')
                : String(warning.with).startsWith('image:') ? pkg.t('une image')
                    : pkg.t('les infos');
            lines.push(pkg.t('« ${name} » chevauche ${other}.', { name: name(warning.id), other }));
        } else if (warning.kind === 'panels') {
            lines.push(pkg.t('« ${name} » chevauche « ${other} » : changez de coin ou réduisez une largeur.',
                { name: name(warning.id), other: name(warning.with) }));
        }
    }
    box.replaceChildren(...lines.map((line) => {
        const div = document.createElement('div');
        div.textContent = line;
        return div;
    }));
    if (lines.length) {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'btn btn-sm btn-outline-warning mt-2';
        action.textContent = pkg.t('Réorganiser automatiquement');
        action.addEventListener('click', reorganizePanels);
        box.appendChild(action);
    }
    box.hidden = lines.length === 0;
}

// Reflète les réglages courants dans l'onglet (chargement, modification).
export function renderStatsTab() {
    if (!$('stats')) return;
    const settings = currentSettings();
    const list = modePanels(settings);
    if (!list.some((panel) => panel.id === selectedId)) {
        selectedId = list[0]?.id || null;
    }
    // Le liseré du panneau choisi suit la sélection (visible en mode édition).
    pkg.setStatsPanelSelection?.(selectedId);
    setValue('switchStats', settings.enabled);
    renderList();
    renderConfigMenu();
    renderForm();
    renderWarnings();
    syncDragMode();
}

export function initStatsTab() {
    if (initialized || !$('stats')) return;
    initialized = true;
    syncGalleryMode();

    $('switchStats')?.addEventListener('change', (event) => {
        commit({ ...currentSettings(), enabled: event.target.checked },
            event.target, { immediate: true });
    });
    $('btnStatsAdd')?.addEventListener('click', openGallery);
    $('statsAddMenu')?.addEventListener('click', onGalleryClick);
    $('inputStatsGallerySearch')?.addEventListener('input', (event) => filterGallery(event.target.value));
    // Focus sur la recherche à l'ouverture : on tape aussitôt ce qu'on cherche.
    $(GALLERY_MODAL)?.addEventListener('shown.bs.modal', () => $('inputStatsGallerySearch')?.focus());
    const list = $('statsPanelList');
    list?.addEventListener('click', onListClick);
    list?.addEventListener('change', onListChange);
    if (list) bindListReorder(list);
    $('btnStatsStyleToAll')?.addEventListener('click', applyStyleToAll);
    document.querySelectorAll('[data-stats-style-preset]').forEach((button) => {
        button.addEventListener('click',
            () => applyStylePreset(button.dataset.statsStylePreset, button));
    });
    restorePngScale();
    $('btnStatsExportPng')?.addEventListener('click', exportPanelPng);
    $('btnStatsExportCsv')?.addEventListener('click', exportPanelCsv);
    $('statsConfigMenu')?.addEventListener('click', (event) => {
        const apply = event.target.closest('[data-config-apply]');
        if (apply) {
            applyConfig(apply.dataset.configApply);
            return;
        }
        const del = event.target.closest('[data-config-delete]');
        if (del) {
            deleteConfig(del.dataset.configDelete);
            return;
        }
        if (event.target.closest('[data-stats-config-save]')) showConfigSave();
        if (event.target.closest('[data-stats-panels-export]')) exportPanels();
        if (event.target.closest('[data-stats-panels-import]')) $('statsPanelsImportFile')?.click();
    });
    $('statsPanelsImportFile')?.addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) importPanels(file);
    });
    $('btnStatsConfigSaveOk')?.addEventListener('click', saveCurrentConfig);
    $('btnStatsConfigSaveCancel')?.addEventListener('click', hideConfigSave);
    $('inputStatsConfigName')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveCurrentConfig();
        else if (event.key === 'Escape') hideConfigSave();
    });
    bindFormFields();
    bindFormSections();
    bindDragAndDrop();
    bindHoverTip();
    document.addEventListener('mygcflow:stats-layout', (event) => renderWarnings(event.detail?.warnings));
    // Données chargées, filtre, fenêtre redimensionnée : la taille du panneau
    // change, les tailles d'export affichées aussi.
    document.addEventListener('mygcflow:stats-preview', () => renderPngScales(selectedPanel()));
    // Saisie à la souris : onglet ouvert/fermé, lecture lancée/arrêtée.
    document.addEventListener('shown.bs.tab', syncDragMode);
    document.addEventListener('shown.bs.tab', syncFormPreview);
    document.addEventListener('hidden.bs.tab', syncDragMode);
    const controlBar = $('controlBar');
    if (controlBar && typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncDragMode).observe(controlBar, { attributes: true, attributeFilter: ['data-playback-state'] });
    }
    renderStatsTab();
}

// Auto-initialisation : ui.js appelle ses init pendant sa propre évaluation,
// avant celle de ce module (ordre d'index.js) — un appel depuis là tomberait
// dans la zone morte de `initialized` et ferait échouer tout le graphe.
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initStatsTab);
    else initStatsTab();
}
