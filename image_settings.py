"""Images posées sur la carte (onglet Images) : réglages persistés.

Préférence GLOBALE (bloc `images` de settings.json), jamais une section de
thème : un avatar ou un logo d'association ne doit pas disparaître quand on
change de thème. Une liste par page, comme `stats` : `items` pour le mode
principal (Mes géocaches), `evolution_items` pour /evolution — indépendantes
(une image retirée d'une page n'affecte pas l'autre), `enabled` reste commun.

`configs` : configurations nommées {name, items}, instantanés d'une liste —
applicables sur les DEUX pages (une image est la même partout) : c'est aussi
le moyen de reprendre sur une page les images de l'autre.

Miroir exact de `normalizeImagesSettings` (static/js/images_model.mjs) : les
deux côtés passent les mêmes vecteurs de test
(tests/fixtures/images/settings_cases.json), toute règle modifiée ici doit
l'être là-bas. Les coercitions élémentaires (bornes, couleurs, fractions,
titres, marges de coin communes) sont celles des panneaux de stats.
"""

from __future__ import annotations

import datetime
import re
from dataclasses import dataclass, field

import image_library
from stats_settings import (
    STATS_ANCHORS,
    STATS_OFFSET_RANGE,
    STATS_POSITION_MODES,
    _ID_RE,
    _bool,
    _choice,
    _coerce_block,
    _color,
    _config_name,
    _int_in,
    _new_id,
    _share_corner_margins,
    _title,
    _unit,
)

IMAGES_MAX_ITEMS = 4
# Tous les emplacements des panneaux sauf le centre de la carte.
IMAGE_ANCHORS = tuple(a for a in STATS_ANCHORS if a != "middle-center")
IMAGE_SHAPES = ("rect", "rounded", "circle")
IMAGE_FITS = ("contain", "cover")
IMAGE_SIZE_RANGE = (40, 1200)
IMAGE_RADIUS_RANGE = (0, 200)
IMAGE_OPACITY_RANGE = (0, 100)
IMAGE_PADDING_RANGE = (0, 100)
IMAGE_BORDER_RANGE = (0, 50)
IMAGE_FADE_RANGE = (0, 5000)
# Planing : par dates, ou par jalons du compteur de trouvailles (« à la
# 1000e trouvaille »), converti en date au moment de l'animation.
IMAGE_SCHEDULE_BY = ("date", "find")
IMAGE_FIND_RANGE = (1, 10_000_000)
# Effet d'entrée et de sortie : fondu seul, glissement depuis le bord le plus
# proche, ou zoom (« pop »), tous combinés au fondu.
IMAGE_EFFECTS = ("fade", "slide", "zoom")
# Configurations nommées : instantanés de la liste d'une page.
IMAGES_MAX_CONFIGS = 12


@dataclass
class ImagesSettings:
    # Interrupteur général : masque toutes les images sans perdre la liste.
    enabled: bool = True
    # Images normalisées (dict), dans l'ordre de dessin et d'empilement.
    items: list = field(default_factory=list)
    # Liste propre à la page Évolution (/evolution), même schéma — absente
    # d'un vieux settings.json, elle est vide (jamais une copie d'`items`).
    evolution_items: list = field(default_factory=list)
    # Configurations nommées {name, items}, applicables sur les deux pages.
    configs: list = field(default_factory=list)


def image_item_defaults() -> dict:
    """Valeurs par défaut d'une image : en bas à droite (le titre et les
    infos occupent le haut par défaut), 160 px de large, hauteur d'après
    le ratio de l'image."""
    return {
        "enabled": True,
        "file": "",
        "name": "",
        "position": {
            "mode": "anchor", "anchor": "bottom-right", "dx": 16, "dy": 16,
            "width": 160, "height": None, "x": 0, "y": 0,
        },
        "style": {
            "shape": "rounded",
            "radius": 12,
            "fit": "contain",
            "opacity": 100,
            "background": "#ffffff",
            "background_opacity": 0,
            "padding": 0,
            "shadow": False,
            "border_color": "#ffffff",
            "border_width": 0,
        },
        # Apparition/disparition pendant l'animation : par dates
        # « AAAA-MM-JJ » (`by: date`) ou par numéros de trouvaille
        # (`by: find`) — None = pas de borne ; les deux paires sont gardées
        # pour qu'un aller-retour entre les modes ne perde rien. Durée de la
        # transition en ms, effet d'entrée/sortie.
        "schedule": {
            "by": "date",
            "start": None,
            "end": None,
            "start_find": None,
            "end_find": None,
            "fade": 600,
            "effect": "fade",
        },
    }


_POSITION_COERCERS = {
    "mode": lambda v, d: _choice(v, STATS_POSITION_MODES, d),
    "anchor": lambda v, d: _choice(v, IMAGE_ANCHORS, d),
    "dx": lambda v, d: _int_in(v, d, STATS_OFFSET_RANGE),
    "dy": lambda v, d: _int_in(v, d, STATS_OFFSET_RANGE),
    "width": lambda v, d: _int_in(v, d, IMAGE_SIZE_RANGE),
    # Hauteur imposée, nullable : None (ou non numérique) = d'après le ratio.
    "height": lambda v, d: None if v is None else _int_in(v, None, IMAGE_SIZE_RANGE),
    "x": _unit,
    "y": _unit,
}

_STYLE_COERCERS = {
    "shape": lambda v, d: _choice(v, IMAGE_SHAPES, d),
    "radius": lambda v, d: _int_in(v, d, IMAGE_RADIUS_RANGE),
    "fit": lambda v, d: _choice(v, IMAGE_FITS, d),
    "opacity": lambda v, d: _int_in(v, d, IMAGE_OPACITY_RANGE),
    "background": _color,
    "background_opacity": lambda v, d: _int_in(v, d, IMAGE_OPACITY_RANGE),
    "padding": lambda v, d: _int_in(v, d, IMAGE_PADDING_RANGE),
    "shadow": lambda v, d: _bool(v, d),
    "border_color": _color,
    "border_width": lambda v, d: _int_in(v, d, IMAGE_BORDER_RANGE),
}

# Forme stricte d'une date de planing : « AAAA-MM-JJ » ET jour réel
# (fromisoformat valide) — « 2026-02-30 » ou « hier » deviennent None.
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _date(value, default) -> str | None:
    if not (isinstance(value, str) and _DATE_RE.fullmatch(value)):
        return None
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return None
    return value


def _find(value, default):
    # Numéro de trouvaille nullable : None (ou non numérique) = pas de borne.
    return None if value is None else _int_in(value, None, IMAGE_FIND_RANGE)


_SCHEDULE_COERCERS = {
    "by": lambda v, d: _choice(v, IMAGE_SCHEDULE_BY, d),
    "start": _date,
    "end": _date,
    "start_find": _find,
    "end_find": _find,
    "fade": lambda v, d: _int_in(v, d, IMAGE_FADE_RANGE),
    "effect": lambda v, d: _choice(v, IMAGE_EFFECTS, d),
}


def coerce_image_item(raw) -> dict | None:
    """Image normalisée, ou None si l'entrée n'est pas un objet. Un fichier
    invalide devient '' (image à choisir, ou absente sur cette machine) :
    l'entrée est gardée, ses réglages ne sont pas perdus."""
    if not isinstance(raw, dict):
        return None
    defaults = image_item_defaults()
    raw_id = raw.get("id")
    return {
        "id": raw_id if isinstance(raw_id, str) and _ID_RE.fullmatch(raw_id) else "",
        "enabled": _bool(raw.get("enabled"), defaults["enabled"]),
        "file": image_library.safe_image_name(raw.get("file")),
        "name": _title(raw.get("name")),
        "position": _coerce_block(raw.get("position"), defaults["position"], _POSITION_COERCERS),
        "style": _coerce_block(raw.get("style"), defaults["style"], _STYLE_COERCERS),
        "schedule": _coerce_block(raw.get("schedule"), defaults["schedule"], _SCHEDULE_COERCERS),
    }


def _coerce_item_list(source) -> list:
    """Liste normalisée : invalides écartés, identifiants manquants ou en
    double régénérés, tronquée à IMAGES_MAX_ITEMS, marges de coin communes."""
    items = []
    seen = set()
    for raw in source if isinstance(source, list) else []:
        item = coerce_image_item(raw)
        if item is None:
            continue
        if not item["id"] or item["id"] in seen:
            item["id"] = _new_id()
            while item["id"] in seen:
                item["id"] = _new_id()
        seen.add(item["id"])
        items.append(item)
        if len(items) >= IMAGES_MAX_ITEMS:
            break
    return _share_corner_margins(items)


def coerce_images_config(raw) -> dict | None:
    """Configuration nommée normalisée {name, items}, ou None si le nom est
    vide après aplatissement. Les images suivent les règles d'une liste."""
    if not isinstance(raw, dict):
        return None
    name = _config_name(raw.get("name"))
    if not name:
        return None
    return {"name": name, "items": _coerce_item_list(raw.get("items"))}


def _coerce_config_list(source) -> list:
    """Configurations : premier nom gagnant (un doublon serait impossible à
    distinguer), tronquées à IMAGES_MAX_CONFIGS — comme stats.configs."""
    configs = []
    names = set()
    for raw in source if isinstance(source, list) else []:
        config = coerce_images_config(raw)
        if config is None or config["name"] in names:
            continue
        names.add(config["name"])
        configs.append(config)
        if len(configs) >= IMAGES_MAX_CONFIGS:
            break
    return configs


def coerce_images_settings(raw, current: ImagesSettings | None = None) -> ImagesSettings:
    """Bloc `images` normalisé. Patch de premier niveau, comme `stats` : une
    clé absente (`enabled`, `items`, `evolution_items`, `configs`) garde la
    valeur courante."""
    base = current if isinstance(current, ImagesSettings) else ImagesSettings()
    if not isinstance(raw, dict):
        return ImagesSettings(enabled=base.enabled, items=list(base.items),
                              evolution_items=list(base.evolution_items),
                              configs=list(base.configs))
    return ImagesSettings(
        enabled=_bool(raw.get("enabled"), base.enabled),
        items=_coerce_item_list(raw["items"] if "items" in raw else base.items),
        evolution_items=_coerce_item_list(
            raw["evolution_items"] if "evolution_items" in raw else base.evolution_items),
        configs=_coerce_config_list(raw["configs"] if "configs" in raw else base.configs),
    )
