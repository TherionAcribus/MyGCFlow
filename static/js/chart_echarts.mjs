// Adaptateur ECharts de la page Statistiques : jeu de séries (chart_query.mjs)
// + description du graphique → objet d'options ECharts. Module pur (il ne
// charge pas ECharts : il fabrique seulement l'objet passé à setOption),
// testé par tests/js/chart_echarts.test.mjs.
//
//   buildChartOption(result, spec, { labels, tokens, typeColors, attributeName })
//     labels      makeLabels(...) (chart_labels.mjs)
//     tokens      couleurs du thème courant, lues dans stats_page.css :
//                 { text, textMuted, grid, surface, others, unknown, up, down,
//                   empty, heat: [rampe d'une teinte, du plus faible au plus
//                   fort], series: [8 teintes, dans l'ordre fixe de la palette] }
//     typeColors  { 'Traditional Cache': '#008000', … } — mêmes couleurs que
//                 les points de la carte (static/json/defaultGcColors.json)
//
// Le chiffre clé (`number`) n'est pas un graphique ECharts : null, la page
// l'affiche en HTML à partir de numberModel().
//
// Présentations d'une comparaison (spec.compare.layout) :
//   overlay  séries superposées (barres groupées, courbes) dans un repère ;
//   side     un petit graphique par période, même échelle pour tous ;
//   delta    barres de l'écart entre les deux périodes, bleu au-dessus de
//            zéro, rouge en dessous, toujours avec leur signe.
//
// Règles de dessin (marques fines et sobres) : barres de 24 px au plus,
// bout arrondi de 4 px et base carrée ; courbes de 2 px ; aire à 10 %
// d'opacité ; quadrillage d'un pixel, plein ; légende dès deux séries ;
// texte toujours dans les couleurs de texte, jamais dans celle d'une série.
// Case incomplète (mois en cours…) : remplissage atténué, bord en tirets.

import { OTHERS_KEY, UNKNOWN_KEY, ymdOfDay } from './stats_model.mjs';
import { challengeSummary } from './chart_challenge.mjs';
import { niceAxisMax, numberOutlook, projectionValues } from './chart_goal.mjs';

// Au-delà, les étiquettes de valeur sur chaque barre deviennent du bruit.
const MAX_LABELLED_BARS = 24;
// Au-delà, un axe de temps devient zoomable à la molette…
const ZOOM_FROM_KEYS = 60;
// … et, au-delà de celui-ci (jours, semaines), gagne une glissière.
const SLIDER_FROM_KEYS = 400;
// Au-delà, plus de points sur la courbe (le trait suffit).
const MAX_SYMBOL_KEYS = 40;

export function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&#39;')
        .replace(/"/g, '&quot;');
}

// Luminance relative WCAG d'une couleur #rgb / #rrggbb.
function luminance(hex) {
    const raw = String(hex || '').replace('#', '');
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    const channel = (i) => {
        const c = parseInt(full.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    if (la === null || lb === null) return null;
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

// Texte posé sur une case colorée : blanc ou presque noir, le plus lisible
// (dégradé clair en mode sombre).
const DARK_LABEL = '#111827';
export function labelColorOn(color) {
    const white = contrastRatio(color, '#ffffff');
    const dark = contrastRatio(color, DARK_LABEL);
    return white === null || dark === null || white >= dark ? '#ffffff' : DARK_LABEL;
}

// Une couleur de type quasi invisible sur le fond (le blanc des
// « Locationless » sur fond clair) est remplacée par le gris des notes.
function visibleOn(color, tokens) {
    const ratio = contrastRatio(color, tokens.surface);
    return ratio !== null && ratio < 1.4 ? tokens.textMuted : color;
}

// Couleur d'une catégorie : « Autres » et « Inconnu » en gris, types de
// caches aux couleurs de la carte, sinon la teinte de rang `index`.
function categoryColor(dim, key, index, tokens, typeColors) {
    if (key === OTHERS_KEY) return tokens.others;
    if (key === UNKNOWN_KEY) return tokens.unknown;
    if (dim === 'cache_type' && typeColors?.[key]) return visibleOn(typeColors[key], tokens);
    return tokens.series[index % tokens.series.length];
}

// Teinte de chaque clé de l'axe, dans l'ordre de l'axe : la même clé garde
// la même couleur d'un graphique côte à côte à l'autre. `palette` :
//   multi  une teinte de la palette par clé (types compris) ;
//   gc / auto  couleurs de la carte pour les types, sinon une teinte par clé.
function keyColors(result, ctx, palette = 'auto') {
    let index = 0;
    const typeColors = palette === 'multi' ? null : ctx.typeColors;
    return result.keys.map((key) => {
        const special = key === OTHERS_KEY || key === UNKNOWN_KEY;
        return categoryColor(result.dim, key, special ? 0 : index++, ctx.tokens, typeColors);
    });
}

// Couleurs par barre d'une série seule (null : une seule teinte pour toutes).
//   auto / gc  types de caches aux couleurs de la carte ; autres catégories
//              d'une seule teinte (l'axe les nomme), « Autres » / « Inconnu »
//              en gris ;
//   multi      une teinte par clé ;
//   heat       dégradé selon la valeur ;
//   accent     une seule teinte, sans exception.
function barColors(result, spec, ctx, values) {
    const palette = spec.view.palette;
    if (palette === 'accent') return null;
    if (palette === 'heat') {
        // Sans le premier pas : une barre proche de zéro resterait visible.
        const ramp = ctx.tokens.heat.length > 2 ? ctx.tokens.heat.slice(1) : ctx.tokens.heat;
        const max = Math.max(0, ...values.map((v) => v ?? 0));
        return values.map((v) => rampColor(ramp, max ? (v ?? 0) / max : 0));
    }
    if (palette === 'multi') return keyColors(result, ctx, 'multi');
    if (result.kind !== 'category') return null;
    if (result.dim === 'cache_type') return keyColors(result, ctx, 'gc');
    const base = ctx.tokens.series[0];
    return result.keys.map((key) => (key === OTHERS_KEY ? ctx.tokens.others : key === UNKNOWN_KEY ? ctx.tokens.unknown : base));
}

// Nom d'une série sans 2ᵉ dimension : sa source quand le graphique en
// compare plusieurs, sa période quand il en compare plusieurs (sauf côte à
// côte, où chaque repère porte déjà la sienne), sinon la mesure.
export function seriesName(result, s, spec, labels, { withPeriod = true } = {}) {
    const parts = [];
    if ((result.sources?.length || 1) > 1) parts.push(labels.sourceNoun(s.source));
    if (withPeriod && result.periods.length > 1) parts.push(labels.seriesPeriodLabel(result.periods[s.periodIndex]));
    return parts.length ? parts.join(' · ') : labels.measureName(spec.measure, spec.source);
}

// Nom et couleur de chaque série. Une série par période, par source et, le
// cas échéant, par valeur de la 2ᵉ dimension — la couleur suit cette valeur
// (ou la période, ou la source), jamais le rang d'affichage. Exporté pour
// le tableau « Voir les valeurs » (mêmes noms que la légende).
export function seriesIdentity(result, spec, ctx, { side = false } = {}) {
    const { labels, tokens, typeColors, attributeName } = ctx;
    const multiSource = (result.sources?.length || 1) > 1;
    const periods = result.periods.length;
    let splitIndex = 0;
    const splitColors = new Map();
    return result.series.map((s) => {
        if (s.split === null) {
            const index = multiSource ? (s.sourceIndex || 0) * periods + s.periodIndex : s.periodIndex;
            return {
                name: seriesName(result, s, spec, labels, { withPeriod: !side }),
                color: tokens.series[index % tokens.series.length],
            };
        }
        if (!splitColors.has(s.split)) {
            const special = s.split === OTHERS_KEY || s.split === UNKNOWN_KEY || spec.splitBy === 'cache_type';
            splitColors.set(s.split, categoryColor(spec.splitBy, s.split, special ? 0 : splitIndex++, tokens, typeColors));
        }
        const splitName = labels.axisLabel(spec.splitBy, s.split, { attributeName });
        const prefix = [];
        if (multiSource) prefix.push(labels.sourceNoun(s.source));
        if (periods > 1 && !side) prefix.push(labels.seriesPeriodLabel(result.periods[s.periodIndex]));
        return { name: [...prefix, splitName].join(' · '), color: splitColors.get(s.split) };
    });
}

// Libellés de l'axe des clés : rang « depuis le début » (Mois 1…) ou clé.
export function axisLabels(result, ctx, { long = false } = {}) {
    return result.keys.map((key) => (result.align === 'elapsed'
        ? ctx.labels.elapsedLabel(result.elapsedUnit, key)
        : ctx.labels.axisLabel(result.dim, key, { long, attributeName: ctx.attributeName })));
}

const valueFormatter = (spec, result, ctx, options = {}) => (v) => ctx.labels.formatValue(v, spec.measure, {
    normalize: result.normalize, ...options,
});

function tooltipBase(tokens) {
    return {
        backgroundColor: tokens.surface,
        borderColor: tokens.grid,
        borderWidth: 1,
        textStyle: { color: tokens.text, fontSize: 12 },
        extraCssText: 'box-shadow: 0 4px 14px rgba(0,0,0,0.18); border-radius: 8px;',
        confine: true,
    };
}

function marker(color) {
    return `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;background:${color}"></span>`;
}

// Infobulle d'axe : clé en toutes lettres puis une ligne par série — avec,
// sur un axe « depuis le début », la vraie date de chaque série, et la
// mention « en cours » pour une case incomplète.
function axisTooltipFormatter(result, spec, ctx, identities) {
    const { labels } = ctx;
    const heads = axisLabels(result, ctx, { long: true });
    const format = valueFormatter(spec, result, ctx);
    const ongoing = labels.t('en cours');
    return (params) => {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return '';
        const i = list[0].dataIndex;
        const rows = list.filter((p) => {
            // Projection : seulement là où elle a une valeur.
            if (p.seriesIndex < result.series.length) return true;
            const raw = typeof p.value === 'object' && p.value !== null ? p.value.value : p.value;
            return raw !== null && raw !== undefined && raw !== '-';
        }).map((p) => {
            const identity = identities[p.seriesIndex] || {};
            const s = result.series[p.seriesIndex];
            const raw = typeof p.value === 'object' && p.value !== null ? p.value.value : p.value;
            const color = typeof p.color === 'string' ? p.color : identity.color;
            const notes = [];
            if (s?.dates?.[i] !== null && s?.dates?.[i] !== undefined) notes.push(labels.dateInUnit(result.elapsedUnit, s.dates[i]));
            if (s && s.partial === i) notes.push(ongoing);
            // Record daté : ses jours (« du 3 au 25 juil. 2024 »).
            if (s?.records?.[i]) notes.push(labels.recordText(s.records[i]));
            const note = notes.length ? ` <span style="opacity:.7">(${escapeHtml(notes.join(', '))})</span>` : '';
            const name = identities.length > 1 ? `${escapeHtml(identity.name)} : ` : '';
            return `<div>${marker(color)}${name}<b>${escapeHtml(format(raw))}</b>${note}</div>`;
        });
        return `<div style="margin-bottom:4px;font-weight:600">${escapeHtml(heads[i] ?? '')}</div>${rows.join('')}`;
    };
}

function axisStyle(tokens) {
    return {
        axisLine: { show: true, lineStyle: { color: tokens.grid } },
        axisTick: { show: false },
        axisLabel: { color: tokens.textMuted, hideOverlap: true },
        splitLine: { show: false },
    };
}

function valueAxis(spec, result, ctx, { log = false, max = undefined, gridIndex = undefined, signed = false } = {}) {
    const { tokens, labels } = ctx;
    const compact = signed
        ? (v) => labels.formatDelta(v, spec.measure, result.normalize)
        : valueFormatter(spec, result, ctx, { compact: true });
    return {
        type: log ? 'log' : 'value',
        gridIndex,
        max,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: tokens.textMuted, formatter: compact },
        splitLine: { lineStyle: { color: tokens.grid, width: 1, type: 'solid' } },
        // Une moyenne de D/T ne descend pas sous 1 : pas d'axe forcé à zéro.
        scale: spec.measure.op === 'mean' && spec.measure.field !== 'age' && result.normalize === 'none',
        minInterval: spec.measure.op === 'mean' || result.normalize !== 'none' ? 0 : 1,
    };
}

function legendOption(tokens, extra = {}) {
    return {
        type: 'scroll',
        top: 0,
        left: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 12,
        textStyle: { color: tokens.textMuted },
        pageTextStyle: { color: tokens.textMuted },
        ...extra,
    };
}

function common(ctx, showLegend) {
    const { tokens } = ctx;
    return {
        // « Réduire les animations » : les graphiques sont posés d'un coup.
        animationDuration: ctx.reduceMotion ? 0 : 400,
        animationDurationUpdate: ctx.reduceMotion ? 0 : 300,
        backgroundColor: 'transparent',
        // Police de la page (stats_page_state.js › readTokens) : un canvas refuse
        // « inherit » et retombait sur 10 px sans-serif, quelle que soit la
        // taille demandée.
        textStyle: { color: tokens.text, fontFamily: tokens.font || 'sans-serif' },
        aria: { enabled: true },
        legend: showLegend ? legendOption(tokens) : { show: false },
    };
}

// Case incomplète : remplissage atténué, bord en tirets de la même teinte.
function partialStyle(color) {
    return { opacity: 0.45, borderColor: color, borderWidth: 1, borderType: 'dashed' };
}

// Record mis en avant (`view.record`) : une épingle sur la plus grande
// valeur (la première à égalité), qui porte cette valeur.
export function recordIndex(values) {
    let best = -1;
    values.forEach((v, i) => {
        if (v !== null && v !== undefined && v > 0 && (best < 0 || v > values[best])) best = i;
    });
    return best;
}

function recordMark(s, ctx, spec, result, horizontal, color) {
    const k = recordIndex(s.values);
    if (k < 0) return undefined;
    const v = s.values[k];
    return {
        symbol: 'pin',
        symbolSize: 46,
        silent: true,
        itemStyle: { color },
        label: {
            color: labelColorOn(color),
            fontSize: 11,
            fontWeight: 600,
            formatter: () => ctx.labels.formatValue(v, spec.measure, { compact: true, normalize: result.normalize }),
        },
        data: [{ coord: horizontal ? [v, k] : [k, v], value: v }],
    };
}

// Série ECharts d'une série de résultat (barre ou courbe).
function seriesOption(s, identity, result, spec, ctx, { chart, horizontal, stacked, single, perItem, axisIndex }) {
    const { tokens, labels } = ctx;
    const log = spec.view.log;
    const colors = perItem ? barColors(result, spec, ctx, s.values) : null;
    const data = s.values.map((value, k) => {
        const v = log && value !== null && value <= 0 ? null : value;
        const color = colors ? colors[k] : identity.color;
        if (!colors && k !== s.partial) return v;
        const itemStyle = { color };
        if (k === s.partial && chart === 'bar') Object.assign(itemStyle, partialStyle(color));
        return { value: v, itemStyle };
    });
    const base = { name: identity.name, data, color: identity.color, ...axisIndex };
    if (spec.view.record && single && !stacked) base.markPoint = recordMark(s, ctx, spec, result, horizontal, identity.color);
    const labelFormatter = (p) => labels.formatValue(typeof p.value === 'object' ? p.value?.value : p.value, spec.measure, {
        compact: true, normalize: result.normalize,
    });
    if (chart === 'bar') {
        return {
            ...base,
            type: 'bar',
            barMaxWidth: 24,
            stack: stacked ? `total${axisIndex?.xAxisIndex ?? ''}` : undefined,
            itemStyle: {
                borderRadius: stacked ? 0 : (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]),
                borderColor: stacked ? tokens.surface : undefined,
                borderWidth: stacked ? 1 : 0,
            },
            label: spec.view.labels && result.keys.length <= MAX_LABELLED_BARS && !stacked ? {
                show: true,
                position: horizontal ? 'right' : 'top',
                color: tokens.textMuted,
                fontSize: 11,
                formatter: labelFormatter,
            } : { show: false },
            emphasis: { focus: single ? 'none' : 'series' },
        };
    }
    const showSymbol = result.keys.length <= MAX_SYMBOL_KEYS;
    return {
        ...base,
        type: 'line',
        smooth: spec.view.smooth,
        stack: stacked ? `total${axisIndex?.xAxisIndex ?? ''}` : undefined,
        connectNulls: false,
        showSymbol,
        symbol: 'circle',
        symbolSize: 8,
        itemStyle: { borderColor: tokens.surface, borderWidth: 2 },
        lineStyle: { width: 2, cap: 'round', join: 'round' },
        areaStyle: chart === 'area' ? { opacity: 0.1 } : undefined,
        label: spec.view.labels && showSymbol ? {
            show: true,
            position: 'top',
            color: tokens.textMuted,
            fontSize: 11,
            formatter: labelFormatter,
        } : { show: false },
        emphasis: { focus: single ? 'none' : 'series' },
    };
}

function categoryAxis(result, ctx, { isBar, horizontal, gridIndex }) {
    return {
        type: 'category',
        gridIndex,
        data: axisLabels(result, ctx),
        boundaryGap: isBar,
        inverse: horizontal,
        ...axisStyle(ctx.tokens),
    };
}

function axisTooltip(result, spec, ctx, identities, isBar) {
    return {
        ...tooltipBase(ctx.tokens),
        trigger: 'axis',
        axisPointer: isBar
            ? { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,0.10)' } }
            : { type: 'line', lineStyle: { color: ctx.tokens.textMuted, width: 1 } },
        formatter: axisTooltipFormatter(result, spec, ctx, identities),
    };
}

function zoomOption(result, tokens) {
    // Axes « longs » : le temps, en dates réelles ou depuis le début.
    if (result.kind !== 'time' && result.align !== 'elapsed') return null;
    if (result.keys.length <= ZOOM_FROM_KEYS) return null;
    const zoom = [{ type: 'inside' }];
    if (result.keys.length > SLIDER_FROM_KEYS) {
        zoom.push({
            type: 'slider',
            height: 16,
            bottom: 6,
            borderColor: tokens.grid,
            fillerColor: 'rgba(127,127,127,0.15)',
            handleStyle: { color: tokens.surface, borderColor: tokens.textMuted },
            moveHandleSize: 0,
            textStyle: { color: tokens.textMuted },
            dataBackground: { lineStyle: { color: tokens.textMuted }, areaStyle: { color: tokens.grid } },
        });
    }
    return zoom;
}

// Barres ou courbes, séries superposées dans un même repère.
function overlayOption(result, spec, ctx) {
    const { tokens } = ctx;
    const chart = spec.view.chart === 'bar' ? 'bar' : spec.view.chart;
    const isBar = chart === 'bar';
    const horizontal = isBar && spec.view.orientation === 'horizontal';
    const identities = seriesIdentity(result, spec, ctx);
    const single = identities.length === 1;
    const stacked = spec.view.stack && identities.length > 1;
    // Une série seule : couleurs par barre selon la palette (types aux
    // couleurs de la carte, « Autres » / « Inconnu » en gris…).
    const perItem = single && isBar;
    const zoom = zoomOption(result, tokens);
    const slider = zoom && zoom.length > 1;

    const series = result.series.map((s, i) => seriesOption(s, identities[i], result, spec, ctx, {
        chart, horizontal, stacked, single, perItem,
    }));
    // Projection et objectif (courbe de cumul) : courbes prolongées en
    // tirets, ligne de l'objectif, axe qui les contient.
    const tooltipIdentities = [...identities];
    const goal = spec.goal?.value ?? null;
    let reach = goal ?? 0;
    if (spec.view.projection && !stacked && ctx.today !== null && ctx.today !== undefined) {
        result.series.forEach((s, i) => {
            const values = projectionValues(result, s, ctx.today);
            if (!values) return;
            reach = Math.max(reach, ...values.filter((v) => v !== null));
            const color = identities[i].color;
            const name = identities[i].name + ' — ' + ctx.labels.t('à ce rythme');
            tooltipIdentities.push({ name, color });
            series.push({
                type: 'line', name, data: values, color, silent: true, showSymbol: false, symbol: 'none',
                lineStyle: { width: 2, type: 'dashed', color }, connectNulls: true, z: 1,
                emphasis: { disabled: true },
            });
        });
    }
    if (goal && series[0]) {
        series[0].markLine = {
            silent: true,
            symbol: 'none',
            lineStyle: { type: 'dashed', color: tokens.text, width: 1 },
            label: { position: 'insideEndTop', color: tokens.text, formatter: () => ctx.labels.t('Objectif : ${n}', { n: ctx.labels.formatValue(goal, spec.measure) }) },
            data: [{ yAxis: goal }],
        };
    }
    const keys = categoryAxis(result, ctx, { isBar, horizontal });
    const values = valueAxis(spec, result, ctx, {
        log: spec.view.log,
        // L'objectif et la fin projetée restent dans le cadre.
        max: reach ? (extent) => niceAxisMax(Math.max(extent.max, reach)) : undefined,
    });
    const option = {
        ...common(ctx, identities.length > 1),
        grid: {
            left: 8,
            // Barres horizontales : place de l'étiquette de valeur ; courbe :
            // la dernière date est centrée sur le bord droit.
            right: horizontal ? 32 : (isBar ? 16 : 36),
            // Record épinglé au-dessus de la plus haute valeur : place pour
            // l'épingle.
            // Objectif : place pour son étiquette, au-dessus de la ligne.
            top: Math.max(identities.length > 1 ? 36 : (spec.view.record && !horizontal ? 52 : 16), goal ? 34 : 0),
            bottom: slider ? 40 : 8,
            containLabel: true,
        },
        tooltip: axisTooltip(result, spec, ctx, tooltipIdentities, isBar),
        xAxis: horizontal ? values : keys,
        yAxis: horizontal ? keys : values,
        series,
    };
    if (zoom) option.dataZoom = zoom;
    return option;
}

// Répartition de n petits graphiques : au plus 4 par ligne.
function sideCells(n) {
    const cols = n <= 4 ? n : Math.ceil(n / 2);
    const rows = Math.ceil(n / cols);
    return Array.from({ length: n }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), cols, rows }));
}

// Un petit graphique par période, même échelle pour tous.
function sideOption(result, spec, ctx) {
    const { tokens, labels } = ctx;
    const chart = spec.view.chart;
    const isBar = chart === 'bar';
    const horizontal = isBar && spec.view.orientation === 'horizontal';
    const identities = seriesIdentity(result, spec, ctx, { side: true });
    const stacked = spec.view.stack && Boolean(spec.splitBy);
    const splits = Boolean(spec.splitBy);
    const perItem = !splits && isBar;
    const cells = sideCells(result.periods.length);
    const max = sharedMax(result, stacked);
    const legendHeight = splits ? 8 : 0;

    const grids = [];
    const titles = [];
    const xAxis = [];
    const yAxis = [];
    for (const [i, cell] of cells.entries()) {
        const width = 100 / cell.cols;
        const height = (100 - legendHeight) / cell.rows;
        const top = legendHeight + cell.row * height;
        grids.push({
            left: `${cell.col * width + 1}%`,
            width: `${width - 2}%`,
            top: `${top + 10}%`,
            height: `${height - 14}%`,
            containLabel: true,
        });
        titles.push({
            text: labels.seriesPeriodLabel(result.periods[i]),
            left: `${cell.col * width + width / 2}%`,
            top: `${top}%`,
            textAlign: 'center',
            textStyle: { fontSize: 12, fontWeight: 600, color: tokens.textMuted },
        });
        const keys = categoryAxis(result, ctx, { isBar, horizontal, gridIndex: i });
        const values = valueAxis(spec, result, ctx, { log: spec.view.log, max: spec.view.log ? undefined : max, gridIndex: i });
        xAxis.push(horizontal ? values : keys);
        yAxis.push(horizontal ? keys : values);
    }
    const series = result.series.map((s, k) => seriesOption(s, identities[k], result, spec, ctx, {
        chart: isBar ? 'bar' : chart,
        horizontal,
        stacked,
        single: !splits,
        perItem,
        axisIndex: { xAxisIndex: s.periodIndex, yAxisIndex: s.periodIndex },
    }));
    return {
        ...common(ctx, false),
        legend: splits ? legendOption(tokens, { data: [...new Set(identities.map((d) => d.name))] }) : { show: false },
        title: titles,
        grid: grids,
        tooltip: axisTooltip(result, spec, ctx, identities, isBar),
        xAxis,
        yAxis,
        series,
    };
}

// Plus grande valeur affichée (empilée : plus grande somme), pour donner
// la même échelle à tous les petits graphiques.
function sharedMax(result, stacked) {
    let max = 0;
    if (stacked) {
        const sums = new Map();
        for (const s of result.series) {
            s.values.forEach((v, i) => {
                const key = `${s.periodIndex}:${i}`;
                sums.set(key, (sums.get(key) || 0) + (v || 0));
            });
        }
        for (const v of sums.values()) max = Math.max(max, v);
    } else {
        for (const s of result.series) for (const v of s.values) if (v !== null) max = Math.max(max, v);
    }
    return max > 0 ? max : undefined;
}

// Écart entre deux périodes : une barre par clé, bleue au-dessus de zéro,
// rouge en dessous ; l'infobulle donne les deux valeurs.
function deltaOption(result, spec, ctx) {
    const { tokens, labels } = ctx;
    const horizontal = spec.view.chart === 'bar' && spec.view.orientation === 'horizontal';
    // Deux périodes d'une source, ou une période de deux sources.
    const nameA = seriesName(result, result.series[0], spec, labels);
    const nameB = seriesName(result, result.series[1], spec, labels);
    const heads = axisLabels(result, ctx, { long: true });
    const format = valueFormatter(spec, result, ctx);
    const data = result.delta.values.map((v) => ({
        value: v,
        itemStyle: {
            color: v !== null && v < 0 ? tokens.down : tokens.up,
            borderRadius: v !== null && v < 0
                ? (horizontal ? [4, 0, 0, 4] : [0, 0, 4, 4])
                : (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]),
        },
    }));
    const keys = categoryAxis(result, ctx, { isBar: true, horizontal });
    const values = valueAxis(spec, result, ctx, { signed: true });
    const caption = labels.t('Écart : ${a} par rapport à ${b}', { a: nameA, b: nameB });
    return {
        ...common(ctx, false),
        title: {
            text: caption,
            left: 0,
            top: 0,
            textStyle: { fontSize: 12, fontWeight: 500, color: tokens.textMuted },
        },
        grid: { left: 8, right: horizontal ? 40 : 16, top: 32, bottom: 8, containLabel: true },
        tooltip: {
            ...tooltipBase(tokens),
            trigger: 'axis',
            axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,0.10)' } },
            formatter: (params) => {
                const list = Array.isArray(params) ? params : [params];
                const i = list[0]?.dataIndex;
                if (i === undefined) return '';
                const va = result.series[0].values[i];
                const vb = result.series[1].values[i];
                const d = result.delta.values[i];
                const ratio = labels.formatRatio(result.delta.ratios[i]);
                const lines = [
                    `<div style="margin-bottom:4px;font-weight:600">${escapeHtml(heads[i] ?? '')}</div>`,
                    `<div>${marker(tokens.series[0])}${escapeHtml(nameA)} : <b>${escapeHtml(format(va))}</b></div>`,
                    `<div>${marker(tokens.series[1])}${escapeHtml(nameB)} : <b>${escapeHtml(format(vb))}</b></div>`,
                    `<div style="margin-top:4px">${marker(d !== null && d < 0 ? tokens.down : tokens.up)}${escapeHtml(labels.t('Écart'))} : <b>${escapeHtml(labels.formatDelta(d, spec.measure, result.normalize))}</b>${ratio ? ' (' + escapeHtml(ratio) + ')' : ''}</div>`,
                ];
                return lines.join('');
            },
        },
        xAxis: horizontal ? values : keys,
        yAxis: horizontal ? keys : values,
        series: [{
            type: 'bar',
            name: labels.t('Écart'),
            barMaxWidth: 24,
            data,
            label: spec.view.labels && result.keys.length <= MAX_LABELLED_BARS ? {
                show: true,
                position: horizontal ? 'right' : 'top',
                color: tokens.textMuted,
                fontSize: 11,
                formatter: (p) => labels.formatDelta(p.value?.value ?? p.value, spec.measure, result.normalize),
            } : { show: false },
            markLine: {
                silent: true,
                symbol: 'none',
                label: { show: false },
                lineStyle: { color: tokens.textMuted, width: 1, type: 'solid' },
                data: [horizontal ? { xAxis: 0 } : { yAxis: 0 }],
            },
        }],
    };
}

// Anneau(x) : un par période, côte à côte ; chaque catégorie garde sa
// teinte d'un anneau à l'autre.
function donutOption(result, spec, ctx) {
    const { tokens, labels } = ctx;
    const colors = keyColors(result, ctx, spec.view.palette === 'multi' ? 'multi' : 'gc');
    const pct = new Intl.NumberFormat(labels.locale, { style: 'percent', maximumFractionDigits: 1 });
    const n = result.series.length;
    const format = valueFormatter(spec, result, ctx);
    const outer = Math.min(72, Math.round((100 / Math.max(1, n)) * 1.5));
    const inner = Math.round(outer * 0.66);
    const legendNames = new Set();
    const series = result.series.map((s, i) => {
        const data = result.keys
            .map((key, k) => ({ key, k, value: s.values[k] }))
            .filter((d) => d.value > 0)
            .map((d) => {
                const name = labels.axisLabel(result.dim, d.key, { attributeName: ctx.attributeName });
                legendNames.add(name);
                return { name, value: d.value, keyIndex: d.k, itemStyle: { color: colors[d.k] } };
            });
        const total = data.reduce((sum, d) => sum + d.value, 0);
        const single = n === 1;
        return {
            type: 'pie',
            name: seriesName(result, s, spec, labels),
            radius: [`${single ? 48 : inner}%`, `${single ? 72 : outer}%`],
            center: single
                ? (data.length > 1 ? ['38%', '50%'] : ['50%', '50%'])
                : [`${((i + 0.5) / n) * 100}%`, '52%'],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: tokens.surface, borderWidth: 2, borderRadius: 4 },
            label: spec.view.labels ? {
                show: true,
                color: tokens.textMuted,
                formatter: (p) => pct.format(total ? p.value / total : 0),
            } : { show: false },
            labelLine: { show: spec.view.labels },
            data,
            total,
        };
    });
    const totals = series.map((s) => s.total);
    for (const s of series) delete s.total;
    const single = n === 1;
    const option = {
        ...common(ctx, false),
        legend: legendNames.size > 1 ? legendOption(tokens, single
            ? { orient: 'vertical', right: 0, left: undefined, top: 'middle' }
            : { bottom: 0, top: undefined }) : { show: false },
        tooltip: {
            ...tooltipBase(tokens),
            trigger: 'item',
            formatter: (p) => {
                const total = totals[p.seriesIndex] || 0;
                const head = single ? '' : `<div style="margin-bottom:4px;font-weight:600">${escapeHtml(p.seriesName)}</div>`;
                return `${head}${marker(p.color)}${escapeHtml(p.name)} : <b>${escapeHtml(format(p.value))}</b> (${escapeHtml(pct.format(total ? p.value / total : 0))})`;
            },
        },
        series,
    };
    if (!single) {
        option.title = series.map((s, i) => ({
            text: s.name,
            left: `${((i + 0.5) / n) * 100}%`,
            top: 0,
            textAlign: 'center',
            textStyle: { fontSize: 12, fontWeight: 600, color: tokens.textMuted },
        }));
    }
    return option;
}

// Clic sur une marque (barre, point, part, case) → { seriesIndex, keyIndex }
// dans le résultat, ou null (écart, chaleur, radar : pas une valeur d'une
// série). `params` : l'événement « click » d'ECharts.
export function clickTarget(result, spec, params) {
    if (!params || params.componentType !== 'series') return null;
    const chart = spec.view.chart;
    if (chart === 'number' || chart === 'heatmap' || chart === 'radar' || result.delta) return null;
    if (chart === 'map') {
        const keyIndex = result.keys.indexOf(params.name);
        return keyIndex < 0 ? null : { seriesIndex: params.seriesIndex, keyIndex };
    }
    if (chart === 'donut' || chart === 'challenge') {
        // Grille de défi : une case vide n'a rien à montrer sur la carte.
        if (chart === 'challenge' && !params.value?.[2]) return null;
        const keyIndex = params.data?.keyIndex;
        return Number.isInteger(keyIndex) ? { seriesIndex: params.seriesIndex, keyIndex } : null;
    }
    if (chart === 'calendar') {
        const iso = Array.isArray(params.value) ? params.value[0] : null;
        if (typeof iso !== 'string') return null;
        const day = Date.parse(iso + 'T00:00:00Z') / 86400000;
        const days = result.align === 'elapsed' ? (result.series[0]?.dates || []) : result.keys;
        const keyIndex = days.indexOf(day);
        return keyIndex < 0 ? null : { seriesIndex: 0, keyIndex };
    }
    if (!result.series[params.seriesIndex] || !Number.isInteger(params.dataIndex)) return null;
    return { seriesIndex: params.seriesIndex, keyIndex: params.dataIndex };
}

// ---------------------------------------------------------------------------
// Carte par zones (chart_zones.mjs)
// ---------------------------------------------------------------------------
//
// `ctx.zoneMap` (stats_page_geo.js) : { name, bounds, nameOf(id),
// levelNoun(n) } quand les contours sont prêts — `name` est la carte
// enregistrée dans ECharts (registerMap), `bounds` le cadrage
// ([[ouest, nord], [est, sud]], null = toute la carte) ; sinon
// { loading: true } ou { error: true }.

// Mesures dont les valeurs s'additionnent (total sous chaque vignette) et
// sont entières (classes « 4–7 » plutôt que « 4 – 8 »).
const ZONE_ADDITIVE = ['count', 'cumulative', 'active'];
const ZONE_INTEGER = ['count', 'cumulative', 'active', 'distinct', 'dt_coverage'];

// Classes de la légende : couleur et libellé, du plus faible au plus fort.
export function zoneLegend(result, spec, ctx) {
    const { tokens, labels } = ctx;
    const { breaks, classes, min, max, mode } = result.zones.scale;
    const ramp = tokens.heat.length > 2 ? tokens.heat.slice(1) : tokens.heat;
    const integer = ZONE_INTEGER.includes(spec.measure.op) && result.normalize === 'none';
    const fmt = (v) => labels.formatValue(v, spec.measure, { compact: true, normalize: result.normalize, bare: true });
    const unit = labels.valueUnit(spec.measure, result.normalize);
    const year = (day) => ymdOfDay(day).y;
    const out = Array.from({ length: classes }, (_, c) => {
        const lower = c === 0 ? null : breaks[c - 1];
        const upper = c === classes - 1 ? null : breaks[c];
        const lo = lower ?? min;
        let label;
        if (min === null) label = '';
        else if (mode === 'year') {
            const a = year(lo);
            const b = upper === null ? year(max) : year(upper) - 1;
            label = a === b ? String(a) : `${a}–${b}`;
        } else if (integer) {
            // Borne non entière (échelle linéaire, log) : [3,33 ; 5,67[ = 4–5.
            const a = c === 0 ? min : Math.ceil(lo);
            const b = upper === null ? max : Math.ceil(upper) - 1;
            label = a >= b ? fmt(a) : `${fmt(a)}–${fmt(b)}`;
        } else {
            label = `${fmt(lo)} – ${fmt(upper ?? max)}`;
        }
        return { lower, upper, label, color: rampColor(ramp, classes === 1 ? 1 : c / (classes - 1)) };
    });
    if (unit && out.length && out.at(-1).label) out.at(-1).label += ' ' + unit;
    return out;
}

function zoneTooltip(result, spec, ctx, zm) {
    const { labels } = ctx;
    const nameOf = zm?.nameOf || ((id) => id);
    const fmt = valueFormatter(spec, result, ctx);
    const rank = result.series.map((s) => {
        const order = s.values.map((v, i) => [v, i]).filter(([v]) => v !== null).sort((a, b) => b[0] - a[0]);
        const out = new Map();
        order.forEach(([, i], r) => out.set(i, r + 1));
        return { of: order.length, at: out };
    });
    return {
        ...tooltipBase(ctx.tokens),
        trigger: 'item',
        formatter: (params) => {
            const k = result.keys.indexOf(params.name);
            const s = result.series[params.seriesIndex];
            const head = `<div style="font-weight:600;margin-bottom:2px">${escapeHtml(nameOf(params.name))}</div>`;
            if (k < 0 || !s || s.values[k] === null) return head + escapeHtml(labels.t('Aucune donnée'));
            const lines = [`<b>${escapeHtml(fmt(s.values[k]))}</b>`];
            const r = rank[params.seriesIndex];
            if (r.of > 1 && spec.measure.op !== 'first_day') {
                lines.push(escapeHtml(labels.t('rang ${n} sur ${of}', { n: r.at.get(k), of: r.of })));
            }
            const prev = params.seriesIndex > 0 ? result.series[params.seriesIndex - 1].values[k] : undefined;
            if (prev !== undefined && spec.measure.op !== 'first_day') {
                const since = labels.seriesPeriodLabel(result.periods[params.seriesIndex - 1]);
                lines.push(escapeHtml(prev === null
                    ? labels.t('nouvelle depuis ${period}', { period: since })
                    : labels.t('${delta} depuis ${period}', {
                        delta: labels.formatDelta(s.values[k] - prev, spec.measure, result.normalize), period: since,
                    })));
            }
            return head + lines.join('<br>');
        },
    };
}

function mapPlaceholder(ctx, text) {
    return {
        ...common(ctx, false),
        title: { text, left: 'center', top: 'middle', textStyle: { color: ctx.tokens.textMuted, fontSize: 13, fontWeight: 400 } },
        series: [],
    };
}

// Une vignette par période (ou moment), même échelle pour toutes ; la
// légende des classes en bas.
function mapOption(result, spec, ctx) {
    const { tokens, labels } = ctx;
    const zm = ctx.zoneMap || ctx.zoneMapOf?.(result, spec);
    if (zm?.error) return mapPlaceholder(ctx, labels.t('Contours des zones indisponibles.'));
    if (!zm?.name) return mapPlaceholder(ctx, labels.t('Chargement de la carte…'));
    const legend = zoneLegend(result, spec, ctx);
    const cells = sideCells(Math.max(1, result.series.length));
    const many = result.series.length > 1;
    const legendBand = 12;
    const titleBand = many ? 13 : 0;
    const highlight = spec.view.map?.highlight !== false;
    const additive = ZONE_ADDITIVE.includes(spec.measure.op) && result.normalize === 'none';
    const geo = [];
    const titles = [];
    const series = result.series.map((s, i) => {
        const cell = cells[i];
        const width = 100 / cell.cols;
        const height = (100 - legendBand) / cell.rows;
        const top = cell.row * height;
        geo.push({
            map: zm.name,
            roam: false,
            ...(zm.aspectScale ? { aspectScale: zm.aspectScale } : {}),
            left: `${cell.col * width + 1}%`,
            top: `${top + titleBand}%`,
            width: `${width - 2}%`,
            height: `${height - titleBand - 2}%`,
            ...(zm.bounds ? { boundingCoords: zm.bounds } : {}),
            itemStyle: { areaColor: tokens.empty, borderColor: tokens.grid, borderWidth: 0.6 },
            emphasis: { label: { show: false }, itemStyle: { areaColor: tokens.empty, borderColor: tokens.text, borderWidth: 1.2 } },
            select: { disabled: true },
            // Zones qui ont changé depuis la vignette précédente : contour.
            regions: highlight ? s.changed.map((name) => ({
                name, itemStyle: { borderColor: tokens.text, borderWidth: 1.4 },
            })) : [],
        });
        if (many) {
            const count = s.values.filter((v) => v !== null).length;
            const total = s.values.reduce((sum, v) => sum + (v || 0), 0);
            const sub = zm.levelNoun ? zm.levelNoun(count) : String(count);
            // « zones : 5 · Trouvailles : 6 »
            const noun = spec.measure.op === 'active' ? labels.measureName(spec.measure, spec.source) : labels.sourceNoun(spec.source);
            titles.push({
                text: labels.seriesPeriodLabel(result.periods[i]),
                subtext: additive ? `${sub} · ${noun} : ${labels.formatValue(total, spec.measure, { compact: true })}` : sub,
                left: `${cell.col * width + width / 2}%`,
                top: `${top}%`,
                textAlign: 'center',
                itemGap: 2,
                textStyle: { fontSize: 12, fontWeight: 600, color: tokens.text },
                subtextStyle: { fontSize: 11, color: tokens.textMuted },
            });
        }
        return {
            type: 'map',
            geoIndex: i,
            name: labels.seriesPeriodLabel(result.periods[i]),
            data: result.keys.map((name, k) => ({ name, value: s.values[k] })).filter((d) => d.value !== null),
        };
    });
    return {
        ...common(ctx, false),
        title: titles,
        tooltip: zoneTooltip(result, spec, ctx, zm),
        geo,
        visualMap: {
            type: 'piecewise',
            seriesIndex: series.map((_, i) => i),
            pieces: legend.map(({ lower, upper, label, color }) => ({
                ...(lower !== null ? { gte: lower } : {}),
                ...(upper !== null ? { lt: upper } : {}),
                label,
                color,
            })),
            orient: 'horizontal',
            left: 'center',
            bottom: 0,
            itemWidth: 14,
            itemHeight: 10,
            itemGap: 8,
            selectedMode: false,
            textStyle: { color: tokens.textMuted, fontSize: 11 },
        },
        series,
    };
}

// Hauteur d'une carte à plusieurs vignettes : chacune garde une taille
// lisible, la carte du tableau s'allonge.
function mapHeight(result, width) {
    const n = result.series.length;
    if (n <= 1 || !width) return null;
    const { cols, rows } = sideCells(n)[0];
    const cell = Math.round(Math.min(320, Math.max(170, (width / cols) * 0.8)));
    return rows * cell + 48;
}

export function buildChartOption(result, spec, ctx) {
    const chart = spec.view.chart;
    if (chart === 'number') return null;
    if (chart === 'map') return mapOption(result, spec, ctx);
    if (chart === 'donut') return donutOption(result, spec, ctx);
    if (chart === 'heatmap') return heatmapOption(result, spec, ctx);
    if (chart === 'calendar') return calendarOption(result, spec, ctx);
    if (chart === 'radar') return radarOption(result, spec, ctx);
    if (chart === 'challenge') return challengeOption(result, spec, ctx);
    if (result.delta) return deltaOption(result, spec, ctx);
    if (spec.compare.layout === 'side' && result.periods.length > 1) return sideOption(result, spec, ctx);
    return overlayOption(result, spec, ctx);
}

// Chiffre clé : une valeur par période (ou par source) ; la première porte
// l'écart avec la deuxième (« +18 % par rapport à 2025 », « par rapport aux
// trouvailles reçues »).
export function numberModel(result, spec, ctx) {
    const { labels } = ctx;
    const multiSource = (result.sources?.length || 1) > 1;
    const many = result.periods.length > 1 || multiSource;
    const blocks = result.series.map((s) => ({
        label: many ? seriesName(result, s, spec, labels) : '',
        value: s.values[0] ?? null,
        text: labels.formatValue(s.values[0] ?? null, spec.measure, { normalize: result.normalize }),
        // Jours du record (meilleure journée, série, pause).
        record: labels.recordText(s.records?.[0]),
        delta: null,
    }));
    // Objectif / projection : sur la première valeur.
    const s0 = result.series[0];
    if (s0 && blocks[0] && (spec.goal || spec.view.projection) && ctx.today !== null && ctx.today !== undefined) {
        const outlook = numberOutlook({
            value: s0.values[0] ?? 0, goal: spec.goal?.value ?? null,
            entry: result.periods[s0.periodIndex], today: ctx.today, goalDay: s0.goalDay ?? null,
        });
        blocks[0].outlook = { ...outlook, ...labels.outlookLines(outlook, spec.measure, { projection: spec.view.projection }) };
    }
    if (many && blocks.length >= 2 && blocks[0].value !== null && blocks[1].value !== null) {
        const diff = blocks[0].value - blocks[1].value;
        const ratio = blocks[1].value ? diff / blocks[1].value : null;
        blocks[0].delta = {
            sign: Math.sign(diff),
            text: labels.formatDelta(diff, spec.measure, result.normalize),
            ratio: labels.formatRatio(ratio),
            versus: multiSource && result.series[1].source !== result.series[0].source
                ? labels.comparedToSource(result.series[1].source)
                : labels.comparedTo(result.periods[result.series[1].periodIndex]),
        };
    }
    return blocks;
}

// ---------------------------------------------------------------------------
// Dégradé (palette « heat », grille, calendrier)
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
    const raw = String(hex || '').replace('#', '');
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

// Couleur d'un niveau 0…1 le long d'une rampe (teinte unique, du clair au
// foncé en mode clair, du sombre au clair en mode sombre).
export function rampColor(ramp, level) {
    if (!ramp?.length) return '#888888';
    const x = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)) * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, Math.floor(x));
    if (ramp.length === 1) return ramp[0];
    const a = hexToRgb(ramp[i]);
    const b = hexToRgb(ramp[i + 1]);
    const f = x - i;
    const mix = a.map((c, k) => Math.round(c + (b[k] - c) * f));
    return '#' + mix.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function visualMapOption(max, spec, result, ctx, extra = {}) {
    const { tokens } = ctx;
    return {
        type: 'continuous',
        min: 0,
        max: max || 1,
        calculable: false,
        orient: 'horizontal',
        itemWidth: 10,
        itemHeight: 120,
        inRange: { color: tokens.heat },
        textStyle: { color: tokens.textMuted, fontSize: 11 },
        formatter: (v) => ctx.labels.formatValue(v, spec.measure, { compact: true, normalize: result.normalize }),
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// Grille (carte de chaleur)
// ---------------------------------------------------------------------------

const HALF_STEPS = Array.from({ length: 9 }, (_, i) => String(1 + i / 2));

// Grille : difficulté × terrain (regroupement D/T), ou regroupement × 2ᵉ
// dimension. Une seule période : la première.
function heatmapOption(result, spec, ctx) {
    const { tokens, labels, attributeName } = ctx;
    const format = valueFormatter(spec, result, ctx);
    let xLabels;
    let yLabels;
    const cells = [];
    if (result.dim === 'dt') {
        xLabels = HALF_STEPS.map((v) => labels.axisLabel('difficulty', v));
        yLabels = HALF_STEPS.map((v) => labels.axisLabel('terrain', v));
        const values = result.series[0]?.values || [];
        const byKey = new Map(result.keys.map((key, i) => [key, values[i]]));
        HALF_STEPS.forEach((d, i) => HALF_STEPS.forEach((tr, j) => {
            cells.push([i, j, byKey.get(`${Number(d)}|${Number(tr)}`) ?? 0]);
        }));
    } else {
        const rows = result.series.filter((s) => s.periodIndex === 0);
        xLabels = axisLabels(result, ctx);
        yLabels = rows.map((s) => (s.split === null
            ? labels.measureName(spec.measure, spec.source)
            : labels.axisLabel(spec.splitBy, s.split, { attributeName })));
        rows.forEach((s, j) => s.values.forEach((v, i) => cells.push([i, j, v ?? 0])));
    }
    const max = Math.max(0, ...cells.map((c) => c[2]));
    const xName = result.dim === 'dt' ? labels.dimension('difficulty') : '';
    const yName = result.dim === 'dt' ? labels.dimension('terrain') : '';
    return {
        ...common(ctx, false),
        tooltip: {
            ...tooltipBase(tokens),
            trigger: 'item',
            formatter: (p) => {
                const [x, y, v] = p.value;
                const head = result.dim === 'dt'
                    ? labels.axisLabel('dt', `${Number(HALF_STEPS[x])}|${Number(HALF_STEPS[y])}`)
                    : `${xLabels[x]} · ${yLabels[y]}`;
                return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(head)}</div><b>${escapeHtml(format(v === '-' ? 0 : v))}</b>`;
            },
        },
        // Les titres d'axe sortent du rectangle « containLabel » : place
        // réservée à gauche et en bas.
        grid: { left: yName ? 30 : 8, right: 16, top: 12, bottom: xName ? 62 : 44, containLabel: true },
        xAxis: {
            type: 'category', data: xLabels, name: xName, nameLocation: 'middle', nameGap: 24,
            nameTextStyle: { color: tokens.textMuted }, ...axisStyle(tokens), splitArea: { show: false },
        },
        yAxis: {
            type: 'category', data: yLabels, name: yName, nameLocation: 'middle', nameGap: 28, nameRotate: 90,
            nameTextStyle: { color: tokens.textMuted }, ...axisStyle(tokens), splitArea: { show: false },
        },
        visualMap: visualMapOption(max, spec, result, ctx, { left: 'center', bottom: 0 }),
        series: [{
            type: 'heatmap',
            // Les cases vides restent au fond : seule une valeur colore.
            data: cells.map(([x, y, v]) => [x, y, v ? v : '-']),
            itemStyle: { borderColor: tokens.surface, borderWidth: 2, borderRadius: 3 },
            label: {
                show: spec.view.labels && cells.length <= 150,
                color: '#ffffff',
                textBorderColor: 'rgba(0,0,0,0.45)',
                textBorderWidth: 2,
                fontSize: 10,
                formatter: (p) => labels.formatValue(p.value[2], spec.measure, { compact: true, normalize: result.normalize }),
            },
            emphasis: { itemStyle: { borderColor: tokens.text, borderWidth: 1 } },
        }],
    };
}

// ---------------------------------------------------------------------------
// Calendrier (regroupement par jour)
// ---------------------------------------------------------------------------

// Au plus trois années dessinées, les plus récentes de la première période.
export const CALENDAR_MAX_YEARS = 3;
// Cases carrées : 53 semaines dans la largeur disponible, entre 8 et 18 px.
const CALENDAR_CELL = 13;
const CALENDAR_LEFT = 72;
export function calendarCell(width) {
    if (!width) return CALENDAR_CELL;
    return Math.max(8, Math.min(18, Math.floor((width - CALENDAR_LEFT - 8) / 53)));
}
const calendarBlock = (cell) => cell * 7 + 38;

function utcYear(day) {
    return new Date(day * 86400000).getUTCFullYear();
}

function isoDate(day) {
    return new Date(day * 86400000).toISOString().slice(0, 10);
}

// Années du calendrier : { years, truncated }.
export function calendarYears(result) {
    const entry = result.periods[0];
    if (!entry) return { years: [], truncated: false };
    const first = utcYear(entry.from);
    const last = utcYear(entry.fullTo ?? entry.to);
    const all = [];
    for (let y = last; y >= first; y--) all.push(y);
    return { years: all.slice(0, CALENDAR_MAX_YEARS), truncated: all.length > CALENDAR_MAX_YEARS };
}

// Hauteur du graphique en pixels quand elle dépend des données (calendrier :
// un bandeau par année) ; null = hauteur par défaut de la carte.
export function chartHeight(result, spec, width = 0) {
    if (spec.view.chart === 'challenge') return challengeHeight(result, width);
    if (spec.view.chart === 'map') return mapHeight(result, width);
    if (spec.view.chart !== 'calendar') return null;
    const { years } = calendarYears(result);
    return 40 + Math.max(1, years.length) * calendarBlock(calendarCell(width));
}

function calendarOption(result, spec, ctx) {
    const { tokens, labels } = ctx;
    const series0 = result.series[0];
    const days = result.align === 'elapsed' ? (series0?.dates || []) : result.keys;
    const { years } = calendarYears(result);
    const points = [];
    days.forEach((day, i) => {
        const v = series0?.values[i];
        if (day === null || day === undefined || !v) return;
        points.push({ year: utcYear(day), value: [isoDate(day), v] });
    });
    const max = Math.max(0, ...points.map((p) => p.value[1]));
    const format = valueFormatter(spec, result, ctx);
    const dateFmt = new Intl.DateTimeFormat(labels.locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const cell = calendarCell(ctx.width);
    const block = calendarBlock(cell);
    // ECharts range les noms de jours du dimanche au samedi, quel que soit
    // le premier jour affiché.
    // Petites cases : un jour sur deux nommé (lun., mer., ven.), comme
    // GitHub — sinon les noms débordent des rangées.
    const weekdays = labels.weekdayNames().map((name, i) => (cell < 13 && (i % 2 || i === 6) ? '' : name));
    const dayNames = [weekdays[6], ...weekdays.slice(0, 6)];
    return {
        ...common(ctx, false),
        tooltip: {
            ...tooltipBase(tokens),
            trigger: 'item',
            formatter: (p) => `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(dateFmt.format(new Date(p.value[0] + 'T00:00:00Z')))}</div><b>${escapeHtml(format(p.value[1]))}</b>`,
        },
        visualMap: visualMapOption(max, spec, result, ctx, { right: 0, top: 0, itemHeight: 90 }),
        calendar: years.map((year, i) => ({
            range: String(year),
            top: 40 + i * block + 18,
            left: CALENDAR_LEFT,
            cellSize: [cell, cell],
            splitLine: { show: false },
            itemStyle: { color: tokens.empty, borderColor: tokens.surface, borderWidth: 2 },
            yearLabel: { show: true, position: 'left', margin: 44, color: tokens.textMuted, fontSize: 12 },
            dayLabel: { firstDay: 1, nameMap: dayNames, color: tokens.textMuted, fontSize: 10, margin: 6 },
            monthLabel: { nameMap: labels.monthNames(), color: tokens.textMuted, fontSize: 10 },
        })),
        series: years.map((year, i) => ({
            type: 'heatmap',
            coordinateSystem: 'calendar',
            calendarIndex: i,
            data: points.filter((p) => p.year === year).map((p) => p.value),
            itemStyle: { borderColor: tokens.surface, borderWidth: 2 },
        })),
    };
}

// ---------------------------------------------------------------------------
// Grille de défi (D/T 81, Calendrier 366, Jasmer, mois de trouvaille)
// ---------------------------------------------------------------------------

// Taille d'une case selon la grille (au plus).
const CHALLENGE_MAX_CELL = { dt: 36, calendar: 24, jasmer: 26, finds_ym: 36 };
const CHALLENGE_MIN_CELL = 6;

// Années × mois plus hautes que larges (Jasmer : 27 années) : couchées, une
// colonne par année, une ligne par mois — la grille tient dans la largeur
// d'une carte au lieu de s'étirer en hauteur.
function challengeTransposed(grid) {
    return (grid.metric === 'jasmer' || grid.metric === 'finds_ym') && grid.rows > grid.cols;
}

// Mise en page : cases carrées, grille centrée sous les deux lignes du
// bilan.
function challengeLayout(result, width) {
    const grid = result.grid;
    const transposed = challengeTransposed(grid);
    const cols = transposed ? grid.rows : grid.cols;
    const rows = transposed ? grid.cols : grid.rows;
    const dt = grid.metric === 'dt';
    const left = dt ? 52 : 46;
    const right = 8;
    const top = 56;
    const bottom = dt ? 44 : 26;
    const avail = Math.max(0, (width || 480) - left - right);
    const cell = Math.max(CHALLENGE_MIN_CELL, Math.min(CHALLENGE_MAX_CELL[grid.metric] || 24, Math.floor(avail / cols)));
    const offset = Math.max(0, Math.floor((avail - cell * cols) / 2));
    return { transposed, cell, rows, cols, left: left + offset, top, width: cell * cols, height: cell * rows, bottom };
}

function challengeHeight(result, width) {
    if (!result.grid) return null;
    const layout = challengeLayout(result, width);
    return layout.top + layout.height + layout.bottom;
}

// Bilan affiché au-dessus de la grille (première série).
export function challengeText(result, ctx) {
    if (!result.grid) return null;
    const summary = challengeSummary(result.series[0]?.values || []);
    return { summary, ...ctx.labels.challengeLines(result.grid.metric, summary, result.keys) };
}

function challengeOption(result, spec, ctx) {
    const { tokens, labels } = ctx;
    const grid = result.grid;
    if (!grid) return null;
    const metric = grid.metric;
    const values = result.series[0]?.values || [];
    const text = challengeText(result, ctx);
    const { summary } = text;
    const next = new Set(summary.loops > 0 ? summary.next : []);
    const layout = challengeLayout(result, ctx.width);
    const format = valueFormatter(spec, result, ctx);
    const max = Math.max(0, ...values.map((v) => v || 0));

    // Mois en toutes lettres abrégées si la case le permet, sinon l'initiale.
    const monthFmt = new Intl.DateTimeFormat(labels.locale, { month: layout.cell >= 30 ? 'short' : 'narrow', timeZone: 'UTC' });
    const month = (m) => monthFmt.format(Date.UTC(2024, m - 1, 1));
    const half = (v) => labels.axisLabel('difficulty', String(v));
    let rowLabels;
    let colLabels;
    if (metric === 'dt') {
        rowLabels = grid.rowKeys.map(half);
        colLabels = grid.colKeys.map(half);
    } else if (metric === 'calendar') {
        rowLabels = labels.monthNames();
        colLabels = grid.colKeys.map(String);
    } else {
        rowLabels = grid.rowKeys.map(String);
        colLabels = grid.colKeys.map(month);
    }
    const xLabels = layout.transposed ? rowLabels : colLabels;
    const yLabels = layout.transposed ? colLabels : rowLabels;
    // Jours du calendrier : 1, 5, 10… ; années en colonnes : ECharts écarte
    // celles qui se chevauchent.
    let xInterval = 0;
    if (metric === 'calendar') xInterval = (i) => i === 0 || (i + 1) % 5 === 0;
    else if (layout.transposed) xInterval = 'auto';
    const yInterval = !layout.transposed && layout.cell < 14 && metric !== 'calendar' ? 1 : 0;

    const data = grid.cells.map((cell, i) => {
        const n = values[i] || 0;
        const level = max ? 0.25 + 0.75 * (n / max) : 0;
        const style = { color: n ? rampColor(tokens.heat, level) : tokens.empty };
        // Cases du prochain tour (déjà trouvées) : liseré.
        if (next.has(i)) Object.assign(style, { borderColor: tokens.text, borderWidth: 2 });
        const [x, y] = layout.transposed ? [cell.r, cell.c] : [cell.c, cell.r];
        const item = { value: [x, y, n], keyIndex: i, itemStyle: style };
        if (n && labelColorOn(style.color) !== '#ffffff') {
            item.label = { color: labelColorOn(style.color), textBorderWidth: 0 };
        }
        return item;
    });
    const xName = metric === 'dt' ? labels.dimension('terrain') : '';
    const yName = metric === 'dt' ? labels.dimension('difficulty') : '';
    const axis = (data, name, interval, extra = {}) => ({
        type: 'category', data, name, nameLocation: 'middle',
        nameTextStyle: { color: tokens.textMuted }, ...axisStyle(tokens), splitArea: { show: false },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: tokens.textMuted, fontSize: 11, interval },
        ...extra,
    });
    return {
        ...common(ctx, false),
        title: {
            text: text.coverage + '   ·   ' + text.tours,
            subtext: text.missing,
            left: 0,
            top: 4,
            itemGap: 6,
            textStyle: { color: tokens.text, fontSize: 13, fontWeight: 600 },
            subtextStyle: { color: tokens.textMuted, fontSize: 12, width: Math.max(120, (ctx.width || 480) - 8), overflow: 'truncate' },
        },
        tooltip: {
            ...tooltipBase(tokens),
            trigger: 'item',
            formatter: (p) => {
                const i = p.data?.keyIndex;
                const head = labels.challengeCellLabel(metric, result.keys[i]);
                return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(head)}</div><b>${escapeHtml(format(p.value[2]))}</b>`;
            },
        },
        grid: { left: layout.left, top: layout.top, width: layout.width, height: layout.height, containLabel: false },
        xAxis: axis(xLabels, xName, xInterval, { nameGap: 26 }),
        yAxis: axis(yLabels, yName, yInterval, { inverse: true, nameGap: 34, nameRotate: 90 }),
        series: [{
            type: 'heatmap',
            data,
            itemStyle: { borderColor: tokens.surface, borderWidth: layout.cell >= 12 ? 2 : 1, borderRadius: layout.cell >= 16 ? 3 : 1 },
            label: {
                show: spec.view.labels && layout.cell >= 20,
                color: '#ffffff',
                textBorderColor: 'rgba(0,0,0,0.45)',
                textBorderWidth: 2,
                fontSize: 10,
                formatter: (p) => (p.value[2] ? labels.formatValue(p.value[2], spec.measure, { compact: true }) : ''),
            },
            emphasis: { itemStyle: { borderColor: tokens.text, borderWidth: 1 } },
        }],
    };
}

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

function radarOption(result, spec, ctx) {
    const { tokens } = ctx;
    const identities = seriesIdentity(result, spec, ctx);
    const names = axisLabels(result, ctx);
    const top = sharedMax(result, false) || 1;
    const format = valueFormatter(spec, result, ctx);
    return {
        ...common(ctx, identities.length > 1),
        tooltip: {
            ...tooltipBase(tokens),
            trigger: 'item',
            formatter: (p) => {
                const rows = names.map((name, i) => `<div>${escapeHtml(name)} : <b>${escapeHtml(format(p.value[i]))}</b></div>`);
                return `<div style="font-weight:600;margin-bottom:4px">${marker(p.color)}${escapeHtml(p.name)}</div>${rows.join('')}`;
            },
        },
        radar: {
            indicator: names.map((name) => ({ name, max: top })),
            radius: '66%',
            center: ['50%', identities.length > 1 ? '56%' : '52%'],
            axisName: { color: tokens.textMuted, fontSize: 11 },
            splitLine: { lineStyle: { color: tokens.grid } },
            splitArea: { show: false },
            axisLine: { lineStyle: { color: tokens.grid } },
        },
        series: [{
            type: 'radar',
            symbolSize: 6,
            data: result.series.map((s, i) => ({
                name: identities[i].name,
                value: s.values.map((v) => v ?? 0),
                itemStyle: { color: identities[i].color },
                lineStyle: { width: 2, color: identities[i].color },
                areaStyle: { opacity: 0.1, color: identities[i].color },
            })),
        }],
    };
}

// ---------------------------------------------------------------------------
// Vignette de la galerie
// ---------------------------------------------------------------------------

const noLabel = (part) => ({ ...(part || {}), show: false });

function thumbnailAxis(axis) {
    if (!axis) return axis;
    if (Array.isArray(axis)) return axis.map(thumbnailAxis);
    return {
        ...axis,
        name: '',
        axisLabel: noLabel(axis.axisLabel),
        axisTick: noLabel(axis.axisTick),
        splitLine: noLabel(axis.splitLine),
    };
}

function thumbnailGrid(grid) {
    if (Array.isArray(grid)) return grid.map((g) => ({ ...g, containLabel: false }));
    return { left: 2, right: 2, top: 4, bottom: 2, containLabel: false };
}

function thumbnailSeries(series, single) {
    const { markLine, markPoint, markArea, endLabel, ...rest } = series;
    const out = {
        ...rest,
        silent: true,
        label: noLabel(series.label),
        labelLine: noLabel(series.labelLine),
        emphasis: { disabled: true },
    };
    if (series.type === 'line') {
        out.symbol = 'none';
        out.lineStyle = { ...(series.lineStyle || {}), width: Math.min(series.lineStyle?.width ?? 2, 1.5) };
    }
    // Anneau seul : sans légende à côté, il occupe la vignette.
    if (series.type === 'pie' && single) {
        out.radius = ['45%', '90%'];
        out.center = ['50%', '50%'];
    }
    return out;
}

// Option d'un graphique réduite à sa forme : ni texte, ni légende, ni
// interaction, ni animation. Sert aux aperçus de la galerie (quelques
// dizaines de pixels de haut, données réelles de l'utilisateur).
export function thumbnailOption(option) {
    if (!option) return null;
    const { dataZoom, title, toolbox, ...rest } = option;
    const out = {
        ...rest,
        animation: false,
        aria: { enabled: false },
        tooltip: { show: false },
        legend: { show: false },
    };
    if (option.grid) out.grid = thumbnailGrid(option.grid);
    if (option.xAxis) out.xAxis = thumbnailAxis(option.xAxis);
    if (option.yAxis) out.yAxis = thumbnailAxis(option.yAxis);
    if (option.visualMap) {
        out.visualMap = Array.isArray(option.visualMap)
            ? option.visualMap.map((v) => ({ ...v, show: false }))
            : { ...option.visualMap, show: false };
    }
    if (option.radar) {
        out.radar = { ...option.radar, radius: '85%', center: ['50%', '50%'], axisName: { show: false } };
    }
    if (option.calendar) {
        out.calendar = (Array.isArray(option.calendar) ? option.calendar : [option.calendar])
            .map((c) => ({ ...c, dayLabel: noLabel(c.dayLabel), monthLabel: noLabel(c.monthLabel), yearLabel: noLabel(c.yearLabel) }));
    }
    const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : [];
    out.series = series.map((s) => thumbnailSeries(s, series.length === 1));
    return out;
}
