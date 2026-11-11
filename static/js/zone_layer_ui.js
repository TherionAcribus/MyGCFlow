// Onglet Zones (templates/menu_zones.html) : affichage de la couche
// (préférence globale zones_display, enregistrée tout de suite) et son
// apparence (thème, pkg.options.zones — « Sauvegarder » dans l'onglet Style).
// La couche elle-même : zone_layer.js. Pages « Mes Géocaches » et
// « Évolution », chacune avec sa préférence d'affichage.

import * as pkg from './index.js';
import { t } from './notifications.js';
import { saveSettingsPatch } from './settings_api.mjs';
import { reportSave } from './saved_indicator.mjs';
import { normalizeZoneLayerOptions } from './zone_layer_model.mjs';

let bound = false;
const el = (id) => document.getElementById(id);
// Jeux Évolution proposés pour la part trouvée (« Mes Géocaches ») : null
// tant que la liste n'est pas chargée.
let datasets = null;
let datasetsLoading = false;

// Reflète pkg.options.zones et la préférence dans l'onglet. N'écrit que le
// DOM (appelé aussi par profiles.js au chargement d'un thème).
const page = () => pkg.zoneLayerPage?.() ?? null;
const displayKey = () => pkg.zoneDisplayKey?.() ?? 'zones_display';

export function syncZoneLayerUI() {
    if (!page()) return;
    const o = normalizeZoneLayerOptions(pkg.options?.zones);
    const set = (id, value) => {
        const node = el(id);
        if (node) node.value = String(value);
    };
    const check = (id, value) => {
        const node = el(id);
        if (node) node.checked = value;
    };
    check('switchZonesDisplay', window.userSettings?.[displayKey()] === true);
    set('zonesLevel', o.level);
    set('zonesMeasure', o.measure);
    set('zonesScale', o.scale);
    set('zonesClasses', o.classes);
    set('zonesColor', o.color.toLowerCase());
    set('zonesOpacity', o.opacity);
    check('zonesOutline', o.outline);
    check('zonesGlow', o.glow);
    check('zonesLegend', o.legend);
    set('zonesLegendPosition', o.legendPosition);
    set('zonesGridSize', o.gridSize);
    const gridRow = el('zonesGridSizeRow');
    if (gridRow) gridRow.hidden = o.level !== 'grid';
    const share = o.measure === 'found_share';
    for (const id of ['zonesShareDatasetRow', 'zonesShareBaseRow']) {
        const row = el(id);
        if (row) row.hidden = !share;
    }
    set('zonesShareBase', o.shareBase);
    if (share) syncDatasetChoices(o.shareDataset);
    const value = el('zonesOpacityValue');
    if (value) value.textContent = o.opacity + ' %';
    const position = el('zonesLegendPosition');
    if (position) position.disabled = !o.legend;
    // L'échelle n'a pas de sens pour une date (une couleur par période).
    const scale = el('zonesScale');
    if (scale) scale.disabled = o.measure === 'first_day';
    // Périmètre des données de la mesure choisie, rappelé sous le contrôle :
    // la part trouvée lit tout le jeu Évolution, les autres mesures suivent
    // les données filtrées de la carte.
    const scope = el('zonesScopeHint');
    if (scope) {
        const evolution = page() === 'evolution';
        scope.textContent = o.measure === 'found_share'
            ? (evolution
                ? t('Vos trouvailles croisées avec les caches affichées, par code GC.')
                : t('Tout le jeu Évolution choisi, quels que soient les filtres de la carte.'))
            : (evolution
                ? t('Calculé sur les caches du jeu affiché, à la date montrée.')
                : t('Calculé sur vos trouvailles filtrées, à la date montrée.'));
    }
    syncZoneStatus();
}

// Ligne d'état sous l'interrupteur : contours en chargement, rien à montrer…
export function syncZoneStatus() {
    const node = el('zonesStatus');
    if (!node) return;
    const state = pkg.getZoneLayerDebugState?.();
    let text = '';
    if (state?.enabled) {
        if (state.status === 'loading') {
            text = state.options?.measure === 'found_share' ? t('Chargement de la part trouvée…') : t('Chargement des contours…');
        } else if (state.status === 'error') {
            text = state.options?.measure === 'found_share' ? t('Part trouvée indisponible.') : t('Contours des zones indisponibles.');
        } else if (state.status === 'no-dataset') text = t('Choisissez le jeu Évolution à croiser avec vos trouvailles.');
        else if (state.status === 'missing') text = t("Ce jeu Évolution n'existe plus : choisissez-en un autre.");
        else if (state.status === 'empty') {
            text = page() === 'evolution'
                ? t('Aucune cache à colorer : ouvrez ou importez un jeu dans l’onglet Données.')
                : t('Aucune trouvaille à colorer : importez vos trouvailles dans l’onglet Données.');
        }
    }
    node.textContent = text;
    node.hidden = !text;
}

function readOptions() {
    const value = (id) => el(id)?.value;
    const checked = (id) => el(id)?.checked === true;
    pkg.options.zones = normalizeZoneLayerOptions({
        level: value('zonesLevel'),
        measure: value('zonesMeasure'),
        scale: value('zonesScale'),
        classes: value('zonesClasses'),
        color: value('zonesColor'),
        opacity: value('zonesOpacity'),
        outline: checked('zonesOutline'),
        glow: checked('zonesGlow'),
        legend: checked('zonesLegend'),
        legendPosition: value('zonesLegendPosition'),
        gridSize: value('zonesGridSize'),
        // Page Évolution : pas de choix, le jeu ouvert ; l'option est gardée.
        shareDataset: el('zonesShareDataset') ? value('zonesShareDataset') : pkg.options?.zones?.shareDataset,
        shareBase: value('zonesShareBase'),
    });
}

// Liste des jeux du menu « Jeu Évolution », chargée à la première demande.
// Un jeu supprimé reste choisi (la couche le signale) jusqu'au prochain choix.
function syncDatasetChoices(selected) {
    const select = el('zonesShareDataset');
    if (!select) return;
    if (datasets === null) {
        if (!datasetsLoading) {
            datasetsLoading = true;
            fetch('/api/evolution/datasets', { headers: { Accept: 'application/json' } })
                .then((response) => (response.ok ? response.json() : { datasets: [] }))
                .catch(() => ({ datasets: [] }))
                .then((body) => {
                    datasets = Array.isArray(body?.datasets) ? body.datasets : [];
                    datasetsLoading = false;
                    syncDatasetChoices(normalizeZoneLayerOptions(pkg.options?.zones).shareDataset);
                });
        }
        return;
    }
    const wanted = [{ id: 0, name: datasets.length ? t('Choisir un jeu…') : t('Aucun jeu : importez-en un sur la page Évolution') }]
        .concat(datasets.map((d) => ({ id: d.id, name: d.name })));
    if (selected && !datasets.some((d) => d.id === selected)) wanted.push({ id: selected, name: t('Jeu supprimé') });
    const signature = JSON.stringify(wanted);
    if (select.dataset.choices !== signature) {
        select.replaceChildren(...wanted.map((d) => new Option(d.name, String(d.id))));
        select.dataset.choices = signature;
    }
    select.value = String(selected || 0);
}

function onOptionChange() {
    readOptions();
    syncZoneLayerUI();
    pkg.refreshZoneLayer?.();
    syncZoneStatus();
}

// Préréglages du menu « Préréglages » : un lot de réglages cohérent posé
// d'un coup (structurels → rafraîchissement complet). Le contrôle revient à
// sa place : il lance une action, il n'étale pas un état.
const ZONE_PRESETS = {
    visited: { measure: 'first_day' },
    conquest: { measure: 'count', scale: 'log' },
    coverage: { measure: 'dt_coverage', scale: 'linear' },
};

function onPresetChange(event) {
    const preset = ZONE_PRESETS[event.currentTarget.value];
    event.currentTarget.value = '';
    if (!preset) return;
    pkg.options.zones = normalizeZoneLayerOptions({ ...pkg.options?.zones, ...preset });
    syncZoneLayerUI();
    pkg.refreshZoneLayer?.();
    syncZoneStatus();
}

// Réglages d'apparence seuls (couleur, opacité, contours, lueur, légende) :
// ni les données ni l'échelle ne changent — la couche ne fait que repeindre,
// pas de reconstruction ni de relevé d'état à chaque cran du curseur.
function onAppearanceChange() {
    readOptions();
    const o = normalizeZoneLayerOptions(pkg.options?.zones);
    const value = el('zonesOpacityValue');
    if (value) value.textContent = o.opacity + ' %';
    const position = el('zonesLegendPosition');
    if (position) position.disabled = !o.legend;
    pkg.refreshZoneLayerAppearance?.();
}

async function onDisplayToggle(event) {
    const box = event.currentTarget;
    const on = box.checked;
    const key = displayKey();
    if (window.userSettings) window.userSettings[key] = on;
    pkg.refreshZoneLayer?.();
    syncZoneStatus();
    const ok = await reportSave(el('zonesSaveStatus'), saveSettingsPatch({ [key]: on }));
    if (!ok) {
        // Échec : la case et la carte reviennent à la valeur du disque.
        box.checked = !on;
        if (window.userSettings) window.userSettings[key] = !on;
        pkg.refreshZoneLayer?.();
        syncZoneStatus();
    }
}

export function initZoneLayerUI() {
    if (bound || !page()) return;
    const display = el('switchZonesDisplay');
    if (!display) return;
    bound = true;
    syncZoneLayerUI();
    display.addEventListener('change', onDisplayToggle);
    for (const id of ['zonesLevel', 'zonesMeasure', 'zonesScale', 'zonesClasses',
        'zonesGridSize', 'zonesShareDataset', 'zonesShareBase']) {
        el(id)?.addEventListener('change', onOptionChange);
    }
    for (const id of ['zonesColor', 'zonesOutline', 'zonesGlow', 'zonesLegend', 'zonesLegendPosition']) {
        el(id)?.addEventListener('change', onAppearanceChange);
    }
    // Opacité : suivie pendant le glissement.
    el('zonesOpacity')?.addEventListener('input', onAppearanceChange);
    el('zonesPreset')?.addEventListener('change', onPresetChange);
    // « Sauvegarder le thème » : même action que le bouton de l'onglet Style.
    el('btnZonesSaveTheme')?.addEventListener('click', () => {
        window.profileManager?.saveCurrentAsProfile();
    });
    // L'état (contours arrivés…) se lit à l'ouverture de l'onglet.
    document.querySelector('a[href="#zones"]')?.addEventListener('shown.bs.tab', syncZoneStatus);
}

// Préférences prêtes au jalon mygcflow:ready. S'initialise lui-même (cf.
// AGENTS.md, ordre d'évaluation).
if (window.mygcflowReady) {
    initZoneLayerUI();
} else {
    window.addEventListener('mygcflow:ready', initZoneLayerUI, { once: true });
}
