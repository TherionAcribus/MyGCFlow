// Point d'entrée de la page « Statistiques » (/stats).
//
// Page sans carte : elle ne charge ni OpenLayers ni index.js (graphe complet
// de la page carte). Elle ne tire que des modules autonomes — thème, bouton
// « Quitter » — et, à partir du lot 1, les modules purs chart_*.mjs.
// Plan : MyGCFlow_Plan_Statistiques.md.

import { syncThemeFromSettings } from './theme.js';
import { bindQuitButtons } from './app_quit.js';

// Locale ECharts (libellés de ses outils : export, zoom…) selon la langue de
// l'interface. Le français vient de static/vendor/echarts/langFR.js, chargé
// par le gabarit ; l'anglais est inclus dans echarts.min.js.
export function echartsLocale(lang = document.documentElement.lang) {
    return String(lang || '').toLowerCase().startsWith('fr') ? 'FR' : 'EN';
}

// Préférences globales : seul le thème sert à cette page pour l'instant. Le
// script anti-FOUC l'a déjà posé depuis le miroir local ; on réaligne sur la
// valeur du serveur, qui fait référence (comme init.js sur les pages carte).
async function loadUserSettings() {
    try {
        const response = await fetch('/api/settings');
        if (!response.ok) return;
        const settings = await response.json();
        window.userSettings = settings;
        syncThemeFromSettings(settings);
    } catch (e) {
        console.warn('[stats] Préférences non chargées :', e?.message || e);
    }
}

// Relevé pour les tests E2E.
window.getStatsPageSnapshot = () => ({
    echartsVersion: window.echarts?.version || null,
    locale: echartsLocale(),
});

bindQuitButtons();
loadUserSettings().finally(() => {
    window.mygcflowStatsReady = true;
});
