// Page Statistiques : cartes du tableau — construction, calcul des
// résultats, chiffres clés et dessin des graphiques.

import { t } from './notifications.js';
import { chartSources, periodsAreMultiple } from './chart_spec.mjs';
import { runChartQueries } from './chart_query.mjs';
import { describeFilters } from './chart_filters.mjs';
import {
    buildChartOption, calendarCell, calendarYears, challengeText, chartHeight, numberModel,
} from './chart_echarts.mjs';
import { chartAnimates } from './chart_video.mjs';
import { chartLinksToMap } from './chart_map_link.mjs';
import { panelFromSpec } from './chart_panel_link.mjs';
import {
    effectiveQueryOptions, hasOwnPeriod, HEIGHT_PIXELS, MAX_ITEMS, SIZE_COLUMNS,
} from './dashboard_model.mjs';
import {
    activeDashboard, attributeName, chartTitle, datasetName, filterValueLabel, periodsBadge, renderToolbar,
} from './stats_page_dashboard.js';
import { tableOf } from './stats_page_data.js';
import { renderPreview } from './stats_page_editor.js';
import { confirmMapLink, onChartClick } from './stats_page_links.js';
import { $, echartsLocale, readTokens, state } from './stats_page_state.js';

// Cartes reconstruites ou réutilisées : une carte dont le contenu (item +
// état de ses sources) n'a pas changé garde son DOM et son instance ECharts —
// déplacer, renommer ou ajouter une carte ne redessine pas tout le tableau.
function cardKey(item) {
    const failed = chartSources(item.spec).some((s) => state.sourceErrors.has(s));
    return JSON.stringify(item) + (failed ? '|erreur' : '');
}

function releaseCard(id) {
    state.charts.get(id)?.dispose();
    state.charts.delete(id);
    state.rendered.delete(id);
    state.deferred.delete(id);
}

// Les états de menu qui dépendent de la position, pas du contenu.
function syncCardMenuState(card, index, count) {
    const set = (action, disabled) => {
        const button = card.querySelector('[data-action=' + action + ']');
        if (button) button.disabled = disabled;
    };
    set('duplicate', count >= MAX_ITEMS);
    set('before', index === 0);
    set('after', index === count - 1);
}

export function renderDashboard() {
    renderToolbar();
    const dashboard = activeDashboard();
    const grid = $('statsGrid');
    const count = dashboard.items.length;

    const previous = new Map();
    for (const el of grid.querySelectorAll('.stats-card')) previous.set(el.dataset.chartId, el);

    const placed = dashboard.items.map((item, index) => {
        const key = cardKey(item);
        let card = previous.get(item.spec.id);
        if (card) previous.delete(item.spec.id);
        if (card && card.dataset.itemKey !== key) {
            releaseCard(item.spec.id); // contenu changé : instance libérée
            card = null;
        }
        if (!card) {
            card = cardElement(item, index, count);
            card.dataset.itemKey = key;
        }
        syncCardMenuState(card, index, count);
        return card;
    });
    // Cartes retirées ou remplacées : leurs instances ECharts sont libérées.
    for (const [id] of previous) releaseCard(id);
    state.results.clear();
    state.resizeObserver.disconnect();
    grid.replaceChildren(...placed);
    $('statsGridEmpty').hidden = count > 0;
    $('btnStatsAddChart').disabled = count >= MAX_ITEMS;
    renderAllCharts();
}

// Sélecteur d'une carte (identifiant hexadécimal, sans caractère à échapper).
export function cardSelector(id) {
    return '[data-chart-id=' + CSS.escape(id) + ']';
}

function cardElement(item, index, count) {
    const { spec } = item;
    const card = document.createElement('article');
    card.className = `stats-card stats-size-${item.size}`;
    card.style.setProperty('--stats-cols', SIZE_COLUMNS[item.size]);
    card.style.setProperty('--stats-chart-height', HEIGHT_PIXELS[item.height || 'M'] + 'px');
    card.dataset.chartId = spec.id;
    card.dataset.chart = spec.view.chart;
    card.dataset.height = item.height || 'M';

    const header = document.createElement('header');
    header.className = 'stats-card-header';
    // Poignée : glisser la carte ailleurs dans la grille (le menu garde
    // « Déplacer avant / après » pour le clavier).
    const grip = document.createElement('span');
    grip.className = 'stats-card-grip ti ti-grip-vertical';
    grip.title = t('Glisser pour déplacer');
    grip.setAttribute('aria-hidden', 'true');
    header.append(grip);
    const title = document.createElement('h2');
    title.className = 'stats-card-title';
    title.textContent = chartTitle(spec);
    header.append(title);
    if (hasOwnPeriod(spec) || periodsAreMultiple(spec.periods)) {
        const badge = document.createElement('span');
        badge.className = 'stats-card-period';
        badge.textContent = periodsBadge(spec);
        badge.title = hasOwnPeriod(spec)
            ? t('Période propre à ce graphique') + ' : ' + badge.textContent
            : badge.textContent;
        header.append(badge);
    }
    header.append(cardMenu(spec, index, count));
    card.append(header);
    if (spec.filters !== null) {
        // Filtres propres, VISIBLES (plus seulement en infobulle) : ils
        // remplacent ceux du tableau de bord — le périmètre se lit d'un coup.
        const scope = document.createElement('p');
        scope.className = 'stats-card-scope';
        const icon = document.createElement('i');
        icon.className = 'ti ti-filter stats-card-filter';
        icon.setAttribute('aria-hidden', 'true');
        const described = describeFilters(spec.filters, filterValueLabel)
            .map(({ field, values }) => state.labels.filterField(field) + ' : ' + values.join(', '));
        const text = document.createElement('span');
        text.className = 'stats-card-scope-text';
        text.textContent = t('Filtres propres') + ' : '
            + (described.length ? described.join(' · ') : t('aucun — les filtres du tableau sont ignorés'));
        scope.append(icon, text);
        scope.title = t('Ces filtres remplacent ceux du tableau de bord : ${what}',
            { what: text.textContent.slice(t('Filtres propres').length + 3) });
        card.append(scope);
    }

    const body = document.createElement('div');
    body.className = 'stats-card-body';
    body.append(cardBodyContent(spec));
    card.append(body);
    const note = document.createElement('p');
    note.className = 'stats-card-note';
    note.hidden = true;
    card.append(note);
    // Coin : glisser pour changer la largeur (S → XL) et la hauteur.
    const resize = document.createElement('span');
    resize.className = 'stats-card-resize';
    resize.title = t('Glisser pour redimensionner');
    resize.setAttribute('aria-hidden', 'true');
    card.append(resize);
    return card;
}

// Contenu d'un corps de carte : le chiffre clé ou l'hôte du graphique.
// Réutilisé par renderAllCharts pour restaurer le conteneur après un état
// « indisponible » affiché à sa place.
function cardBodyContent(spec) {
    if (spec.view.chart === 'number') {
        const number = document.createElement('div');
        number.className = 'stats-number';
        return number;
    }
    const host = document.createElement('div');
    host.className = 'stats-chart';
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', chartTitle(spec));
    return host;
}

// Une source n'a pas pu être chargée : le graphique affiche l'explication et
// une relance plutôt qu'un rendu qui ressemblerait à un vrai zéro.
function unavailableBlock(failed) {
    const box = document.createElement('div');
    box.className = 'stats-card-unavailable';
    const icon = document.createElement('i');
    icon.className = 'ti ti-cloud-off';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('p');
    const names = failed.map((source) => source.startsWith('evolution:')
        ? t('Jeu « ${name} »', { name: datasetName(source.split(':')[1]) })
        : state.labels.sourceLabel(source)).join(' · ');
    text.textContent = t('${names} : données indisponibles', { names });
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-sm btn-outline-secondary stats-card-retry';
    retry.textContent = t('Réessayer');
    const refresh = document.createElement('i');
    refresh.className = 'ti ti-refresh me-1';
    refresh.setAttribute('aria-hidden', 'true');
    retry.prepend(refresh);
    box.append(icon, text, retry);
    return box;
}

export function menuButton(action, icon, label, { danger = false, disabled = false } = {}) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = danger ? 'dropdown-item text-danger' : 'dropdown-item';
    button.dataset.action = action;
    button.disabled = disabled;
    const i = document.createElement('i');
    i.className = `ti ${icon} me-2`;
    i.setAttribute('aria-hidden', 'true');
    button.append(i, document.createTextNode(label));
    li.append(button);
    return li;
}

// « Envoyer en panneau vidéo » : grisé (avec la raison en bulle) quand le
// graphique n'a pas d'équivalent.
function panelMenuButton(spec) {
    const out = panelFromSpec(spec, { title: '' });
    const li = menuButton('to-panel', 'ti-movie', t('Envoyer en panneau vidéo'), { disabled: Boolean(out.error) });
    if (out.error) {
        li.title = out.error === 'several-sources'
            ? t("Un panneau vidéo ne compte qu'une source.")
            : t("Ce graphique n'a pas d'équivalent en panneau vidéo.");
    }
    return li;
}

function cardMenu(spec, index, count) {
    const wrap = document.createElement('div');
    wrap.className = 'dropdown stats-card-menu';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-ghost-secondary btn-icon btn-sm';
    toggle.dataset.bsToggle = 'dropdown';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', t('Actions du graphique'));
    toggle.title = t('Actions du graphique');
    const icon = document.createElement('i');
    icon.className = 'ti ti-dots';
    icon.setAttribute('aria-hidden', 'true');
    toggle.append(icon);
    const menu = document.createElement('ul');
    menu.className = 'dropdown-menu dropdown-menu-end';
    const divider = document.createElement('li');
    divider.innerHTML = '<hr class="dropdown-divider">';
    // Source en échec : pas d'image ni de vidéo à produire.
    const unavailable = chartSources(spec).some((s) => state.sourceErrors.has(s));
    menu.append(
        menuButton('edit', 'ti-pencil', t('Modifier')),
        menuButton('duplicate', 'ti-copy', t('Dupliquer'), { disabled: count >= MAX_ITEMS }),
        menuButton('present', 'ti-presentation', t("Présenter à partir d'ici"), { disabled: unavailable }),
        menuButton('values', 'ti-table', t('Voir les valeurs'), { disabled: unavailable }),
        menuButton('export', 'ti-download', t('Exporter en image (PNG)'), { disabled: unavailable || spec.view.chart === 'number' }),
        menuButton('export-svg', 'ti-vector', t('Exporter en image vectorielle (SVG)'), { disabled: unavailable || spec.view.chart === 'number' }),
        panelMenuButton(spec),
        menuButton('video', 'ti-video', t('Créer une vidéo animée'), { disabled: unavailable || !chartAnimates(spec) }),
        menuButton('before', 'ti-arrow-left', t('Déplacer avant'), { disabled: index === 0 }),
        menuButton('after', 'ti-arrow-right', t('Déplacer après'), { disabled: index === count - 1 }),
        divider,
        menuButton('delete', 'ti-trash', t('Supprimer'), { danger: true }),
    );
    wrap.append(toggle, menu);
    return wrap;
}

// Le résultat ne dépend que de la requête effective et des données : il est
// mémorisé (dataRev invalide à chaque rechargement de source). Le cache est
// borné — l'aperçu de l'éditeur génère une clé par frappe.
const RESULT_CACHE_MAX = 300;

export function computeResult(spec, dashboard) {
    const key = JSON.stringify({ spec, period: dashboard.period, filters: dashboard.filters,
        kind: dashboard.kind, dataset: dashboard.dataset, today: state.today }) + '|' + state.dataRev;
    const cached = state.resultCache.get(key);
    if (cached) {
        // Réinsertion : l'entrée la plus ancienne partira en première.
        state.resultCache.delete(key);
        state.resultCache.set(key, cached);
        return cached;
    }
    const result = runChartQueries(spec, tableOf, {
        ...effectiveQueryOptions(spec, dashboard),
        today: state.today,
        labelOf: (dim, key) => state.labels.axisLabel(dim, key, { attributeName }),
    });
    if (state.resultCache.size >= RESULT_CACHE_MAX) {
        state.resultCache.delete(state.resultCache.keys().next().value);
    }
    state.resultCache.set(key, result);
    return result;
}

export function chartContext() {
    return { labels: state.labels, tokens: state.tokens, typeColors: state.typeColors, attributeName,
        reduceMotion: state.reduceMotion, today: state.today };
}

// Note sous un graphique : ce qui n'est pas compté ou a été coupé.
export function cardNote(result, spec) {
    const notes = [];
    if (spec.groupBy === 'attribute' && result.meta.noAttribute) {
        notes.push(t('Sans attribut : ${n}', { n: result.meta.noAttribute }));
    }
    if (result.truncated) notes.push(t('Seules les 8 périodes les plus récentes sont affichées.'));
    const chart = spec.view.chart;
    if (chart === 'challenge' && result.meta.unknown) {
        const n = result.meta.unknown;
        notes.push(spec.groupBy === 'dt' ? t('Sans D/T : ${n}', { n }) : t('Sans date de publication : ${n}', { n }));
    }
    if ((chart === 'calendar' || chart === 'heatmap' || chart === 'challenge') && result.periods.length > 1) {
        notes.push(t('Seule la première période est dessinée.'));
    }
    if (chart === 'calendar' && calendarYears(result).truncated) {
        notes.push(t('Seules les 3 années les plus récentes sont dessinées.'));
    }
    if (result.toDate) {
        const date = new Intl.DateTimeFormat(state.labels.locale, { day: 'numeric', month: 'long', timeZone: 'UTC' })
            .format(new Date(result.toDate.day * 86400000));
        notes.push(t('Comparaison à date : chaque période est arrêtée au ${date}.', { date }));
    }
    if (!result.meta.rows) notes.push(t('Aucune donnée sur cette période.'));
    return notes.join(' · ');
}

export function renderNumber(container, result, spec, dashboard) {
    const entries = numberModel(result, spec, chartContext());
    container.replaceChildren();
    for (const entry of entries) {
        const block = document.createElement('div');
        block.className = 'stats-number-block';
        const value = document.createElement('div');
        value.className = 'stats-number-value';
        value.textContent = entry.text;
        const caption = document.createElement('div');
        caption.className = 'stats-number-caption';
        const { periods } = effectiveQueryOptions(spec, dashboard);
        caption.textContent = entry.label || state.labels.periodChoiceLabel(periods[0]);
        block.append(value, caption);
        // Record daté : ses jours, et la carte de ces jours-là.
        if (entry.record) {
            const record = document.createElement('div');
            record.className = 'stats-number-record';
            record.textContent = entry.record;
            block.append(record);
            if (chartClickable(spec, result)) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-link btn-sm stats-number-map';
                button.innerHTML = '<i class="ti ti-map me-1" aria-hidden="true"></i>';
                button.append(document.createTextNode(t('Voir sur la carte')));
                const seriesIndex = entries.indexOf(entry);
                button.addEventListener('click', () => confirmMapLink(spec.id, { seriesIndex, keyIndex: 0 }));
                block.append(button);
            }
        }
        if (entry.outlook) block.append(outlookBlock(entry.outlook));
        if (entry.delta) block.append(deltaLine(entry.delta));
        container.append(block);
    }
}

// Objectif (barre de progression) et projection d'un chiffre clé.
function outlookBlock(outlook) {
    const wrap = document.createElement('div');
    wrap.className = 'stats-number-outlook';
    if (outlook.goal) {
        const bar = document.createElement('div');
        bar.className = 'stats-goal';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', String(outlook.goal));
        bar.setAttribute('aria-valuenow', String(Math.min(outlook.value, outlook.goal)));
        bar.setAttribute('aria-valuetext', outlook.progress);
        bar.classList.toggle('is-reached', outlook.reached);
        const fill = document.createElement('div');
        fill.className = 'stats-goal-fill';
        fill.style.width = (outlook.ratio * 100).toFixed(1) + '%';
        bar.append(fill);
        const progress = document.createElement('div');
        progress.className = 'stats-goal-text';
        progress.textContent = outlook.progress;
        wrap.append(bar, progress);
    }
    for (const text of outlook.lines) {
        const line = document.createElement('div');
        line.className = 'stats-goal-line';
        line.textContent = text;
        wrap.append(line);
    }
    return wrap;
}

// « ▲ +12 (+18 %) par rapport à 2025 » : la flèche porte le sens (et sa
// couleur), le texte reste dans les couleurs de texte.
function deltaLine(delta) {
    const line = document.createElement('div');
    line.className = 'stats-number-delta';
    line.classList.add(delta.sign > 0 ? 'is-up' : delta.sign < 0 ? 'is-down' : 'is-flat');
    const icon = document.createElement('i');
    icon.className = `ti ${delta.sign > 0 ? 'ti-trending-up' : delta.sign < 0 ? 'ti-trending-down' : 'ti-minus'}`;
    icon.setAttribute('aria-hidden', 'true');
    const text = delta.ratio ? delta.text + ' (' + delta.ratio + ')' : delta.text;
    line.append(icon, document.createTextNode(' ' + text + ' ' + delta.versus));
    return line;
}

// Les marques d'un graphique ouvrent-elles la carte ? (curseur « main »)
export const TIME_DIMS = new Set(['year', 'quarter', 'month', 'week', 'day']);
export function chartClickable(spec, result) {
    if (!chartLinksToMap(spec) || result.delta) return false;
    // Chiffre clé : seulement un record daté (« Voir sur la carte »).
    if (spec.view.chart === 'number') return spec.measure.op === 'max_per_day' || spec.measure.op === 'streak';
    return !['heatmap', 'radar'].includes(spec.view.chart);
}

// Bilan d'une grille de défi (relevé E2E).
export function challengeSnapshot(result) {
    const text = result?.grid ? challengeText(result, chartContext()) : null;
    if (!text) return null;
    const { filled, available, loops, next } = text.summary;
    return { metric: result.grid.metric, filled, available, loops, next: next.length,
        coverage: text.coverage, tours: text.tours, missing: text.missing };
}

// `fill` : hauteur à prendre quand le graphique n'impose pas la sienne
// (présentation : tout l'écran).
export function renderChartInto(host, result, spec, { fill = 0 } = {}) {
    const width = host.clientWidth || host.parentElement?.clientWidth || 0;
    const option = buildChartOption(result, spec, { ...chartContext(), width });
    if (!chartClickable(spec, result)) {
        for (const series of option.series || []) series.cursor = 'default';
    }
    // Calendrier : un bandeau par année, la carte s'allonge.
    const height = chartHeight(result, spec, width);
    host.style.height = height ? height + 'px' : (fill ? fill + 'px' : '');
    // Les cases du calendrier ont une taille en pixels, calculée sur la
    // largeur : un redimensionnement qui la change impose un nouveau dessin
    // (onHostsResized), pas un simple resize().
    if (spec.view.chart === 'calendar') host.dataset.calendarCell = String(calendarCell(width));
    else delete host.dataset.calendarCell;
    // Grille de défi : cases carrées et centrées sur la largeur dessinée.
    if (spec.view.chart === 'challenge') host.dataset.challengeWidth = String(width);
    else delete host.dataset.challengeWidth;
    let chart = window.echarts.getInstanceByDom(host);
    if (!chart) {
        chart = window.echarts.init(host, null, { locale: echartsLocale(), renderer: 'canvas' });
        chart.on('click', (params) => onChartClick(host, params));
    }
    chart.setOption(option, true);
    chart.resize();
    return chart;
}

// Au-delà de ce nombre de cartes, celles hors écran ne sont dessinées qu'à
// l'approche (le résultat est calculé quand même : exports et relevés exacts).
const DEFER_CHARTS_BEYOND = 12;
const DEFER_MARGIN_PX = 400;

function nearViewport(host) {
    const rect = host.getBoundingClientRect();
    return rect.bottom > -DEFER_MARGIN_PX && rect.top < window.innerHeight + DEFER_MARGIN_PX;
}

// Dessine le contenu d'une carte : bloc « indisponible », chiffre clé ou
// graphique ECharts (différé si la carte est loin de l'écran).
function renderCard(item, card, dashboard) {
    const { spec } = item;
    const body = card.querySelector('.stats-card-body');
    const note = card.querySelector('.stats-card-note');
    const failed = chartSources(spec).filter((s) => state.sourceErrors.has(s));
    if (failed.length) {
        state.results.set(spec.id, { result: null, spec, error: failed });
        state.rendered.delete(spec.id);
        note.hidden = true;
        body.replaceChildren(unavailableBlock(failed));
        return;
    }
    const result = computeResult(spec, dashboard);
    state.results.set(spec.id, { result, spec });
    // Après un état « indisponible », remettre le conteneur attendu.
    if (!body.querySelector('.stats-chart, .stats-number')) {
        body.replaceChildren(cardBodyContent(spec));
    }
    note.textContent = cardNote(result, spec);
    note.hidden = !note.textContent;
    const seen = state.rendered.get(spec.id);
    const fresh = seen?.result === result && seen.tokensRev === state.tokensRev;
    if (spec.view.chart === 'number') {
        if (!fresh) {
            renderNumber(card.querySelector('.stats-number'), result, spec, dashboard);
            state.rendered.set(spec.id, { result, tokensRev: state.tokensRev });
        }
        return;
    }
    const host = card.querySelector('.stats-chart');
    if (state.charts.has(spec.id) && fresh) {
        // Même requête, même thème : l'instance déjà dessinée suffit.
        state.resizeObserver.observe(host);
        return;
    }
    // Grande collection, carte loin de l'écran : dessin différé à l'approche.
    if (!window.echarts.getInstanceByDom(host) && dashboard.items.length > DEFER_CHARTS_BEYOND && !nearViewport(host)) {
        host.classList.add('is-pending');
        state.deferred.add(spec.id);
        state.lazyObserver.observe(host);
        return;
    }
    host.classList.remove('is-pending');
    state.deferred.delete(spec.id);
    state.lazyObserver?.unobserve(host);
    state.charts.set(spec.id, renderChartInto(host, result, spec));
    state.rendered.set(spec.id, { result, tokensRev: state.tokensRev });
    state.resizeObserver.observe(host);
}

export function renderAllCharts() {
    if (!state.tokens) state.tokens = readTokens();
    state.deferred.clear();
    state.lazyObserver?.disconnect();
    state.lazyObserver ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const card = entry.target.closest('.stats-card');
            const item = card && activeDashboard().items.find((i) => i.spec.id === card.dataset.chartId);
            if (item) renderCard(item, card, activeDashboard());
        }
    }, { rootMargin: DEFER_MARGIN_PX + 'px' });
    const dashboard = activeDashboard();
    for (const item of dashboard.items) {
        const card = $('statsGrid').querySelector(cardSelector(item.spec.id));
        if (card) renderCard(item, card, dashboard);
    }
}

// Cartes différées dessinées d'office : export ou impression. Sans
// argument, toutes les cartes différées ; sinon une seule.
export function renderDeferred(onlyId = null) {
    const dashboard = activeDashboard();
    for (const id of [...state.deferred]) {
        if (onlyId && id !== onlyId) continue;
        const card = $('statsGrid').querySelector(cardSelector(id));
        const item = card && dashboard.items.find((i) => i.spec.id === id);
        if (item) renderCard(item, card, dashboard);
    }
}

// Redimensionnement d'un graphique (fenêtre, carte) : ECharts suit la
// nouvelle taille ; un calendrier dont la taille de case change est redessiné
// — au cadre suivant, car le redessin change la hauteur de l'hôte et
// relancerait l'observateur pendant sa propre notification.
const resizedCalendars = new Set();

export function onHostsResized(entries) {
    for (const { target: host } of entries) {
        const drawn = host.dataset.calendarCell;
        const challengeWidth = host.dataset.challengeWidth;
        if ((drawn !== undefined && Number(drawn) !== calendarCell(host.clientWidth))
            || (challengeWidth !== undefined && Number(challengeWidth) !== host.clientWidth)) {
            if (!resizedCalendars.size) requestAnimationFrame(redrawResizedCalendars);
            resizedCalendars.add(host);
            continue;
        }
        window.echarts.getInstanceByDom(host)?.resize();
    }
}

function redrawResizedCalendars() {
    const hosts = [...resizedCalendars];
    resizedCalendars.clear();
    for (const host of hosts) {
        if (!host.isConnected) continue;
        if (host === $('statsEdPreview')) {
            renderPreview();
            continue;
        }
        const id = host.closest('.stats-card')?.dataset.chartId;
        const entry = id && state.results.get(id);
        if (entry?.result) state.charts.set(id, renderChartInto(host, entry.result, entry.spec));
    }
}

