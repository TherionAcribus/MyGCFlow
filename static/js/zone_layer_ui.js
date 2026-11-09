// Onglet Zones (templates/menu_zones.html) : affichage de la couche
// (préférence globale zones_display, enregistrée tout de suite) et son
// apparence (thème, pkg.options.zones — « Sauvegarder » dans l'onglet Style).
// La couche elle-même : zone_layer.js. Page « Mes Géocaches » seulement.

import * as pkg from './index.js';
import { t } from './notifications.js';
import { isMainPage } from './app_mode.mjs';
import { saveSettingsPatch } from './settings_api.mjs';
import { reportSave } from './saved_indicator.mjs';
import { normalizeZoneLayerOptions } from './zone_layer_model.mjs';

let bound = false;
const el = (id) => document.getElementById(id);

// Reflète pkg.options.zones et la préférence dans l'onglet. N'écrit que le
// DOM (appelé aussi par profiles.js au chargement d'un thème).
export function syncZoneLayerUI() {
    if (!isMainPage()) return;
    const o = normalizeZoneLayerOptions(pkg.options?.zones);
    const set = (id, value) => {
        const node = el(id);
        if (node) node.value = String(value);
    };
    const check = (id, value) => {
        const node = el(id);
        if (node) node.checked = value;
    };
    check('switchZonesDisplay', window.userSettings?.zones_display === true);
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
    const value = el('zonesOpacityValue');
    if (value) value.textContent = o.opacity + ' %';
    const position = el('zonesLegendPosition');
    if (position) position.disabled = !o.legend;
    // L'échelle n'a pas de sens pour une date (une couleur par période).
    const scale = el('zonesScale');
    if (scale) scale.disabled = o.measure === 'first_day';
    syncZoneStatus();
}

// Ligne d'état sous l'interrupteur : contours en chargement, rien à montrer…
export function syncZoneStatus() {
    const node = el('zonesStatus');
    if (!node) return;
    const state = pkg.getZoneLayerDebugState?.();
    let text = '';
    if (state?.enabled) {
        if (state.status === 'loading') text = t('Chargement des contours…');
        else if (state.status === 'error') text = t('Contours des zones indisponibles.');
        else if (state.status === 'empty') text = t('Aucune trouvaille à colorer : importez vos trouvailles dans l’onglet Données.');
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
    });
}

function onOptionChange() {
    readOptions();
    syncZoneLayerUI();
    pkg.refreshZoneLayer?.();
    syncZoneStatus();
}

async function onDisplayToggle(event) {
    const box = event.currentTarget;
    const on = box.checked;
    if (window.userSettings) window.userSettings.zones_display = on;
    pkg.refreshZoneLayer?.();
    syncZoneStatus();
    const ok = await reportSave(el('zonesSaveStatus'), saveSettingsPatch({ zones_display: on }));
    if (!ok) {
        // Échec : la case et la carte reviennent à la valeur du disque.
        box.checked = !on;
        if (window.userSettings) window.userSettings.zones_display = !on;
        pkg.refreshZoneLayer?.();
        syncZoneStatus();
    }
}

export function initZoneLayerUI() {
    if (bound || !isMainPage()) return;
    const display = el('switchZonesDisplay');
    if (!display) return;
    bound = true;
    syncZoneLayerUI();
    display.addEventListener('change', onDisplayToggle);
    for (const id of ['zonesLevel', 'zonesMeasure', 'zonesScale', 'zonesClasses', 'zonesColor', 'zonesOutline',
        'zonesGlow', 'zonesLegend', 'zonesLegendPosition']) {
        el(id)?.addEventListener('change', onOptionChange);
    }
    // Opacité : suivie pendant le glissement.
    el('zonesOpacity')?.addEventListener('input', onOptionChange);
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
