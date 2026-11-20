"""Apparence des étapes et du trait de la page Parcours (docs/parcours.md).

Bloc du thème `points.parcours_style` :

- rendu des étapes, le même au repos et pendant la lecture : pastilles du
  parcours (couleur par nature d'étape, points du thème masqués) ou points
  du thème (numéro en petite pastille à côté) ;
- étapes : rayon des pastilles, numérotation (sur tout le parcours, par
  journée, aucune) et couleur par nature d'étape — les lieux et les bases
  gardent la leur dans les deux rendus ;
- ligne du plan entre les étapes d'une journée : pointillés, pleine, aucune ;
- trait de la lecture (et de la vidéo) : couleur, épaisseur, opacité. Le
  géocacheur en prend la couleur.

Le trait du mode principal (`trail`) ne sert plus sur cette page :
le thème étant partagé, le régler ici ne change pas la page principale.

Copie JS : static/js/parcours_style.mjs ; tests/test_parcours_style.py écrit
la table dans tests/fixtures/parcours/parcours_style.json, que le test JS
compare à la sienne.
"""

from __future__ import annotations

import re

KINDS = ("find", "lab", "dnf", "place", "base")
RENDERS = ("stops", "theme")
NUMBERS = ("trip", "day", "none")
PLAN_LINES = ("dashed", "solid", "none")

RANGES = {
    "size": (7, 18),
    "trail_width": (1, 12),
    "trail_opacity": (10, 100),
}

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def colors_defaults() -> dict:
    """Accent de l'app (trouvailles), ambre (Labs), gris (DNF), violet
    (lieux), anthracite (bases)."""
    return {
        "find": "#0072c6", "lab": "#f59f00", "dnf": "#868e96",
        "place": "#ae3ec9", "base": "#343a40",
    }


def parcours_style_defaults() -> dict:
    """Bloc du thème par défaut : pastilles du parcours au repos comme en
    lecture, numérotées sur tout le parcours."""
    return {
        "render": "stops",
        "size": 11,
        "numbers": "trip",
        "colors": colors_defaults(),
        "plan_line": "dashed",
        "trail_color": "#00b8d4",
        "trail_width": 3,
        "trail_opacity": 100,
    }


def _choice(value, allowed, default):
    return value if value in allowed else default


def _color(value, default):
    return value.lower() if isinstance(value, str) and _HEX_RE.match(value) else default


def _int(value, default, low, high):
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    return int(round(max(low, min(high, number))))


def coerce_parcours_style(raw, current: dict | None = None) -> dict:
    """Bloc normalisé : valeurs bornées, champs absents = valeur courante
    (défaut sinon)."""
    defaults = parcours_style_defaults()
    cur = current if isinstance(current, dict) else {}
    base = {**defaults, **{k: v for k, v in cur.items() if k in defaults}}
    src = raw if isinstance(raw, dict) else {}
    out = {
        "render": _choice(src.get("render"), RENDERS, base["render"]),
        "numbers": _choice(src.get("numbers"), NUMBERS, base["numbers"]),
        "plan_line": _choice(src.get("plan_line"), PLAN_LINES, base["plan_line"]),
        "trail_color": _color(src.get("trail_color"), base["trail_color"]),
    }
    for key, (low, high) in RANGES.items():
        out[key] = _int(src.get(key), base[key], low, high)
    colors_src = src.get("colors") if isinstance(src.get("colors"), dict) else {}
    colors_cur = base.get("colors") if isinstance(base.get("colors"), dict) else {}
    out["colors"] = {
        k: _color(colors_src.get(k), _color(colors_cur.get(k), defaults["colors"][k])) for k in KINDS
    }
    return {key: out[key] for key in defaults}


def parcours_style_table() -> dict:
    """Défauts, choix et bornes, comparés par le test JS."""
    return {
        "defaults": parcours_style_defaults(),
        "kinds": list(KINDS),
        "choices": {"render": list(RENDERS), "numbers": list(NUMBERS), "plan_line": list(PLAN_LINES)},
        "ranges": {key: list(r) for key, r in RANGES.items()},
    }
