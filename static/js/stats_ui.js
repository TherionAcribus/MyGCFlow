// Onglet « Stats » : liste des panneaux, modèles, formulaire du panneau choisi.
//
// Préférence globale : chaque modification s'applique aussitôt à l'aperçu
// (applyStatsSettings) puis part au serveur en bloc complet `{ stats }`,
// regroupée par un debounce comme les autres préférences globales.
import * as pkg from './index.js';
import { isEvolutionPage } from './app_mode.mjs';
import { makeDebouncedSettingsSaver } from './settings_api.mjs';
import { reportSave } from './saved_indicator.mjs';
import {
    CATEGORICAL_METRICS,
    EVOLUTION_COUNTER_ITEMS,
    EVOLUTION_METRICS_BY_KIND,
    STATS_COUNTER_ITEMS,
    STATS_MAX_CONFIGS,
    STATS_MAX_PANELS,
    STATS_METRICS_BY_KIND,
    createStatsPanel,
    normalizeStatsConfig,
    normalizeStatsPanel,
    statsPanelsKey,
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
        ['bar', 'container', { position: { anchor: 'top-right', dy: 8, width: 260 } }],
    ],
    'summary-progress': [
        ['counter', 'summary', { position: { anchor: 'top-left' } }],
        ['line', 'cumulative', { position: { anchor: 'bottom-left', width: 340 } }],
    ],
    'types-donut': [['donut', 'cache_type', { position: { anchor: 'top-right', width: 300 } }]],
    race: [['bar', 'country', { position: { anchor: 'top-right' }, options: { sort: 'race', max_items: 6 } }]],
    'difficulty-terrain': [
        ['bar', 'difficulty', { position: { anchor: 'bottom-right', width: 240 } }],
        ['bar', 'terrain', { position: { anchor: 'bottom-right', dy: 8, width: 240 } }],
    ],
    jasmer: [['grid', 'jasmer', { position: { anchor: 'bottom-left', width: 220 } }]],
    calendar: [['grid', 'calendar', { position: { anchor: 'bottom-center', width: 440 } }]],
    'evo-overview': [
        ['counter', 'summary', { position: { anchor: 'top-left' }, options: { items: ['actives', 'placees', 'archivees', 'peak'] } }],
        ['line', 'actives', { position: { anchor: 'bottom-left', width: 340 } }],
    ],
    'evo-status': [['bar', 'status', { position: { anchor: 'top-right', width: 260 } }]],
    'evo-geo': [
        ['bar', 'country', { position: { anchor: 'top-right', width: 260 } }],
        ['bar', 'county', { position: { anchor: 'top-right', dy: 8, width: 260 } }],
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

function updateSelected(mutate, field) {
    updatePanels((panels) => {
        const panel = panels.find((p) => p.id === selectedId);
        if (panel) mutate(panel);
        return panels;
    }, field);
}

// Entrées du menu « Ajouter » selon le mode : chaque item porte
// data-stats-modes (« main », « evolution », les deux) ; un en-tête ou un
// séparateur n'est affiché que si un item visible le suit (menu sans sections
// vides). Le mode ne change pas au fil de la page : filtrage unique à l'init.
function syncAddMenuMode() {
    const mode = evolutionMode ? 'evolution' : 'main';
    const entries = [...document.querySelectorAll('#statsAddMenu > li')];
    let hasVisible = false;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.dataset.statsModes) {
            entry.hidden = !entry.dataset.statsModes.split(' ').includes(mode);
            if (!entry.hidden) hasVisible = true;
        } else {
            entry.hidden = !hasVisible;
            hasVisible = false;
        }
    }
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
            badge.textContent = `(${evolutionMode ? pkg.t('Trouvailles') : pkg.t('Évolution')})`;
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
    const id = item.dataset.panelId;
    const action = target.dataset.action;
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
            const copy = createStatsPanel(panels[index].kind, panels[index].metric, panels[index]);
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
    }, toggle, { immediate: true });
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
    // Pas de canvas pour un panneau masqué : l'export PNG n'a rien à offrir.
    const pngBtn = $('btnStatsExportPng');
    if (pngBtn) pngBtn.disabled = !panel.enabled;

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
    // Grille : les nombres ne s'affichent qu'en mode « nombre de trouvailles ».
    const values = $('switchStatsValues');
    if (values) values.disabled = panel.kind === 'grid' && o.cell_mode !== 'count';

    document.querySelectorAll('#statsPanelForm [data-stats-kind]').forEach((el) => {
        const kindOk = el.dataset.statsKind.split(' ').includes(panel.kind);
        // Marqueur data-stats-evo : contrôle du mode Évolution (univers
        // « Compter » — sans objet pour la métrique « statut », qui ignore
        // l'univers).
        const evoOk = !el.hasAttribute('data-stats-evo')
            || (evolutionMode && panel.metric !== 'status');
        el.hidden = !kindOk || !evoOk;
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
    // Colonne centrale : le panneau est centré, la marge horizontale ne sert
    // pas ; position libre : aucune marge ne sert.
    const dx = $('inputStatsDx');
    if (dx) dx.disabled = free || p.anchor.endsWith('-center');
    const dy = $('inputStatsDy');
    if (dy) dy.disabled = free;

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

    // Mini-aperçu : le panneau dessiné à sa taille réelle — utile quand la
    // carte est hors vue (écran étroit). Masqué si non dessinable.
    const preview = $('statsPanelPreview');
    if (preview) {
        const drawn = pkg.drawStatsPanelPreview?.(panel.id, preview);
        preview.hidden = !drawn;
        preview.style.opacity = panel.enabled ? '' : '0.45';
        if (drawn) preview.style.width = `${Math.round(panel.position.width)}px`;
    }
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
            updateSelected((panel) => writePath(panel, path, value), el);
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
            updateSelected((panel) => {
                panel.position.anchor = radio.value;
                panel.position.mode = 'anchor';
            }, radio.closest('.stats-anchor-grid'));
            renderForm();
        });
    });
    $('btnStatsBackToAnchor')?.addEventListener('click', (event) => {
        updateSelected((panel) => { panel.position.mode = 'anchor'; }, event.currentTarget);
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

// Largeur de la poignée de redimensionnement, mesurée depuis le bord droit
// du canvas : un pointeur qui s'y abaisse change la largeur au lieu de
// déplacer le panneau (la hauteur suit, measure dépend de la largeur).
const RESIZE_GRIP = 14;

function withFreePosition(id, x, y) {
    const settings = currentSettings();
    return {
        ...settings,
        [panelsKey()]: modePanels(settings).map((panel) => (panel.id === id
            ? { ...panel, position: { ...panel.position, mode: 'free', x, y } }
            : panel)),
    };
}

function withWidth(id, width) {
    const settings = currentSettings();
    return {
        ...settings,
        [panelsKey()]: modePanels(settings).map((panel) => (panel.id === id
            ? { ...panel, position: { ...panel.position, width } }
            : panel)),
    };
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
    const sections = document.querySelectorAll('details.stats-form-section[id]');
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

function bindDragAndDrop() {
    const host = $('mapWithFrames');
    if (!host) return;
    let drag = null;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const positionFor = (event) => {
        const left = event.clientX - drag.base.left - drag.offsetX;
        const top = event.clientY - drag.base.top - drag.offsetY;
        const freeW = drag.container.width - drag.width;
        const freeH = drag.container.height - drag.height;
        return {
            x: freeW > 0 ? clamp01(left / freeW) : 0,
            y: freeH > 0 ? clamp01(top / freeH) : 0,
        };
    };
    host.addEventListener('pointerdown', (event) => {
        const canvas = event.target.closest?.('canvas.stats-panel');
        if (!canvas || event.button !== 0 || !host.classList.contains('stats-editing')) return;
        if (pkg.isAnimationInProgress?.()) return;
        const rect = pkg.getStatsPanelRect?.(canvas.dataset.panelId);
        if (!rect) return;
        const base = host.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const resizing = event.clientX >= canvasRect.right - RESIZE_GRIP;
        drag = {
            id: canvas.dataset.panelId,
            pointerId: event.pointerId,
            canvas,
            base,
            mode: resizing ? 'resize' : 'move',
            offsetX: resizing ? 0 : event.clientX - base.left - rect.x,
            offsetY: resizing ? 0 : event.clientY - base.top - rect.y,
            startClientX: event.clientX,
            startWidth: canvasRect.width,
            width: rect.width,
            height: rect.height,
            container: rect.container,
            last: null,
            lastWidth: null,
        };
        canvas.setPointerCapture?.(event.pointerId);
        // Le curseur en ligne posé au survol cède la place à la classe.
        canvas.style.cursor = '';
        canvas.classList.add(resizing ? 'is-resizing' : 'is-dragging');
        event.preventDefault();
        selectedId = drag.id;
        renderStatsTab();
    });
    host.addEventListener('pointermove', (event) => {
        if (!drag) {
            // Survol hors glisser : le curseur annonce la poignée du bord
            // droit (curseur en ligne — le CSS ne connaît pas la position).
            const canvas = event.target?.closest?.('canvas.stats-panel');
            if (canvas && host.classList.contains('stats-editing')) {
                const canvasRect = canvas.getBoundingClientRect();
                canvas.style.cursor = event.clientX >= canvasRect.right - RESIZE_GRIP
                    ? 'ew-resize' : 'grab';
            }
            return;
        }
        if (event.pointerId !== drag.pointerId) return;
        if (drag.mode === 'resize') {
            drag.lastWidth = drag.startWidth + (event.clientX - drag.startClientX);
            // Aperçu en direct de la largeur, comme la position : écrite en
            // place, sans renormalisation ni envoi — le commit les fait.
            pkg.previewStatsPanelWidth?.(drag.id, drag.lastWidth);
            return;
        }
        drag.last = positionFor(event);
        // Aperçu en direct : la position est écrite en place, sans
        // renormalisation ni envoi — le commit au dépôt fait les deux.
        pkg.previewStatsPanelPosition?.(drag.id, drag.last.x, drag.last.y);
    });
    const end = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.canvas.classList.remove('is-dragging', 'is-resizing');
        if (drag.mode === 'resize' && drag.lastWidth != null) {
            commit(withWidth(drag.id, drag.lastWidth), STATS_SAVE_STATUS, { immediate: true });
        } else if (drag.last) {
            commit(withFreePosition(drag.id, drag.last.x, drag.last.y),
                STATS_SAVE_STATUS, { immediate: true });
        }
        drag = null;
        renderForm();
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
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
function exportFileName(panel, ext) {
    const label = (panel.title || pkg.defaultStatsPanelTitle(panel) || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `stats-${label || `${panel.kind}-${panel.metric}`}.${ext}`;
}

async function exportPanelPng() {
    const panel = selectedPanel();
    const blob = panel ? await pkg.statsPanelPngBlob?.(panel.id) : null;
    if (blob) downloadBlob(blob, exportFileName(panel, 'png'));
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
            badge.textContent = `(${evolutionMode ? pkg.t('Trouvailles') : pkg.t('Évolution')})`;
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

// « Réorganiser » de l'alerte de mise en page : chaque panneau repart sur un
// coin distinct, dans l'ordre de la liste — une pile par ancre ne peut plus
// chevaucher ni les autres panneaux ni les cartouches. `middle-center` est
// volontairement exclu (un panneau au milieu de la carte, non).
const REORG_ANCHORS = ['bottom-left', 'bottom-right', 'top-left', 'top-right', 'middle-left', 'middle-right'];

function reorganizePanels() {
    const previous = structuredClone(modePanels(currentSettings()));
    updatePanels((panels) => {
        panels.forEach((panel, i) => {
            panel.position = {
                ...panel.position,
                mode: 'anchor', anchor: REORG_ANCHORS[i % REORG_ANCHORS.length],
                dx: 16, dy: 16,
            };
        });
        return panels;
    }, STATS_SAVE_STATUS, { immediate: true });
    renderStatsTab();
    // Réversible, comme une suppression : la liste d'avant revient entière.
    pkg.showActionToast?.(
        pkg.t('Panneaux réorganisés'),
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
            const other = warning.with === 'titleFrame' ? pkg.t('le titre') : pkg.t('les infos');
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
    syncAddMenuMode();

    $('switchStats')?.addEventListener('change', (event) => {
        commit({ ...currentSettings(), enabled: event.target.checked },
            event.target, { immediate: true });
    });
    $('statsAddMenu')?.addEventListener('click', (event) => {
        const preset = event.target.closest('[data-stats-preset]');
        if (preset) {
            addPanels(PRESETS[preset.dataset.statsPreset] || []);
            return;
        }
        const add = event.target.closest('[data-stats-add]');
        if (add) {
            const [kind, metric] = add.dataset.statsAdd.split(':');
            // Compteur en Évolution : les tuiles de la chronologie, pas celles
            // des trouvailles (défauts du mode principal).
            const overrides = kind === 'counter' && COUNTER_DEFAULT_ITEMS
                ? { options: { items: COUNTER_DEFAULT_ITEMS } }
                : {};
            addPanels([[kind, metric, overrides]]);
        }
    });
    const list = $('statsPanelList');
    list?.addEventListener('click', onListClick);
    list?.addEventListener('change', onListChange);
    if (list) bindListReorder(list);
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
    document.addEventListener('mygcflow:stats-layout', (event) => renderWarnings(event.detail?.warnings));
    // Saisie à la souris : onglet ouvert/fermé, lecture lancée/arrêtée.
    document.addEventListener('shown.bs.tab', syncDragMode);
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
