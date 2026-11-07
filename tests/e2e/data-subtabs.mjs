import { expect } from '@playwright/test';

// Helper des sous-onglets de l'onglet Données (« Sources » /
// « Filtres & affichage », lot « réorganisation Données »).
// Un contrôle d'un pane fermé n'est pas visible : tout test qui interagit
// avec les filtres (#selectType, datepickers, #filterPresetSelect, …) ou
// les réglages d'affichage (#selectDiscoverySources, #checkDnfDisplay,
// #checkOwnerDisplay) doit ouvrir le pane Filtres ; celui qui clique les
// boutons des cartes sources (#file-input-btn*, #labs*, #gcLogs*, …) ou lit
// leurs bilans (#bddReportNote, #labsReportNote, #gcLogsReportNote) doit
// ouvrir le pane Sources.
// Le clic est inconditionnel : Bootstrap ignore un onglet déjà actif.
// Attention à la persistance : le choix survit au reload
// (localStorage « dataSubTab », ui.js) — un test qui recharge la page après
// avoir ouvert Filtres retombe sur Filtres, pas sur Sources.

const SUBTAB_BUTTONS = {
    sources: '#dataSourcesTab',
    filters: '#dataFiltersTab',
};

/**
 * Ouvre le sous-onglet demandé de l'onglet Données.
 * @param {import('@playwright/test').Page} page
 * @param {'sources'|'filters'} name
 */
export async function openDataSubTab(page, name) {
    const selector = SUBTAB_BUTTONS[name];
    if (!selector) throw new Error(`Sous-onglet Données inconnu : ${name}`);
    await page.locator(selector).click();
}

// « Options avancées » des cartes sources (<details>) : les actions
// secondaires et destructives de chaque source y vivent, en dernier —
// #clearDatabaseBtn ; #labsUpdateBtn, #labsExportBtn, #clearLabsBtn ;
// #gcLogsUpdateBtn, #gcLogsExportBtn, #gcLogsClearBtn. Elles ne sont
// visibles que section dépliée (et, pour ces actions, collection non vide).
const SOURCE_ADVANCED = {
    geocaches: '#geocachesAdvanced',
    labs: '#labsAdvanced',
    logs: '#gcLogsAdvanced',
};

/**
 * Déplie les « Options avancées » d'une carte source (sans la replier si
 * elle l'est déjà) et retourne le locator de la section.
 * @param {import('@playwright/test').Page} page
 * @param {'geocaches'|'labs'|'logs'} cardName
 */
export async function openSourceAdvanced(page, cardName) {
    const selector = SOURCE_ADVANCED[cardName];
    if (!selector) throw new Error(`Carte source inconnue : ${cardName}`);
    const section = page.locator(selector);
    if (!(await section.evaluate(el => el.open))) {
        await section.locator(':scope > summary').click();
    }
    await expect(section).toHaveAttribute('open', '');
    return section;
}
