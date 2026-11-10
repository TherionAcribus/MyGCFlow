"""Rapport de rattachement aux zones : les noms de Geocaching.com (pays,
région, département) que les données de zones ne reconnaissent pas.

Un nom non reconnu n'empêche pas l'affichage : la cache est placée d'après
sa position (zones.py). Mais il signale une région à découper autrement ou un
alias à ajouter dans une recette (docs/zones-ajouter-un-pays.md). Le rapport
le montre dans l'onglet Zones, avec un bouton « Copier le rapport » à joindre
à une demande sur GitHub.

Entrée : des groupes de lignes de même nom brut et de mêmes zones retenues,
`(country, state, county, zone_country, zone_region, zone_subregion, n)`. Les
trouvailles et les caches d'un jeu Évolution se ramènent à ce format ; la
vérification des noms se fait une fois par nom distinct, sans la position
(`ZoneIndex.assign` sans coordonnées : seuls les noms parlent).
"""
from __future__ import annotations

from collections import Counter, defaultdict

import zones

FORMAT_VERSION = 1
LEVELS = ("country", "region", "subregion")
# Zones où la position a placé les lignes d'un nom : les plus fréquentes.
TOP_ZONES = 3


def _clean(value):
    text = str(value).strip() if value not in (None, "") else ""
    return text or None


def _has_level(index, country_id, level):
    if not country_id:
        return False
    info = index.country(country_id)
    return bool(info and level in info.levels)


def build_report(groups, index=None) -> dict:
    """Rapport pour des groupes de lignes (voir le module)."""
    index = index or zones.get_index()
    total = 0
    outside = Counter()
    # (niveau, pays retenu, nom brut) → { n, country_name, zones: Counter }
    items = defaultdict(lambda: {"n": 0, "country_name": None, "zones": Counter()})
    checked = {}

    available = index.available()
    for country, state, county, z_country, z_region, z_sub, n in groups:
        n = int(n or 0)
        if n <= 0:
            continue
        total += n
        country, state, county = _clean(country), _clean(state), _clean(county)
        z_country, z_region, z_sub = _clean(z_country), _clean(z_region), _clean(z_sub)

        # Hors carte, niveau par niveau (seulement là où le niveau existe).
        if not z_country:
            outside["country"] += n
        elif not z_region and available and _has_level(index, z_country, "region"):
            outside["region"] += n
        if z_country and not z_sub and available and _has_level(index, z_country, "subregion"):
            outside["subregion"] += n

        if not available:
            continue
        key = (country, state, county)
        names = checked.get(key)
        if names is None:
            names = checked[key] = index.assign(country=country, state=state, county=county)
        via = names.via
        by_name_country = names.country if via[0] == "name" else None

        if country and via[0] != "name":
            entry = items[("country", None, country)]
            entry["n"] += n
            entry["country_name"] = country
            entry["zones"][z_country] += n
        # Région et département : vérifiés dans le pays reconnu par son nom,
        # sinon dans celui que la position a donné.
        context = by_name_country or z_country
        # (« parent » : région déduite du département ; le nom de région,
        # lui, n'est pas reconnu.)
        region_ok = via[1] == "name"
        county_ok = via[2] == "name"
        if not by_name_country and context:
            info = index.country(context)
            region_id = info.by_name("region", state) if info and state and "region" in info.levels else None
            region_ok = region_id is not None
            county_ok = bool(info and county and "subregion" in info.levels
                             and info.by_name("subregion", county, parent=region_id))
        if state and not region_ok and _has_level(index, context, "region"):
            entry = items[("region", context, state)]
            entry["n"] += n
            entry["country_name"] = country
            entry["zones"][z_region] += n
        if county and not county_ok and _has_level(index, context, "subregion"):
            entry = items[("subregion", context, county)]
            entry["n"] += n
            entry["country_name"] = country
            entry["zones"][z_sub] += n

    unrecognized = [
        {
            "level": level,
            "country": country_id,
            "country_name": entry["country_name"],
            "name": name,
            "count": entry["n"],
            # [id, nombre] ; id None = hors carte à ce niveau.
            "zones": [[zone, count] for zone, count in entry["zones"].most_common(TOP_ZONES)],
        }
        for (level, country_id, name), entry in items.items()
    ]
    unrecognized.sort(key=lambda item: (LEVELS.index(item["level"]), -item["count"], item["name"]))
    return {
        "v": FORMAT_VERSION,
        "available": available,
        "total": total,
        "signature": zones.data_signature() if available else "",
        "unrecognized": unrecognized,
        "outside": {level: outside[level] for level in LEVELS},
    }


def finds_groups(features):
    """Groupes des trouvailles (features du jeu de base de la carte, zones
    posées par zones.annotate_features). Les étapes Lab n'ont ni pays ni
    région de Geocaching.com : seules leurs zones comptent."""
    counter = Counter()
    for feature in features or ():
        props = (feature or {}).get("properties") or {}
        counter[(
            _clean(props.get("country")), _clean(props.get("state")), None,
            props.get("zone_country"), props.get("zone_region"), props.get("zone_subregion"),
        )] += 1
    return [(*key, n) for key, n in counter.items()]
