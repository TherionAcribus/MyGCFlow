// Libellés de la page Statistiques : mesures, dimensions, clés d'axe,
// périodes, valeurs. Module pur : la traduction `t` et la locale sont
// passées par l'appelant (window.t dans la page, l'identité dans les tests).
//
// Les chaînes passent par `t('…')` écrit tel quel (jamais dans un template
// literal, jamais `t?.(…)`) : c'est ce que pybabel extrait (AGENTS.md).

import { OTHERS_KEY, UNKNOWN_KEY } from './stats_model.mjs';

const identity = (s, vars) => (vars
    ? String(s).replace(/\$\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m))
    : s);

// Mesures proposées à l'utilisateur, dans l'ordre du menu. `key` est la
// valeur du <select> (op ou op:champ).
export const MEASURE_CHOICES = Object.freeze([
    { key: 'count', measure: { op: 'count' } },
    { key: 'distinct:caches', measure: { op: 'distinct', field: 'caches' } },
    { key: 'distinct:days', measure: { op: 'distinct', field: 'days' } },
    { key: 'distinct:cache_type', measure: { op: 'distinct', field: 'cache_type' } },
    { key: 'distinct:country', measure: { op: 'distinct', field: 'country' } },
    { key: 'distinct:state', measure: { op: 'distinct', field: 'state' } },
    { key: 'distinct:owner', measure: { op: 'distinct', field: 'owner' } },
    { key: 'mean:difficulty', measure: { op: 'mean', field: 'difficulty' } },
    { key: 'mean:terrain', measure: { op: 'mean', field: 'terrain' } },
    { key: 'mean:age', measure: { op: 'mean', field: 'age' } },
    { key: 'max_per_day', measure: { op: 'max_per_day' } },
    { key: 'cumulative:all', measure: { op: 'cumulative', from: 'all' } },
    { key: 'cumulative', measure: { op: 'cumulative' } },
]);

export function measureKey(measure) {
    if (measure.op === 'distinct' || measure.op === 'mean') return `${measure.op}:${measure.field}`;
    if (measure.op === 'cumulative' && measure.from === 'all') return 'cumulative:all';
    return measure.op;
}

export function measureOfKey(key) {
    return MEASURE_CHOICES.find((c) => c.key === key)?.measure || { op: 'count' };
}

// Regroupements proposés, dans l'ordre du menu, par famille.
export const GROUP_CHOICES = Object.freeze([
    { family: 'none', dims: ['none'] },
    { family: 'time', dims: ['year', 'quarter', 'month', 'week', 'day'] },
    { family: 'cyclic', dims: ['month_of_year', 'week_of_year', 'day_of_year', 'weekday'] },
    { family: 'category', dims: ['cache_type', 'container', 'difficulty', 'terrain', 'dt', 'country', 'state', 'owner', 'attribute', 'age', 'published_year'] },
]);

// Graphiques proposés au lot 1 (les autres arrivent avec leur rendu).
export const LOT1_CHARTS = Object.freeze(['bar', 'line', 'area', 'donut', 'number']);

const UTC_DAY = 86400000;

export function makeLabels({ t = identity, locale = 'fr' } = {}) {
    const dateFmt = (options) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options });
    const dayFmt = dateFmt({ day: 'numeric', month: 'short', year: 'numeric' });
    const dayMonthFmt = dateFmt({ day: 'numeric', month: 'short' });
    const monthYearFmt = dateFmt({ month: 'short', year: 'numeric' });
    const monthYearLongFmt = dateFmt({ month: 'long', year: 'numeric' });
    const monthFmt = dateFmt({ month: 'short' });
    const monthLongFmt = dateFmt({ month: 'long' });
    const weekdayFmt = dateFmt({ weekday: 'short' });
    const weekdayLongFmt = dateFmt({ weekday: 'long' });
    const intFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const decFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const halfFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    const compactFmt = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
    const fromDay = (day) => new Date(day * UTC_DAY);

    const AGE = [
        t('Le jour même'), t('1 à 7 jours'), t('8 jours à 1 mois'), t('1 à 6 mois'),
        t('6 à 12 mois'), t('1 à 2 ans'), t('2 à 5 ans'), t('5 à 10 ans'),
        t('10 à 15 ans'), t('15 ans et plus'),
    ];

    const DIMENSIONS = {
        none: t('Au total'),
        year: t('Année'),
        quarter: t('Trimestre'),
        month: t('Mois'),
        week: t('Semaine'),
        day: t('Jour'),
        month_of_year: t("Mois de l'année"),
        week_of_year: t("Semaine de l'année"),
        day_of_year: t("Jour de l'année"),
        weekday: t('Jour de la semaine'),
        cache_type: t('Type de cache'),
        container: t('Contenant'),
        difficulty: t('Difficulté'),
        terrain: t('Terrain'),
        dt: t('Difficulté / terrain'),
        country: t('Pays'),
        state: t('Région'),
        owner: t('Propriétaire'),
        attribute: t('Attribut'),
        age: t('Âge de la cache'),
        published_year: t('Année de publication'),
    };

    // Option du menu « regroupement » dans la phrase (« par année »).
    const GROUP_PHRASES = {
        none: t('au total'),
        year: t('par année'),
        quarter: t('par trimestre'),
        month: t('par mois'),
        week: t('par semaine'),
        day: t('par jour'),
        month_of_year: t("par mois de l'année"),
        week_of_year: t("par semaine de l'année"),
        day_of_year: t("par jour de l'année"),
        weekday: t('par jour de la semaine'),
        cache_type: t('par type de cache'),
        container: t('par contenant'),
        difficulty: t('par difficulté'),
        terrain: t('par terrain'),
        dt: t('par difficulté / terrain'),
        country: t('par pays'),
        state: t('par région'),
        owner: t('par propriétaire'),
        attribute: t('par attribut'),
        age: t('par âge de la cache'),
        published_year: t('par année de publication'),
    };

    const GROUP_FAMILIES = {
        none: t('Un seul chiffre'),
        time: t('Au fil du temps'),
        cyclic: t('Pour comparer les périodes'),
        category: t('Par caractéristique'),
    };

    // Option du menu « mesure » dans la phrase (« le nombre de trouvailles »).
    const MEASURE_PHRASES = {
        count: t('le nombre de trouvailles'),
        'distinct:caches': t('le nombre de caches différentes'),
        'distinct:days': t('le nombre de jours de cache'),
        'distinct:cache_type': t('le nombre de types de caches'),
        'distinct:country': t('le nombre de pays'),
        'distinct:state': t('le nombre de régions'),
        'distinct:owner': t('le nombre de propriétaires'),
        'mean:difficulty': t('la difficulté moyenne'),
        'mean:terrain': t('le terrain moyen'),
        'mean:age': t("l'âge moyen des caches à la trouvaille"),
        max_per_day: t('le record sur une journée'),
        'cumulative:all': t('le cumul de mes trouvailles'),
        cumulative: t('le cumul sur la période'),
    };

    // Nom court d'une mesure (titre par défaut, infobulles, chiffre clé).
    const MEASURE_NAMES = {
        count: t('Trouvailles'),
        'distinct:caches': t('Caches différentes'),
        'distinct:days': t('Jours de cache'),
        'distinct:cache_type': t('Types de caches'),
        'distinct:country': t('Pays'),
        'distinct:state': t('Régions'),
        'distinct:owner': t('Propriétaires'),
        'mean:difficulty': t('Difficulté moyenne'),
        'mean:terrain': t('Terrain moyen'),
        'mean:age': t('Âge moyen à la trouvaille'),
        max_per_day: t('Record sur une journée'),
        'cumulative:all': t('Cumul des trouvailles'),
        cumulative: t('Cumul sur la période'),
    };

    const CHARTS = {
        bar: t('barres'),
        line: t('courbe'),
        area: t('aire'),
        donut: t('anneau'),
        number: t('chiffre clé'),
        calendar: t('calendrier'),
        heatmap: t('grille'),
        radar: t('radar'),
    };

    const SIZES = {
        S: t('Petit'),
        M: t('Moyen'),
        L: t('Grand'),
        XL: t('Toute la largeur'),
    };

    // Questions toutes faites (dashboard_model.mjs › QUESTIONS).
    const QUESTIONS = {
        total: [t('Nombre de trouvailles'), t('Le total de la période.')],
        days: [t('Jours de cache'), t('Les jours où vous avez trouvé au moins une cache.')],
        countries_count: [t('Pays visités'), t('Le nombre de pays de vos trouvailles.')],
        by_year: [t('Ma meilleure année'), t('Vos trouvailles année par année, sur tout votre historique.')],
        progress: [t('Ma progression'), t('Le total de vos trouvailles, mois après mois.')],
        months: [t('Mes mois les plus actifs'), t("Janvier, février… : quels mois de l'année vous cachez le plus.")],
        weekdays: [t('Mes jours de la semaine'), t('Du lundi au dimanche : quand vous trouvez vos caches.')],
        types: [t('Mes types de caches'), t('La part de chaque type, avec les couleurs de la carte.')],
        countries: [t('Mes pays'), t('Les pays où vous avez le plus trouvé.')],
        owners: [t('Mes propriétaires favoris'), t('Les poseurs dont vous avez trouvé le plus de caches.')],
        difficulty: [t('Difficulté des caches'), t('Vos trouvailles par niveau de difficulté.')],
        terrain: [t('Terrain des caches'), t('Vos trouvailles par niveau de terrain.')],
        containers: [t('Tailles des caches'), t('Nano, micro, petite… : les contenants trouvés.')],
        age: [t('Âge des caches à la trouvaille'), t('Trouvées le jour de leur publication, ou des années après.')],
        record: [t('Mon record par année'), t('Le plus grand nombre de trouvailles en une journée, chaque année.')],
    };

    function categoryLabel(dim, key, attributeName) {
        if (key === OTHERS_KEY) return t('Autres');
        if (key === UNKNOWN_KEY) return t('Inconnu');
        if (dim === 'attribute') return t(String(attributeName ? attributeName(key) : key));
        if (dim === 'owner') return String(key);
        // Types, contenants, pays, régions : noms du GPX, traduits par le
        // catalogue comme dans les panneaux de la carte.
        return t(String(key));
    }

    // Libellé d'une clé d'axe. `long` : forme développée des infobulles.
    function axisLabel(dim, key, { long = false, attributeName = null } = {}) {
        if (key === OTHERS_KEY) return t('Autres');
        if (key === UNKNOWN_KEY) return t('Inconnu');
        switch (dim) {
            case 'none': return t('Total');
            case 'year': case 'published_year': return String(key);
            case 'quarter': return t('T${q} ${y}', { q: key % 10, y: Math.floor(key / 10) });
            case 'month': {
                const date = Date.UTC(Math.floor(key / 100), (key % 100) - 1, 1);
                return (long ? monthYearLongFmt : monthYearFmt).format(date);
            }
            case 'week':
                return long ? t('Semaine du ${date}', { date: dayFmt.format(fromDay(key)) }) : dayFmt.format(fromDay(key));
            case 'day': return dayFmt.format(fromDay(key));
            case 'month_of_year': return (long ? monthLongFmt : monthFmt).format(Date.UTC(2024, key - 1, 1));
            case 'week_of_year': return t('S${n}', { n: key });
            // Année bissextile de référence : la case 60 est le 29 février.
            case 'day_of_year': return dayMonthFmt.format(Date.UTC(2024, 0, key));
            // Le 1ᵉʳ janvier 2024 était un lundi (jour ISO 1).
            case 'weekday': return (long ? weekdayLongFmt : weekdayFmt).format(Date.UTC(2024, 0, key));
            case 'difficulty': case 'terrain': return halfFmt.format(Number(key));
            case 'dt': {
                const [d, tr] = String(key).split('|').map(Number);
                return t('D${d} / T${t}', { d: halfFmt.format(d), t: halfFmt.format(tr) });
            }
            case 'age': return AGE[key] ?? String(key);
            default: return categoryLabel(dim, key, attributeName);
        }
    }

    function periodLabel(entry) {
        const period = entry.period || {};
        if (period.label) return period.label;
        switch (period.kind) {
            case 'all': return t('Toutes mes trouvailles');
            case 'year': return String(entry.year);
            case 'month': return monthYearLongFmt.format(Date.UTC(entry.year, entry.month - 1, 1));
            case 'each':
                return entry.month
                    ? monthYearLongFmt.format(Date.UTC(entry.year, entry.month - 1, 1))
                    : String(entry.year);
            case 'rolling': return rollingLabel(period);
            default:
                return t('${from} – ${to}', { from: dayFmt.format(fromDay(entry.from)), to: dayFmt.format(fromDay(entry.to)) });
        }
    }

    function rollingLabel({ unit, count }) {
        if (count === 1) {
            if (unit === 'day') return t("Aujourd'hui");
            if (unit === 'month') return t('Le dernier mois');
            return t('La dernière année');
        }
        if (unit === 'day') return t('Les ${n} derniers jours', { n: count });
        if (unit === 'month') return t('Les ${n} derniers mois', { n: count });
        return t('Les ${n} dernières années', { n: count });
    }

    // Libellé d'une période telle que décrite (avant déploiement), pour les
    // menus.
    function periodChoiceLabel(period) {
        if (!period) return t('Période du tableau de bord');
        if (period.label) return period.label;
        switch (period.kind) {
            case 'all': return t('Toutes mes trouvailles');
            case 'year': return String(period.year);
            case 'month': return monthYearLongFmt.format(Date.UTC(period.year, period.month - 1, 1));
            case 'rolling': return rollingLabel(period);
            case 'each': return period.unit === 'month' ? t('Chaque mois') : t('Chaque année');
            case 'range':
                return t('${from} – ${to}', {
                    from: dayFmt.format(Date.parse(period.from + 'T00:00:00Z')),
                    to: dayFmt.format(Date.parse(period.to + 'T00:00:00Z')),
                });
            default: return '';
        }
    }

    // Valeur affichée : moyennes de D/T à une décimale, âge en jours entiers,
    // le reste en entiers. `compact` pour les graduations (12,3 k).
    function formatValue(value, measure, { compact = false } = {}) {
        if (value === null || value === undefined || Number.isNaN(value)) return '—';
        if (measure?.op === 'mean' && measure.field !== 'age') return decFmt.format(value);
        if (measure?.op === 'mean' && measure.field === 'age') {
            return t('${n} j', { n: intFmt.format(Math.round(value)) });
        }
        if (compact && Math.abs(value) >= 10000) return compactFmt.format(value);
        return intFmt.format(value);
    }

    function measureName(measure) {
        return MEASURE_NAMES[measureKey(measure)] || MEASURE_NAMES.count;
    }

    // Titre par défaut d'un graphique sans titre : « Trouvailles par année ».
    function defaultTitle(spec) {
        const name = measureName(spec.measure);
        if (spec.groupBy === 'none') return name;
        return t('${measure} ${group}', { measure: name, group: GROUP_PHRASES[spec.groupBy] || '' });
    }

    return {
        t,
        locale,
        dimension: (dim) => DIMENSIONS[dim] || dim,
        groupPhrase: (dim) => GROUP_PHRASES[dim] || dim,
        groupFamily: (family) => GROUP_FAMILIES[family] || family,
        measurePhrase: (key) => MEASURE_PHRASES[key] || key,
        measureName,
        chart: (chart) => CHARTS[chart] || chart,
        size: (size) => SIZES[size] || size,
        question: (id) => ({ title: QUESTIONS[id]?.[0] || id, description: QUESTIONS[id]?.[1] || '' }),
        axisLabel,
        periodLabel,
        periodChoiceLabel,
        formatValue,
        defaultTitle,
    };
}
