// Adaptateur ECharts de la page Statistiques : jeu de séries (chart_query.mjs)
// + description du graphique → objet d'options ECharts. Module pur (il ne
// charge pas ECharts : il fabrique seulement l'objet passé à setOption),
// testé par tests/js/chart_echarts.test.mjs.
//
//   buildChartOption(result, spec, { labels, tokens, typeColors, attributeName })
//     labels      makeLabels(...) (chart_labels.mjs)
//     tokens      couleurs du thème courant, lues dans stats_page.css :
//                 { text, textMuted, grid, surface, others, unknown, up, down,
//                   series: [8 teintes, dans l'ordre fixe de la palette] }
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

import { OTHERS_KEY, UNKNOWN_KEY } from './stats_model.mjs';

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
// la même couleur d'un graphique côte à côte à l'autre.
function keyColors(result, ctx) {
    let index = 0;
    return result.keys.map((key) => {
        const special = key === OTHERS_KEY || key === UNKNOWN_KEY;
        return categoryColor(result.dim, key, special ? 0 : index++, ctx.tokens, ctx.typeColors);
    });
}

// Nom et couleur de chaque série. Une série par période et, le cas échéant,
// par valeur de la 2ᵉ dimension — la couleur suit cette valeur (ou la
// période), jamais le rang d'affichage.
function seriesIdentity(result, spec, ctx, { side = false } = {}) {
    const { labels, tokens, typeColors, attributeName } = ctx;
    const many = result.periods.length > 1;
    let splitIndex = 0;
    const splitColors = new Map();
    return result.series.map((s) => {
        const period = result.periods[s.periodIndex];
        const periodName = period ? labels.seriesPeriodLabel(period) : '';
        if (s.split === null) {
            return {
                name: many && !side ? periodName : labels.measureName(spec.measure),
                color: tokens.series[s.periodIndex % tokens.series.length],
            };
        }
        if (!splitColors.has(s.split)) {
            const special = s.split === OTHERS_KEY || s.split === UNKNOWN_KEY || spec.splitBy === 'cache_type';
            splitColors.set(s.split, categoryColor(spec.splitBy, s.split, special ? 0 : splitIndex++, tokens, typeColors));
        }
        const splitName = labels.axisLabel(spec.splitBy, s.split, { attributeName });
        return { name: many && !side ? `${periodName} · ${splitName}` : splitName, color: splitColors.get(s.split) };
    });
}

// Libellés de l'axe des clés : rang « depuis le début » (Mois 1…) ou clé.
function axisLabels(result, ctx, { long = false } = {}) {
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
        const rows = list.map((p) => {
            const identity = identities[p.seriesIndex] || {};
            const s = result.series[p.seriesIndex];
            const raw = typeof p.value === 'object' && p.value !== null ? p.value.value : p.value;
            const color = typeof p.color === 'string' ? p.color : identity.color;
            const notes = [];
            if (s?.dates?.[i] !== null && s?.dates?.[i] !== undefined) notes.push(labels.dateInUnit(result.elapsedUnit, s.dates[i]));
            if (s && s.partial === i) notes.push(ongoing);
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
        animationDuration: 400,
        animationDurationUpdate: 300,
        backgroundColor: 'transparent',
        textStyle: { color: tokens.text, fontFamily: 'inherit' },
        aria: { enabled: true },
        legend: showLegend ? legendOption(tokens) : { show: false },
    };
}

// Case incomplète : remplissage atténué, bord en tirets de la même teinte.
function partialStyle(color) {
    return { opacity: 0.45, borderColor: color, borderWidth: 1, borderType: 'dashed' };
}

// Série ECharts d'une série de résultat (barre ou courbe).
function seriesOption(s, identity, result, spec, ctx, { chart, horizontal, stacked, single, perItem, axisIndex }) {
    const { tokens, labels } = ctx;
    const log = spec.view.log;
    const colors = perItem ? keyColors(result, ctx) : null;
    const data = s.values.map((value, k) => {
        const v = log && value !== null && value <= 0 ? null : value;
        const color = colors ? colors[k] : identity.color;
        if (!colors && k !== s.partial) return v;
        const itemStyle = { color };
        if (k === s.partial && chart === 'bar') Object.assign(itemStyle, partialStyle(color));
        return { value: v, itemStyle };
    });
    const base = { name: identity.name, data, color: identity.color, ...axisIndex };
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
    // Une série seule par catégorie : chaque barre à la couleur de sa
    // catégorie (types aux couleurs de la carte, « Autres » / « Inconnu »
    // en gris).
    const perItem = single && isBar && result.kind === 'category';
    const zoom = zoomOption(result, tokens);
    const slider = zoom && zoom.length > 1;

    const series = result.series.map((s, i) => seriesOption(s, identities[i], result, spec, ctx, {
        chart, horizontal, stacked, single, perItem,
    }));
    const keys = categoryAxis(result, ctx, { isBar, horizontal });
    const values = valueAxis(spec, result, ctx, { log: spec.view.log });
    const option = {
        ...common(ctx, identities.length > 1),
        grid: {
            left: 8,
            // Barres horizontales : place de l'étiquette de valeur ; courbe :
            // la dernière date est centrée sur le bord droit.
            right: horizontal ? 32 : (isBar ? 16 : 36),
            top: identities.length > 1 ? 36 : 16,
            bottom: slider ? 40 : 8,
            containLabel: true,
        },
        tooltip: axisTooltip(result, spec, ctx, identities, isBar),
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
    const perItem = !splits && isBar && result.kind === 'category';
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
    const [a, b] = result.periods;
    const nameA = labels.seriesPeriodLabel(a);
    const nameB = labels.seriesPeriodLabel(b);
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
    const colors = keyColors(result, ctx);
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
                return { name, value: d.value, itemStyle: { color: colors[d.k] } };
            });
        const total = data.reduce((sum, d) => sum + d.value, 0);
        const single = n === 1;
        return {
            type: 'pie',
            name: single ? labels.measureName(spec.measure) : labels.seriesPeriodLabel(result.periods[s.periodIndex]),
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

export function buildChartOption(result, spec, ctx) {
    const chart = spec.view.chart;
    if (chart === 'number') return null;
    if (chart === 'donut') return donutOption(result, spec, ctx);
    // Calendrier, grille, radar : lot 3 — dessinés en barres d'ici là.
    const drawn = ['bar', 'line', 'area'].includes(chart) ? spec : { ...spec, view: { ...spec.view, chart: 'bar' } };
    if (result.delta) return deltaOption(result, drawn, ctx);
    if (spec.compare.layout === 'side' && result.periods.length > 1) return sideOption(result, drawn, ctx);
    return overlayOption(result, drawn, ctx);
}

// Chiffre clé : une valeur par période ; la première porte l'écart avec la
// deuxième (« +18 % par rapport à 2025 »).
export function numberModel(result, spec, { labels }) {
    const many = result.periods.length > 1;
    const blocks = result.series.map((s) => ({
        label: many ? labels.seriesPeriodLabel(result.periods[s.periodIndex]) : '',
        value: s.values[0] ?? null,
        text: labels.formatValue(s.values[0] ?? null, spec.measure, { normalize: result.normalize }),
        delta: null,
    }));
    if (many && blocks.length >= 2 && blocks[0].value !== null && blocks[1].value !== null) {
        const diff = blocks[0].value - blocks[1].value;
        const ratio = blocks[1].value ? diff / blocks[1].value : null;
        blocks[0].delta = {
            sign: Math.sign(diff),
            text: labels.formatDelta(diff, spec.measure, result.normalize),
            ratio: labels.formatRatio(ratio),
            versus: labels.comparedTo(result.periods[1]),
        };
    }
    return blocks;
}
