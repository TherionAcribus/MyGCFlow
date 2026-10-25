"""Flashs par événement de la page Mes poses (docs/mode-poses.md).

Chaque type d'événement de la vie d'une cache (publication, trouvaille,
favori, désactivation, archivage…) a son flash, réglé dans le thème
(`flash.events.<type>`) : forme, taille, couleur, contour — comme le flash de
disparition du mode Évolution. Ce module est la source de vérité des types,
de leur ordre (priorité : un seul flash par cache et par jour, le plus
marquant l'emporte), de leurs défauts et des formes permises. Le client a sa
copie dans static/js/event_flash.mjs ; tests/test_event_flash.py écrit la
table dans tests/fixtures/flash/event_flash_kinds.json, que le test JS
compare à la sienne.

Une table, pas une classe par type : ajouter un type ne demande qu'une
ligne ici, une dans le module JS et une ligne de gabarit.
"""

from __future__ import annotations

import re

try:  # libellés traduits à l'affichage (Flask-Babel) ; module utilisable sans
    from flask_babel import lazy_gettext as _l
except Exception:  # pragma: no cover - tests unitaires sans Babel
    def _l(text):
        return text

# Formes permises : celles du flash d'apparition, plus « same » (reprend le
# flash principal du thème) et le feu d'artifice.
EVENT_FLASH_MODES = (
    "same", "none", "circle", "implode", "echo", "target", "star", "sparkle",
    "square", "triangle", "diamond", "fireworks",
)
EVENT_COLOR_TYPES = ("gc", "none", "fix")
EVENT_BORDER_TYPES = ("auto", "gc", "none", "fix")
EVENT_SIZE_RANGE = (5, 200)
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _defaults(mode, size, color, color_type="fix"):
    return {"mode": mode, "size": size, "color": color, "color_type": color_type,
            "border_color": "#ffffff", "border_color_type": "auto"}


# (type, libellé, défauts), dans l'ordre de priorité décroissante.
EVENT_FLASH_KINDS = (
    ("archive", _l("Archivage"), _defaults("implode", 40, "#616161")),
    ("disable", _l("Désactivation"), _defaults("implode", 30, "#9e9e9e")),
    ("enable", _l("Réactivation"), _defaults("echo", 30, "#66bb6a")),
    ("publish", _l("Publication"), _defaults("same", 40, "#ffffff")),
    ("alert", _l("Signalement (maintenance demandée)"), _defaults("target", 30, "#ff9800")),
    ("maintenance", _l("Maintenance du poseur"), _defaults("sparkle", 28, "#43a047")),
    ("ftf", _l("Première trouvaille"), _defaults("fireworks", 34, "#009dff")),
    ("favorite", _l("Point favori"), _defaults("star", 36, "#ffc107")),
    ("find", _l("Trouvaille"), _defaults("circle", 20, "#ffffff", "gc")),
    ("dnf", _l("DNF"), _defaults("circle", 20, "#263238")),
    ("note", _l("Note"), _defaults("none", 16, "#90a4ae")),
    ("reviewer", _l("Note du relecteur"), _defaults("none", 16, "#7e57c2")),
)
EVENT_FLASH_KEYS = tuple(kind for kind, _label, _d in EVENT_FLASH_KINDS)
_DEFAULTS = {kind: d for kind, _label, d in EVENT_FLASH_KINDS}


def event_flash_defaults() -> dict:
    """Bloc `flash.events` par défaut (copie modifiable)."""
    return {kind: dict(d) for kind, d in _DEFAULTS.items()}


def _clamp_size(value, default):
    if isinstance(value, bool):
        return default
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return default
    return max(EVENT_SIZE_RANGE[0], min(EVENT_SIZE_RANGE[1], number))


def _color(value, default):
    return value.lower() if isinstance(value, str) and _HEX_RE.match(value) else default


def _choice(value, allowed, default):
    return value if value in allowed else default


def coerce_event_flash(raw, current: dict) -> dict:
    src = raw if isinstance(raw, dict) else {}
    return {
        "mode": _choice(src.get("mode"), EVENT_FLASH_MODES, current["mode"]),
        "size": _clamp_size(src.get("size"), current["size"]),
        "color": _color(src.get("color"), current["color"]),
        "color_type": _choice(src.get("color_type"), EVENT_COLOR_TYPES, current["color_type"]),
        "border_color": _color(src.get("border_color"), current["border_color"]),
        "border_color_type": _choice(src.get("border_color_type"), EVENT_BORDER_TYPES, current["border_color_type"]),
    }


def coerce_event_flashes(raw, current: dict | None = None) -> dict:
    """Bloc `flash.events` normalisé : chaque type connu (défauts pour les
    absents ou invalides, valeur courante pour les champs absents), types
    inconnus écartés. Un thème antérieur à Mes poses reçoit les défauts."""
    base = current if isinstance(current, dict) else {}
    src = raw if isinstance(raw, dict) else {}
    out = {}
    for kind in EVENT_FLASH_KEYS:
        existing = base.get(kind) if isinstance(base.get(kind), dict) else None
        merged = coerce_event_flash(existing, _DEFAULTS[kind]) if existing else dict(_DEFAULTS[kind])
        out[kind] = coerce_event_flash(src.get(kind), merged)
    return out


def scale_event_flash_sizes(events: dict, factor: float) -> dict:
    """Tailles × facteur (copie d'un thème vers un autre mode)."""
    out = {}
    for kind, value in (events or {}).items():
        item = dict(value)
        item["size"] = _clamp_size(round(item.get("size", _DEFAULTS.get(kind, {}).get("size", 20)) * factor),
                                   _DEFAULTS.get(kind, {}).get("size", 20))
        out[kind] = item
    return out


def event_flash_kinds_for_template() -> list:
    """[{key, label, defaults}] pour le gabarit de l'onglet Flash."""
    return [{"key": kind, "label": label, "defaults": dict(d)} for kind, label, d in EVENT_FLASH_KINDS]


def event_flash_table() -> dict:
    """Table sans libellés, comparée par le test JS (dérive Python/JS)."""
    return {"kinds": list(EVENT_FLASH_KEYS), "modes": list(EVENT_FLASH_MODES),
            "defaults": {kind: dict(d) for kind, d in _DEFAULTS.items()}}
