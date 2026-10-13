import json
import os
import threading
from collections import OrderedDict, defaultdict
from datetime import date, datetime
from typing import Dict, List, Optional, Tuple

import paths


# Taille max du cache LRU des résultats filtrés (combinaisons de filtres).
# Chaque entrée stocke un GeoJSON complet potentiellement lourd ; on borne la
# mémoire consommée en évictant l'entrée la moins récemment utilisée.
FILTER_CACHE_MAX_SIZE = 32

# Clé d'index pour les features sans pays/région connue (ex. Labs) : rend la
# valeur inconnue sélectionnable explicitement — l'option « Non renseigné »
# des listes pays/région porte cette valeur.
UNKNOWN_GEO = "__unknown__"

# Version du contenu persisté (geojson_data.json + index). Une base écrite
# par une ancienne version n'a ni features Labs ni index source : le mtime
# de la base ne changeant pas, seul un numéro de version l'invalide.
PERSIST_VERSION = 2


def _parse_date(value) -> Optional[date]:
    """Convertit une valeur en date (YYYY-MM-DD) ou retourne None."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            # On ne garde que la partie date au cas où du temps serait présent
            return datetime.strptime(value[:10], "%Y-%m-%d").date()
        except Exception:
            return None
    return None


def _count_by_source(features: List[Dict]) -> Dict[str, int]:
    """Ventilation par source_kind ; features anciennes sans le champ → geocache."""
    counts: Dict[str, int] = defaultdict(int)
    for f in features:
        kind = (f.get("properties") or {}).get("source_kind") or "geocache"
        counts[kind] += 1
    return dict(counts)


def build_metadata_from_features(features: List[Dict]) -> Dict:
    """Calcule les métadonnées de base (bornes de dates, nombre, publication)."""
    if not features:
        return {
            "startDate": None,
            "endDate": None,
            "deltaDays": None,
            "numberOfCaches": 0,
            "countBySource": {},
            "publishedStartDate": None,
            "publishedEndDate": None,
        }

    def _safe_date(values: List[str], agg_fn):
        if not values:
            return None
        try:
            return agg_fn(values)
        except Exception:
            return None

    valid_find_dates = [
        f.get("properties", {}).get("date_find")
        for f in features
        if f.get("properties", {}).get("date_find")
    ]
    start_date_str = _safe_date(valid_find_dates, min)
    end_date_str = _safe_date(valid_find_dates, max)
    start_date = _parse_date(start_date_str) if start_date_str else None
    end_date = _parse_date(end_date_str) if end_date_str else None
    # Comptage inclusif : le premier et le dernier jour sont tous deux animés.
    # C'est la même convention que static/js/video_timing.mjs::inclusiveDayCount.
    delta_days = (end_date - start_date).days + 1 if start_date and end_date else None

    valid_published_dates = [
        f.get("properties", {}).get("published_date")
        for f in features
        if f.get("properties", {}).get("published_date")
    ]
    published_start_str = _safe_date(valid_published_dates, min)
    published_end_str = _safe_date(valid_published_dates, max)

    return {
        "startDate": start_date.strftime("%Y-%m-%d") if start_date else None,
        "endDate": end_date.strftime("%Y-%m-%d") if end_date else None,
        "deltaDays": delta_days,
        "numberOfCaches": len(features),
        "countBySource": _count_by_source(features),
        "publishedStartDate": published_start_str,
        "publishedEndDate": published_end_str,
    }


def _float_set(values) -> set:
    """Convertit une liste de chaînes/floats en un set de floats (ignore les invalides)."""
    out = set()
    for v in values or []:
        try:
            out.add(float(v))
        except (TypeError, ValueError):
            continue
    return out


def _normalize_filter_key(selected_values: Dict) -> Tuple:
    """Crée une clé stable pour le cache de filtres (ordre des listes ignoré)."""
    def _list_key(values):
        if not isinstance(values, list):
            return tuple()
        # Comparaison sur des chaînes pour éviter les soucis de types (float/int/str)
        return tuple(sorted(str(v) for v in values))

    dates = selected_values.get("dates") or {}
    published_dates = selected_values.get("published_dates") or {}

    return (
        _list_key(selected_values.get("sources") or []),
        _list_key(selected_values.get("type") or []),
        _list_key(selected_values.get("terrain") or []),
        _list_key(selected_values.get("difficulty") or []),
        _list_key(selected_values.get("container") or []),
        _list_key(selected_values.get("countries") or []),
        _list_key(selected_values.get("states") or []),
        dates.get("startDate"),
        dates.get("endDate"),
        published_dates.get("startDate"),
        published_dates.get("endDate"),
    )


class GeojsonIndexCache:
    """Cache en mémoire + persistance légère des index GeoJSON (date/type/région)."""

    def __init__(
        self,
        db_path: Optional[str] = None,
        persist_path: Optional[str] = None,
        base_geojson_path: Optional[str] = None,
    ):
        # Emplacements centralisés dans paths.py : les tests navigateur les
        # redirigent vers un dossier jetable, l'application installée vers
        # %LOCALAPPDATA%\MyGCFlow.
        self.db_path = db_path or str(paths.database_path())
        self.persist_path = persist_path or str(paths.geojson_indexes_path())
        self.base_geojson_path = base_geojson_path or str(paths.geojson_data_path())
        self._lock = threading.Lock()
        self._reset(self._get_db_mtime())
        self._load_from_disk()

    # ---------- Gestion d'état ----------
    def _reset(self, db_mtime: Optional[float]):
        self._base_geojson: Optional[Dict] = None
        self._base_metadata: Optional[Dict] = None
        self._filter_cache: "OrderedDict[Tuple, Dict]" = OrderedDict()
        self._indexes: Dict[str, Dict[str, List[int]]] = {
            "date": defaultdict(list),
            "type": defaultdict(list),
            "country": defaultdict(list),
            "state": defaultdict(list),
            "source": defaultdict(list),
        }
        self._db_mtime = db_mtime

    def invalidate(self, reason: str = ""):
        with self._lock:
            self._reset(self._get_db_mtime())
            try:
                if os.path.exists(self.persist_path):
                    os.remove(self.persist_path)
            except Exception as exc:
                print(f"[CACHE] Impossible de supprimer le cache persistant ({reason}): {exc}")

    def invalidate_if_db_changed(self, current_mtime: Optional[float]):
        with self._lock:
            if current_mtime is None:
                return
            if self._db_mtime != current_mtime:
                self._reset(current_mtime)

    def get_database_mtime(self) -> Optional[float]:
        return self._get_db_mtime()

    def _get_db_mtime(self) -> Optional[float]:
        try:
            return os.path.getmtime(self.db_path)
        except Exception:
            return None

    # ---------- Chargement / persistance ----------
    def _persist_indexes_locked(self):
        try:
            os.makedirs(os.path.dirname(self.persist_path), exist_ok=True)
            payload = {
                "version": PERSIST_VERSION,
                "db_mtime": self._db_mtime,
                "indexes": {
                    name: {k: v for k, v in idx.items()} for name, idx in self._indexes.items()
                },
            }
            with open(self.persist_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
        except Exception as exc:
            print(f"[CACHE] Impossible de persister les index: {exc}")

    def _load_from_disk(self) -> bool:
        """Recharge index + GeoJSON complet depuis le disque si cohérent avec la BDD."""
        try:
            if not (os.path.exists(self.persist_path) and os.path.exists(self.base_geojson_path)):
                return False

            current_mtime = self._get_db_mtime()
            with open(self.persist_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            # Version du contenu persisté : un fichier d'avant Labs est ignoré
            # même si le mtime de la base correspond.
            if data.get("version") != PERSIST_VERSION:
                return False

            persisted_mtime = data.get("db_mtime")
            if current_mtime is not None and persisted_mtime != current_mtime:
                return False

            with open(self.base_geojson_path, "r", encoding="utf-8") as f:
                geojson = json.load(f)

            indexes = data.get("indexes") or {}
            with self._lock:
                self._base_geojson = geojson
                self._base_metadata = build_metadata_from_features(geojson.get("features", []))
                self._db_mtime = persisted_mtime or current_mtime
                self._indexes = {
                    "date": defaultdict(list, indexes.get("date") or {}),
                    "type": defaultdict(list, indexes.get("type") or {}),
                    "country": defaultdict(list, indexes.get("country") or {}),
                    "state": defaultdict(list, indexes.get("state") or {}),
                    "source": defaultdict(list, indexes.get("source") or {}),
                }
                self._filter_cache = OrderedDict()
            return True
        except Exception as exc:
            print(f"[CACHE] Impossible de recharger le cache persistant: {exc}")
            return False

    # ---------- Gestion du jeu de données complet ----------
    def set_base_dataset(
        self,
        geojson: Dict,
        metadata: Optional[Dict] = None,
        db_mtime: Optional[float] = None,
    ):
        if db_mtime is None:
            db_mtime = self._get_db_mtime()
        with self._lock:
            self._base_geojson = geojson
            self._base_metadata = metadata or build_metadata_from_features(
                geojson.get("features", [])
            )
            self._db_mtime = db_mtime
            self._filter_cache = OrderedDict()
            self._build_indexes_locked()
            self._persist_indexes_locked()

    def get_base_dataset_if_current(
        self, db_mtime: Optional[float]
    ) -> Optional[Tuple[Dict, Dict]]:
        with self._lock:
            if self._base_geojson is None:
                return None
            if db_mtime is not None and self._db_mtime != db_mtime:
                return None
            return self._base_geojson, self._base_metadata

    def _build_indexes_locked(self):
        features = (self._base_geojson or {}).get("features", [])
        indexes = {
            "date": defaultdict(list),
            "type": defaultdict(list),
            "country": defaultdict(list),
            "state": defaultdict(list),
            "source": defaultdict(list),
        }
        for idx, feature in enumerate(features):
            props = feature.get("properties") or {}

            date_key = props.get("date_find")
            if date_key:
                indexes["date"][date_key].append(idx)

            cache_type = props.get("cache_type")
            if cache_type:
                indexes["type"][cache_type].append(idx)

            # Valeur inconnue indexée sous la sentinelle : sélectionnable
            # explicitement, comme les pays/régions nommés.
            indexes["country"][props.get("country") or UNKNOWN_GEO].append(idx)
            indexes["state"][props.get("state") or UNKNOWN_GEO].append(idx)

            source_kind = props.get("source_kind") or "geocache"
            indexes["source"][source_kind].append(idx)

        self._indexes = indexes

    # ---------- Filtrage + cache ----------
    def get_filtered_if_current(
        self, selected_values: Dict, db_mtime: Optional[float]
    ) -> Optional[Tuple[Dict, Dict]]:
        key = _normalize_filter_key(selected_values)
        with self._lock:
            cached = self._filter_cache.get(key)
            if not cached:
                return None
            if db_mtime is not None and cached.get("db_mtime") != db_mtime:
                # Entrée périmée : l'évicter proactivement plutôt que d'attendre
                # qu'elle soit poussée dehors par la taille.
                self._filter_cache.pop(key, None)
                return None
            # Hit : marquer comme récemment utilisé (LRU).
            self._filter_cache.move_to_end(key)
            return cached["geojson"], cached["metadata"]

    def store_filtered_result(
        self,
        selected_values: Dict,
        geojson: Dict,
        metadata: Dict,
        db_mtime: Optional[float],
    ):
        key = _normalize_filter_key(selected_values)
        with self._lock:
            # Mise à jour d'une clé existante ou insertion d'une nouvelle entrée.
            # OrderedDict.move_to_end n'est pas nécessaire ici : l'affectation
            # ci-dessous ne réordonne pas, on le fait donc explicitement pour
            # garantir que la clé fraîchement écrite soit la plus récente.
            self._filter_cache[key] = {
                "geojson": geojson,
                "metadata": metadata,
                "db_mtime": db_mtime,
            }
            self._filter_cache.move_to_end(key)
            # Éviction LRU : retirer l'entrée la moins récemment utilisée
            # tant qu'on dépasse la taille max.
            while len(self._filter_cache) > FILTER_CACHE_MAX_SIZE:
                evicted_key, _ = self._filter_cache.popitem(last=False)
                print(f"[CACHE] LRU éviction d'un résultat filtré (taille max={FILTER_CACHE_MAX_SIZE})")

    def filter_with_indexes(
        self, selected_values: Dict, db_mtime: Optional[float] = None
    ) -> Optional[Tuple[Dict, Dict]]:
        if db_mtime is None:
            db_mtime = self._get_db_mtime()

        with self._lock:
            if self._base_geojson is None or (
                db_mtime is not None and self._db_mtime != db_mtime
            ):
                return None

        key = _normalize_filter_key(selected_values)
        cached = self.get_filtered_if_current(selected_values, db_mtime)
        if cached:
            return cached

        candidate_ids = self._candidate_ids(selected_values)
        if candidate_ids is None:
            return None

        features = (self._base_geojson or {}).get("features", [])

        # Neutralité géographique : une sélection couvrant tout le périmètre
        # offert est « tous » et inclut les valeurs inconnues. Calculée ici car
        # _matches_filters n'a pas accès aux index ; le périmètre des états est
        # restreint aux candidats (un pays sans état n'offre pas d'options).
        sources = selected_values.get("sources")
        sel_countries = {str(v) for v in (selected_values.get("countries") or [])}
        sel_states = {str(v) for v in (selected_values.get("states") or [])}
        candidate_set = set(candidate_ids)
        with self._lock:
            offered_countries = set(self._indexes["country"].keys())
            state_scope = {
                s for s in self._indexes["state"].keys()
                if set(self._indexes["state"].get(s) or []) & candidate_set
            }
        precomputed = {
            "types": set(selected_values.get("type") or []),
            "allowed_sources": set(sources) if isinstance(sources, list) and sources else None,
            # terrain/difficulty sont des floats en base (db.Float) ; on compare
            # donc en float pour éviter str(5.0)="5.0" != "5" (sélection du <select>).
            "terrain": _float_set(selected_values.get("terrain") or []),
            "difficulty": _float_set(selected_values.get("difficulty") or []),
            "container": {str(v) for v in (selected_values.get("container") or [])},
            "countries": sel_countries,
            "states": sel_states,
            "geo_neutral_country": not isinstance(selected_values.get("countries"), list)
                or not offered_countries
                or offered_countries <= sel_countries,
            "geo_neutral_state": not isinstance(selected_values.get("states"), list)
                or not state_scope
                or state_scope <= sel_states,
            "date_start": _parse_date((selected_values.get("dates") or {}).get("startDate")),
            "date_end": _parse_date((selected_values.get("dates") or {}).get("endDate")),
            "pub_start": _parse_date((selected_values.get("published_dates") or {}).get("startDate")),
            "pub_end": _parse_date((selected_values.get("published_dates") or {}).get("endDate")),
        }
        filtered_features = []
        for idx in candidate_ids:
            try:
                feature = features[idx]
            except Exception:
                continue
            props = feature.get("properties") or {}
            if self._matches_filters(props, precomputed):
                filtered_features.append(feature)

        geojson = {"type": "FeatureCollection", "features": filtered_features}
        metadata = build_metadata_from_features(filtered_features)
        self.store_filtered_result(selected_values, geojson, metadata, db_mtime)
        return geojson, metadata

    # ---------- Helpers de filtrage ----------
    def _candidate_ids(self, selected_values: Dict) -> Optional[List[int]]:
        """Retourne une liste ordonnée d'ids candidats issue des index."""
        with self._lock:
            indexes = self._indexes

        # Restriction de sources explicite : liste vide = aucun résultat ;
        # champ absent = pas de restriction (toutes sources).
        sources = selected_values.get("sources")
        if isinstance(sources, list) and len(sources) == 0:
            return []

        # Type de cache obligatoire (comportement identique au filtrage SQL actuel)
        types = selected_values.get("type") or []
        if not isinstance(types, list) or len(types) == 0:
            return []

        candidates = set()
        for t in types:
            candidates.update(indexes["type"].get(t, []))
        if not candidates:
            return []

        if isinstance(sources, list) and sources:
            source_ids = set()
            for s in sources:
                source_ids.update(indexes["source"].get(s, []))
            candidates &= source_ids
            if not candidates:
                return []

        # Pays : une sélection couvrant toutes les options offertes (nommées +
        # « Non renseigné ») est neutre — état « tous », les valeurs inconnues
        # (Labs comprises) y restent visibles. Une sélection partielle est
        # géographique : les inconnues n'y passent que via la sentinelle. Une
        # liste vide n'est « Aucun » (aucun résultat) que si la dimension
        # offrait des options — sinon elle est inactive (selectHasRealOptions).
        offered_countries = set(indexes["country"].keys())
        countries = selected_values.get("countries")
        if isinstance(countries, list):
            if len(countries) == 0:
                if offered_countries:
                    return []
            elif not offered_countries <= set(countries):
                country_ids = set()
                for c in countries:
                    country_ids.update(indexes["country"].get(c, []))
                candidates &= country_ids
                if not candidates:
                    return []

        # Régions : mêmes règles, mais la dimension n'est « offerte » que si des
        # états existent dans le périmètre déjà restreint (un pays sans état
        # n'offre pas d'options régionales — sélection vide = inactive). La
        # sentinelle fait partie des options offertes comme les nommés.
        states = selected_values.get("states")
        if isinstance(states, list):
            state_scope = {
                s for s in indexes["state"].keys()
                if set(indexes["state"].get(s) or []) & candidates
            }
            if len(states) == 0:
                if state_scope:
                    return []
            elif not state_scope <= set(states):
                state_ids = set()
                for s in states:
                    state_ids.update(indexes["state"].get(s, []))
                candidates &= state_ids
                if not candidates:
                    return []

        dates = selected_values.get("dates") or {}
        start_date = _parse_date(dates.get("startDate"))
        end_date = _parse_date(dates.get("endDate"))
        if start_date and end_date:
            date_ids = set()
            for date_key, ids in indexes["date"].items():
                d = _parse_date(date_key)
                if d and start_date <= d <= end_date:
                    date_ids.update(ids)
            candidates &= date_ids
            if not candidates:
                return []

        return sorted(list(candidates))

    def _matches_filters(self, props: Dict, precomputed: Dict) -> bool:
        """Filtre final (terrain/difficulté/container/publication) après indexation."""
        # Restriction explicite de sources (absence = pas de restriction).
        kind = props.get("source_kind") or "geocache"
        allowed = precomputed["allowed_sources"]
        if allowed is not None and kind not in allowed:
            return False

        if props.get("cache_type") not in precomputed["types"]:
            return False

        is_lab = kind == "lab"

        def _m(val, value_set):
            return not value_set or str(val) in value_set

        def _m_float(val, value_set):
            if not value_set:
                return True
            try:
                return float(val) in value_set
            except (TypeError, ValueError):
                return False

        # Difficulté/terrain/taille : non applicables aux Labs, ils ne
        # retirent jamais une feature Lab (plan §9.2). Période de pose : un
        # Lab n'y est soumis que si sa publication est connue (lue dans le
        # GPX) — inconnue, elle ne le retire pas.
        if is_lab:
            published_date = _parse_date(props.get("published_date"))
            if published_date and precomputed["pub_start"] and precomputed["pub_end"] \
                    and not (precomputed["pub_start"] <= published_date <= precomputed["pub_end"]):
                return False
        else:
            if not _m_float(props.get("terrain"), precomputed["terrain"]):
                return False
            if not _m_float(props.get("difficulty"), precomputed["difficulty"]):
                return False
            if not _m(props.get("container"), precomputed["container"]):
                return False
            if precomputed["pub_start"] and precomputed["pub_end"]:
                published_date = _parse_date(props.get("published_date"))
                if not published_date or not (precomputed["pub_start"] <= published_date <= precomputed["pub_end"]):
                    return False

        # Pays/région : sous sélection neutre (« tous »), les valeurs inconnues
        # passent ; sous sélection géographique réelle, la valeur inconnue ne
        # correspond qu'à la sentinelle « Non renseigné ».
        if not precomputed["geo_neutral_country"]:
            if not _m(props.get("country") or UNKNOWN_GEO, precomputed["countries"]):
                return False
        if not precomputed["geo_neutral_state"]:
            if not _m(props.get("state") or UNKNOWN_GEO, precomputed["states"]):
                return False

        # Date de trouvaille (seule la date par feature est à parser, les bornes sont précalculées)
        if precomputed["date_start"] and precomputed["date_end"]:
            find_date = _parse_date(props.get("date_find"))
            if not find_date or not (precomputed["date_start"] <= find_date <= precomputed["date_end"]):
                return False

        return True
