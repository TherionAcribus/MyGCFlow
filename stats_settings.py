"""Panneaux de statistiques posés sur la carte : réglages persistés.

Préférence GLOBALE (bloc `stats` de settings.json), jamais une section de
thème : changer de thème ne doit pas faire disparaître les panneaux.

Miroir exact de `normalizeStatsSettings` (static/js/stats_model.mjs) : les deux
côtés passent les mêmes vecteurs de test (tests/fixtures/stats/settings_cases.json),
toute règle modifiée ici doit l'être là-bas.

Les options d'un panneau dépendent de son type (`kind`) et leurs valeurs par
défaut de sa métrique : un schéma par type plutôt qu'une dataclass figée qui
porterait les options de tous les types à la fois.
"""

from __future__ import annotations

import math
import re
import uuid
from dataclasses import dataclass, field

STATS_MAX_PANELS = 6

STATS_METRICS_BY_KIND = {
    # Grilles : matrice D/T 9×9, Jasmer (année × mois de publication),
    # trouvailles mois × année (mêmes clés que Jasmer, sur la date de
    # trouvaille), calendrier 366 (mois × jour de trouvaille), année
    # d'activité (semaines × jours, façon contributions GitHub).
    "grid": ("dt", "jasmer", "finds_ym", "calendar", "activity"),
    "bar": ("cache_type", "container", "difficulty", "terrain", "year", "month", "weekday", "age", "country", "state", "attribute", "owner"),
    # Anneau (camembert si le trou vaut 0) : catégories seulement.
    "donut": ("cache_type", "container", "country", "state", "attribute", "owner"),
    # Courbe des trouvailles cumulées.
    "line": ("cumulative",),
    # Tuiles de chiffres clés (cf. STATS_COUNTER_ITEMS).
    "counter": ("summary",),
}

# Mode Évolution (page /evolution) : le jeu compte des CACHES (poses et
# archivages), pas des trouvailles. Registre distinct et liste de panneaux
# propre (`evolution_panels`) ; la normalisation accepte l'union des deux
# registres, le rendu filtre par mode (visiblePanels côté client).
EVOLUTION_METRICS_BY_KIND = {
    "grid": (),
    "bar": ("cache_type", "container", "difficulty", "terrain", "country", "state", "county", "status", "lifetime"),
    "donut": ("cache_type", "container", "country", "state", "county", "status"),
    "line": ("actives", "placees", "archivees"),
    "counter": ("summary",),
}

# Univers comptés par un panneau catégoriel Évolution (« Compter ») :
# 'active' = caches présentes à la date affichée (ensemble vivant),
# 'placed'/'archived' = cumuls monotone des événements.
STATS_COUNTED = ("active", "placed", "archived")

STATS_KINDS = tuple(STATS_METRICS_BY_KIND)

STATS_ANCHORS = (
    "top-left", "top-center", "top-right",
    "middle-left", "middle-center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
)
# « anchor » : coin + marges, empilé avec les panneaux du même coin ; « free » :
# glissé à la souris, position normalisée (x, y) dans l'espace libre du cadre.
STATS_POSITION_MODES = ("anchor", "free")

STATS_HIGHLIGHTS = ("new", "every", "none")
STATS_CELL_MODES = ("count", "filled", "heat")
# « race » : course de barres, l'ordre suit l'état courant et les lignes se
# doublent en glissant.
STATS_SORTS = ("natural", "count", "label", "race")
STATS_ORIENTATIONS = ("horizontal", "vertical")
# « multi » : une couleur distincte par catégorie (anneaux hors types).
STATS_PALETTES = ("gc", "accent", "heat", "multi")
STATS_COUNTER_ITEMS = ("total", "days", "best_day", "streak", "types", "countries", "states", "attributes", "owners", "oldest", "same_day", "north", "south", "east", "west")
# Tuiles du mode Évolution : compteurs de la chronologie (actives, cumuls
# placées/archivées, pic d'actives) et catégories distinctes de l'ensemble
# actif (types, pays, régions — mêmes clés qu'en mode principal).
EVOLUTION_COUNTER_ITEMS = ("actives", "placees", "archivees", "peak", "types", "countries", "states", "age_moyen")
_ALL_COUNTER_ITEMS = STATS_COUNTER_ITEMS + EVOLUTION_COUNTER_ITEMS

STATS_OFFSET_RANGE = (0, 2000)
STATS_WIDTH_RANGE = (120, 1200)
# Hauteur optionnelle d'un panneau (px CSS) : None = hauteur automatique,
# déduite de la largeur et du contenu (measureStatsPanel côté client).
STATS_HEIGHT_RANGE = (60, 1200)
STATS_MAX_ITEMS_RANGE = (3, 30)
STATS_OPACITY_RANGE = (0, 100)
STATS_FONT_SIZE_RANGE = (8, 32)
STATS_RADIUS_RANGE = (0, 40)
STATS_HOLE_RANGE = (0, 85)
STATS_COLUMNS_RANGE = (1, 3)
STATS_TITLE_MAX = 80
# Configurations nommées : instantanés de la liste de panneaux.
STATS_MAX_CONFIGS = 12
STATS_CONFIG_NAME_MAX = 40
# Mode de la page où la configuration a été enregistrée (mêmes valeurs que
# le « mode » du JSON exporté côté client) ; « finds » par défaut — les
# configurations antérieures viennent de la page principale.
STATS_CONFIG_MODES = ("finds", "evolution")

# Toujours appliquées par fullmatch, en classes ASCII explicites : `$` admet
# un saut de ligne final et `\d` les chiffres non latins en Python, pas en JS.
_ID_RE = re.compile(r"[0-9a-f]{6,32}")
_HEX_RE = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})")
# Chaîne numérique simple : « 12 », « -3 », « 12.5 ». Rien d'autre (« 0x10 »,
# « 1e3 », « » vide) — le client applique exactement la même règle.
_NUMERIC_RE = re.compile(r"[ \t]*-?[0-9]+(?:\.[0-9]+)?[ \t]*")


@dataclass
class StatsSettings:
    # Interrupteur général : coupe tous les panneaux sans perdre leur réglage.
    enabled: bool = True
    # Panneaux normalisés (dict), dans l'ordre de dessin et d'empilement.
    panels: list = field(default_factory=list)
    # Liste propre au mode Évolution (/evolution), même schéma.
    evolution_panels: list = field(default_factory=list)
    # Configurations nommées : {name, mode, panels}, instantanés de la liste.
    configs: list = field(default_factory=list)


def _round_half_up(value: float) -> int:
    # Math.round côté client : arrondi au demi supérieur, y compris en négatif
    # (round() de Python arrondit au pair, 2.5 → 2, là où le client dit 3).
    return int(math.floor(value + 0.5))


def _number(value):
    """Nombre fini lu d'un nombre JSON ou d'une chaîne numérique simple, sinon None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str) and _NUMERIC_RE.fullmatch(value):
        number = float(value)
    else:
        return None
    return number if math.isfinite(number) else None


def _int_in(value, default: int, bounds: tuple) -> int:
    number = _number(value)
    if number is None:
        return default
    return max(bounds[0], min(bounds[1], _round_half_up(number)))


def _unit(value, default: float) -> float:
    """Fraction [0, 1] arrondie à 1e-4, même opération que le client."""
    number = _number(value)
    if number is None:
        return default
    number = max(0.0, min(1.0, number))
    return math.floor(number * 10000 + 0.5) / 10000


def _bool(value, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _choice(value, choices: tuple, default: str) -> str:
    return value if isinstance(value, str) and value in choices else default


def _choices(value, choices: tuple, default: list) -> list:
    """Liste de choix connus, sans doublon, dans l'ordre donné ; vide ou
    invalide → défaut (un panneau de compteurs sans compteur n'a pas de sens)."""
    if not isinstance(value, list):
        return list(default)
    out = []
    for item in value:
        if isinstance(item, str) and item in choices and item not in out:
            out.append(item)
    return out or list(default)


def _color(value, default: str) -> str:
    # Forme longue seulement en sortie : le sélecteur couleur HTML n'accepte
    # pas « #abc ».
    if not (isinstance(value, str) and _HEX_RE.fullmatch(value)):
        return default
    if len(value) == 4:
        value = "#" + "".join(c * 2 for c in value[1:])
    return value


def _title(value) -> str:
    if not isinstance(value, str):
        return ""
    # Aplati puis blancs de bord enlevés, comme _config_name : un titre
    # réduit à des espaces est vide et retombe sur le titre par défaut.
    flat = value.replace("\r\n", " ").replace("\r", " ").replace("\n", " ").strip()
    return flat[:STATS_TITLE_MAX]


def _config_name(value) -> str:
    # Aplati comme un titre, blancs de bord enlevés : un nom vide écarte
    # la configuration.
    if not isinstance(value, str):
        return ""
    flat = value.replace("\r\n", " ").replace("\r", " ").replace("\n", " ").strip()
    return flat[:STATS_CONFIG_NAME_MAX]


_CATEGORICAL = ("cache_type", "container", "country", "state", "county", "status", "attribute", "owner")

_DEFAULT_WIDTH = {"grid": 280, "bar": 280, "donut": 300, "line": 320, "counter": 280}
# Année d'activité : 53 semaines en colonnes, illisible à 280 px.
_ACTIVITY_WIDTH = 520


def stats_panel_defaults(kind: str, metric: str) -> dict:
    """Valeurs par défaut d'un panneau, qui dépendent de son type et de sa métrique.

    Les grandeurs ordonnées (tailles, D/T, années) gardent leur ordre naturel ;
    les catégories sans ordre propre (types, pays, régions) sont triées par
    nombre de trouvailles.
    """
    if kind == "grid":
        options = {
            "show_percent": False,
            "highlight": "new",
            # Année d'activité : intensité selon le nombre du jour. Même
            # traitement pour les trouvailles mois × année (comptage dense) ;
            # les défis à cases (D/T, Jasmer, calendrier) restent
            # « remplie ou vide ».
            "cell_mode": "count" if metric == "dt" else "heat" if metric in ("activity", "finds_ym") else "filled",
            "show_coverage": True,
            "show_loops": False,
        }
        palette = "heat"
    elif kind == "bar":
        options = {
            "show_values": True,
            "show_percent": False,
            "highlight": "new",
            "sort": "count" if metric in ("cache_type", "country", "state", "county", "status", "attribute", "owner") else "natural",
            # Âge et durée de vie : grandeurs ordonnées, mais libellés
            # longs (« 6 à 12 mois », « 5 à 10 ans »).
            "orientation": "horizontal" if metric in _CATEGORICAL or metric in ("age", "lifetime") else "vertical",
            "max_items": 8,
            "hide_empty": False,
        }
        palette = "gc" if metric == "cache_type" else "accent"
    elif kind == "donut":
        options = {
            "show_values": True,
            "show_percent": True,
            "highlight": "new",
            "max_items": 6,
            "hole": 55,
            "show_legend": True,
        }
        palette = "gc" if metric == "cache_type" else "multi"
    elif kind == "line":
        options = {
            "show_values": True,
            "highlight": "every",
            "show_area": True,
            "show_milestones": True,
        }
        palette = "accent"
    else:
        options = {
            "highlight": "every",
            "items": ["total", "days", "best_day", "streak", "types"],
            "columns": 2,
        }
        palette = "accent"
    return {
        "enabled": True,
        "show_title": True,
        "title": "",
        "position": {
            "mode": "anchor", "anchor": "top-left", "dx": 16, "dy": 16,
            "width": _ACTIVITY_WIDTH if metric == "activity" else _DEFAULT_WIDTH.get(kind, 280),
            "height": None, "x": 0, "y": 0,
        },
        "options": options,
        "style": {
            "background": "#0b1a2b",
            "background_opacity": 85,
            "text_color": "#ffffff",
            "accent_color": "#29d34e",
            "palette": palette,
            "font_size": 12,
            "radius": 10,
            "inherit_font": True,
        },
    }


# Coercition d'une option selon son nom : seules les options du schéma du type
# survivent, une option étrangère (sort sur une grille…) est supprimée.
_OPTION_COERCERS = {
    "show_values": lambda v, d: _bool(v, d),
    "show_percent": lambda v, d: _bool(v, d),
    "highlight": lambda v, d: _choice(v, STATS_HIGHLIGHTS, d),
    "cell_mode": lambda v, d: _choice(v, STATS_CELL_MODES, d),
    "show_coverage": lambda v, d: _bool(v, d),
    "show_loops": lambda v, d: _bool(v, d),
    "sort": lambda v, d: _choice(v, STATS_SORTS, d),
    "orientation": lambda v, d: _choice(v, STATS_ORIENTATIONS, d),
    "max_items": lambda v, d: _int_in(v, d, STATS_MAX_ITEMS_RANGE),
    "hide_empty": lambda v, d: _bool(v, d),
    "hole": lambda v, d: _int_in(v, d, STATS_HOLE_RANGE),
    "show_legend": lambda v, d: _bool(v, d),
    "show_area": lambda v, d: _bool(v, d),
    "show_milestones": lambda v, d: _bool(v, d),
    "items": lambda v, d: _choices(v, _ALL_COUNTER_ITEMS, d),
    "counted": lambda v, d: _choice(v, STATS_COUNTED, d),
    "columns": lambda v, d: _int_in(v, d, STATS_COLUMNS_RANGE),
}

_POSITION_COERCERS = {
    "mode": lambda v, d: _choice(v, STATS_POSITION_MODES, d),
    "anchor": lambda v, d: _choice(v, STATS_ANCHORS, d),
    "dx": lambda v, d: _int_in(v, d, STATS_OFFSET_RANGE),
    "dy": lambda v, d: _int_in(v, d, STATS_OFFSET_RANGE),
    "width": lambda v, d: _int_in(v, d, STATS_WIDTH_RANGE),
    # Hauteur imposée, nullable : None (ou non numérique) = automatique ;
    # un nombre est borné comme la largeur (0 → 60, pas annulé).
    "height": lambda v, d: None if v is None else _int_in(v, None, STATS_HEIGHT_RANGE),
    "x": _unit,
    "y": _unit,
}

_STYLE_COERCERS = {
    "background": _color,
    "background_opacity": lambda v, d: _int_in(v, d, STATS_OPACITY_RANGE),
    "text_color": _color,
    "accent_color": _color,
    "palette": lambda v, d: _choice(v, STATS_PALETTES, d),
    "font_size": lambda v, d: _int_in(v, d, STATS_FONT_SIZE_RANGE),
    "radius": lambda v, d: _int_in(v, d, STATS_RADIUS_RANGE),
    "inherit_font": lambda v, d: _bool(v, d),
}


def _coerce_block(raw, defaults: dict, coercers: dict) -> dict:
    source = raw if isinstance(raw, dict) else {}
    return {key: coercers[key](source.get(key), default) for key, default in defaults.items()}


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def coerce_stats_panel(raw) -> dict | None:
    """Panneau normalisé, ou None s'il n'est pas représentable.

    Type ou métrique inconnus, ou combinaison invalide (grille « year ») :
    le panneau est écarté plutôt que deviné. L'identifiant est vérifié par
    coerce_stats_settings (unicité sur la liste)."""
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    metric = raw.get("metric")
    if kind not in STATS_METRICS_BY_KIND:
        return None
    # Union des deux registres : les panneaux du mode Évolution vivent dans
    # la même liste, le rendu filtre par mode.
    if metric not in STATS_METRICS_BY_KIND[kind] and metric not in EVOLUTION_METRICS_BY_KIND.get(kind, ()):
        return None
    defaults = stats_panel_defaults(kind, metric)
    options = _coerce_block(raw.get("options"), defaults["options"], _OPTION_COERCERS)
    # « Compter » (univers actives/placées/archivées) : option des barres et
    # anneaux en mode Évolution, conservée seulement si fournie — les
    # panneaux du mode principal ne la portent pas (absent = 'active').
    raw_options = raw.get("options")
    if kind in ("bar", "donut") and isinstance(raw_options, dict) and "counted" in raw_options:
        options["counted"] = _OPTION_COERCERS["counted"](raw_options["counted"], "active")
    raw_id = raw.get("id")
    return {
        "id": raw_id if isinstance(raw_id, str) and _ID_RE.fullmatch(raw_id) else "",
        "kind": kind,
        "metric": metric,
        "enabled": _bool(raw.get("enabled"), defaults["enabled"]),
        "show_title": _bool(raw.get("show_title"), defaults["show_title"]),
        "title": _title(raw.get("title")),
        "position": _coerce_block(raw.get("position"), defaults["position"], _POSITION_COERCERS),
        "options": options,
        "style": _coerce_block(raw.get("style"), defaults["style"], _STYLE_COERCERS),
    }


def _coerce_panel_list(source) -> list:
    """Liste de panneaux normalisée : invalides écartés, identifiants manquants
    ou en double régénérés, tronquée à STATS_MAX_PANELS."""
    panels = []
    seen = set()
    for item in source if isinstance(source, list) else []:
        panel = coerce_stats_panel(item)
        if panel is None:
            continue
        if not panel["id"] or panel["id"] in seen:
            panel["id"] = _new_id()
            while panel["id"] in seen:
                panel["id"] = _new_id()
        seen.add(panel["id"])
        panels.append(panel)
        if len(panels) >= STATS_MAX_PANELS:
            break
    return _share_corner_margins(panels)


def _share_corner_margins(panels: list) -> list:
    """Marges de coin : les panneaux ancrés à un même coin forment une pile qui
    partage ses marges (dx, dy) — celles du premier de la liste, désactivé ou
    non. Les panneaux d'une pile sont séparés d'un écart fixe côté client
    (layoutPanels) : réordonner une pile ne la déplace plus. Les panneaux
    libres gardent les leurs."""
    margins = {}
    for panel in panels:
        position = panel["position"]
        if position["mode"] != "anchor":
            continue
        first = margins.get(position["anchor"])
        if first is None:
            margins[position["anchor"]] = (position["dx"], position["dy"])
        else:
            position["dx"], position["dy"] = first
    return panels


def coerce_stats_config(raw) -> dict | None:
    """Configuration nommée normalisée {name, mode, panels}, ou None si le nom
    est vide après aplatissement. Les panneaux suivent les mêmes règles que la
    liste courante (identifiants uniques dans la configuration). « mode »
    retient la page d'enregistrement : une configuration de l'autre mode est
    marquée dans le menu et non applicable (stats_ui › renderConfigMenu)."""
    if not isinstance(raw, dict):
        return None
    name = _config_name(raw.get("name"))
    if not name:
        return None
    return {
        "name": name,
        "mode": _choice(raw.get("mode"), STATS_CONFIG_MODES, "finds"),
        "panels": _coerce_panel_list(raw.get("panels")),
    }


def coerce_stats_settings(raw, current: StatsSettings | None = None) -> StatsSettings:
    """Bloc `stats` normalisé.

    Patch de premier niveau : une clé absente (`enabled`, `panels`, `configs`)
    garde la valeur courante. Les panneaux invalides sont écartés sans rejeter
    les autres ; au-delà de STATS_MAX_PANELS, la liste est tronquée. Un
    identifiant manquant ou déjà vu est régénéré. Configurations : premier
    nom gagnant (un doublon serait impossible à distinguer), au-delà de
    STATS_MAX_CONFIGS la liste est tronquée."""
    base = current if isinstance(current, StatsSettings) else StatsSettings()
    if not isinstance(raw, dict):
        return StatsSettings(
            enabled=base.enabled, panels=list(base.panels),
            evolution_panels=list(base.evolution_panels), configs=list(base.configs))

    enabled = _bool(raw.get("enabled"), base.enabled)
    panels = _coerce_panel_list(raw["panels"] if "panels" in raw else base.panels)
    evolution_panels = _coerce_panel_list(
        raw["evolution_panels"] if "evolution_panels" in raw else base.evolution_panels)
    configs = []
    names = set()
    config_source = raw["configs"] if "configs" in raw else base.configs
    for item in config_source if isinstance(config_source, list) else []:
        config = coerce_stats_config(item)
        if config is None or config["name"] in names:
            continue
        names.add(config["name"])
        configs.append(config)
        if len(configs) >= STATS_MAX_CONFIGS:
            break
    return StatsSettings(enabled=enabled, panels=panels,
                         evolution_panels=evolution_panels, configs=configs)
