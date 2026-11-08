// Formulaire de filtres de la page Statistiques : un menu à choix multiples
// (Tom Select, comme les filtres de la carte) par champ, garni des seules
// valeurs présentes avec leur nombre de trouvailles. Sert au tableau de
// bord (fenêtre « Filtres ») et à un graphique (éditeur, filtres propres).
//
// La logique (valeurs proposées, résumé) est pure : chart_filters.mjs.

import { initTomSelect } from './ui_bootstrap.js';
import { t } from './notifications.js';
import { FILTER_FORM_FIELDS, cleanFilters, filterChoices } from './chart_filters.mjs';

// Construit le formulaire dans `container` (vidé). `onChange` est appelé à
// chaque changement de sélection.
export function renderFilterForm(container, { table, filters, labels, attributeName, idPrefix, onChange = null }) {
    destroyFilterForm(container);
    container.replaceChildren();
    const nf = new Intl.NumberFormat(labels.locale);
    for (const field of FILTER_FORM_FIELDS) {
        const choices = filterChoices(table, field);
        // Un champ à une seule valeur ne filtre rien : masqué (sauf s'il
        // porte déjà une sélection, à pouvoir retirer).
        const selected = new Set(filters?.[field] || []);
        if (choices.length < 2 && !selected.size) continue;
        const row = document.createElement('div');
        row.className = 'mb-3 stats-filter-row';
        const id = idPrefix + field;
        const label = document.createElement('label');
        label.className = 'form-label';
        label.htmlFor = id;
        label.textContent = labels.filterField(field);
        const select = document.createElement('select');
        select.id = id;
        // form-select : la feuille Tom Select Bootstrap 5 en tire le cadre.
        select.className = 'form-select';
        select.multiple = true;
        select.dataset.filterField = field;
        for (const { value, count } of choices) {
            const text = labels.filterValue(field, value, { attributeName }) + ' (' + nf.format(count) + ')';
            select.append(new Option(text, value, false, selected.has(value)));
        }
        // Valeur sélectionnée absente des données : gardée, pour pouvoir la retirer.
        for (const value of selected) {
            if (!choices.some((c) => c.value === value)) {
                select.append(new Option(labels.filterValue(field, value, { attributeName }) + ' (0)', value, false, true));
            }
        }
        row.append(label, select);
        if (field === 'attribute') {
            const hint = document.createElement('div');
            hint.className = 'form-hint';
            hint.textContent = t('Plusieurs attributs : une cache doit les porter tous.');
            row.append(hint);
        }
        container.append(row);
        initTomSelect(select, {
            placeholder: t('Aucun filtre'),
            maxOptions: 300,
            dropdownParent: 'body',
            plugins: ['remove_button', 'checkbox_options'],
        });
        if (onChange) select.addEventListener('change', onChange);
    }
    if (!container.children.length) {
        const empty = document.createElement('p');
        empty.className = 'text-muted small mb-0';
        empty.textContent = t('Vos trouvailles sont trop homogènes pour être filtrées.');
        container.append(empty);
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
        else for (const option of select.options) option.selected = false;
    }
}

export function destroyFilterForm(container) {
    for (const select of container.querySelectorAll('select[data-filter-field]')) {
        try { select.tomselect?.destroy(); } catch (_) { /* déjà détruit */ }
    }
}
