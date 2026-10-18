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
    STATS_COUNTER_ITEMS,
    STATS_MAX_PANELS,
    STATS_METRICS_BY_KIND,
    createStatsPanel,
} from './stats_model.mjs';

const saveStatsDebounced = makeDebouncedSettingsSaver(500);

// Élément du titre « Panneaux » qui porte le retour « Enregistré ✓ » des
// actions sans champ dédié (ajout, suppression, réordonnancement, dépôt).
const STATS_SAVE_STATUS = 'statsSaveStatus';

let selectedId = null;
let initialized = false;

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
};

const KIND_ICONS = {
    grid: 'ti-layout-grid',
    bar: 'ti-chart-bar',
    donut: 'ti-chart-donut',
    line: 'ti-chart-line',
    counter: 'ti-123',
};

const CATEGORICAL = ['cache_type', 'container', 'country', 'state'];

const $ = (id) => document.getElementById(id);

function currentSettings() {
    return pkg.getStatsSettings();
}

function selectedPanel() {
    return currentSettings().panels.find((panel) => panel.id === selectedId) || null;
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
    const panels = settings.panels.map((panel) => structuredClone(panel));
    const result = mutate(panels);
    commit({ ...settings, panels: result || panels }, field, options);
}

function updateSelected(mutate, field) {
    updatePanels((panels) => {
        const panel = panels.find((p) => p.id === selectedId);
        if (panel) mutate(panel);
        return panels;
    }, field);
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
    const { panels } = currentSettings();
    list.replaceChildren();
    panels.forEach((panel, index) => {
        const item = document.createElement('li');
        item.className = `list-group-item${panel.id === selectedId ? ' is-selected' : ''}`;
        item.dataset.panelId = panel.id;

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
    if (empty) empty.hidden = panels.length > 0;
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
        const wanted = STATS_METRICS_BY_KIND[panel.kind].join(',');
        if (metricSelect.dataset.kind !== wanted) {
            metricSelect.replaceChildren(...STATS_METRICS_BY_KIND[panel.kind].map((metric) => {
                const option = document.createElement('option');
                option.value = metric;
                option.textContent = pkg.defaultStatsPanelTitle({ metric });
                return option;
            }));
            metricSelect.dataset.kind = wanted;
        }
        metricSelect.value = panel.metric;
    }

    const titleInput = $('inputStatsTitle');
    if (titleInput) titleInput.placeholder = pkg.defaultStatsPanelTitle(panel);
    setValue('inputStatsTitle', panel.title);
    setValue('switchStatsShowTitle', panel.show_title);
    if (titleInput) titleInput.disabled = !panel.show_title;

    // Options : seules celles du type du panneau existent (les autres restent
    // indéfinies, setValue les ignore).
    const o = panel.options;
    setValue('switchStatsValues', o.show_values);
    setValue('selectStatsHighlight', o.highlight);
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
    if (o.columns !== undefined) setValue('selectStatsColumns', String(o.columns));
    document.querySelectorAll('#statsCounterItems [data-counter-item]').forEach((box) => {
        box.checked = (o.items || []).includes(box.dataset.counterItem);
    });
    // Grille : les nombres ne s'affichent qu'en mode « nombre de trouvailles ».
    const values = $('switchStatsValues');
    if (values) values.disabled = panel.kind === 'grid' && o.cell_mode !== 'count';

    document.querySelectorAll('#statsPanelForm [data-stats-kind]').forEach((el) => {
        el.hidden = !el.dataset.statsKind.split(' ').includes(panel.kind);
    });
    // Nombre de lignes : catégories des histogrammes, et anneaux.
    const categorical = CATEGORICAL.includes(panel.metric);
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
    setValue('selectStatsPalette', s.palette);
    setValue('inputStatsFontSize', s.font_size);
    setValue('inputStatsRadius', s.radius);
    setValue('switchStatsInheritFont', s.inherit_font);
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
    $('statsCounterItems')?.addEventListener('change', (event) => {
        const checked = [...document.querySelectorAll('#statsCounterItems [data-counter-item]')]
            .filter((box) => box.checked)
            .map((box) => box.dataset.counterItem);
        const items = STATS_COUNTER_ITEMS.filter((item) => checked.includes(item));
        if (!items.length) {
            event.target.checked = true;
            return;
        }
        updateSelected((panel) => { panel.options.items = items; }, event.target);
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
        panels: settings.panels.map((panel) => (panel.id === id
            ? { ...panel, position: { ...panel.position, mode: 'free', x, y } }
            : panel)),
    };
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
        drag = {
            id: canvas.dataset.panelId,
            pointerId: event.pointerId,
            canvas,
            base,
            offsetX: event.clientX - base.left - rect.x,
            offsetY: event.clientY - base.top - rect.y,
            width: rect.width,
            height: rect.height,
            container: rect.container,
            last: null,
        };
        canvas.setPointerCapture?.(event.pointerId);
        canvas.classList.add('is-dragging');
        event.preventDefault();
        selectedId = drag.id;
        renderStatsTab();
    });
    host.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.last = positionFor(event);
        // Aperçu en direct, sans écriture : l'enregistrement part au dépôt.
        pkg.applyStatsSettings(withFreePosition(drag.id, drag.last.x, drag.last.y));
    });
    const end = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.canvas.classList.remove('is-dragging');
        if (drag.last) commit(withFreePosition(drag.id, drag.last.x, drag.last.y),
            STATS_SAVE_STATUS, { immediate: true });
        drag = null;
        renderForm();
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
}

function renderWarnings(warnings = pkg.getStatsLayoutWarnings?.() || []) {
    const box = $('statsLayoutWarnings');
    if (!box) return;
    const panels = currentSettings().panels;
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
    box.hidden = lines.length === 0;
}

// Reflète les réglages courants dans l'onglet (chargement, modification).
export function renderStatsTab() {
    if (!$('stats')) return;
    const settings = currentSettings();
    if (!settings.panels.some((panel) => panel.id === selectedId)) {
        selectedId = settings.panels[0]?.id || null;
    }
    setValue('switchStats', settings.enabled);
    renderList();
    renderForm();
    renderWarnings();
    syncDragMode();
}

export function initStatsTab() {
    if (initialized || isEvolutionPage() || !$('stats')) return;
    initialized = true;

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
            addPanels([[kind, metric, {}]]);
        }
    });
    const list = $('statsPanelList');
    list?.addEventListener('click', onListClick);
    list?.addEventListener('change', onListChange);
    bindFormFields();
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
