"""Formats de logs Geocaching — contrat `mygcflow-logs` v1 et logs des GPX.

Module sans dépendance obligatoire à Flask, testable sur fichiers
(docs/logs-geocaching.md). Deux sources :

- `mygcflow-logs` v1 : JSON neutre (logs, fiches de caches, couverture),
  produit par n'importe quel outil ;
- les logs Groundspeak d'un GPX (`<groundspeak:log>`) : My Finds, Pocket
  Query, export GSAK. Un GPX ne déclare aucune couverture : il n'autorise
  que l'ajout et la mise à jour, jamais une suppression.

Règles implémentées ici :

- une date de log est **civile** (`AAAA-MM-JJ`) ; d'un instant ISO, seule la
  partie date est retenue, sans conversion de fuseau (l'heure des GPX est
  factice) ; une date illisible rejette le log — elle n'est jamais devinée ;
- un log sans identité stable (`log_id` ou code `GL…`) est rejeté : sans
  elle, la fusion entre deux imports est impossible ;
- un type inconnu est conservé et signalé ; un type d'objet voyageur est
  rejeté (il ne concerne pas les caches) ;
- le texte d'un log n'est jamais lu ;
- une couverture mal formée est écartée : elle ne pourra rien supprimer ;
- tout document XML portant DOCTYPE/ENTITY est refusé (XXE).
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from io import BytesIO

from lab_formats import DTD_RE, validate_coordinates

# Les raisons (erreurs, avertissements) remontent jusqu'à l'interface : elles
# passent par gettext quand Flask-Babel est là, sans en faire une dépendance —
# hors application, le texte source français est rendu tel quel.
try:
    from flask_babel import gettext as _
except ImportError:  # module utilisé seul (outils, scripts)
    def _(message, **variables):
        return message % variables if variables else message

FORMAT_LOGS = "mygcflow-logs"
LOGS_SCHEMA_VERSION = 1
FORMAT_GPX = "gpx"
# Valeurs de `source_format` en base.
SOURCE_LOGS = "mygcflow-logs"
SOURCE_GPX = "gpx"
SOURCE_GPX_MYFINDS = "gpx-myfinds"
# Provenance d'une correction manuelle de coordonnées : prioritaire sur tout
# import ultérieur (même valeur que côté Labs).
USER_CORRECTION = "user_correction"

MAX_LOGS = 1_000_000
MAX_CACHES = 500_000

# ---------------------------------------------------------------------------
# Types de logs
# ---------------------------------------------------------------------------

CATEGORY_FIND = "find"
CATEGORY_DNF = "dnf"
CATEGORY_NOTE = "note"
CATEGORY_OWNER = "owner"
CATEGORY_REVIEWER = "reviewer"
CATEGORY_ALERT = "alert"
CATEGORY_EVENT = "event"
CATEGORY_OTHER = "other"

# Identifiants Geocaching (ceux des images `images/logtypes/<id>.png`) et
# libellé anglais des GPX. La catégorie ne dit pas qui a écrit le log : un
# Archive est une action de poseur s'il vient du propriétaire.
LOG_TYPES = {
    2: (CATEGORY_FIND, "Found it"),
    10: (CATEGORY_FIND, "Attended"),
    11: (CATEGORY_FIND, "Webcam Photo Taken"),
    3: (CATEGORY_DNF, "Didn't find it"),
    4: (CATEGORY_NOTE, "Write note"),
    46: (CATEGORY_OWNER, "Owner Maintenance"),
    47: (CATEGORY_OWNER, "Update Coordinates"),
    22: (CATEGORY_OWNER, "Temporarily Disable Listing"),
    23: (CATEGORY_OWNER, "Enable Listing"),
    5: (CATEGORY_OWNER, "Archive"),
    12: (CATEGORY_OWNER, "Unarchive"),
    24: (CATEGORY_REVIEWER, "Publish Listing"),
    25: (CATEGORY_REVIEWER, "Retract Listing"),
    18: (CATEGORY_REVIEWER, "Post Reviewer Note"),
    76: (CATEGORY_REVIEWER, "Submit for Review"),
    45: (CATEGORY_ALERT, "Needs Maintenance"),
    7: (CATEGORY_ALERT, "Needs Archived"),
    9: (CATEGORY_EVENT, "Will Attend"),
    74: (CATEGORY_EVENT, "Announcement"),
}

# Variantes d'identifiants (images alternatives du site) → identifiant canonique.
TYPE_ALIASES = {1: 12, 6: 5, 68: 18, 1003: 24}

# Objets voyageurs : Retrieved, Dropped off, Marked missing, Grabbed,
# Discovered, Visited — sans rapport avec les caches.
TRACKABLE_TYPE_IDS = frozenset({13, 14, 16, 19, 48, 75})


def _label_key(label: str) -> str:
    return re.sub(r"\s+", " ", str(label).replace("’", "'")).strip().lower()


_TYPE_BY_LABEL = {_label_key(label): type_id for type_id, (_cat, label) in LOG_TYPES.items()}
_TYPE_BY_LABEL.update({
    "needs archive": 7,
    "webcam photo taken": 11,
    "temporarily disable": 22,
    "enable": 23,
})


def canonical_type_id(type_id: int) -> int:
    return TYPE_ALIASES.get(type_id, type_id)


def type_id_from_label(label) -> int | None:
    if not label:
        return None
    return _TYPE_BY_LABEL.get(_label_key(label))


def log_category(type_id) -> str:
    entry = LOG_TYPES.get(type_id)
    return entry[0] if entry else CATEGORY_OTHER


_DAY_RANK = {CATEGORY_DNF: 0, CATEGORY_FIND: 1}


def day_order_key(log_date, type_id, log_id):
    """Ordre des logs d'une même journée (les logs n'ont pas d'heure fiable) :
    DNF, puis trouvaille, puis le reste ; `log_id` croissant ensuite."""
    return (log_date, _DAY_RANK.get(log_category(type_id), 2), log_id)


# ---------------------------------------------------------------------------
# Identités : codes GC (caches) et GL (logs)
# ---------------------------------------------------------------------------

_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRTVWXYZ"
_CODE_OFFSET = 411_120
_GC_CODE_RE = re.compile(r"^GC[0-9A-Z]{1,8}$")


def normalize_gc_code(value) -> str | None:
    """`gc 345j4` → `GC345J4` ; None si ce n'est pas un code GC."""
    if not isinstance(value, str):
        return None
    code = re.sub(r"\s+", "", value).upper()
    return code if _GC_CODE_RE.match(code) else None


def code_to_id(code, prefix: str) -> int | None:
    """Code `GC…`/`GL…` → identifiant numérique. Sous 65 536 : hexadécimal ;
    au-delà : base 31 de l'identifiant + 411 120 (vérifié sur des codes GC
    réels ; les codes GL suivent le même algorithme)."""
    if not isinstance(code, str):
        return None
    text = code.strip().upper()
    if not text.startswith(prefix) or len(text) <= len(prefix) or len(text) > len(prefix) + 8:
        return None
    body = text[len(prefix):]
    if len(body) <= 4 and all(ch in "0123456789ABCDEF" for ch in body):
        return int(body, 16)
    value = 0
    for ch in body:
        digit = _CODE_ALPHABET.find(ch)
        if digit < 0:
            return None
        value = value * 31 + digit
    value -= _CODE_OFFSET
    return value if value >= 0x10000 else None


def id_to_code(value: int, prefix: str) -> str:
    if value < 0x10000:
        return f"{prefix}{value:X}"
    value += _CODE_OFFSET
    digits = ""
    while value:
        value, rest = divmod(value, 31)
        digits = _CODE_ALPHABET[rest] + digits
    return prefix + digits


# ---------------------------------------------------------------------------
# Valeurs élémentaires
# ---------------------------------------------------------------------------

_CIVIL_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])")
# Le géocaching commence en mai 2000 : une date antérieure est une erreur.
MIN_LOG_DATE = date(2000, 1, 1)
CACHE_STATUSES = frozenset({"active", "disabled", "archived", "unknown"})
# Même règle que bdd.clean_geo_text (pays sans régions : « None »).
_GEO_PLACEHOLDERS = frozenset({"none"})


def parse_civil_date(value) -> date | None:
    """`2012-01-08` ou `2012-01-08T20:00:00Z` → date(2012, 1, 8) ; None sinon."""
    if not isinstance(value, str):
        return None
    m = _CIVIL_DATE_RE.match(value.strip())
    if not m:
        return None
    try:
        parsed = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    return parsed if parsed >= MIN_LOG_DATE else None


def parse_instant(value) -> datetime | None:
    """Instant ISO 8601 → datetime UTC naïf (comme les colonnes DateTime)."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _safe_int(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _clean_str(value, max_length: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:max_length] if text else None


def _clean_geo(value) -> str | None:
    text = _clean_str(value, 100)
    return None if text is None or text.lower() in _GEO_PLACEHOLDERS else text


def _rating(value) -> float | None:
    """Difficulté/terrain : 1 à 5 par pas de 0,5."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if 1.0 <= number <= 5.0 and (number * 2).is_integer() else None


# ---------------------------------------------------------------------------
# Résultats
# ---------------------------------------------------------------------------

@dataclass
class LogDraft:
    log_id: int
    gc_code: str
    type_id: int
    log_date: date
    author_id: int | None = None
    author_name: str | None = None
    favorite: bool | None = None
    type_label: str | None = None
    warnings: list = field(default_factory=list)


@dataclass
class CacheDraft:
    gc_code: str
    name: str | None = None
    cache_type: str | None = None
    container: str | None = None
    difficulty: float | None = None
    terrain: float | None = None
    country: str | None = None
    state: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    corrected_latitude: float | None = None
    corrected_longitude: float | None = None
    owner_id: int | None = None
    owner_name: str | None = None
    placed_date: date | None = None
    status: str | None = None
    favorite_points: int | None = None
    warnings: list = field(default_factory=list)


@dataclass
class CoverageScope:
    """Périmètre que le fichier contient en entier : un log stocké dans ce
    périmètre mais absent du fichier a été supprimé sur le site."""
    kind: str                              # 'author' | 'caches'
    author_id: int | None = None
    gc_codes: frozenset | None = None
    type_ids: frozenset | None = None      # None = tous les types
    since: date | None = None              # None = depuis toujours

    def contains(self, gc_code, type_id, log_date, author_id) -> bool:
        if self.kind == "author" and author_id != self.author_id:
            return False
        if self.kind == "caches" and gc_code not in self.gc_codes:
            return False
        if self.type_ids is not None and type_id not in self.type_ids:
            return False
        return self.since is None or log_date >= self.since


@dataclass
class LogsParseResult:
    ok: bool
    errors: list = field(default_factory=list)      # erreurs structurelles
    logs: list = field(default_factory=list)        # LogDraft
    caches: list = field(default_factory=list)      # CacheDraft
    rejected: list = field(default_factory=list)    # (section, index, raison)
    duplicates: int = 0
    meta: dict = field(default_factory=dict)

    def warning_counts(self) -> list:
        """Avertissements des enregistrements retenus, regroupés par raison."""
        counts = Counter(w for item in (*self.logs, *self.caches) for w in item.warnings)
        return [{"reason": reason, "count": n} for reason, n in counts.most_common()]

    def rejected_counts(self) -> list:
        counts = Counter(reason for _section, _idx, reason in self.rejected)
        return [{"reason": reason, "count": n} for reason, n in counts.most_common()]


def _new_meta(source) -> dict:
    return {"format": FORMAT_LOGS if source == SOURCE_LOGS else FORMAT_GPX,
            "source": source, "exported_at": None, "generator": None,
            "account_user_id": None, "account_username": None, "coverage": []}


# ---------------------------------------------------------------------------
# Détection
# ---------------------------------------------------------------------------

_FORMAT_HINT_RE = re.compile(r'"format"\s*:\s*"' + re.escape(FORMAT_LOGS) + '"')


def detect_logs_file_format(data: bytes) -> str | None:
    """Identifie le contenu : 'mygcflow-logs', 'gpx' ou None."""
    head = data[:65536].decode("utf-8-sig", "replace").lstrip()
    if head.startswith("{"):
        # Indice seulement (le fichier peut peser des dizaines de Mo) :
        # parse_logs_json revalide le contrat entier.
        return FORMAT_LOGS if _FORMAT_HINT_RE.search(head) else None
    if head.startswith("<"):
        if DTD_RE.search(head):
            return None  # rejeté plus loin aussi — jamais un format supporté
        return FORMAT_GPX if "groundspeak.com/cache" in head else None
    return None


def parse_logs_file(data: bytes) -> LogsParseResult:
    fmt = detect_logs_file_format(data)
    if fmt == FORMAT_LOGS:
        return parse_logs_json(data)
    if fmt == FORMAT_GPX:
        return parse_gpx_logs(data)
    res = LogsParseResult(ok=False)
    res.errors.append({"field": None, "reason": _("format de fichier non reconnu")})
    return res


# ---------------------------------------------------------------------------
# Contrat mygcflow-logs v1
# ---------------------------------------------------------------------------

def _parse_log_record(rec) -> tuple[LogDraft | None, str | None]:
    if not isinstance(rec, dict):
        return None, _("enregistrement non objet")
    warnings = []

    log_id = _safe_int(rec.get("log_id"))
    if rec.get("log_id") not in (None, "") and (log_id is None or log_id <= 0):
        return None, _("log_id invalide")
    code_id = None
    if rec.get("log_code") not in (None, ""):
        code_id = code_to_id(rec.get("log_code"), "GL")
        if code_id is None:
            return None, _("log_code invalide")
    if log_id is not None and code_id is not None and log_id != code_id:
        return None, _("log_id et log_code ne concordent pas")
    log_id = log_id if log_id is not None else code_id
    if log_id is None:
        return None, _("log sans identité (ni log_id, ni log_code)")

    gc_code = normalize_gc_code(rec.get("gc_code"))
    if gc_code is None:
        return None, _("code GC absent ou invalide")

    raw_type = _safe_int(rec.get("type_id"))
    type_label = _clean_str(rec.get("type_label"), 64)
    if rec.get("type_id") not in (None, "") and raw_type is None:
        return None, _("type_id invalide")
    type_id = canonical_type_id(raw_type) if raw_type is not None else type_id_from_label(type_label)
    if type_id is None:
        return None, _("type de log absent ou inconnu")
    if type_id in TRACKABLE_TYPE_IDS:
        return None, _("log d'objet voyageur, sans rapport avec les caches")
    if type_id not in LOG_TYPES:
        warnings.append(_("type de log inconnu — conservé"))

    log_date = parse_civil_date(rec.get("date"))
    if log_date is None:
        return None, _("date absente ou illisible")

    author = rec.get("author") if isinstance(rec.get("author"), dict) else {}
    author_id = _safe_int(author.get("id"))
    author_name = _clean_str(author.get("name"), 255)

    favorite = rec.get("favorite")
    if favorite not in (True, False, None):
        warnings.append(_("favorite non booléen — ignoré"))
        favorite = None

    return LogDraft(log_id=log_id, gc_code=gc_code, type_id=type_id, log_date=log_date,
                    author_id=author_id, author_name=author_name, favorite=favorite,
                    type_label=type_label, warnings=warnings), None


def _coords(lat, lon, warnings, label) -> tuple:
    if lat is None and lon is None:
        return None, None
    if lat is None or lon is None:
        warnings.append(_("%(label)s incomplètes — ignorées", label=label))
        return None, None
    check = validate_coordinates(lat, lon)
    warnings.extend(check.warnings)
    if not check.ok:
        warnings.append(_("%(label)s invalides — ignorées", label=label))
        return None, None
    return check.latitude, check.longitude


def _parse_cache_record(rec) -> tuple[CacheDraft | None, str | None]:
    if not isinstance(rec, dict):
        return None, _("enregistrement non objet")
    gc_code = normalize_gc_code(rec.get("gc_code"))
    if gc_code is None:
        return None, _("code GC absent ou invalide")
    draft = CacheDraft(gc_code=gc_code)
    w = draft.warnings
    draft.name = _clean_str(rec.get("name"), 255)
    draft.cache_type = _clean_str(rec.get("type"), 50)
    draft.container = _clean_str(rec.get("container"), 50)
    draft.country = _clean_geo(rec.get("country"))
    draft.state = _clean_geo(rec.get("state"))
    draft.latitude, draft.longitude = _coords(
        rec.get("latitude"), rec.get("longitude"), w, _("coordonnées"))
    corrected = rec.get("corrected") if isinstance(rec.get("corrected"), dict) else {}
    draft.corrected_latitude, draft.corrected_longitude = _coords(
        corrected.get("latitude"), corrected.get("longitude"), w, _("coordonnées corrigées"))
    for attr in ("difficulty", "terrain"):
        raw = rec.get(attr)
        value = _rating(raw)
        if raw is not None and value is None:
            w.append(_("%(field)s hors échelle — ignorée", field=attr))
        setattr(draft, attr, value)
    owner = rec.get("owner") if isinstance(rec.get("owner"), dict) else {}
    draft.owner_id = _safe_int(owner.get("id"))
    draft.owner_name = _clean_str(owner.get("name"), 255)
    draft.placed_date = parse_civil_date(rec.get("placed_date"))
    if rec.get("placed_date") not in (None, "") and draft.placed_date is None:
        w.append(_("date de pose illisible — ignorée"))
    status = rec.get("status")
    if isinstance(status, str) and status.strip().lower() in CACHE_STATUSES:
        draft.status = status.strip().lower()
    elif status is not None:
        w.append(_("état de cache inconnu — ignoré"))
    fp = _safe_int(rec.get("favorite_points"))
    draft.favorite_points = fp if fp is not None and fp >= 0 else None
    return draft, None


def _parse_coverage(item) -> tuple[CoverageScope | None, str | None]:
    """Seules les entrées `complete: true` comptent ; toute ambiguïté écarte
    l'entrée — une couverture douteuse ne doit rien supprimer."""
    if not isinstance(item, dict):
        return None, _("couverture non objet — ignorée")
    if item.get("complete") is not True:
        return None, None
    type_ids = None
    if item.get("type_ids") is not None:
        raw = item.get("type_ids")
        ids = [_safe_int(v) for v in raw] if isinstance(raw, list) else [None]
        if not ids or any(v is None for v in ids):
            return None, _("couverture : type_ids invalide — ignorée")
        type_ids = frozenset(canonical_type_id(v) for v in ids)
    since = None
    if item.get("since") is not None:
        since = parse_civil_date(item.get("since"))
        if since is None:
            return None, _("couverture : since illisible — ignorée")
    kind = item.get("kind")
    if kind == "author":
        author_id = _safe_int(item.get("author_id"))
        if author_id is None:
            return None, _("couverture : author_id manquant — ignorée")
        return CoverageScope(kind="author", author_id=author_id, type_ids=type_ids, since=since), None
    if kind == "caches":
        raw = item.get("gc_codes")
        codes = [normalize_gc_code(c) for c in raw] if isinstance(raw, list) else []
        if not codes or any(c is None for c in codes):
            return None, _("couverture : gc_codes invalide — ignorée")
        return CoverageScope(kind="caches", gc_codes=frozenset(codes), type_ids=type_ids,
                             since=since), None
    return None, _("couverture : kind inconnu — ignorée")


def parse_logs_json(data: bytes | str) -> LogsParseResult:
    """Parse un fichier `mygcflow-logs` v1."""
    res = LogsParseResult(ok=False, meta=_new_meta(SOURCE_LOGS))
    text = data.decode("utf-8-sig", "replace") if isinstance(data, (bytes, bytearray)) else str(data)
    try:
        doc = json.loads(text)
    except (json.JSONDecodeError, ValueError) as exc:
        res.errors.append({"field": None, "reason": _("JSON invalide : %(error)s", error=exc)})
        return res
    if not isinstance(doc, dict) or doc.get("format") != FORMAT_LOGS:
        res.errors.append({"field": "format", "reason": _("pas un fichier mygcflow-logs")})
        return res
    if doc.get("schema_version") != LOGS_SCHEMA_VERSION:
        res.errors.append({"field": "schema_version",
                           "reason": _("version non supportée : %(version)s",
                                       version=repr(doc.get("schema_version")))})
        return res
    logs = doc.get("logs")
    caches = doc.get("caches", [])
    coverage = doc.get("coverage", [])
    if not isinstance(logs, list):
        res.errors.append({"field": "logs", "reason": _("absent ou n'est pas une liste")})
    if not isinstance(caches, list):
        res.errors.append({"field": "caches", "reason": _("n'est pas une liste")})
    if not isinstance(coverage, list):
        res.errors.append({"field": "coverage", "reason": _("n'est pas une liste")})
    if res.errors:
        return res
    if len(logs) > MAX_LOGS or len(caches) > MAX_CACHES:
        res.errors.append({"field": "logs", "reason": _("trop d'enregistrements")})
        return res

    meta = res.meta
    meta["exported_at"] = parse_instant(doc.get("exported_at"))
    generator = doc.get("generator") if isinstance(doc.get("generator"), dict) else {}
    name = _clean_str(generator.get("name"), 64)
    version = _clean_str(generator.get("version"), 32)
    meta["generator"] = f"{name} {version}" if name and version else name
    account = doc.get("account") if isinstance(doc.get("account"), dict) else {}
    meta["account_user_id"] = _safe_int(account.get("user_id"))
    meta["account_username"] = _clean_str(account.get("username"), 255)
    meta["declared_logs"] = len(logs)
    meta["declared_caches"] = len(caches)

    seen_logs = set()
    for idx, rec in enumerate(logs):
        draft, reason = _parse_log_record(rec)
        if draft is None:
            res.rejected.append(("logs", idx, reason))
        elif draft.log_id in seen_logs:
            res.duplicates += 1
        else:
            seen_logs.add(draft.log_id)
            res.logs.append(draft)

    seen_caches = set()
    for idx, rec in enumerate(caches):
        draft, reason = _parse_cache_record(rec)
        if draft is None:
            res.rejected.append(("caches", idx, reason))
        elif draft.gc_code in seen_caches:
            res.duplicates += 1
        else:
            seen_caches.add(draft.gc_code)
            res.caches.append(draft)

    for idx, item in enumerate(coverage):
        scope, reason = _parse_coverage(item)
        if scope is not None:
            meta["coverage"].append(scope)
        elif reason:
            res.rejected.append(("coverage", idx, reason))

    res.ok = True
    return res


# ---------------------------------------------------------------------------
# Logs Groundspeak d'un GPX
# ---------------------------------------------------------------------------

def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _child(element, name):
    for child in element:
        if _local(child.tag) == name:
            return child
    return None


def _child_text(element, name) -> str | None:
    child = _child(element, name)
    return child.text if child is not None else None


def logs_from_cache_element(cache_el, gc_code) -> tuple[list, list]:
    """Logs d'un `<groundspeak:cache>` → (LogDraft…, raisons de rejet…).

    Partagé par `parse_gpx_logs` et l'import My Finds (`bdd.uploadBdd`), qui
    l'appelle dans sa propre passe sur le fichier."""
    drafts, rejected = [], []
    logs_el = _child(cache_el, "logs") if cache_el is not None else None
    if logs_el is None:
        return drafts, rejected
    code = normalize_gc_code(gc_code)
    for log_el in logs_el:
        if _local(log_el.tag) != "log":
            continue
        if code is None:
            rejected.append(_("code GC absent ou invalide"))
            continue
        log_id = _safe_int(log_el.get("id"))
        if log_id is None or log_id <= 0:
            rejected.append(_("log sans identité (ni log_id, ni log_code)"))
            continue
        label = _clean_str(_child_text(log_el, "type"), 64)
        type_id = type_id_from_label(label)
        if type_id is None:
            rejected.append(_("type de log absent ou inconnu"))
            continue
        log_date = parse_civil_date(_child_text(log_el, "date"))
        if log_date is None:
            rejected.append(_("date absente ou illisible"))
            continue
        finder = _child(log_el, "finder")
        drafts.append(LogDraft(
            log_id=log_id, gc_code=code, type_id=type_id, log_date=log_date,
            author_id=_safe_int(finder.get("id")) if finder is not None else None,
            author_name=_clean_str(finder.text, 255) if finder is not None else None,
            type_label=label))
    return drafts, rejected


def _cache_draft_from_wpt(wpt, cache_el, code) -> CacheDraft:
    draft = CacheDraft(gc_code=code)
    draft.latitude, draft.longitude = _coords(wpt.get("lat"), wpt.get("lon"), draft.warnings,
                                              _("coordonnées"))
    draft.name = _clean_str(_child_text(cache_el, "name"), 255)
    draft.cache_type = _clean_str(_child_text(cache_el, "type"), 50)
    draft.container = _clean_str(_child_text(cache_el, "container"), 50)
    draft.difficulty = _rating(_child_text(cache_el, "difficulty"))
    draft.terrain = _rating(_child_text(cache_el, "terrain"))
    draft.country = _clean_geo(_child_text(cache_el, "country"))
    draft.state = _clean_geo(_child_text(cache_el, "state"))
    owner = _child(cache_el, "owner")
    if owner is not None:
        draft.owner_id = _safe_int(owner.get("id"))
        draft.owner_name = _clean_str(owner.text, 255)
    # Le <time> d'un waypoint Groundspeak est la date de pose.
    draft.placed_date = parse_civil_date(_child_text(wpt, "time"))
    archived = (cache_el.get("archived") or "").lower()
    available = (cache_el.get("available") or "").lower()
    if archived == "true":
        draft.status = "archived"
    elif available == "false":
        draft.status = "disabled"
    elif available == "true":
        draft.status = "active"
    return draft


def _account_from_finders(logs) -> tuple:
    """My Finds ne contient que les logs du joueur : un identifiant d'auteur
    unique désigne le compte. Plusieurs → aucun (fichier inattendu)."""
    ids = {d.author_id for d in logs if d.author_id is not None}
    if len(ids) != 1:
        return None, None
    user_id = ids.pop()
    names = Counter(d.author_name for d in logs if d.author_id == user_id and d.author_name)
    return user_id, (names.most_common(1)[0][0] if names else None)


def myfinds_parse_result(logs, rejected_reasons) -> LogsParseResult:
    """Résultat d'import pour les logs collectés par l'import My Finds."""
    res = LogsParseResult(ok=True, meta=_new_meta(SOURCE_GPX_MYFINDS))
    seen = set()
    for draft in logs:
        if draft.log_id in seen:
            res.duplicates += 1
            continue
        seen.add(draft.log_id)
        res.logs.append(draft)
    res.rejected = [("logs", None, reason) for reason in rejected_reasons]
    res.meta["account_user_id"], res.meta["account_username"] = _account_from_finders(res.logs)
    return res


def parse_gpx_logs(data: bytes) -> LogsParseResult:
    """Logs et fiches de caches d'un GPX Groundspeak (My Finds, PQ, GSAK)."""
    res = LogsParseResult(ok=False, meta=_new_meta(SOURCE_GPX))
    head = data[:65536].decode("utf-8-sig", "replace")
    root_at = head.find("<gpx")
    if DTD_RE.search(head[:root_at] if root_at >= 0 else head):
        res.errors.append({"field": None, "reason": _("DOCTYPE/ENTITY interdit (XML non sûr)")})
        return res

    header = {}
    in_header = True
    seen_logs, seen_caches = set(), set()
    try:
        for event, el in ET.iterparse(BytesIO(data), events=("start", "end")):
            name = _local(el.tag)
            if event == "start":
                if name == "wpt":
                    in_header = False
                continue
            if in_header:
                if name in ("name", "time") and name not in header:
                    header[name] = el.text
                continue
            if name != "wpt":
                continue
            cache_el = _child(el, "cache")
            code = normalize_gc_code(_child_text(el, "name"))
            if cache_el is not None and code is not None:
                if code not in seen_caches:
                    seen_caches.add(code)
                    res.caches.append(_cache_draft_from_wpt(el, cache_el, code))
                drafts, rejected = logs_from_cache_element(cache_el, code)
                for draft in drafts:
                    if draft.log_id in seen_logs:
                        res.duplicates += 1
                    else:
                        seen_logs.add(draft.log_id)
                        res.logs.append(draft)
                res.rejected.extend(("logs", None, reason) for reason in rejected)
                if len(res.logs) > MAX_LOGS or len(res.caches) > MAX_CACHES:
                    res.errors.append({"field": "logs", "reason": _("trop d'enregistrements")})
                    return res
            el.clear()
    except ET.ParseError as exc:
        res.errors.append({"field": None, "reason": _("XML invalide : %(error)s", error=exc)})
        return res

    meta = res.meta
    meta["exported_at"] = parse_instant(header.get("time"))
    if "my finds pocket query" in (header.get("name") or "").lower():
        meta["source"] = SOURCE_GPX_MYFINDS
        meta["account_user_id"], meta["account_username"] = _account_from_finders(res.logs)
    meta["declared_logs"] = len(res.logs)
    meta["declared_caches"] = len(res.caches)
    res.ok = True
    return res
