// Adaptateur ECharts de la page Statistiques : jeu de séries (chart_query.mjs)
// + description du graphique → objet d'options ECharts. Module pur (il ne
// charge pas ECharts : il fabrique seulement l'objet passé à setOption),
// testé par tests/js/chart_echarts.test.mjs.
//
//   buildChartOption(result, spec, { labels, tokens, typeColors, attributeName })
//     labels      makeLabels(...) (chart_labels.mjs)
//     tokens      couleurs du thème courant, lues dans stats_page.css :
//                 { text, textMuted, grid, surface, others, unknown,
//                   series: [8 teintes, dans l'ordre fixe de la palette] }
//     typeColors  { 'Traditional Cache': '#008000', … } — mêmes couleurs que
//                 les points de la carte (static/json/defaultGcColors.json)
//
// Le chiffre clé (`number`) n'est pas un graphique ECharts : null, la page
// l'affiche en HTML.
//
// Règles de dessin (marques fines et sobres) : barres de 24 px au plus,
// bout arrondi de 4 px et base carrée ; courbes de 2 px ; aire à 10 %
// d'opacité ; quadrillage d'un pixel, plein ; légende dès deux séries ;
// texte toujours dans les couleurs de texte, jamais dans celle d'une série.

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

// Nom et couleur de chaque série. Une série par période et, le cas échéant,
// par valeur de la 2ᵉ dimension — la couleur suit cette valeur (ou la
// période), jamais le rang d'affichage.
function seriesIdentity(result, spec, ctx) {
    const { labels, tokens, typeColors, attributeName } = ctx;
    const many = result.periods.length > 1;
    let splitIndex = 0;
    const splitColors = new Map();
    return result.series.map((s) => {
        const period = result.periods[s.periodIndex];
        const periodName = period ? labels.periodLabel(period) : '';
        if (s.split === null) {
            return {
                name: many ? periodName : labels.measureName(spec.measure),
                color: tokens.series[s.periodIndex % tokens.series.length],
            };
        }
        if (!splitColors.has(s.split)) {
            const special = s.split === OTHERS_KEY || s.split === UNKNOWN_KEY || spec.splitBy === 'cache_type';
            splitColors.set(s.split, categoryColor(spec.splitBy, s.split, special ? 0 : splitIndex++, tokens, typeColors));
        }
        const splitName = labels.axisLabel(spec.splitBy, s.split, { attributeName });
        return { name: many ? `${periodName} · ${splitName}` : splitName, color: splitColors.get(s.split) };
    });
}

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

// Infobulle d'axe : clé en toutes lettres puis une ligne par série.
function axisTooltipFormatter(result, spec, ctx, identities) {
    const { labels, attributeName } = ctx;
    return (params) => {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return '';
        const key = result.keys[list[0].dataIndex];
        const head = escapeHtml(labels.axisLabel(result.dim, key, { long: true, attributeName }));
        const rows = list.map((p) => {
            const identity = identities[p.seriesIndex] || {};
            const raw = Array.isArray(p.value) ? p.value[1] : p.value;
            const color = typeof p.color === 'string' ? p.color : identity.color;
            const name = identities.length > 1 ? `${escapeHtml(identity.name)} : ` : '';
            return `<div>${marker(color)}${name}<b>${escapeHtml(labels.formatValue(raw, spec.measure))}</b></div>`;
        });
        return `<div style="margin-bottom:4px;font-weight:600">${head}</div>${rows.join('')}`;
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

function valueAxis(spec, ctx, log) {
    const { tokens, labels } = ctx;
    return {
        type: log ? 'log' : 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: tokens.textMuted, formatter: (v) => labels.formatValue(v, spec.measure, { compact: true }) },
        splitLine: { lineStyle: { color: tokens.grid, width: 1, type: 'solid' } },
        // Une moyenne de D/T ne descend pas sous 1 : pas d'axe forcé à zéro.
        scale: spec.measure.op === 'mean' && spec.measure.field !== 'age',
        minInterval: spec.measure.op === 'mean' ? 0 : 1,
    };
}

function common(ctx, identities) {
    const { tokens } = ctx;
    return {
        animationDuration: 400,
        animationDurationUpdate: 300,
        backgroundColor: 'transparent',
        textStyle: { color: tokens.text, fontFamily: 'inherit' },
        aria: { enabled: true },
        legend: identities.length > 1 ? {
            type: 'scroll',
            top: 0,
            left: 0,
            icon: 'roundRect',
            itemWidth: 12,
            itemHeight: 12,
            textStyle: { color: tokens.textMuted },
            pageTextStyle: { color: tokens.textMuted },
        } : { show: false },
    };
}

function cartesianOption(result, spec, ctx) {
    const { tokens, labels, typeColors, attributeName } = ctx;
    const chart = spec.view.chart;
    const isBar = chart === 'bar';
    const horizontal = isBar && spec.view.orientation === 'horizontal';
    const log = spec.view.log;
    const identities = seriesIdentity(result, spec, ctx);
    const single = identities.length === 1;
    const categories = result.keys.map((key) => labels.axisLabel(result.dim, key, { attributeName }));
    const zoom = result.kind === 'time' && result.keys.length > ZOOM_FROM_KEYS;
    const slider = zoom && result.keys.length > SLIDER_FROM_KEYS;
    const stacked = spec.view.stack && identities.length > 1;
    // Une série seule par catégorie de types : chaque barre à la couleur de
    // son type ; « Autres » / « Inconnu » en gris dans tous les cas.
    const perItemColor = single && isBar && result.kind === 'category';

    const series = result.series.map((s, i) => {
        const identity = identities[i];
        const data = s.values.map((value, k) => {
            const v = log && value !== null && value <= 0 ? null : value;
            if (!perItemColor) return v;
            return { value: v, itemStyle: { color: categoryColor(result.dim, result.keys[k], 0, tokens, typeColors) } };
        });
        const base = { name: identity.name, data, color: identity.color };
        if (isBar) {
            return {
                ...base,
                type: 'bar',
                barMaxWidth: 24,
                stack: stacked ? 'total' : undefined,
                itemStyle: {
                    // Bout arrondi, base carrée ; piles séparées par un filet
                    // de la couleur du fond.
                    borderRadius: stacked ? 0 : (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]),
                    borderColor: stacked ? tokens.surface : undefined,
                    borderWidth: stacked ? 1 : 0,
                },
                label: spec.view.labels && result.keys.length <= MAX_LABELLED_BARS && !stacked ? {
                    show: true,
                    position: horizontal ? 'right' : 'top',
                    color: tokens.textMuted,
                    fontSize: 11,
                    formatter: (p) => labels.formatValue(p.value, spec.measure, { compact: true }),
                } : { show: false },
                emphasis: { focus: single ? 'none' : 'series' },
            };
        }
        const showSymbol = result.keys.length <= MAX_SYMBOL_KEYS;
        return {
            ...base,
            type: 'line',
            smooth: spec.view.smooth,
            stack: stacked ? 'total' : undefined,
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
                formatter: (p) => labels.formatValue(p.value, spec.measure, { compact: true }),
            } : { show: false },
            emphasis: { focus: single ? 'none' : 'series' },
        };
    });

    const categoryAxis = {
        type: 'category',
        data: categories,
        boundaryGap: isBar,
        inverse: horizontal,
        ...axisStyle(tokens),
    };
    const option = {
        ...common(ctx, identities),
        grid: {
            left: 8,
            // Barres horizontales : place de l'étiquette de valeur ; courbe :
            // la dernière date est centrée sur le bord droit.
            right: horizontal ? 32 : (isBar ? 16 : 36),
            top: identities.length > 1 ? 36 : 16,
            bottom: slider ? 40 : 8,
            containLabel: true,
        },
        tooltip: {
            ...tooltipBase(tokens),
            trigger: 'axis',
            axisPointer: isBar
                ? { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,0.10)' } }
                : { type: 'line', lineStyle: { color: tokens.textMuted, width: 1 } },
            formatter: axisTooltipFormatter(result, spec, ctx, identities),
        },
        xAxis: horizontal ? valueAxis(spec, ctx, log) : categoryAxis,
        yAxis: horizontal ? categoryAxis : valueAxis(spec, ctx, log),
        series,
    };
    if (zoom) {
        option.dataZoom = [{ type: 'inside' }];
    }
    if (slider) {
        option.dataZoom.push(
            {
                type: 'slider',
                height: 16,
                bottom: 6,
                borderColor: tokens.grid,
                fillerColor: 'rgba(127,127,127,0.15)',
                handleStyle: { color: tokens.surface, borderColor: tokens.textMuted },
                moveHandleSize: 0,
                textStyle: { color: tokens.textMuted },
                dataBackground: { lineStyle: { color: tokens.textMuted }, areaStyle: { color: tokens.grid } },
            },
        );
    }
    return option;
}

function donutOption(result, spec, ctx) {
    const { tokens, labels, typeColors, attributeName } = ctx;
    // Un anneau montre une série : la première (comparaison côte à côte : lot 2).
    const values = result.series[0]?.values || [];
    let index = 0;
    const data = result.keys
        .map((key, k) => ({ key, value: values[k] }))
        .filter((d) => d.value > 0)
        .map((d) => {
            const special = d.key === OTHERS_KEY || d.key === UNKNOWN_KEY;
            return {
                name: labels.axisLabel(result.dim, d.key, { attributeName }),
                value: d.value,
                itemStyle: { color: categoryColor(result.dim, d.key, special ? 0 : index++, tokens, typeColors) },
            };
        });
    const total = data.reduce((sum, d) => sum + d.value, 0);
    const pct = new Intl.NumberFormat(labels.locale, { style: 'percent', maximumFractionDigits: 1 });
    const identities = data.length > 1 ? data.map((d) => ({ name: d.name })) : [];
    return {
        ...common(ctx, identities),
        legend: data.length > 1 ? {
            type: 'scroll',
            orient: 'vertical',
            right: 0,
            top: 'middle',
            icon: 'roundRect',
            itemWidth: 12,
            itemHeight: 12,
            textStyle: { color: tokens.textMuted },
            pageTextStyle: { color: tokens.textMuted },
        } : { show: false },
        tooltip: {
            ...tooltipBase(tokens),
            trigger: 'item',
            formatter: (p) => `${marker(p.color)}${escapeHtml(p.name)} : <b>${escapeHtml(labels.formatValue(p.value, spec.measure))}</b> (${escapeHtml(pct.format(total ? p.value / total : 0))})`,
        },
        series: [{
            type: 'pie',
            name: labels.measureName(spec.measure),
            radius: ['48%', '72%'],
            center: data.length > 1 ? ['38%', '50%'] : ['50%', '50%'],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: tokens.surface, borderWidth: 2, borderRadius: 4 },
            label: spec.view.labels ? {
                show: true,
                color: tokens.textMuted,
                formatter: (p) => pct.format(total ? p.value / total : 0),
            } : { show: false },
            labelLine: { show: spec.view.labels },
            data,
        }],
    };
}

export function buildChartOption(result, spec, ctx) {
    switch (spec.view.chart) {
        case 'number': return null;
        case 'donut': return donutOption(result, spec, ctx);
        case 'line': case 'area': return cartesianOption(result, spec, ctx);
        // Calendrier, grille, radar : lot 3 — dessinés en barres d'ici là.
        default: return cartesianOption(result, { ...spec, view: { ...spec.view, chart: 'bar' } }, ctx);
    }
}

// Chiffre clé : la valeur de la première série (ou de chaque période).
export function numberModel(result, spec, { labels }) {
    return result.series.map((s) => ({
        label: result.periods.length > 1 ? labels.periodLabel(result.periods[s.periodIndex]) : '',
        value: s.values[0] ?? null,
        text: labels.formatValue(s.values[0] ?? null, spec.measure),
    }));
}
