"""Lecture des exports CSV du mode Évolution.

Un export décrit toutes les caches d'une zone géographique : code GC,
coordonnées, date de placement, et éventuellement date d'archivage. Le mode
Évolution s'en sert pour animer l'apparition (placement) et la disparition
(archivage) des caches au fil du temps.

Module pur (aucune dépendance à Flask ni à la base) :

- read_header(path)          : valide l'en-tête sans lire le reste du fichier ;
- iter_batches(path, report) : parcourt le fichier en flux et produit des lots
                               de lignes normalisées (voir ROW_FIELDS), en
                               tenant les compteurs de FileReport à jour.

Les libellés de type et de taille sont traduits vers les noms canoniques
anglais de l'application (couleurs, icônes, filtres), qui sont aussi ceux des
fichiers GPX Groundspeak. Les coordonnées corrigées sont volontairement
ignorées : dans une vidéo publiée, elles révéleraient des finales de mystery.
"""

from __future__ import annotations

import csv
import io
import math
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Callable, Dict, Iterator, List, Optional, Tuple

# Champs d'une ligne normalisée, dans l'ordre des tuples produits.
ROW_FIELDS = (
    "gc_code", "name", "type", "size", "difficulty", "terrain", "owner",
    "placed_by", "country", "region", "county", "lat", "lon", "placed",
    "archived_on", "is_archived", "exported_at",
)

# Colonnes indispensables : sans elles, impossible de placer une cache dans le
# temps et sur la carte.
REQUIRED_FIELDS = ("gc_code", "latitude", "longitude", "placed")

# En-têtes reconnus, après normalisation (minuscules, sans accents, espaces
# simples). Les exports connus sont en français ; quelques équivalents anglais
# sont acceptés pour d'autres outils. La correspondance est exacte : « Ajouté »
# et « Ajouté par » doivent rester distincts.
HEADER_ALIASES: Dict[str, str] = {
    "gc code": "gc_code", "code gc": "gc_code", "gccode": "gc_code", "code": "gc_code",
    "nom de la geocache": "name", "nom": "name", "name": "name", "cache name": "name",
    "type": "type", "type de cache": "type", "cache type": "type",
    "taille": "size", "size": "size", "container": "size", "contenant": "size",
    "difficulte": "difficulty", "difficulty": "difficulty",
    "terrain": "terrain",
    "proprietaire": "owner", "owner": "owner",
    "placee par": "placed_by", "placed by": "placed_by",
    "pays": "country", "country": "country",
    "region": "region", "state": "region", "etat": "region",
    "departement": "county", "county": "county",
    "latitude": "latitude", "lat": "latitude",
    "longitude": "longitude", "lon": "longitude", "lng": "longitude",
    "date de placement": "placed", "placed": "placed", "placed date": "placed",
    "hidden": "placed", "hidden date": "placed",
    "derniere date d'archivage": "archived_on", "date d'archivage": "archived_on",
    "archived date": "archived_on", "archive date": "archived_on",
    "last archived date": "archived_on",
    "archivee": "archived", "archived": "archived",
    "ajoute": "exported_at", "added": "exported_at",
}

# Types : libellé normalisé (voir _norm_label) -> nom canonique.
TYPE_ALIASES: Dict[str, str] = {
    "traditionnelle": "Traditional Cache", "traditional": "Traditional Cache",
    "traditional cache": "Traditional Cache",
    "multi cache": "Multi-cache", "multi": "Multi-cache",
    "cache mystere": "Unknown Cache", "mystere": "Unknown Cache", "mystery": "Unknown Cache",
    "mystery cache": "Unknown Cache", "unknown cache": "Unknown Cache", "unknown": "Unknown Cache",
    "earthcache": "Earthcache", "earth cache": "Earthcache",
    "virtuelle": "Virtual Cache", "cache virtuelle": "Virtual Cache", "virtual": "Virtual Cache",
    "virtual cache": "Virtual Cache",
    "event": "Event Cache", "evenement": "Event Cache", "event cache": "Event Cache",
    "mega event": "Mega-Event Cache", "mega event cache": "Mega-Event Cache",
    "giga event": "Giga-Event Cache", "giga event cache": "Giga-Event Cache",
    "letterbox": "Letterbox Hybrid", "letterbox hybrid": "Letterbox Hybrid",
    "wherigo": "Wherigo Cache", "wherigo cache": "Wherigo Cache",
    "webcam": "Webcam Cache", "webcam cache": "Webcam Cache",
    "cache in trash out": "Cache In Trash Out Event", "cito": "Cache In Trash Out Event",
    "cache in trash out event": "Cache In Trash Out Event",
    "cache sans localisation": "Locationless (Reverse) Cache",
    "locationless": "Locationless (Reverse) Cache",
    "locationless (reverse) cache": "Locationless (Reverse) Cache",
    "lab": "Lab Cache", "lab cache": "Lab Cache", "adventure lab": "Lab Cache",
    "community celebration": "Community Celebration Event",
    "community celebration event": "Community Celebration Event",
    "gps adventures": "GPS Adventures Exhibit", "gps adventures exhibit": "GPS Adventures Exhibit",
    "gps adventures maze": "GPS Adventures Exhibit",
    "hq block party": "Geocaching HQ Block Party", "block party": "Geocaching HQ Block Party",
    "geocaching hq block party": "Geocaching HQ Block Party",
}

SIZE_ALIASES: Dict[str, str] = {
    "micro": "Micro",
    "petite": "Small", "small": "Small",
    "normale": "Regular", "moyenne": "Regular", "regular": "Regular",
    "grande": "Large", "large": "Large",
    "autre": "Other", "other": "Other",
    "virtuelle": "Virtual", "virtual": "Virtual",
    "non choisie": "Not chosen", "non specifiee": "Not chosen", "not chosen": "Not chosen",
}

_TRUE = {"true", "1", "oui", "vrai", "yes", "y", "o"}
_FALSE = {"false", "0", "non", "faux", "no", "n", ""}

_GC_CODE_RE = re.compile(r"^GC[0-9A-Z]{1,8}$")

# Nombre maximal de libellés inconnus détaillés dans le rapport.
_MAX_UNKNOWN_LABELS = 20
# Taille lue pour détecter l'encodage.
_SNIFF_BYTES = 1024 * 1024


class CsvFormatError(ValueError):
    """Fichier inexploitable (en-tête illisible ou colonnes obligatoires absentes)."""

    def __init__(self, message: str, missing: Optional[List[str]] = None):
        super().__init__(message)
        self.missing = list(missing or [])


@dataclass
class FileReport:
    """Compte rendu de l'import d'un fichier, renvoyé à l'interface."""

    filename: str = ""
    encoding: str = "utf-8"
    delimiter: str = ","
    rows_read: int = 0
    rows_valid: int = 0
    invalid: Dict[str, int] = field(default_factory=dict)
    archived_without_date: int = 0
    reactivated: int = 0
    archive_before_placement: int = 0
    bad_archive_date: int = 0
    missing_exported_at: int = 0
    unknown_types: Dict[str, int] = field(default_factory=dict)
    unknown_sizes: Dict[str, int] = field(default_factory=dict)
    # Renseignés par le stockage (evolution_store.import_file).
    rows_new: int = 0
    rows_updated: int = 0
    rows_unchanged: int = 0
    rows_older: int = 0
    rows_duplicate: int = 0
    rows_newly_archived: int = 0

    @property
    def rows_invalid(self) -> int:
        return sum(self.invalid.values())

    def count_invalid(self, reason: str) -> None:
        self.invalid[reason] = self.invalid.get(reason, 0) + 1

    def to_dict(self) -> dict:
        return {
            "filename": self.filename,
            "encoding": self.encoding,
            "delimiter": self.delimiter,
            "rows_read": self.rows_read,
            "rows_valid": self.rows_valid,
            "rows_invalid": self.rows_invalid,
            "invalid": dict(self.invalid),
            "archived_without_date": self.archived_without_date,
            "reactivated": self.reactivated,
            "archive_before_placement": self.archive_before_placement,
            "bad_archive_date": self.bad_archive_date,
            "missing_exported_at": self.missing_exported_at,
            "unknown_types": dict(self.unknown_types),
            "unknown_sizes": dict(self.unknown_sizes),
            "rows_new": self.rows_new,
            "rows_updated": self.rows_updated,
            "rows_unchanged": self.rows_unchanged,
            "rows_older": self.rows_older,
            "rows_duplicate": self.rows_duplicate,
            "rows_newly_archived": self.rows_newly_archived,
        }


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def normalize_header(name: str) -> str:
    text = _strip_accents(str(name or "")).lower()
    text = text.replace("’", "'").replace("﻿", "")
    return " ".join(text.split())


def _norm_label(value: str) -> str:
    text = _strip_accents(value).lower().replace("-", " ").replace("_", " ")
    return " ".join(text.split())


def map_type(label: str) -> Tuple[str, bool]:
    """Nom canonique d'un type de cache, et False si le libellé est inconnu."""
    raw = (label or "").strip()
    if not raw:
        return "", True
    canonical = TYPE_ALIASES.get(_norm_label(raw))
    return (canonical, True) if canonical else (raw, False)


def map_size(label: str) -> Tuple[str, bool]:
    raw = (label or "").strip()
    if not raw:
        return "", True
    canonical = SIZE_ALIASES.get(_norm_label(raw))
    return (canonical, True) if canonical else (raw, False)


def parse_bool(value: str) -> Optional[bool]:
    text = (value or "").strip().lower()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    return None


def parse_date(value: str) -> Optional[date]:
    """Date ISO (heure éventuelle ignorée) ou JJ/MM/AAAA ; None si illisible."""
    text = (value or "").strip()
    if not text:
        return None
    head = text[:10]
    try:
        return date.fromisoformat(head)
    except ValueError:
        pass
    m = re.match(r"^(\d{1,2})[/.](\d{1,2})[/.](\d{4})", text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    return None


def parse_timestamp(value: str) -> str:
    """Horodatage d'export normalisé « AAAA-MM-JJ HH:MM:SS », '' si absent ou illisible.

    Le format fixe rend les horodatages comparables comme des chaînes, ce que
    fait la base pour décider quel export d'une même cache est le plus récent.
    """
    text = (value or "").strip()
    if not text:
        return ""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(text[:19], fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    day = parse_date(text)
    return f"{day.isoformat()} 00:00:00" if day else ""


def parse_number(value: str) -> Optional[float]:
    text = (value or "").strip().replace(",", ".")
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def parse_rating(value: str) -> Optional[float]:
    number = parse_number(value)
    if number is None or not 1 <= number <= 5:
        return None
    return number


# ---------------------------------------------------------------------------
# Lecture du fichier
# ---------------------------------------------------------------------------

class _CountingReader(io.RawIOBase):
    """Flux binaire qui compte les octets lus, pour la progression."""

    def __init__(self, raw):
        self._raw = raw
        self.bytes_read = 0

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:
        chunk = self._raw.read(len(buffer))
        n = len(chunk)
        buffer[:n] = chunk
        self.bytes_read += n
        return n

    def close(self) -> None:
        try:
            self._raw.close()
        finally:
            super().close()


def detect_encoding(path: str) -> str:
    """utf-8-sig si le début du fichier est de l'UTF-8 valide, cp1252 sinon."""
    with open(path, "rb") as fh:
        head = fh.read(_SNIFF_BYTES)
    try:
        head.decode("utf-8")
        return "utf-8-sig"
    except UnicodeDecodeError as exc:
        # Un caractère multi-octets coupé par la limite de lecture n'est pas
        # une erreur d'encodage.
        if exc.start >= len(head) - 3 and exc.reason == "unexpected end of data":
            return "utf-8-sig"
        return "cp1252"


def detect_delimiter(header_line: str) -> str:
    """Séparateur le plus fréquent hors guillemets parmi , ; et tabulation."""
    counts = {",": 0, ";": 0, "\t": 0}
    in_quotes = False
    for char in header_line:
        if char == '"':
            in_quotes = not in_quotes
        elif not in_quotes and char in counts:
            counts[char] += 1
    best = max(counts, key=lambda d: counts[d])
    return best if counts[best] > 0 else ","


def _raise_field_limit() -> None:
    # Les colonnes de notes et de logs peuvent dépasser la limite par défaut
    # (128 Kio) ; sys.maxsize déborde un long C sous Windows.
    limit = 10 * 1024 * 1024
    try:
        csv.field_size_limit(max(csv.field_size_limit(), limit))
    except OverflowError:  # pragma: no cover - dépend de la plateforme
        csv.field_size_limit(min(sys.maxsize, 2 ** 31 - 1))


def map_header(names: List[str]) -> Dict[str, int]:
    """Index de colonne de chaque champ reconnu (première occurrence retenue)."""
    mapping: Dict[str, int] = {}
    for index, name in enumerate(names):
        key = HEADER_ALIASES.get(normalize_header(name))
        if key and key not in mapping:
            mapping[key] = index
    return mapping


def _missing_fields(mapping: Dict[str, int]) -> List[str]:
    return [f for f in REQUIRED_FIELDS if f not in mapping]


def _open_text(path: str, encoding: str):
    counting = _CountingReader(open(path, "rb"))
    buffered = io.BufferedReader(counting, buffer_size=256 * 1024)
    text = io.TextIOWrapper(buffered, encoding=encoding, errors="replace", newline="")
    return counting, text


def read_header(path: str) -> Tuple[Dict[str, int], str, str]:
    """(colonnes reconnues, encodage, séparateur) ; CsvFormatError si inexploitable."""
    encoding = detect_encoding(path)
    counting, text = _open_text(path, encoding)
    try:
        header_line = text.readline()
    finally:
        text.close()
    if not header_line.strip():
        raise CsvFormatError("empty", missing=list(REQUIRED_FIELDS))
    delimiter = detect_delimiter(header_line)
    _raise_field_limit()
    names = next(csv.reader([header_line], delimiter=delimiter), [])
    mapping = map_header(names)
    missing = _missing_fields(mapping)
    if missing:
        raise CsvFormatError("missing-columns", missing=missing)
    return mapping, encoding, delimiter


def _cell(row: List[str], mapping: Dict[str, int], key: str) -> str:
    index = mapping.get(key)
    if index is None or index >= len(row):
        return ""
    return row[index].strip()


def _count_label(bucket: Dict[str, int], label: str) -> None:
    if label in bucket or len(bucket) < _MAX_UNKNOWN_LABELS:
        bucket[label] = bucket.get(label, 0) + 1


def normalize_row(row: List[str], mapping: Dict[str, int], report: FileReport) -> Optional[tuple]:
    """Ligne normalisée (voir ROW_FIELDS), ou None si elle est invalide."""
    code = _cell(row, mapping, "gc_code").upper()
    if not _GC_CODE_RE.match(code):
        report.count_invalid("code")
        return None

    lat = parse_number(_cell(row, mapping, "latitude"))
    lon = parse_number(_cell(row, mapping, "longitude"))
    if (lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180
            or (lat == 0 and lon == 0)):
        report.count_invalid("coordinates")
        return None

    placed = parse_date(_cell(row, mapping, "placed"))
    if placed is None:
        report.count_invalid("placed")
        return None

    archived_text = _cell(row, mapping, "archived_on")
    archived_on = parse_date(archived_text)
    if archived_text and archived_on is None:
        report.bad_archive_date += 1

    if "archived" in mapping:
        flag = parse_bool(_cell(row, mapping, "archived"))
        is_archived = bool(flag) if flag is not None else archived_on is not None
    else:
        is_archived = archived_on is not None

    if is_archived:
        if archived_on is None:
            # Ne disparaîtra jamais : comptée comme active jusqu'au bout.
            report.archived_without_date += 1
        elif archived_on < placed:
            report.archive_before_placement += 1
    elif archived_on is not None:
        # Cache réactivée après un archivage : l'ancienne date ne compte plus.
        report.reactivated += 1
        archived_on = None

    cache_type, known = map_type(_cell(row, mapping, "type"))
    if not known:
        _count_label(report.unknown_types, cache_type)
    size, known = map_size(_cell(row, mapping, "size"))
    if not known:
        _count_label(report.unknown_sizes, size)

    exported_at = parse_timestamp(_cell(row, mapping, "exported_at"))
    if not exported_at:
        report.missing_exported_at += 1

    report.rows_valid += 1
    return (
        code,
        _cell(row, mapping, "name")[:300],
        cache_type,
        size,
        parse_rating(_cell(row, mapping, "difficulty")),
        parse_rating(_cell(row, mapping, "terrain")),
        _cell(row, mapping, "owner")[:200],
        _cell(row, mapping, "placed_by")[:200],
        _cell(row, mapping, "country")[:100],
        _cell(row, mapping, "region")[:100],
        _cell(row, mapping, "county")[:100],
        lat,
        lon,
        placed.isoformat(),
        archived_on.isoformat() if archived_on else None,
        1 if is_archived else 0,
        exported_at,
    )


def iter_batches(
    path: str,
    report: FileReport,
    on_progress: Optional[Callable[[float], None]] = None,
    batch_size: int = 5000,
) -> Iterator[List[tuple]]:
    """Parcourt le fichier en flux et produit des lots de lignes normalisées.

    on_progress reçoit la fraction du fichier lue (0..1) après chaque lot.
    """
    mapping, encoding, delimiter = read_header(path)
    report.encoding = encoding
    report.delimiter = delimiter
    total = max(1, os.path.getsize(path))

    counting, text = _open_text(path, encoding)
    try:
        reader = csv.reader(text, delimiter=delimiter)
        next(reader, None)  # en-tête
        batch: List[tuple] = []
        for row in reader:
            if not row or all(not cell.strip() for cell in row):
                continue
            report.rows_read += 1
            normalized = normalize_row(row, mapping, report)
            if normalized is not None:
                batch.append(normalized)
            if len(batch) >= batch_size:
                yield batch
                batch = []
                if on_progress:
                    on_progress(min(1.0, counting.bytes_read / total))
        if batch:
            yield batch
        if on_progress:
            on_progress(1.0)
    finally:
        text.close()
