"""Trouvailles en colonnes pour la page Statistiques (`GET /api/stats/finds`).

La page carte reçoit le GeoJSON complet (une feature par trouvaille, avec
géométrie et nom). Les graphiques n'ont besoin que de quelques propriétés :
ce module les range en colonnes, les chaînes répétées (type, contenant, pays,
région, propriétaire, attributs) codées par un index dans un dictionnaire.
Le client (`static/js/chart_sources.mjs`) relit ce format.

Source : le jeu de base du cache GeoJSON (`bdd.geojson_cache`), le même que
celui de la page carte — trouvailles et étapes Lab, sans filtre.
"""

PAYLOAD_VERSION = 1

# Colonnes codées par dictionnaire : valeur absente ou vide → -1.
_DICT_COLUMNS = ("cache_type", "container", "country", "state", "owner")


def _attribute_key(attr):
    """Clé d'un attribut GPX (même règle que filter_model.mjs › attributeKey)."""
    if not isinstance(attr, dict):
        return None
    ident = attr.get("id")
    if ident is not None and ident != "":
        return str(ident)
    name = attr.get("name")
    return str(name) if name else None


def _attribute_present(attr):
    """`inc` '0' marque une absence explicite (filter_model.mjs › attributePresent)."""
    return str(attr.get("inc")) != "0"


def _number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def build_finds_payload(features):
    """Colonnes des trouvailles, dans l'ordre des features."""
    dicts = {name: [] for name in _DICT_COLUMNS}
    indexes = {name: {} for name in _DICT_COLUMNS}
    columns = {name: [] for name in _DICT_COLUMNS}
    attribute_dict = []      # [{key, name}]
    attribute_index = {}

    date, published, kind, code = [], [], [], []
    difficulty, terrain, attributes = [], [], []

    for feature in features:
        props = (feature or {}).get("properties") or {}
        date.append(props.get("date_find") or None)
        published.append(props.get("published_date") or None)
        is_lab = props.get("source_kind") == "lab"
        kind.append(1 if is_lab else 0)
        # Identité de la cache trouvée : GC code, ou identifiant d'étape Lab.
        code.append(props.get("gc_code") or props.get("record_uid") or None)
        difficulty.append(_number(props.get("difficulty")))
        terrain.append(_number(props.get("terrain")))

        for name in _DICT_COLUMNS:
            value = props.get(name)
            value = str(value).strip() if value not in (None, "") else ""
            if not value:
                columns[name].append(-1)
                continue
            idx = indexes[name].get(value)
            if idx is None:
                idx = indexes[name][value] = len(dicts[name])
                dicts[name].append(value)
            columns[name].append(idx)

        present = []
        for attr in props.get("attributes") or []:
            key = _attribute_key(attr)
            if key is None or not _attribute_present(attr):
                continue
            idx = attribute_index.get(key)
            if idx is None:
                idx = attribute_index[key] = len(attribute_dict)
                attribute_dict.append({"key": key, "name": str(attr.get("name") or key)})
            if idx not in present:
                present.append(idx)
        attributes.append(present)

    return {
        "v": PAYLOAD_VERSION,
        "count": len(date),
        "date": date,
        "published": published,
        "kind": kind,
        "code": code,
        "difficulty": difficulty,
        "terrain": terrain,
        **columns,
        "attributes": attributes,
        "dicts": {**dicts, "attribute": attribute_dict},
    }
