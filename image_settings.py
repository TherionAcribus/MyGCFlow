"""Images posées sur la carte (onglet Images) : réglages persistés.

Préférence GLOBALE (bloc `images` de settings.json), jamais une section de
thème : un avatar ou un logo d'association ne doit pas disparaître quand on
change de thème. Une seule liste pour les deux modes (Mes géocaches et
Évolution) : le logo est le même partout (MyGCFlow_Plan_Images.md, §2).

Miroir exact de `normalizeImagesSettings` (static/js/images_model.mjs) : les
deux côtés passent les mêmes vecteurs de test
(tests/fixtures/images/settings_cases.json), toute règle modifiée ici doit
l'être là-bas. Les coercitions élémentaires (bornes, couleurs, fractions,
titres, marges de coin communes) sont celles des panneaux de stats.
"""

from __future__ import annotations

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


@dataclass
class ImagesSettings:
    # Interrupteur général : masque toutes les images sans perdre la liste.
    enabled: bool = True
    # Images normalisées (dict), dans l'ordre de dessin et d'empilement.
    items: list = field(default_factory=list)


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


def coerce_images_settings(raw, current: ImagesSettings | None = None) -> ImagesSettings:
    """Bloc `images` normalisé. Patch de premier niveau, comme `stats` : une
    clé absente (`enabled`, `items`) garde la valeur courante."""
    base = current if isinstance(current, ImagesSettings) else ImagesSettings()
    if not isinstance(raw, dict):
        return ImagesSettings(enabled=base.enabled, items=list(base.items))
    return ImagesSettings(
        enabled=_bool(raw.get("enabled"), base.enabled),
        items=_coerce_item_list(raw["items"] if "items" in raw else base.items),
    )
