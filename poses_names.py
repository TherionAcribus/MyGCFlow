"""Pseudos flottants de la page Mes poses (docs/mode-poses.md).

Quand une cache posée reçoit un log, le pseudo du visiteur apparaît près du
point, se déplace puis s'efface — sur la carte comme dans la vidéo.

Deux portées :

- bloc du thème `points.poses_names` (apparence, `poses_names_defaults`) :
  quels logs, contenu de l'étiquette, densité, mouvement (entrée, trajet,
  sortie), texte et couleurs. Désactivé par défaut : un thème antérieur garde
  son rendu ;
- préférence globale `poses_names_privacy` (`privacy_defaults`) : pseudos
  affichés tels quels, réduits aux initiales ou remplacés par « un
  visiteur », et liste de pseudos jamais affichés. Globale pour qu'un
  changement de thème ne remette jamais au jour un pseudo écarté.

`PRESETS` : styles prêts à l'emploi. Les appliquer ne touche que le mouvement
et le texte (`PRESET_KEYS`) ; quels logs, densité et couleurs par type
restent ceux du joueur.

Copie JS : static/js/poses_names.mjs ; tests/test_poses_names.py écrit la
table dans tests/fixtures/poses/poses_names.json, que le test JS compare à
la sienne.
"""

from __future__ import annotations

import re

KINDS = ("find", "dnf", "note")
GROUPINGS = ("merge", "separate")
PATHS = ("away", "toward", "still")
DIRECTIONS = ("up", "down", "left", "right", "radial", "random")
TRAJECTORIES = ("straight", "arc", "wave", "spiral")
EASINGS = ("smooth", "linear", "accelerate", "elastic")
ENTRANCES = ("none", "fade", "pop", "zoom", "typewriter", "drop")
EXITS = ("none", "fade", "shrink", "grow", "scatter", "blink")
FONTS = ("sans", "serif", "mono", "rounded", "condensed", "handwritten")
COLOR_MODES = ("fixed", "event", "finder", "cache_type")
BACKGROUNDS = ("none", "pill", "box", "bubble")
# Couleurs par type d'étiquette (mode « event ») : la plus marquante gagne
# (première trouvaille > palier > favori > visiteur fidèle > trouvaille).
COLOR_KINDS = ("find", "ftf", "milestone", "favorite", "loyal", "dnf", "note")
PRIVACY_MODES = ("show", "initials", "hidden")

RANGES = {
    "loyal_min": (2, 100),
    "max_visible": (1, 60),
    "stagger_ms": (0, 2000),
    "distance": (0, 400),
    "duration_ms": (500, 10000),
    "wobble": (0, 100),
    "tilt": (0, 45),
    "offset_y": (-80, 80),
    "size": (8, 64),
    "opacity": (10, 100),
    "outline_width": (0, 8),
    "glow": (0, 30),
    "background_opacity": (0, 100),
    "emphasis": (1.0, 2.5),
}
FLOAT_KEYS = ("emphasis",)
TEMPLATE_MAX = 80
EXCLUDE_MAX = 200
PSEUDO_MAX = 60

# Clés touchées par un style prêt à l'emploi.
PRESET_KEYS = (
    "grouping", "stagger_ms", "path", "direction", "distance", "trajectory", "easing",
    "duration_ms", "entrance", "exit", "wobble", "tilt", "offset_y", "connector",
    "font", "size", "bold", "italic", "uppercase", "color_mode", "color",
    "outline_width", "outline_color", "glow", "glow_color",
    "background", "background_color", "background_opacity",
)

_BASE_STYLE = {
    "grouping": "merge", "stagger_ms": 150, "path": "away", "direction": "up",
    "distance": 60, "trajectory": "straight", "easing": "smooth", "duration_ms": 2200,
    "entrance": "fade", "exit": "fade", "wobble": 0, "tilt": 0, "offset_y": -14,
    "connector": False, "font": "sans", "size": 14, "bold": True, "italic": False,
    "uppercase": False, "color_mode": "fixed", "color": "#ffffff",
    "outline_width": 3, "outline_color": "#000000", "glow": 0, "glow_color": "#ffffff",
    "background": "none", "background_color": "#000000", "background_opacity": 55,
}

PRESETS = {
    # Le pseudo s'élève doucement au-dessus de la cache.
    "rise": dict(_BASE_STYLE),
    # Bulle de dialogue posée sur la cache.
    "bubbles": {**_BASE_STYLE, "path": "still", "entrance": "pop", "exit": "shrink",
                "duration_ms": 2600, "offset_y": -22, "outline_width": 0,
                "background": "bubble", "background_color": "#ffffff", "background_opacity": 92,
                "color": "#263238", "size": 13},
    # Les visiteurs du jour jaillissent dans toutes les directions.
    "burst": {**_BASE_STYLE, "grouping": "separate", "stagger_ms": 80, "direction": "radial",
              "distance": 90, "trajectory": "arc", "entrance": "zoom", "exit": "scatter",
              "duration_ms": 2400, "offset_y": 0, "color_mode": "finder"},
    # Les pseudos arrivent de loin et se posent sur la cache.
    "landing": {**_BASE_STYLE, "path": "toward", "direction": "random", "distance": 160,
                "trajectory": "arc", "exit": "shrink", "duration_ms": 2600, "offset_y": -12,
                "connector": False},
    # Lettre à lettre, sur une étiquette sombre.
    "typewriter": {**_BASE_STYLE, "path": "still", "entrance": "typewriter", "exit": "fade",
                   "duration_ms": 3000, "offset_y": -20, "font": "mono", "bold": False,
                   "outline_width": 0, "background": "box", "background_opacity": 70,
                   "color": "#c5e1a5", "connector": True},
    # Gros, coloré selon l'événement, qui rebondit.
    "arcade": {**_BASE_STYLE, "entrance": "pop", "exit": "grow", "easing": "elastic",
               "duration_ms": 1800, "distance": 45, "wobble": 30, "uppercase": True,
               "size": 16, "outline_width": 4, "color_mode": "event"},
    # Emportés par le vent, en ondulant.
    "leaves": {**_BASE_STYLE, "direction": "right", "distance": 120, "trajectory": "wave",
               "easing": "linear", "duration_ms": 3500, "wobble": 60, "tilt": 20,
               "font": "serif", "bold": False, "italic": True, "outline_width": 2,
               "offset_y": -8},
    # Tourbillon autour de la cache.
    "swirl": {**_BASE_STYLE, "grouping": "separate", "stagger_ms": 120, "direction": "radial",
              "distance": 70, "trajectory": "spiral", "duration_ms": 3000, "offset_y": 0,
              "glow": 12, "glow_color": "#ffd54f", "outline_width": 2, "color_mode": "finder"},
}

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def kind_colors_defaults() -> dict:
    return {
        "find": "#a5d6a7", "ftf": "#ffd54f", "milestone": "#b388ff", "favorite": "#ff80ab",
        "loyal": "#4fc3f7", "dnf": "#90caf9", "note": "#cfd8dc",
    }


def poses_names_defaults() -> dict:
    """Bloc du thème par défaut : désactivé, style « rise »."""
    return {
        "enabled": False,
        "kinds": {"find": True, "dnf": False, "note": False},
        "only_notable": False,
        "loyal_min": 3,
        "template": "{pseudo}",
        "badges": True,
        "max_visible": 12,
        "avoid_overlap": True,
        "emphasis": 1.3,
        **dict(_BASE_STYLE),
        "opacity": 100,
        "kind_colors": kind_colors_defaults(),
    }


def privacy_defaults() -> dict:
    """Préférence globale : pseudos affichés, aucune exclusion."""
    return {"mode": "show", "exclude": []}


def _bool(value, default):
    return value if isinstance(value, bool) else default


def _choice(value, allowed, default):
    return value if value in allowed else default


def _color(value, default):
    return value.lower() if isinstance(value, str) and _HEX_RE.match(value) else default


def _number(value, default, low, high, *, integer):
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    number = max(low, min(high, number))
    return int(round(number)) if integer else round(number, 2)


def _template(value, default):
    if not isinstance(value, str):
        return default
    # Une seule ligne : les retours à la ligne deviennent des espaces.
    return value.replace("\r", " ").replace("\n", " ")[:TEMPLATE_MAX]


def _section(raw, key):
    value = raw.get(key) if isinstance(raw, dict) else None
    return value if isinstance(value, dict) else {}


_CHOICES = {
    "grouping": GROUPINGS, "path": PATHS, "direction": DIRECTIONS,
    "trajectory": TRAJECTORIES, "easing": EASINGS, "entrance": ENTRANCES, "exit": EXITS,
    "font": FONTS, "color_mode": COLOR_MODES, "background": BACKGROUNDS,
}
_BOOLS = ("enabled", "only_notable", "badges", "avoid_overlap", "connector", "bold", "italic", "uppercase")
_COLORS = ("color", "outline_color", "glow_color", "background_color")


def coerce_poses_names(raw, current: dict | None = None) -> dict:
    """Bloc normalisé : valeurs bornées, champs absents = valeur courante
    (défaut sinon)."""
    defaults = poses_names_defaults()
    # Un bloc courant incomplet (thème d'une version antérieure) est d'abord
    # complété par les défauts.
    cur = current if isinstance(current, dict) else {}
    base = {**defaults, **{k: v for k, v in cur.items() if k in defaults}}
    src = raw if isinstance(raw, dict) else {}
    out = {}
    for key in _BOOLS:
        out[key] = _bool(src.get(key), base[key])
    for key, allowed in _CHOICES.items():
        out[key] = _choice(src.get(key), allowed, base[key])
    for key in _COLORS:
        out[key] = _color(src.get(key), base[key])
    for key, (low, high) in RANGES.items():
        out[key] = _number(src.get(key), base[key], low, high, integer=key not in FLOAT_KEYS)
    out["template"] = _template(src.get("template"), base["template"])
    kinds_src, kinds_cur = _section(src, "kinds"), base.get("kinds") or defaults["kinds"]
    out["kinds"] = {k: _bool(kinds_src.get(k), kinds_cur.get(k, defaults["kinds"][k])) for k in KINDS}
    colors_src = _section(src, "kind_colors")
    colors_cur = base.get("kind_colors") or defaults["kind_colors"]
    out["kind_colors"] = {
        k: _color(colors_src.get(k), colors_cur.get(k, defaults["kind_colors"][k])) for k in COLOR_KINDS
    }
    return {key: out[key] for key in defaults}


def with_preset(names: dict, preset: str) -> dict:
    """Copie dont le mouvement et le texte sont ceux du style `preset`."""
    out = coerce_poses_names(names)
    style = PRESETS.get(preset)
    if not style:
        return out
    for key in PRESET_KEYS:
        out[key] = style[key]
    return out


def coerce_names_privacy(raw, current: dict | None = None) -> dict:
    """Préférence globale normalisée : mode connu, exclusions sans doublon
    (casse ignorée), bornées en nombre et en longueur."""
    base = current if isinstance(current, dict) else privacy_defaults()
    src = raw if isinstance(raw, dict) else {}
    mode = _choice(src.get("mode"), PRIVACY_MODES, base.get("mode", "show"))
    raw_exclude = src.get("exclude", base.get("exclude", []))
    if isinstance(raw_exclude, str):
        raw_exclude = re.split(r"[\n,;]", raw_exclude)
    exclude, seen = [], set()
    for item in raw_exclude if isinstance(raw_exclude, list) else []:
        if not isinstance(item, str):
            continue
        name = item.strip()[:PSEUDO_MAX]
        key = name.casefold()
        if not name or key in seen:
            continue
        seen.add(key)
        exclude.append(name)
        if len(exclude) >= EXCLUDE_MAX:
            break
    return {"mode": mode, "exclude": exclude}


def poses_names_table() -> dict:
    """Défauts, choix, bornes et styles, comparés par le test JS."""
    return {
        "defaults": poses_names_defaults(),
        "privacy_defaults": privacy_defaults(),
        "presets": {name: dict(style) for name, style in PRESETS.items()},
        "preset_keys": list(PRESET_KEYS),
        "choices": {key: list(values) for key, values in _CHOICES.items()},
        "kinds": list(KINDS),
        "color_kinds": list(COLOR_KINDS),
        "privacy_modes": list(PRIVACY_MODES),
        "ranges": {key: list(r) for key, r in RANGES.items()},
        "template_max": TEMPLATE_MAX,
        "exclude_max": EXCLUDE_MAX,
        "pseudo_max": PSEUDO_MAX,
    }
