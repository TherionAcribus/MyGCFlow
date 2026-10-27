"""Animation des points de la page Mes poses (docs/mode-poses.md).

Bloc du thème `points.poses_effects` : effets visuels propres aux caches
posées, chacun optionnel, sans effet sur les autres pages.

- `popularity` : la cache grossit à mesure qu'elle cumule des trouvailles,
  par rapport à la plus trouvée de la sélection (`relative`) ou par paliers
  fixes (`fixed`), jusqu'à `max_scale` fois sa taille ;
- `activity` : lueur derrière la cache, ravivée à chaque trouvaille, qui
  s'éteint de moitié tous les `half_life_days` jours ;
- `freshness` : une cache sans trouvaille depuis `after_days` jours pâlit
  peu à peu, jusqu'à `strength` % ; elle reprend sa couleur à la trouvaille
  suivante ;
- `milestone_flash` : flash des paliers ronds de trouvailles d'une cache
  (forme et couleur : `flash.events.milestone`) ;
- `disabled_pulse` : une cache désactivée pulse lentement ;
- `archived_style` : archivées grisées (`grey`) ou en contour seul (`ghost`).

`level` résume les effets cochés : un préréglage (`sober`, `balanced`,
`rich`) quand ils correspondent exactement, `custom` sinon. Choisir un
préréglage ne touche que les cases (`PRESETS`) : chaque effet garde ses
réglages d'intensité. `archived_style` n'en fait pas partie (un style, pas
un niveau d'animation).

Copie JS : static/js/poses_effects.mjs ; tests/test_poses_effects.py écrit
la table dans tests/fixtures/poses/poses_effects.json, que le test JS
compare à la sienne.
"""

from __future__ import annotations

import re

LEVELS = ("sober", "balanced", "rich", "custom")
POPULARITY_SCALES = ("relative", "fixed")
ARCHIVED_STYLES = ("grey", "ghost")

MAX_SCALE_RANGE = (1.2, 4.0)
HALF_LIFE_RANGE = (1, 365)
INTENSITY_RANGE = (10, 100)
AFTER_DAYS_RANGE = (7, 3650)
STRENGTH_RANGE = (10, 100)

# Effets cochés par chaque préréglage (clé = chemin de la case).
TOGGLES = ("popularity", "activity", "freshness", "milestone_flash", "disabled_pulse")
PRESETS = {
    "sober": {"popularity": False, "activity": False, "freshness": False,
              "milestone_flash": False, "disabled_pulse": False},
    "balanced": {"popularity": True, "activity": False, "freshness": True,
                 "milestone_flash": True, "disabled_pulse": False},
    "rich": {"popularity": True, "activity": True, "freshness": True,
             "milestone_flash": True, "disabled_pulse": True},
}

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def poses_effects_defaults() -> dict:
    """Bloc par défaut : sobre — un thème antérieur garde son rendu."""
    return {
        "level": "sober",
        "popularity": {"enabled": False, "scale": "relative", "max_scale": 2.0},
        "activity": {"enabled": False, "color": "#ffb300", "half_life_days": 14, "intensity": 60},
        "freshness": {"enabled": False, "after_days": 365, "strength": 70},
        "milestone_flash": False,
        "disabled_pulse": False,
        "archived_style": "grey",
    }


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


def _section(raw, key):
    value = raw.get(key) if isinstance(raw, dict) else None
    return value if isinstance(value, dict) else {}


def toggles_of(effects: dict) -> dict:
    """{case: cochée} d'un bloc normalisé."""
    return {
        "popularity": effects["popularity"]["enabled"],
        "activity": effects["activity"]["enabled"],
        "freshness": effects["freshness"]["enabled"],
        "milestone_flash": effects["milestone_flash"],
        "disabled_pulse": effects["disabled_pulse"],
    }


def level_of(effects: dict) -> str:
    """Préréglage dont les cases correspondent exactement, `custom` sinon."""
    toggles = toggles_of(effects)
    for name, preset in PRESETS.items():
        if preset == toggles:
            return name
    return "custom"


def coerce_poses_effects(raw, current: dict | None = None) -> dict:
    """Bloc normalisé : valeurs bornées, champs absents = valeur courante
    (défaut sinon). `level` est recalculé d'après les cases : un niveau servi
    qui contredit les cases n'est jamais retenu."""
    base = current if isinstance(current, dict) else poses_effects_defaults()
    src = raw if isinstance(raw, dict) else {}
    pop, cur_pop = _section(src, "popularity"), base["popularity"]
    act, cur_act = _section(src, "activity"), base["activity"]
    fresh, cur_fresh = _section(src, "freshness"), base["freshness"]
    out = {
        "popularity": {
            "enabled": _bool(pop.get("enabled"), cur_pop["enabled"]),
            "scale": _choice(pop.get("scale"), POPULARITY_SCALES, cur_pop["scale"]),
            "max_scale": _number(pop.get("max_scale"), cur_pop["max_scale"], *MAX_SCALE_RANGE, integer=False),
        },
        "activity": {
            "enabled": _bool(act.get("enabled"), cur_act["enabled"]),
            "color": _color(act.get("color"), cur_act["color"]),
            "half_life_days": _number(act.get("half_life_days"), cur_act["half_life_days"],
                                      *HALF_LIFE_RANGE, integer=True),
            "intensity": _number(act.get("intensity"), cur_act["intensity"], *INTENSITY_RANGE, integer=True),
        },
        "freshness": {
            "enabled": _bool(fresh.get("enabled"), cur_fresh["enabled"]),
            "after_days": _number(fresh.get("after_days"), cur_fresh["after_days"],
                                  *AFTER_DAYS_RANGE, integer=True),
            "strength": _number(fresh.get("strength"), cur_fresh["strength"], *STRENGTH_RANGE, integer=True),
        },
        "milestone_flash": _bool(src.get("milestone_flash"), base["milestone_flash"]),
        "disabled_pulse": _bool(src.get("disabled_pulse"), base["disabled_pulse"]),
        "archived_style": _choice(src.get("archived_style"), ARCHIVED_STYLES, base["archived_style"]),
    }
    out["level"] = level_of(out)
    return {"level": out.pop("level"), **out}


def poses_effects_table() -> dict:
    """Défauts, préréglages et bornes, comparés par le test JS."""
    return {
        "defaults": poses_effects_defaults(),
        "presets": {name: dict(p) for name, p in PRESETS.items()},
        "levels": list(LEVELS),
        "scales": list(POPULARITY_SCALES),
        "archived_styles": list(ARCHIVED_STYLES),
        "ranges": {
            "max_scale": list(MAX_SCALE_RANGE),
            "half_life_days": list(HALF_LIFE_RANGE),
            "intensity": list(INTENSITY_RANGE),
            "after_days": list(AFTER_DAYS_RANGE),
            "strength": list(STRENGTH_RANGE),
        },
    }
