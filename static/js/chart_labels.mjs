// Libellés de la page Statistiques : mesures, dimensions, clés d'axe,
// périodes, valeurs. Module pur : la traduction `t` et la locale sont
// passées par l'appelant (window.t dans la page, l'identité dans les tests).
//
// Les chaînes passent par `t('…')` écrit tel quel (jamais dans un template
// literal, jamais `t?.(…)`) : c'est ce que pybabel extrait (AGENTS.md).

import { OTHERS_KEY, UNKNOWN_KEY } from './stats_model.mjs';
import { cellLabel } from './zone_grid.mjs';

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
    { key: 'distinct:finder', measure: { op: 'distinct', field: 'finder' } },
    { key: 'distinct:county', measure: { op: 'distinct', field: 'county' } },
    { key: 'mean:difficulty', measure: { op: 'mean', field: 'difficulty' } },
    { key: 'mean:terrain', measure: { op: 'mean', field: 'terrain' } },
    { key: 'mean:age', measure: { op: 'mean', field: 'age' } },
    { key: 'max_per_day', measure: { op: 'max_per_day' } },
    { key: 'streak', measure: { op: 'streak' } },
    { key: 'streak:current', measure: { op: 'streak', current: true } },
    { key: 'gap', measure: { op: 'gap' } },
    { key: 'cumulative:all', measure: { op: 'cumulative', from: 'all' } },
    { key: 'cumulative', measure: { op: 'cumulative' } },
    { key: 'active', measure: { op: 'active' } },
    // Cartes par zones seulement (chart_spec.mjs › ZONE_ONLY_OPS).
    { key: 'dt_coverage', measure: { op: 'dt_coverage' } },
    { key: 'first_day', measure: { op: 'first_day' } },
    // Jeux Évolution croisés avec mes trouvailles.
    { key: 'found_share', measure: { op: 'found_share' } },
    { key: 'found_share:all', measure: { op: 'found_share', base: 'all' } },
]);

export function measureKey(measure) {
    if (measure.op === 'distinct' || measure.op === 'mean') return `${measure.op}:${measure.field}`;
    if (measure.op === 'cumulative' && measure.from === 'all') return 'cumulative:all';
    if (measure.op === 'streak' && measure.current) return 'streak:current';
    if (measure.op === 'found_share' && measure.base === 'all') return 'found_share:all';
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
    { family: 'category', dims: ['cache_type', 'container', 'difficulty', 'terrain', 'dt', 'country', 'state', 'county', 'owner', 'cache', 'finder', 'attribute', 'age', 'published_year', 'published_month'] },
    { family: 'zone', dims: ['zone_country', 'zone_region', 'zone_subregion', 'zone_grid'] },
]);

// Graphiques proposés par l'éditeur (tous ceux que l'adaptateur dessine).
export const EDITOR_CHARTS = Object.freeze(['bar', 'line', 'area', 'donut', 'number', 'calendar', 'heatmap', 'radar', 'challenge', 'map']);

const UTC_DAY = 86400000;

// `zoneName(id)` : nom d'une zone (pays, région…) dans la langue de la page,
// lu dans les contours chargés (stats_page_geo.js) ; null tant qu'ils ne le
// sont pas — l'id est alors affiché.
export function makeLabels({ t = identity, locale = 'fr', zoneName = null } = {}) {
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
    const perDayFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const perKm2Fmt = new Intl.NumberFormat(locale, { maximumSignificantDigits: 2 });
    const signedPctFmt = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' });
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
        published_month: t('Mois de publication'),
        cache: t('Cache'),
        finder: t('Visiteur'),
        county: t('Département'),
        zone_country: t('Pays (carte)'),
        zone_region: t('Région (carte)'),
        zone_subregion: t('Département, comté… (carte)'),
        zone_grid: t('Case de la grille (carte)'),
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
        published_month: t('par mois de publication'),
        cache: t('par cache'),
        finder: t('par visiteur'),
        county: t('par département'),
        zone_country: t('sur une carte des pays'),
        zone_region: t('sur une carte des régions'),
        zone_subregion: t('sur une carte des départements, comtés…'),
        zone_grid: t('sur une grille de cases'),
    };

    const GROUP_FAMILIES = {
        none: t('Un seul chiffre'),
        time: t('Au fil du temps'),
        cyclic: t('Pour comparer les périodes'),
        category: t('Par caractéristique'),
        zone: t('Sur une carte'),
    };

    // Option du menu « mesure » de la phrase. La source se choisit à part
    // (« Dans [mes trouvailles], afficher [le nombre] [par année] ») : les
    // mesures ne la nomment pas.
    const MEASURE_PHRASES = {
        count: t('le nombre'),
        'distinct:caches': t('le nombre de caches différentes'),
        'distinct:days': t('le nombre de jours différents'),
        'distinct:cache_type': t('le nombre de types de caches'),
        'distinct:country': t('le nombre de pays'),
        'distinct:state': t('le nombre de régions'),
        'distinct:owner': t('le nombre de propriétaires'),
        'distinct:finder': t('le nombre de visiteurs différents'),
        'distinct:county': t('le nombre de départements'),
        'mean:difficulty': t('la difficulté moyenne'),
        'mean:terrain': t('le terrain moyen'),
        'mean:age': t("l'âge moyen des caches"),
        max_per_day: t('le record sur une journée'),
        streak: t('la plus longue série de jours de cache'),
        'streak:current': t('la série de jours de cache en cours'),
        gap: t('la plus longue pause sans trouvaille'),
        'cumulative:all': t('le cumul depuis le début'),
        cumulative: t('le cumul sur la période'),
        active: t('les caches actives'),
        dt_coverage: t('le nombre de combinaisons D/T'),
        first_day: t('la date de la première trouvaille'),
        found_share: t("la part des caches actives que j'ai trouvées"),
        'found_share:all': t("la part des caches publiées que j'ai trouvées"),
    };

    // Nom court d'une mesure (titre par défaut, infobulles, chiffre clé). Le
    // compte prend le nom de la source (sourceNoun).
    const MEASURE_NAMES = {
        'distinct:caches': t('Caches différentes'),
        'distinct:days': t('Jours de cache'),
        'distinct:cache_type': t('Types de caches'),
        'distinct:country': t('Pays'),
        'distinct:state': t('Régions'),
        'distinct:owner': t('Propriétaires'),
        'distinct:finder': t('Visiteurs différents'),
        'distinct:county': t('Départements'),
        'mean:difficulty': t('Difficulté moyenne'),
        'mean:terrain': t('Terrain moyen'),
        'mean:age': t('Âge moyen des caches'),
        max_per_day: t('Record sur une journée'),
        streak: t('Plus longue série'),
        'streak:current': t('Série en cours'),
        gap: t('Plus longue pause'),
        'cumulative:all': t('Cumul depuis le début'),
        cumulative: t('Cumul sur la période'),
        active: t('Caches actives'),
        dt_coverage: t('Combinaisons D/T'),
        first_day: t('Première trouvaille'),
        found_share: t('Part des actives trouvées'),
        'found_share:all': t('Part des publiées trouvées'),
    };

    // Sources : nom dans les menus, nom de ce qu'on compte (légendes,
    // titres), fin de phrase d'un écart.
    const SOURCE_LABELS = {
        finds: t('Mes trouvailles'),
        dnf: t('Mes DNF'),
        owned: t('Mes caches posées'),
        'poses.received': t('Trouvailles reçues sur mes caches'),
        'poses.dnf': t('DNF reçus sur mes caches'),
        'poses.favorites': t('Favoris reçus sur mes caches'),
        evolution: t('Caches publiées'),
        'evolution:archived': t('Caches archivées'),
    };
    const SOURCE_NOUNS = {
        finds: t('Trouvailles'),
        dnf: t('DNF'),
        owned: t('Caches posées'),
        'poses.received': t('Trouvailles reçues'),
        'poses.dnf': t('DNF reçus'),
        'poses.favorites': t('Favoris reçus'),
        evolution: t('Caches publiées'),
        'evolution:archived': t('Caches archivées'),
    };
    const SOURCE_COMPARED = {
        finds: t('par rapport à mes trouvailles'),
        dnf: t('par rapport à mes DNF'),
        owned: t('par rapport à mes caches posées'),
        'poses.received': t('par rapport aux trouvailles reçues'),
        'poses.dnf': t('par rapport aux DNF reçus'),
        'poses.favorites': t('par rapport aux favoris reçus'),
        evolution: t('par rapport aux caches publiées'),
        'evolution:archived': t('par rapport aux caches archivées'),
    };
    // Clé de libellé d'une source : « evolution:12:archived » →
    // « evolution:archived ».
    const sourceKey = (source) => {
        const text = String(source || 'finds');
        if (!text.startsWith('evolution:')) return text;
        return text.endsWith(':archived') ? 'evolution:archived' : 'evolution';
    };
    const sourceLabel = (source) => SOURCE_LABELS[sourceKey(source)] || String(source);
    const sourceNoun = (source) => SOURCE_NOUNS[sourceKey(source)] || String(source);
    const comparedToSource = (source) => SOURCE_COMPARED[sourceKey(source)] || '';

    const CHARTS = {
        bar: t('barres'),
        line: t('courbe'),
        area: t('aire'),
        donut: t('anneau'),
        number: t('chiffre clé'),
        calendar: t('calendrier'),
        heatmap: t('grille'),
        radar: t('radar'),
        challenge: t('grille de défi'),
        map: t('carte'),
    };

    const LAYOUTS = {
        overlay: t('superposées'),
        side: t('côte à côte'),
        delta: t('en écart'),
    };

    const ALIGNS = {
        calendar: t('Sur le calendrier (janvier avec janvier)'),
        absolute: t('À leurs vraies dates'),
    };
    const ELAPSED_ALIGN = {
        day: t('Jour par jour depuis le début'),
        week: t('Semaine par semaine depuis le début'),
        month: t('Mois par mois depuis le début'),
        quarter: t('Trimestre par trimestre depuis le début'),
        year: t('Année par année depuis le début'),
    };

    const NORMALIZE = {
        none: t('Valeurs'),
        percent: t('En pourcentage du total'),
        per_day: t('Par jour de la période'),
        per_km2: t('Par km² (densité)'),
    };

    const PALETTES = {
        auto: t('Automatique'),
        accent: t('Une seule couleur'),
        multi: t('Une couleur par valeur'),
        gc: t('Couleurs des types (carte)'),
        heat: t('Dégradé selon la valeur'),
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
        ahead: [t("Suis-je en avance sur l'an dernier ?"), t("Le cumul de cette année et celui de l'an dernier, jour après jour.")],
        year_vs_last: [t("Cette année contre l'an dernier"), t("Vos trouvailles mois par mois, cette année et l'an dernier.")],
        year_delta: [t("Écart avec l'an dernier"), t("Combien de trouvailles en plus ou en moins que l'an dernier, chaque mois.")],
        vs_previous_12: [t('12 derniers mois'), t('Comparés aux 12 mois précédents.')],
        all_years: [t('Toutes mes années'), t('Le cumul de chaque année, superposé jour après jour.')],
        months_by_year: [t('Mes années mois par mois'), t('Une courbe par année, de janvier à décembre.')],
        types_vs_last: [t("Mes types cette année et l'an dernier"), t('Les parts de chaque type, côte à côte.')],
        received_by_month: [t('Trouvailles reçues par mois'), t('Les visites sur vos caches posées, mois après mois.')],
        favorites_total: [t('Favoris reçus'), t('Les points favoris laissés sur vos caches.')],
        top_caches: [t('Mes caches les plus visitées'), t('Vos caches posées qui reçoivent le plus de trouvailles.')],
        top_finders: [t('Mes visiteurs les plus fidèles'), t('Les joueurs qui ont trouvé le plus de vos caches.')],
        owned_active: [t('Mes caches actives'), t('Combien de vos caches étaient en place, mois après mois.')],
        finds_vs_received: [t('Trouvées et reçues'), t('Vos trouvailles et celles reçues sur vos caches, année par année.')],
        dnf_by_year: [t('Mes DNF par année'), t('Vos recherches infructueuses, année par année.')],
        finds_vs_dnf: [t('Trouvailles et DNF'), t('Vos réussites et vos échecs, année par année.')],
        evo_active_now: [t('Caches actives'), t('Les caches en place dans la zone, à la fin de la période.')],
        evo_active: [t('Caches actives au fil du temps'), t('Le nombre de caches en place, mois après mois.')],
        evo_flows: [t('Publications et archivages'), t('Les caches qui apparaissent et celles qui disparaissent, chaque année.')],
        evo_published: [t('Publications par année'), t('Les nouvelles caches de la zone, année par année.')],
        evo_types: [t('Types des caches actives'), t('La part de chaque type parmi les caches en place.')],
        evo_counties: [t('Caches actives par département'), t('Où se trouvent les caches en place.')],
        evo_dt: [t('Grille D/T de la zone'), t('Difficulté et terrain des caches en place.')],
        best_day: [t('Ma meilleure journée'), t('Le plus de trouvailles en un jour, et quel jour.')],
        streak_longest: [t('Ma plus longue série'), t("Le plus de jours d'affilée avec au moins une trouvaille.")],
        streak_current: [t('Ma série en cours'), t("Les jours d'affilée jusqu'à aujourd'hui (ou hier : la journée n'est pas finie).")],
        gap_longest: [t('Ma plus longue pause'), t('Le plus de jours sans trouvaille entre deux caches.')],
        streak_by_year: [t('Mes séries année par année'), t("La plus longue série de chaque année.")],
        best_month: [t('Mon meilleur mois'), t('Vos trouvailles mois par mois, le record mis en avant.')],
        next_milestone: [t('Mon prochain cap'), t('Le prochain nombre rond, et quand vous y serez à ce rythme.')],
        year_pace: [t('Mon année à ce rythme'), t("Vos trouvailles de l'année, et où vous finirez au 31 décembre.")],
        year_curve: [t("Ma courbe de l'année, prolongée"), t("Le cumul de l'année, prolongé jusqu'au 31 décembre au rythme actuel.")],
        challenge_dt: [t('Ma grille D/T'), t('Les 81 combinaisons de difficulté et de terrain : celles qui manquent.')],
        challenge_calendar: [t('Mon calendrier 366'), t("Un jour de l'année sans trouvaille ? Les 366 jours, toutes années confondues.")],
        challenge_jasmer: [t('Ma grille Jasmer'), t('Une cache publiée chaque mois depuis mai 2000 : les mois qui manquent.')],
        challenge_months: [t('Mes mois de cache'), t('Chaque mois depuis votre première trouvaille : en avez-vous sauté un ?')],
        zones_conquest: [t('Ma conquête'), t('Quand vous avez trouvé votre première cache dans chaque département, comté…')],
        zones_by_year: [t('Mes zones année par année'), t("La carte de vos trouvailles à la fin de chaque année.")],
        zones_milestones: [t('Mes zones à chaque palier'), t('La carte à votre 100ᵉ, 500ᵉ, 1 000ᵉ trouvaille…')],
        zones_countries: [t('Ma carte du monde'), t('Vos trouvailles pays par pays.')],
        zones_types: [t('Types de caches par région'), t('Le nombre de types différents trouvés dans chaque région.')],
        evo_zones_active: [t('Caches actives, année par année'), t('La carte des caches en place à la fin de chaque année.')],
        evo_zones_density: [t('Densité des caches actives'), t('Les caches en place pour 1 000 km², zone par zone.')],
        evo_zones_coverage: [t('Ma couverture'), t('La part des caches actives que vous avez trouvées, zone par zone.')],
        evo_zones_coverage_years: [t('Ma couverture, année par année'), t('Votre part des caches actives à la fin de chaque année.')],
        zones_dt: [t('Grille D/T par région'), t('Combien des 81 combinaisons de difficulté et de terrain dans chaque région.')],
    };

    const QUESTION_GROUPS = {
        overview: t("Vue d'ensemble"),
        compare: t('Comparer les périodes'),
        when: t('Quand je cache'),
        caches: t('Les caches trouvées'),
        places: t('Lieux et poseurs'),
        poses: t('Mes caches posées'),
        dnf: t('Mes DNF'),
        zone: t('La zone au fil du temps'),
        zone_caches: t('Les caches de la zone'),
        zone_maps: t('Cartes de la zone'),
        challenges: t('Mes défis'),
        maps: t('Mes cartes'),
        records: t('Séries et records'),
        goals: t('Objectifs et projections'),
    };

    function categoryLabel(dim, key, attributeName) {
        if (key === OTHERS_KEY) return t('Autres');
        if (key === UNKNOWN_KEY) return t('Inconnu');
        if (dim === 'attribute') return t(String(attributeName ? attributeName(key) : key));
        if (dim === 'owner') return String(key);
        // Case de grille : ses coordonnées (« 47,2° N · 1,5° O »).
        if (dim === 'zone_grid') {
            return cellLabel(key, { locale, north: t('N'), south: t('S'), east: t('E'), west: t('O') });
        }
        if (dim.startsWith('zone_')) return (zoneName && zoneName(key)) || String(key);
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
            case 'month': case 'published_month': {
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

    // Nom d'une période déployée (chart_periods.mjs) : son libellé
    // personnalisé, sinon ce qu'elle est concrètement (`as`) — « 2025 » pour
    // « la période précédente » de 2026.
    function periodLabel(entry) {
        const period = entry.period || {};
        if (period.label) return period.label;
        const as = entry.as || period;
        if (as.upTo) return upToLabel(as, entry.fullTo ?? entry.to);
        switch (as.kind) {
            case 'all': return t('Toute la période');
            case 'year': return String(as.year);
            case 'month': return monthYearLongFmt.format(Date.UTC(as.year, as.month - 1, 1));
            case 'rolling': return rollingLabel(as);
            case 'previous_rolling': return previousRollingLabel(as);
            case 'moment': return momentLabel(as.moment);
            default:
                return t('${from} – ${to}', { from: dayFmt.format(fromDay(entry.from)), to: dayFmt.format(fromDay(entry.fullTo ?? entry.to)) });
        }
    }

    // Période « depuis le début » : nommée par sa fin — « Jusqu'à fin 2011 »,
    // « Jusqu'à fin mars 2025 », « Jusqu'au 8 nov. 2025 ».
    function upToLabel(as, endDay) {
        if (as.kind === 'year') return t("Jusqu'à fin ${period}", { period: String(as.year) });
        if (as.kind === 'month') {
            return t("Jusqu'à fin ${period}", { period: monthYearLongFmt.format(Date.UTC(as.year, as.month - 1, 1)) });
        }
        return t("Jusqu'au ${date}", { date: dayFmt.format(fromDay(endDay)) });
    }

    // Vignette d'une carte aux moments clés (zone_model.mjs › keyMoments).
    function momentLabel(moment) {
        const date = dayFmt.format(fromDay(moment.day));
        switch (moment.kind) {
            case 'year_end': return String(moment.year);
            case 'quarter_end': return t('T${q} ${y}', { q: moment.quarter, y: moment.year });
            case 'milestone': return t('${n}ᵉ trouvaille', { n: intFmt.format(moment.value) });
            case 'new_zone': return t('Nouvelle zone · ${date}', { date });
            default: {
                // Dernier jour : nommé par ce qu'il a fusionné (« 2026 »).
                const year = (moment.also || []).find((m) => m.kind === 'year_end');
                return year ? String(year.year) : t('Au ${date}', { date });
            }
        }
    }

    function previousRollingLabel({ unit, count }) {
        if (count === 1) {
            if (unit === 'day') return t('La veille');
            if (unit === 'month') return t('Le mois précédent');
            return t("L'année précédente");
        }
        if (unit === 'day') return t('Les ${n} jours précédents', { n: count });
        if (unit === 'month') return t('Les ${n} mois précédents', { n: count });
        return t('Les ${n} années précédentes', { n: count });
    }

    // « par rapport à 2025 », « par rapport aux 12 mois précédents » : la
    // fin de phrase de l'écart d'un chiffre clé.
    function comparedTo(entry) {
        const as = entry.as || entry.period || {};
        if (!entry.period?.label && as.kind === 'previous_rolling') {
            if (as.count === 1) {
                if (as.unit === 'day') return t('par rapport à la veille');
                if (as.unit === 'month') return t('par rapport au mois précédent');
                return t("par rapport à l'année précédente");
            }
            if (as.unit === 'day') return t('par rapport aux ${n} jours précédents', { n: as.count });
            if (as.unit === 'month') return t('par rapport aux ${n} mois précédents', { n: as.count });
            return t('par rapport aux ${n} années précédentes', { n: as.count });
        }
        if (!entry.period?.label && as.upTo) {
            // « par rapport à fin 2024 », « par rapport au 11 nov. 2025 ».
            if (!entry.cut && as.kind === 'year') return t('par rapport à fin ${period}', { period: String(as.year) });
            if (!entry.cut && as.kind === 'month') {
                return t('par rapport à fin ${period}', { period: monthYearLongFmt.format(Date.UTC(as.year, as.month - 1, 1)) });
            }
            return t('par rapport au ${date}', { date: dayFmt.format(fromDay(entry.to)) });
        }
        return t('par rapport à ${period}', { period: periodLabel(entry) });
    }

    // Nom d'une série de comparaison : la période, marquée « en cours » ou
    // « au 8 nov. » quand la comparaison à date l'a coupée.
    function seriesPeriodLabel(entry) {
        if (entry.as?.upTo && !entry.period?.label) {
            if (entry.ongoing) return t("Jusqu'à aujourd'hui");
            if (entry.cut) return t("Jusqu'au ${date}", { date: dayFmt.format(fromDay(entry.to)) });
        }
        const label = periodLabel(entry);
        if (entry.ongoing) return t('${period} (en cours)', { period: label });
        if (entry.cut) return t('${period} (au ${date})', { period: label, date: dayMonthFmt.format(fromDay(entry.to)) });
        return label;
    }

    // Axe « depuis le début de chaque période » : rang 0 → « Mois 1 ».
    function elapsedLabel(unit, key) {
        const n = key + 1;
        switch (unit) {
            case 'day': return t('Jour ${n}', { n });
            case 'week': return t('Semaine ${n}', { n });
            case 'month': return t('Mois ${n}', { n });
            case 'quarter': return t('Trimestre ${n}', { n });
            default: return t('Année ${n}', { n });
        }
    }

    // Vraie date d'une case (infobulle d'un axe « depuis le début »).
    function dateInUnit(unit, day) {
        const date = fromDay(day);
        if (unit === 'month') return monthYearFmt.format(date);
        if (unit === 'quarter') {
            return t('T${q} ${y}', { q: Math.floor(date.getUTCMonth() / 3) + 1, y: date.getUTCFullYear() });
        }
        if (unit === 'year') return String(date.getUTCFullYear());
        return dayFmt.format(date);
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
        if (period.upTo) {
            if (period.kind === 'current') return t("Jusqu'à aujourd'hui");
            if (period.kind === 'range') {
                return t("Jusqu'au ${date}", { date: dayFmt.format(Date.parse(period.to + 'T00:00:00Z')) });
            }
            return upToLabel(period, null);
        }
        switch (period.kind) {
            case 'all': return t('Toute la période');
            case 'year': return String(period.year);
            case 'month': return monthYearLongFmt.format(Date.UTC(period.year, period.month - 1, 1));
            case 'rolling': return rollingLabel(period);
            case 'each': return period.unit === 'month' ? t('Chaque mois') : t('Chaque année');
            case 'current': return period.unit === 'month' ? t('Ce mois-ci') : t('Cette année');
            case 'previous': return t('La période précédente');
            case 'dashboard': return t('Période du tableau de bord');
            case 'moments':
                if (period.rule === 'quarter_end') return t('Moments clés : fins de trimestre');
                if (period.rule === 'milestones') return t('Moments clés : paliers (100ᵉ, 1 000ᵉ…)');
                if (period.rule === 'new_zone') return t('Moments clés : nouvelles zones');
                return t("Moments clés : fins d'année");
            case 'range':
                return t('${from} – ${to}', {
                    from: dayFmt.format(Date.parse(period.from + 'T00:00:00Z')),
                    to: dayFmt.format(Date.parse(period.to + 'T00:00:00Z')),
                });
            default: return '';
        }
    }

    // Champ d'un filtre et valeur proposée.
    function filterField(field) {
        if (field === 'source_kind') return t('Source');
        return DIMENSIONS[field] || field;
    }

    function filterValue(field, value, { attributeName = null } = {}) {
        if (field === 'source_kind') return value === 'lab' ? t('Lab Caches') : t('Géocaches');
        if (field === 'difficulty' || field === 'terrain') return halfFmt.format(Number(value));
        if (field === 'published_year') return String(value);
        return categoryLabel(field, value, attributeName);
    }

    // Noms courts des mois (janvier en tête) et des jours (lundi en tête),
    // pour le calendrier.
    const monthNames = () => Array.from({ length: 12 }, (_, i) => monthFmt.format(Date.UTC(2024, i, 1)));
    const weekdayNames = () => Array.from({ length: 7 }, (_, i) => weekdayFmt.format(Date.UTC(2024, 0, 1 + i)));

    // Valeur affichée : moyennes de D/T à une décimale, âge en jours entiers,
    // le reste en entiers. `compact` pour les graduations (12,3 k).
    // `bare` : sans unité (légende d'une carte, qui la donne une fois).
    function formatValue(value, measure, { compact = false, normalize = 'none', bare = false } = {}) {
        if (value === null || value === undefined || Number.isNaN(value)) return '—';
        if (normalize === 'percent') return t('${n} %', { n: decFmt.format(value) });
        if (normalize === 'per_day') return t('${n} / jour', { n: perDayFmt.format(value) });
        // Densité : par 1 000 km² (des trouvailles par km² ne s'écrivent
        // qu'avec cinq zéros).
        if (normalize === 'per_km2') {
            const n = perKm2Fmt.format(value * 1000);
            return bare ? n : t('${n} / 1 000 km²', { n });
        }
        if (measure?.op === 'first_day') return dayFmt.format(fromDay(value));
        // Part trouvée : pourcentage à une décimale (0,4 % se distingue de 0).
        if (measure?.op === 'found_share') return bare ? decFmt.format(value) : t('${n} %', { n: decFmt.format(value) });
        if (measure?.op === 'mean' && measure.field !== 'age') return decFmt.format(value);
        if ((measure?.op === 'mean' && measure.field === 'age') || measure?.op === 'streak' || measure?.op === 'gap') {
            return t('${n} j', { n: intFmt.format(Math.round(value)) });
        }
        if (compact && Math.abs(value) >= 10000) return compactFmt.format(value);
        return intFmt.format(value);
    }

    // Unité d'une valeur affichée sans elle (`bare`), ou ''.
    function valueUnit(measure, normalize = 'none') {
        if (measure?.op === 'found_share') return '%';
        return normalize === 'per_km2' ? t('/ 1 000 km²') : '';
    }

    // Écart signé : « +12 », « −3 » ; proportion : « +18 % ».
    function formatDelta(value, measure, normalize = 'none') {
        if (value === null || value === undefined || Number.isNaN(value)) return '—';
        const text = formatValue(Math.abs(value), measure, { normalize });
        if (value > 0) return '+' + text;
        if (value < 0) return '−' + text;
        return text;
    }

    function formatRatio(ratio) {
        if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '';
        return signedPctFmt.format(ratio);
    }

    function measureName(measure, source = 'finds') {
        if (measure?.op === 'count') return sourceNoun(source);
        return MEASURE_NAMES[measureKey(measure)] || sourceNoun(source);
    }

    // Grille de défi (chart_challenge.mjs) : couverture, tours complets et
    // cases qui manquent au tour suivant. Mêmes textes que les panneaux de
    // la carte (stats_panels.js) pour les deux premiers.
    const pctFmt = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
    const CHALLENGE_LIST_MAX = 8;
    function challengeCellLabel(metric, key) {
        if (metric === 'dt') return axisLabel('dt', key);
        if (metric === 'calendar') return axisLabel('day_of_year', key);
        return axisLabel('month', key, { long: true });
    }
    function challengeLines(metric, { filled, available, loops, next }, keys) {
        const values = { filled: intFmt.format(filled), available: intFmt.format(available),
            pct: pctFmt.format(available ? filled / available : 0) };
        let coverage;
        if (metric === 'dt') coverage = t('Combinaisons : ${filled}/${available} (${pct})', values);
        else if (metric === 'calendar') coverage = t('Jours : ${filled}/${available} (${pct})', values);
        else coverage = t('Mois : ${filled}/${available} (${pct})', values);
        const n = intFmt.format(loops);
        let tours;
        if (metric === 'jasmer') tours = t('Tours de Jasmer : ${n}', { n });
        else if (metric === 'finds_ym') tours = t('Tours année × mois : ${n}', { n });
        else if (metric === 'calendar') tours = t('Tours de calendrier : ${n}', { n });
        else tours = t('Tours de matrice : ${n}', { n });
        let missing = '';
        if (available && next.length) {
            const count = intFmt.format(next.length);
            const round = intFmt.format(loops + 1);
            if (next.length <= CHALLENGE_LIST_MAX) {
                const list = next.map((i) => challengeCellLabel(metric, keys[i])).join(' · ');
                missing = loops === 0 ? t('Il manque : ${list}', { list })
                    : t('Pour le tour ${round} : ${list}', { round, list });
            } else {
                missing = loops === 0 ? t('Il manque ${count} cases', { count })
                    : t('Pour le tour ${round}, encore ${count} cases', { round, count });
            }
        }
        return { coverage, tours, missing };
    }

    // Jours d'un record (meilleure journée, série, pause) : « le 12 juil.
    // 2024 », « du 3 au 25 juil. 2024 ».
    function recordText(record) {
        if (!record || record.from === null || record.from === undefined) return '';
        if (record.from === record.to) return t('le ${date}', { date: dayFmt.format(fromDay(record.from)) });
        return t('du ${from} au ${to}', { from: dayFmt.format(fromDay(record.from)), to: dayFmt.format(fromDay(record.to)) });
    }

    // Objectif et projection d'un chiffre clé (chart_goal.mjs › numberOutlook) :
    // { progress, lines } — « 812 / 1 000 · 81 % », puis la date atteinte, la
    // date estimée ou la fin de période à ce rythme.
    function outlookLines(outlook, measure, { projection = false } = {}) {
        const value = (v) => formatValue(v, measure);
        const day = (d) => dayFmt.format(fromDay(d));
        const lines = [];
        let progress = '';
        if (outlook.goal) {
            progress = t('${value} / ${goal} · ${pct}', {
                value: value(outlook.value), goal: value(outlook.goal), pct: pctFmt.format(outlook.ratio),
            });
            if (outlook.reached) {
                lines.push(outlook.reachedDay !== null && outlook.reachedDay !== undefined
                    ? t('Objectif atteint le ${date}', { date: day(outlook.reachedDay) })
                    : t('Objectif atteint'));
            } else if (outlook.eta !== null) {
                lines.push(t('À ce rythme : ${goal} le ${date}', { goal: value(outlook.goal), date: day(outlook.eta) }));
            } else if (outlook.short !== null) {
                lines.push(t("À ce rythme : ${n} en fin de période, ${short} de moins que l'objectif", {
                    n: value(outlook.projected), short: value(outlook.short),
                }));
            }
        }
        if (projection && outlook.projected !== null && !(outlook.goal && outlook.short !== null)) {
            lines.push(t('À ce rythme : ${n} en fin de période', { n: value(outlook.projected) }));
        }
        return { progress, lines };
    }

    // Titre par défaut d'un graphique sans titre : « Trouvailles par
    // année », « Caches actives par mois ». Une autre mesure qu'un compte,
    // hors des trouvailles, nomme sa source : « Visiteurs différents par
    // mois — Trouvailles reçues ».
    function defaultTitle(spec) {
        const source = spec.source || 'finds';
        let name = measureName(spec.measure, source);
        const others = spec.extraSources || [];
        if (others.length) {
            name = [source, ...others].map(sourceNoun).join(' / ');
            if (spec.measure.op !== 'count') name = measureName(spec.measure, source) + ' — ' + name;
        } else if (spec.measure.op !== 'count' && spec.measure.op !== 'active' && source !== 'finds') {
            name = name + ' — ' + sourceNoun(source);
        }
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
        questionGroup: (group) => QUESTION_GROUPS[group] || group,
        layout: (layout) => LAYOUTS[layout] || layout,
        align: (align, unit) => (align === 'elapsed' ? ELAPSED_ALIGN[unit] || ELAPSED_ALIGN.day : ALIGNS[align]) || align,
        normalize: (mode) => NORMALIZE[mode] || mode,
        palette: (palette) => PALETTES[palette] || palette,
        filterField,
        filterValue,
        monthNames,
        weekdayNames,
        axisLabel,
        periodLabel,
        seriesPeriodLabel,
        comparedTo,
        comparedToSource,
        sourceLabel,
        sourceNoun,
        elapsedLabel,
        dateInUnit,
        periodChoiceLabel,
        formatValue,
        valueUnit,
        formatDelta,
        formatRatio,
        defaultTitle,
        challengeLines,
        challengeCellLabel,
        recordText,
        outlookLines,
    };
}
