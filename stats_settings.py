"""Panneaux de statistiques posés sur la carte : réglages persistés.

Préférence GLOBALE (bloc `stats` de settings.json), jamais une section de
thème : changer de thème ne doit pas faire disparaître les panneaux.

Miroir exact de `normalizeStatsSettings` (static/js/stats_model.mjs) : les deux
côtés passent les mêmes vecteurs de test (tests/fixtures/stats_settings_cases.json),
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
    # calendrier 366 (mois × jour de trouvaille).
    "grid": ("dt", "jasmer", "calendar"),
    "bar": ("cache_type", "container", "difficulty", "terrain", "year"),
}
STATS_KINDS = tuple(STATS_METRICS_BY_KIND)

STATS_ANCHORS = (
    "top-left", "top-center", "top-right",
    "middle-left", "middle-center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
)

STATS_HIGHLIGHTS = ("new", "every", "none")
STATS_CELL_MODES = ("count", "filled", "heat")
STATS_SORTS = ("natural", "count", "label")
STATS_ORIENTATIONS = ("horizontal", "vertical")
STATS_PALETTES = ("gc", "accent", "heat")

STATS_OFFSET_RANGE = (0, 2000)
STATS_WIDTH_RANGE = (120, 1200)
STATS_MAX_ITEMS_RANGE = (3, 30)
STATS_OPACITY_RANGE = (0, 100)
STATS_FONT_SIZE_RANGE = (8, 32)
STATS_RADIUS_RANGE = (0, 40)
STATS_TITLE_MAX = 80

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


def _round_half_up(value: float) -> int:
    # Math.round côté client : arrondi au demi supérieur, y compris en négatif
    # (round() de Python arrondit au pair, 2.5 → 2, là où le client dit 3).
    return int(math.floor(value + 0.5))


def _int_in(value, default: int, bounds: tuple) -> int:
    if isinstance(value, bool):
        number = None
    elif isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str) and _NUMERIC_RE.fullmatch(value):
        number = float(value)
    else:
        number = None
    if number is None or not math.isfinite(number):
        return default
    return max(bounds[0], min(bounds[1], _round_half_up(number)))


def _bool(value, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _choice(value, choices: tuple, default: str) -> str:
    return value if isinstance(value, str) and value in choices else default


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
    flat = value.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    return flat[:STATS_TITLE_MAX]


def stats_panel_defaults(kind: str, metric: str) -> dict:
    """Valeurs par défaut d'un panneau, qui dépendent de sa métrique.

    Les grandeurs ordonnées (tailles, D/T, années) gardent leur ordre naturel ;
    seuls les types, sans ordre propre, sont triés par nombre de trouvailles.
    """
    if kind == "grid":
        options = {
            "show_values": True,
            "show_percent": False,
            "highlight": "new",
            "cell_mode": "count" if metric == "dt" else "filled",
            "show_coverage": True,
        }
        palette = "heat"
    else:
        options = {
            "show_values": True,
            "show_percent": False,
            "highlight": "every",
            "sort": "count" if metric == "cache_type" else "natural",
            "orientation": (
                "horizontal" if metric in ("cache_type", "container") else "vertical"
            ),
            "max_items": 8,
            "hide_empty": False,
        }
        palette = "gc" if metric == "cache_type" else "accent"
    return {
        "enabled": True,
        "show_title": True,
        "title": "",
        "position": {"anchor": "top-left", "dx": 16, "dy": 16, "width": 280},
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
    "sort": lambda v, d: _choice(v, STATS_SORTS, d),
    "orientation": lambda v, d: _choice(v, STATS_ORIENTATIONS, d),
    "max_items": lambda v, d: _int_in(v, d, STATS_MAX_ITEMS_RANGE),
    "hide_empty": lambda v, d: _bool(v, d),
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
    if kind not in STATS_METRICS_BY_KIND or metric not in STATS_METRICS_BY_KIND[kind]:
        return None
    defaults = stats_panel_defaults(kind, metric)

    position_in = raw.get("position") if isinstance(raw.get("position"), dict) else {}
    pd = defaults["position"]
    position = {
        "anchor": _choice(position_in.get("anchor"), STATS_ANCHORS, pd["anchor"]),
        "dx": _int_in(position_in.get("dx"), pd["dx"], STATS_OFFSET_RANGE),
        "dy": _int_in(position_in.get("dy"), pd["dy"], STATS_OFFSET_RANGE),
        "width": _int_in(position_in.get("width"), pd["width"], STATS_WIDTH_RANGE),
    }

    options_in = raw.get("options") if isinstance(raw.get("options"), dict) else {}
    options = {
        key: _OPTION_COERCERS[key](options_in.get(key), default)
        for key, default in defaults["options"].items()
    }

    style_in = raw.get("style") if isinstance(raw.get("style"), dict) else {}
    style = {
        key: _STYLE_COERCERS[key](style_in.get(key), default)
        for key, default in defaults["style"].items()
    }

    raw_id = raw.get("id")
    return {
        "id": raw_id if isinstance(raw_id, str) and _ID_RE.fullmatch(raw_id) else "",
        "kind": kind,
        "metric": metric,
        "enabled": _bool(raw.get("enabled"), defaults["enabled"]),
        "show_title": _bool(raw.get("show_title"), defaults["show_title"]),
        "title": _title(raw.get("title")),
        "position": position,
        "options": options,
        "style": style,
    }


def coerce_stats_settings(raw, current: StatsSettings | None = None) -> StatsSettings:
    """Bloc `stats` normalisé.

    Patch de premier niveau : une clé absente (`enabled`, `panels`) garde la
    valeur courante. Les panneaux invalides sont écartés sans rejeter les
    autres ; au-delà de STATS_MAX_PANELS, la liste est tronquée. Un identifiant
    manquant ou déjà vu est régénéré."""
    base = current if isinstance(current, StatsSettings) else StatsSettings()
    if not isinstance(raw, dict):
        return StatsSettings(enabled=base.enabled, panels=list(base.panels))

    enabled = _bool(raw.get("enabled"), base.enabled)
    source = raw.get("panels") if "panels" in raw else base.panels
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
    return StatsSettings(enabled=enabled, panels=panels)
