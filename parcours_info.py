"""Fiche des caches de la page Parcours (docs/parcours.md, « Fiche des
caches »).

Bloc du thème `points.parcours_info` : ce que la fiche montre (nom, D/T,
propriétaire, PF de la fiche — au choix, ou rien), où elle s'affiche et
quand, et son apparence :

- à côté de la cache (`near`) : jamais, le temps de la visite de l'étape en
  cours (« temporaire », au moins `duration` secondes d'écran), ou sur toutes
  les étapes atteintes (« permanent » — au repos, sur toutes les étapes) ;
- ailleurs (`fixed`) : un cartouche à un bord ou dans un coin de l'image,
  qui reprend la fiche de l'étape en cours, avec la même durée ;
- design : étiquette (une ligne), fiche (titre et lignes), bandeau (couleur
  d'accent pleine) ou texte seul (liseré) ; police, taille, couleurs du
  texte et du fond, opacité du fond, accent aux couleurs de l'étape ou fixe.

Désactivée par défaut (`near` et `fixed` à « none ») : un thème antérieur
garde son rendu. Le contenu est coché par défaut sauf le propriétaire.

Copie JS : static/js/parcours_info.mjs ; tests/test_parcours_info.py écrit
la table dans tests/fixtures/parcours/parcours_info.json, que le test JS
compare à la sienne.
"""

from __future__ import annotations

import re

NEAR = ("none", "current", "all")
FIXED = ("none", "top", "bottom", "top_left", "top_right", "bottom_left", "bottom_right")
DESIGNS = ("tag", "card", "banner", "text")
FONTS = ("sans", "serif", "mono", "rounded", "condensed", "handwritten")
ACCENTS = ("stop", "fixed")
FILTERS = ("all", "favorites", "dt")
FIELDS = ("name", "dt", "owner", "favorites", "code", "type", "finds", "step")
BOOLS = ("two_lines", "places")

RANGES = {
    "duration": (1, 15),
    "size": (9, 28),
    "background_opacity": (0, 100),
    "filter_dt": (1, 5),
}

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def parcours_info_defaults() -> dict:
    """Fiche coupée (ni à côté des caches, ni ailleurs) ; nom, D/T et PF
    cochés pour le jour où elle est allumée."""
    return {
        "near": "none",
        "fixed": "none",
        "duration": 3,
        "filter": "all",
        "filter_dt": 3,
        "name": True,
        "dt": True,
        "owner": False,
        "favorites": True,
        "code": False,
        "type": False,
        "finds": False,
        "step": False,
        "two_lines": False,
        "places": False,
        "design": "card",
        "font": "sans",
        "size": 13,
        "text_color": "#212529",
        "background_color": "#ffffff",
        "background_opacity": 92,
        "accent": "stop",
        "accent_color": "#0072c6",
    }


def _choice(value, allowed, default):
    return value if value in allowed else default


def _color(value, default):
    return value.lower() if isinstance(value, str) and _HEX_RE.match(value) else default


def _bool(value, default):
    return value if isinstance(value, bool) else default


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


def coerce_parcours_info(raw, current: dict | None = None) -> dict:
    """Bloc normalisé : valeurs bornées, champs absents = valeur courante
    (défaut sinon)."""
    defaults = parcours_info_defaults()
    cur = current if isinstance(current, dict) else {}
    base = {**defaults, **{k: v for k, v in cur.items() if k in defaults}}
    src = raw if isinstance(raw, dict) else {}
    choices = {"near": NEAR, "fixed": FIXED, "design": DESIGNS, "font": FONTS, "accent": ACCENTS,
               "filter": FILTERS}
    out = {}
    for key, allowed in choices.items():
        out[key] = _choice(src.get(key), allowed, _choice(base[key], allowed, defaults[key]))
    for key in FIELDS + BOOLS:
        out[key] = _bool(src.get(key), _bool(base[key], defaults[key]))
    for key in ("text_color", "background_color", "accent_color"):
        out[key] = _color(src.get(key), _color(base[key], defaults[key]))
    for key, (low, high) in RANGES.items():
        out[key] = _int(src.get(key), _int(base[key], defaults[key], low, high), low, high)
    return {key: out[key] for key in defaults}


def parcours_info_table() -> dict:
    """Défauts, choix et bornes, comparés par le test JS."""
    return {
        "defaults": parcours_info_defaults(),
        "fields": list(FIELDS),
        "choices": {"near": list(NEAR), "fixed": list(FIXED), "design": list(DESIGNS),
                    "font": list(FONTS), "accent": list(ACCENTS), "filter": list(FILTERS)},
        "ranges": {key: list(r) for key, r in RANGES.items()},
    }
