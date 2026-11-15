// Formulaire de filtres de la page Statistiques. Sert au tableau de bord
// (fenêtre « Filtres ») et à un graphique (éditeur, filtres propres).
//
// Rubriques (la cache, le lieu, les personnes), puis un contrôle par champ,
// garni des seules valeurs présentes avec leur nombre de lignes :
// - liste courte (types, contenants, D/T…) : boutons à bascule, tout est
//   visible d'un coup d'œil ;
// - liste longue (propriétaires, régions, attributs…) : menu à choix
//   multiples avec recherche (Tom Select, comme les filtres de la carte).
// Dans les deux cas, un <select multiple> garde la sélection (lue par
// readFilterForm) ; les boutons ne font que le piloter.
//
// Les comptes suivent la sélection (« à facettes ») : chaque valeur dit ce
// qu'il resterait en la cochant aussi ; une valeur à 0 est grisée.
//
// La logique (valeurs proposées, comptes, résumé) est pure : chart_filters.mjs.

import { initTomSelect } from './ui_bootstrap.js';
import { t } from './notifications.js';
import {
    FILTER_FORM_GROUPS, cleanFilters, filterChoices, filterFacets, matchingCount,
} from './chart_filters.mjs';

// Champs affichés en boutons tant qu'ils ont au plus TOGGLE_MAX valeurs.
const TOGGLE_FIELDS = new Set(['source_kind', 'cache_type', 'container', 'difficulty', 'terrain', 'country', 'published_year']);
const TOGGLE_MAX = 16;
// D/T : boutons étroits, en une ligne.
const NARROW_FIELDS = new Set(['difficulty', 'terrain']);

const GROUP_TITLES = {
    cache: () => t('Caches'),
    place: () => t('Lieux'),
    people: () => t('Personnes'),
};

// État d'un formulaire construit, par conteneur.
const forms = new WeakMap();

// Construit le formulaire dans `container` (vidé). `onChange` est appelé à
// chaque changement de sélection.
// `tables` : les tables des sources du tableau de bord (valeurs réunies).
// `result` (facultatif) : { el, table, text(matched, total) } — le nombre de
// lignes de `table` retenues, écrit dans `el` à chaque changement.
export function renderFilterForm(container, { tables, filters, labels, attributeName, idPrefix, onChange = null, result = null }) {
    destroyFilterForm(container);
    container.replaceChildren();
    const nf = new Intl.NumberFormat(labels.locale);
    const valueText = (field, value) => labels.filterValue(field, value, { attributeName });
    const fields = [];
    for (const group of FILTER_FORM_GROUPS) {
        const rows = [];
        for (const field of group.fields) {
            const choices = filterChoices(tables, field);
            // Un champ à une seule valeur ne filtre rien : masqué (sauf s'il
            // porte déjà une sélection, à pouvoir retirer).
            const selected = new Set(filters?.[field] || []);
            if (choices.length < 2 && !selected.size) continue;
            // Valeur sélectionnée absente des données : gardée, pour pouvoir la retirer.
            for (const value of selected) {
                if (!choices.some((c) => c.value === value)) choices.push({ value, count: 0 });
            }
            const toggles = TOGGLE_FIELDS.has(field) && choices.length <= TOGGLE_MAX;
            const entry = { field, choices, toggles, id: idPrefix + field };
            rows.push(buildRow(entry, selected, labels.filterField(field), valueText, nf));
            fields.push(entry);
        }
        if (!rows.length) continue;
        const section = document.createElement('section');
        section.className = 'stats-filter-group';
        const title = document.createElement('h3');
        title.className = 'stats-filter-group-title';
        title.textContent = GROUP_TITLES[group.id]();
        section.append(title, ...rows);
        container.append(section);
    }
    if (!fields.length) {
        const empty = document.createElement('p');
        empty.className = 'text-muted small mb-0';
        empty.textContent = t('Vos trouvailles sont trop homogènes pour être filtrées.');
        container.append(empty);
    }

    const form = { tables, fields, nf, valueText, result, container };
    forms.set(container, form);
    for (const entry of fields) {
        if (!entry.toggles) initMenu(entry);
        entry.select.addEventListener('change', () => {
            refreshCounts(form);
            if (onChange) onChange();
        });
    }
    refreshCounts(form);
    watchScroller(container);
}

// Une ligne : libellé, puis boutons ou menu.
function buildRow(entry, selected, labelText, valueText, nf) {
    const { field, choices, toggles, id } = entry;
    const row = document.createElement('div');
    row.className = 'stats-filter-row';
    row.dataset.filterRow = field;
    const label = document.createElement(toggles ? 'span' : 'label');
    label.className = 'form-label stats-filter-label';
    label.id = id + '-label';
    if (!toggles) label.htmlFor = id;
    label.textContent = labelText;
    const select = document.createElement('select');
    select.id = id;
    // form-select : la feuille Tom Select Bootstrap 5 en tire le cadre.
    select.className = 'form-select';
    select.multiple = true;
    select.dataset.filterField = field;
    for (const { value, count } of choices) {
        select.append(new Option(valueText(field, value) + ' (' + nf.format(count) + ')', value, false, selected.has(value)));
    }
    entry.select = select;
    const control = document.createElement('div');
    control.className = 'stats-filter-control';
    if (toggles) {
        select.hidden = true;
        const group = document.createElement('div');
        group.className = 'stats-filter-toggles';
        if (NARROW_FIELDS.has(field)) group.classList.add('is-narrow');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-labelledby', label.id);
        entry.buttons = new Map();
        for (const { value } of choices) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'stats-filter-toggle';
            button.dataset.filterValue = value;
            button.setAttribute('aria-pressed', String(selected.has(value)));
            const text = document.createElement('span');
            text.className = 'stats-filter-toggle-text';
            text.textContent = valueText(field, value);
            const count = document.createElement('span');
            count.className = 'stats-filter-toggle-count';
            button.append(text, count);
            button.addEventListener('click', () => {
                const option = [...select.options].find((o) => o.value === value);
                option.selected = !option.selected;
                button.setAttribute('aria-pressed', String(option.selected));
                select.dispatchEvent(new Event('change'));
            });
            entry.buttons.set(value, button);
            group.append(button);
        }
        control.append(group, select);
    } else {
        control.append(select);
    }
    // Vider ce seul champ (visible quand il filtre).
    const head = document.createElement('div');
    head.className = 'stats-filter-head';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-link btn-sm stats-filter-reset';
    reset.hidden = !selected.size;
    reset.setAttribute('aria-label', t('Retirer le filtre ${field}', { field: labelText }));
    reset.title = reset.getAttribute('aria-label');
    reset.innerHTML = '<i class="ti ti-x" aria-hidden="true"></i>';
    reset.addEventListener('click', () => {
        if (select.tomselect) select.tomselect.clear(true);
        for (const option of select.options) option.selected = false;
        select.dispatchEvent(new Event('change'));
    });
    head.append(label, reset);
    row.append(head, control);
    if (field === 'attribute') {
        const hint = document.createElement('div');
        hint.className = 'form-hint';
        hint.textContent = t('Plusieurs attributs : une cache doit les porter tous.');
        control.append(hint);
    }
    return row;
}

function initMenu(entry) {
    const ts = initTomSelect(entry.select, {
        placeholder: t('Aucun filtre'),
        maxOptions: 300,
        dropdownParent: 'body',
        plugins: ['remove_button', 'checkbox_options'],
        // Valeurs encore utiles d'abord, celles à 0 en fin de liste.
        sortField: [{ field: 'rank', direction: 'asc' }, { field: '$order', direction: 'asc' }],
        render: {
            option: (data, escape) => `<div class="option${data.zero ? ' is-zero' : ''}">${escape(data.text)}</div>`,
            item: (data, escape) => `<div class="item">${escape(data.text)}</div>`,
        },
    });
    entry.ts = ts;
    if (!ts) return;
    // La liste s'ouvre dans <body> : la recaler quand la place change.
    const place = () => requestAnimationFrame(() => placeDropdown(ts));
    ts.on('dropdown_open', place);
    ts.on('type', place);
    ts.on('item_add', place);
    ts.on('item_remove', place);
}

// Liste ouverte sous le champ — ou au-dessus quand la place manque en bas
// (dernières lignes de la fenêtre) : elle ne sort plus de l'écran.
function placeDropdown(ts) {
    if (!ts?.isOpen) return;
    ts.positionDropdown();
    const rect = ts.control.getBoundingClientRect();
    const height = ts.dropdown.offsetHeight;
    const below = window.innerHeight - rect.bottom;
    if (below < height + 8 && rect.top > below) {
        ts.dropdown.style.top = `${rect.top + window.scrollY - height}px`;
    }
}

// Fenêtre qui défile : les listes ouvertes suivent leur champ.
function watchScroller(container) {
    const scroller = container.closest('.modal-body');
    if (!scroller || scroller.dataset.filterScroll) return;
    scroller.dataset.filterScroll = '1';
    scroller.addEventListener('scroll', () => {
        for (const select of scroller.querySelectorAll('select[data-filter-field]')) {
            if (select.tomselect?.isOpen) placeDropdown(select.tomselect);
        }
    }, { passive: true });
}

// Comptes à facettes et résultat, d'après la sélection du moment.
function refreshCounts(form) {
    const filters = readFilterForm(form.container);
    const facets = filterFacets(form.tables, filters, form.fields.map((entry) => entry.field));
    for (const entry of form.fields) {
        const counts = facets.get(entry.field);
        const selected = new Set(filters[entry.field] || []);
        for (const { value } of entry.choices) {
            const count = counts.get(value) || 0;
            const zero = count === 0 && !selected.has(value);
            const text = form.valueText(entry.field, value) + ' (' + form.nf.format(count) + ')';
            const option = [...entry.select.options].find((o) => o.value === value);
            if (option) option.text = text;
            const button = entry.buttons?.get(value);
            if (button) {
                button.querySelector('.stats-filter-toggle-count').textContent = form.nf.format(count);
                button.classList.toggle('is-zero', zero);
                button.setAttribute('aria-pressed', String(selected.has(value)));
            }
            const data = entry.ts?.options[value];
            const rank = zero ? 1 : 0;
            if (data && (data.text !== text || data.rank !== rank)) entry.ts.updateOption(value, { ...data, text, zero, rank });
        }
        // Liste ouverte : nouvel ordre tout de suite.
        if (entry.ts?.isOpen) entry.ts.refreshOptions(false);
        // Champ filtré : sa ligne se distingue, et se vide d'un clic.
        const row = entry.select.closest('.stats-filter-row');
        row?.classList.toggle('is-active', selected.size > 0);
        if (row) row.querySelector('.stats-filter-reset').hidden = !selected.size;
    }
    const { result } = form;
    if (result?.el) {
        const matched = matchingCount(result.table, filters);
        result.el.textContent = result.text(matched, result.table?.n || 0);
        result.el.classList.toggle('is-empty', matched === 0);
    }
}

// Sélection du formulaire → filtres normalisés ({} : aucun).
export function readFilterForm(container) {
    const raw = {};
    for (const select of container.querySelectorAll('select[data-filter-field]')) {
        raw[select.dataset.filterField] = [...select.selectedOptions].map((option) => option.value);
    }
    return cleanFilters(raw);
}

export function clearFilterForm(container) {
    for (const select of container.querySelectorAll('select[data-filter-field]')) {
        if (select.tomselect) select.tomselect.clear(true);
        for (const option of select.options) option.selected = false;
    }
    const form = forms.get(container);
    if (form) refreshCounts(form);
}

export function destroyFilterForm(container) {
    for (const select of container.querySelectorAll('select[data-filter-field]')) {
        try { select.tomselect?.destroy(); } catch (_) { /* déjà détruit */ }
    }
    forms.delete(container);
}
