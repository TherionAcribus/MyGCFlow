"""Formats et parsing Adventure Lab — historique et coordonnées.

Module sans dépendance obligatoire à Flask, testable sur fichiers. Deux formats supportés :

- `mygcflow-lab-finds` v1 : export JSON de l'historique `/logs` produit par
  le script d'export (`static/labs/export_lab_logs.src.js`) — identifiants
  d'étapes + dates de découverte, pas de coordonnées. Le réexport émis par
  l'application (`/api/labs/export`) reste en schema_version 1 : ses champs
  additifs (coordonnées, `owner`, `published_date`, provenance
  `user_correction`) sont relus — une correction manuelle survit ainsi à
  un aller-retour export → réimport.
- GPX Lab2Gpx « un waypoint par étape » : `gsak:Guid` (UUID d'étape),
  `lab2gpx:uuid` (UUID d'Adventure), coordonnées réelles ; `<time>` porte la
  publication de l'Adventure et n'est jamais une date de découverte — elle
  est lue comme telle, avec le propriétaire (`groundspeak:owner`).

Règles du plan implémentées ici :

- une date ambiguë (`14/05/2024`) n'est jamais devinée : la valeur est
  rejetée, l'enregistrement reste conservé sans date exploitable ;
- un instant sans offset n'invente pas de fuseau : seule sa date civile est
  retenue (précision 'day', basis 'source_naive_instant') ;
- les coordonnées exigent deux valeurs finies dans les bornes ; `(0,0)` est
  conservé mais signalé (sentinelle possible), sans rejet aveugle ;
- tout document XML portant DOCTYPE/ENTITY est refusé (XXE) ;
- un identifiant mal formé reste absent — la ligne garde son identité
  locale (local_key) et reste résolvable plus tard.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from io import BytesIO

# Les raisons (erreurs, avertissements) remontent jusqu'à l'interface : elles
# passent par gettext quand Flask-Babel est là, sans en faire une dépendance —
# hors application, le texte source français est rendu tel quel.
try:
    from flask_babel import gettext as _
except ImportError:  # module utilisé seul (outils, scripts)
    def _(message, **variables):
        return message % variables if variables else message

FORMAT_LAB_FINDS = "mygcflow-lab-finds"
LAB_FINDS_SCHEMA_VERSION = 1
FORMAT_LAB2GPX_GPX = "lab2gpx-gpx"
SOURCE_LAB_FINDS = "mygcflow-lab-finds"
SOURCE_LAB2GPX = "lab2gpx-gpx"
# Provenance d'une correction manuelle : prioritaire sur toute source
# fichier, réémise puis relue par le réexport mygcflow-lab-finds.
USER_CORRECTION = "user_correction"

COVERAGE_VALUES = {"unknown", "partial", "complete"}

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Tout ce qui ressemble à un début de datetime ISO : année-mois-jour + T.
ISO_INSTANT_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}T")
DTD_RE = re.compile(r"<!\s*(DOCTYPE|ENTITY)\b", re.IGNORECASE)


def normalize_uuid(value) -> str | None:
    """UUID normalisé en minuscules ; None si absent ou mal formé."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    return v.lower() if UUID_RE.match(v) else None


def normalize_title(title) -> str | None:
    """Titre normalisé pour le rapprochement (NFKC, casse, espaces)."""
    if not isinstance(title, str):
        return None
    t = unicodedata.normalize("NFKC", title).casefold().strip()
    return re.sub(r"\s+", " ", t) or None


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------

@dataclass
class ParsedDate:
    found_date: date | None
    found_at_utc: datetime | None        # naïf, exprimé en UTC
    offset_minutes: int | None
    precision: str | None                # 'instant' | 'day'
    basis: str | None
    warnings: list = field(default_factory=list)


def parse_lab_datetime(found_at, found_date_field=None) -> ParsedDate:
    """Interprète `found_at`/`found_date` d'une découverte.

    `found_at` : ISO 8601 — avec offset/`Z` → instant réel conservé + date
    civile dans cet offset ; date seule → précision 'day' ; naïf → date
    civile seule retenue (jamais de fuseau inventé) ; autre format → rejet.
    `found_date_field` : complément/fallback `YYYY-MM-DD` ; un désaccord avec
    la date civile de l'instant est signalé (l'instant fait foi).
    """
    out = ParsedDate(None, None, None, None, None)
    declared = None
    if isinstance(found_date_field, str) and ISO_DATE_RE.match(found_date_field.strip()):
        try:
            declared = date.fromisoformat(found_date_field.strip())
        except ValueError:
            out.warnings.append(_("found_date invalide (jour inexistant)"))
    elif found_date_field not in (None, ""):
        out.warnings.append(_("found_date au format non ISO — valeur ignorée"))

    text = found_at.strip() if isinstance(found_at, str) else None
    if text:
        if ISO_INSTANT_PREFIX.match(text):
            iso = text[:-1] + "+00:00" if text.endswith("Z") else text
            try:
                dt = datetime.fromisoformat(iso)
            except ValueError:
                out.warnings.append(_("found_at illisible"))
                dt = None
            if dt is not None:
                if dt.tzinfo is not None:
                    off = dt.utcoffset()
                    out.offset_minutes = int(off.total_seconds() // 60) if off else 0
                    out.found_at_utc = dt.astimezone(timezone.utc).replace(tzinfo=None)
                    # Date civile dans l'offset de la source — celle que la
                    # page /logs affiche (jamais la date UTC). /logs y met
                    # l'heure locale du joueur sous une étiquette d'offset du
                    # Pacifique : date et heure lues telles quelles sont
                    # justes, l'instant UTC qui en découle ne l'est pas.
                    out.found_date = dt.date()
                    out.precision = "instant"
                    out.basis = "source_offset"
                else:
                    # Instant sans fuseau : pas de fuseau inventé, on garde
                    # uniquement la date civile telle qu'affichée.
                    out.found_date = dt.date()
                    out.precision = "day"
                    out.basis = "source_naive_instant"
                    out.warnings.append(_("found_at sans fuseau — date civile seule retenue"))
        elif ISO_DATE_RE.match(text):
            try:
                out.found_date = date.fromisoformat(text)
                out.precision = "day"
                out.basis = "source_date_only"
            except ValueError:
                out.warnings.append(_("found_at date seule invalide"))
        else:
            # Format ambigu ou non ISO (ex. 14/05/2024) : jamais deviné.
            out.warnings.append(_("found_at ambigu ou non ISO — rejeté"))
    elif declared is not None:
        out.precision = "day"
        out.basis = "source_date_only"

    if out.found_date is None:
        out.found_date = declared
    elif declared is not None and declared != out.found_date:
        out.warnings.append(_("found_date en désaccord avec l'instant — instant retenu"))

    if out.found_date is None:
        out.precision = None
        out.basis = None
    return out


# ---------------------------------------------------------------------------
# Coordonnées
# ---------------------------------------------------------------------------

@dataclass
class CoordCheck:
    latitude: float | None
    longitude: float | None
    ok: bool
    warnings: list = field(default_factory=list)


def validate_coordinates(lat_raw, lon_raw) -> CoordCheck:
    """Valide un couple lat/lon : fini, bornes respectées, (0,0) signalé."""
    out = CoordCheck(None, None, False)
    try:
        lat = float(lat_raw)
        lon = float(lon_raw)
    except (TypeError, ValueError):
        out.warnings.append(_("coordonnées non numériques"))
        return out
    if not (lat == lat and lon == lon) or lat in (float("inf"), -float("inf")) \
            or lon in (float("inf"), -float("inf")):
        out.warnings.append(_("coordonnées non finies"))
        return out
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        out.warnings.append(_("coordonnées hors bornes"))
        return out
    out.latitude, out.longitude, out.ok = lat, lon, True
    if lat == 0.0 and lon == 0.0:
        out.warnings.append(_("(0,0) — sentinelle possible, à vérifier"))
    return out


# Saisie libre d'une position : symboles de degrés/minutes/secondes lus comme
# des espaces, « O » (Ouest) comme « W ».
_COORD_SYMBOLS = re.compile("[°º˚'’′\"”″]")
_COORD_TOKEN = re.compile(r"\s*([NSEWO]|-?\d+(?:\.\d+)?|[,;])")
_DECIMAL_COMMA = re.compile(r"(\d),(\d)")


def _coord_part(numbers: list[str], negative_allowed: bool) -> float | None:
    """Degrés [minutes [secondes]] → degrés décimaux ; None si mal formé."""
    if not 1 <= len(numbers) <= 3:
        return None
    if any(n.startswith("-") for n in numbers[1:]) \
            or (numbers[0].startswith("-") and not negative_allowed):
        return None
    sign = -1.0 if numbers[0].startswith("-") else 1.0
    values = [abs(float(n)) for n in numbers]
    # Seule la dernière composante peut porter des décimales, et minutes et
    # secondes restent sous 60 : « 48.5 30 » ou « 48 75 » ne veulent rien dire.
    if any(not v.is_integer() for v in values[:-1]) \
            or any(v >= 60 for v in values[1:]):
        return None
    deg = values[0] + sum(v / 60 ** i for i, v in enumerate(values[1:], start=1))
    return sign * deg


def parse_coordinates_text(text) -> CoordCheck:
    """Position saisie en une chaîne, dans les formats courants du géocacheur :

    - décimal : `48.8584, 2.2945` — `48,8584 2,2945` (virgule décimale) ;
    - degrés-minutes : `N 48° 51.504 E 002° 17.670` (format geocaching.com) ;
    - degrés-minutes-secondes : `48°51'30.2"N 2°17'40.2"E` ;
    - lettres N/S et E/W/O devant ou derrière, latitude en premier sans lettre.

    Jamais deviné : toute forme ambiguë est refusée. Bornes et (0,0) passent
    ensuite par `validate_coordinates`."""
    unreadable = CoordCheck(None, None, False, [_("format de coordonnées non reconnu")])
    if not isinstance(text, str) or not text.strip():
        return unreadable
    norm = _COORD_SYMBOLS.sub(" ", unicodedata.normalize("NFKC", text).upper()).strip()
    if "." not in norm:
        norm = _DECIMAL_COMMA.sub(r"\1.\2", norm)

    tokens, pos = [], 0
    while pos < len(norm):
        match = _COORD_TOKEN.match(norm, pos)
        if not match:
            if norm[pos:].strip():
                return unreadable
            break
        tokens.append(match.group(1))
        pos = match.end()

    letters = [tok for tok in tokens if tok.isalpha()]
    if letters:
        if len(letters) != 2:
            return unreadable
        # Lettre devant (N 48 51.504) ou derrière (48 51 30.2 N) : chaque
        # groupe de nombres s'attache à la lettre de son côté.
        prefix = tokens[0].isalpha()
        if not prefix and not tokens[-1].isalpha():
            return unreadable
        groups, current = [], []
        for tok in tokens:
            if tok in (",", ";"):
                continue
            if tok.isalpha():
                if prefix:
                    current = []
                    groups.append((tok, current))
                else:
                    groups.append((tok, current))
                    current = []
            else:
                current.append(tok)
        if (prefix and len(groups) != 2) or (not prefix and current):
            return unreadable
        values = {}
        for letter, numbers in groups:
            value = _coord_part(numbers, negative_allowed=False)
            if value is None:
                return unreadable
            axis = "lat" if letter in "NS" else "lon"
            if axis in values:
                return unreadable
            values[axis] = -value if letter in "SWO" else value
        if len(values) != 2:
            return unreadable
        lat, lon = values["lat"], values["lon"]
    else:
        seps = [i for i, tok in enumerate(tokens) if tok in (",", ";")]
        numbers = [tok for tok in tokens if tok not in (",", ";")]
        if len(seps) == 1:
            first, second = tokens[:seps[0]], tokens[seps[0] + 1:]
        elif not seps and len(numbers) in (2, 4, 6):
            # Sans séparateur ni lettre : autant de composantes de chaque côté.
            half = len(numbers) // 2
            first, second = numbers[:half], numbers[half:]
        else:
            return unreadable
        lat = _coord_part(first, negative_allowed=True)
        lon = _coord_part(second, negative_allowed=True)
        if lat is None or lon is None:
            return unreadable
    return validate_coordinates(lat, lon)


# ---------------------------------------------------------------------------
# Résultats
# ---------------------------------------------------------------------------

@dataclass
class DiscoveryDraft:
    """Découverte normalisée issue d'un fichier historique."""
    local_key: str
    adventure_uuid: str | None
    stage_uuid: str | None
    source_record_key: str | None
    adventure_title: str | None
    stage_title: str | None
    adventure_url: str | None
    found_date: date | None
    found_at_utc: datetime | None
    found_at_offset_minutes: int | None
    date_precision: str | None
    date_basis: str | None
    source_date_text: str | None
    latitude: float | None
    longitude: float | None
    coordinate_scope: str | None
    is_archived: bool
    warnings: list = field(default_factory=list)
    # Champs additifs du réexport MyGCFlow : absents d'un export /logs brut,
    # relus quand ils sont présents (schema_version 1 inchangé).
    coordinate_source: str | None = None
    owner: str | None = None
    published_date: date | None = None


@dataclass
class StageCoord:
    """Étape géolocalisée issue d'un fichier coordonnées."""
    index: int
    stage_uuid: str | None
    adventure_uuid: str | None
    stage_title: str | None
    adventure_url: str | None
    latitude: float
    longitude: float
    found_flag: bool
    stages_total: int | None
    stages_completed: int | None
    warnings: list = field(default_factory=list)
    owner: str | None = None
    published_date: date | None = None   # publication de l'Adventure


@dataclass
class HistoryParseResult:
    ok: bool
    errors: list = field(default_factory=list)      # erreurs structurelles
    drafts: list = field(default_factory=list)       # DiscoveryDraft
    rejected: list = field(default_factory=list)     # (index, raison)
    duplicates: int = 0
    meta: dict = field(default_factory=dict)


@dataclass
class CoordParseResult:
    ok: bool
    errors: list = field(default_factory=list)
    stages: list = field(default_factory=list)       # StageCoord
    rejected: list = field(default_factory=list)
    meta: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Détection
# ---------------------------------------------------------------------------

def detect_lab_file_format(data: bytes) -> str | None:
    """Identifie le contenu : 'mygcflow-lab-finds', 'lab2gpx-gpx' ou None."""
    text = data.decode("utf-8-sig", "replace").lstrip()
    if text.startswith("{"):
        try:
            head = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return None
        if isinstance(head, dict) and head.get("format") == FORMAT_LAB_FINDS:
            return FORMAT_LAB_FINDS
        return None
    if text.startswith("<"):
        if DTD_RE.search(text):
            return None  # rejeté plus loin aussi — jamais un format supporté
        if "lab2gpx" in text[:200000]:
            return FORMAT_LAB2GPX_GPX
        return None
    return None


# ---------------------------------------------------------------------------
# Historique mygcflow-lab-finds
# ---------------------------------------------------------------------------

_MAX_DISCOVERIES = 500_000


def _local_key(stage_uuid, log_id) -> tuple[str | None, str | None]:
    """Clé locale stable + clé source (dédoublonnage sans UUID)."""
    if stage_uuid:
        return stage_uuid, None
    if log_id is not None:
        return f"log:{log_id}", f"log:{log_id}"
    return None, None


def parse_lab_finds(data: bytes | str) -> HistoryParseResult:
    """Parse un export `mygcflow-lab-finds` v1."""
    res = HistoryParseResult(ok=False)
    text = data.decode("utf-8-sig", "replace") if isinstance(data, (bytes, bytearray)) else str(data)
    try:
        doc = json.loads(text)
    except (json.JSONDecodeError, ValueError) as exc:
        res.errors.append({"field": None, "reason": _("JSON invalide : %(error)s", error=exc)})
        return res
    if not isinstance(doc, dict) or doc.get("format") != FORMAT_LAB_FINDS:
        res.errors.append({"field": "format", "reason": _("pas un export mygcflow-lab-finds")})
        return res
    if doc.get("schema_version") != LAB_FINDS_SCHEMA_VERSION:
        res.errors.append({"field": "schema_version",
                           "reason": _("version non supportée : %(version)s",
                                       version=repr(doc.get('schema_version')))})
        return res
    items = doc.get("discoveries")
    if not isinstance(items, list):
        res.errors.append({"field": "discoveries", "reason": _("absent ou n'est pas une liste")})
        return res
    if len(items) > _MAX_DISCOVERIES:
        res.errors.append({"field": "discoveries", "reason": _("trop d'enregistrements")})
        return res

    exported_at = None
    raw_exported = doc.get("exported_at")
    if isinstance(raw_exported, str):
        try:
            exported_at = datetime.fromisoformat(
                raw_exported[:-1] + "+00:00" if raw_exported.endswith("Z") else raw_exported)
        except ValueError:
            exported_at = None
    account = doc.get("account") if isinstance(doc.get("account"), dict) else {}
    res.meta = {
        "format": FORMAT_LAB_FINDS,
        "schema_version": LAB_FINDS_SCHEMA_VERSION,
        "exported_at": exported_at.replace(tzinfo=None) if exported_at else None,
        "coverage": doc.get("coverage") if doc.get("coverage") in COVERAGE_VALUES else "unknown",
        "account_label": (account.get("username") or None) if isinstance(account, dict) else None,
        "declared_count": len(items),
    }

    seen_keys = set()
    for idx, rec in enumerate(items):
        if not isinstance(rec, dict):
            res.rejected.append((idx, _("enregistrement non objet")))
            continue

        stage_raw = rec.get("stage_id")
        stage_uuid = normalize_uuid(stage_raw)
        adventure_uuid = normalize_uuid(rec.get("adventure_id"))
        warnings = []
        if stage_raw not in (None, "") and stage_uuid is None:
            warnings.append(_("stage_id non UUID — identifiant ignoré"))
        if rec.get("adventure_id") not in (None, "") and adventure_uuid is None:
            warnings.append(_("adventure_id non UUID — identifiant ignoré"))

        log_id = rec.get("log_id")
        local_key, record_key = _local_key(stage_uuid, log_id)
        if local_key is None:
            stage_title = rec.get("stage_title")
            if stage_uuid is None and not stage_title:
                res.rejected.append((idx, _("aucune identité exploitable (ni UUID, ni log_id, ni titre)")))
                continue
            digest = hashlib.sha256(
                f"{adventure_uuid}|{stage_title}|{idx}".encode("utf-8")
            ).hexdigest()[:16]
            local_key = f"row:{digest}"
            warnings.append(_("identité dérivée de la ligne — reimport non garanti"))

        if local_key in seen_keys:
            res.duplicates += 1
            continue
        seen_keys.add(local_key)

        pd = parse_lab_datetime(rec.get("found_at"), rec.get("found_date"))
        warnings.extend(pd.warnings)

        lat = lon = None
        scope = rec.get("coordinate_scope")
        if rec.get("latitude") is not None or rec.get("longitude") is not None:
            cc = validate_coordinates(rec.get("latitude"), rec.get("longitude"))
            warnings.extend(cc.warnings)
            if cc.ok:
                lat, lon = cc.latitude, cc.longitude
            else:
                warnings.append(_("coordonnées historique invalides — ignorées"))

        # Réexport MyGCFlow : la sentinelle « correction manuelle » est la
        # seule provenance entrante honorée — tout autre date_basis /
        # coordinate_source déclaré est ignoré et recalculé (ici pour la
        # date, dans la couche store pour les coordonnées).
        user_corrected = rec.get("date_basis") == USER_CORRECTION \
            and pd.found_date is not None

        res.drafts.append(DiscoveryDraft(
            local_key=local_key,
            adventure_uuid=adventure_uuid,
            stage_uuid=stage_uuid,
            source_record_key=record_key or (f"log:{log_id}" if log_id is not None else None),
            adventure_title=_clean_str(rec.get("adventure_title")),
            stage_title=_clean_str(rec.get("stage_title")),
            adventure_url=_clean_str(rec.get("adventure_url")),
            found_date=pd.found_date,
            found_at_utc=pd.found_at_utc,
            found_at_offset_minutes=pd.offset_minutes,
            date_precision=pd.precision,
            date_basis=USER_CORRECTION if user_corrected else pd.basis,
            source_date_text=_clean_str(rec.get("found_at")) or _clean_str(rec.get("found_date")),
            latitude=lat,
            longitude=lon,
            coordinate_scope=scope if scope in ("stage", "adventure") else None,
            is_archived=bool(rec.get("is_archived") or rec.get("adventure_is_archived")),
            warnings=warnings,
            coordinate_source=(USER_CORRECTION
                               if rec.get("coordinate_source") == USER_CORRECTION
                               else None),
            owner=_clean_str(rec.get("owner")),
            published_date=_leading_date(rec.get("published_date")),
        ))

    res.ok = True
    return res


def _clean_str(value) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip()
    return v or None


# ---------------------------------------------------------------------------
# GPX Lab2Gpx (coordonnées)
# ---------------------------------------------------------------------------

def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _child_text(element, local_name: str):
    for child in element:
        if _local_name(child.tag) == local_name:
            return child.text
    return None


def _find(element, local_name: str):
    for child in element.iter():
        if _local_name(child.tag) == local_name:
            return child
    return None


def _leading_date(value) -> date | None:
    """Date civile en tête d'un horodatage ISO ; None si absente ou invalide."""
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def _safe_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_lab2gpx_gpx(data: bytes | str) -> CoordParseResult:
    """Parse un GPX Lab2Gpx « un waypoint par étape » (coordonnées)."""
    res = CoordParseResult(ok=False)
    if isinstance(data, (bytes, bytearray)):
        raw = bytes(data)
    else:
        raw = str(data).encode("utf-8")
    if DTD_RE.search(raw.decode("utf-8", "replace")):
        res.errors.append({"field": None, "reason": _("DOCTYPE/ENTITY interdit (XML non sûr)")})
        return res
    try:
        events = ET.iterparse(BytesIO(raw), events=("end",))
        for _event, elem in events:
            if _local_name(elem.tag) != "wpt":
                continue
            idx = len(res.stages) + len(res.rejected)
            warnings = []
            cc = validate_coordinates(elem.get("lat"), elem.get("lon"))
            if not cc.ok:
                res.rejected.append((idx, "; ".join(cc.warnings) or _("coordonnées invalides")))
                elem.clear()
                continue
            warnings.extend(cc.warnings)

            guid_el = _find(elem, "Guid")
            stage_uuid = normalize_uuid(guid_el.text if guid_el is not None else None)
            adv_el = _find(elem, "uuid")
            adventure_uuid = normalize_uuid(adv_el.text if adv_el is not None else None)
            if stage_uuid is None:
                res.rejected.append((idx, _("pas d'UUID d'étape (gsak:Guid absent ou mal formé)")))
                elem.clear()
                continue

            desc = _child_text(elem, "desc")
            url = _child_text(elem, "url")
            sym = _child_text(elem, "sym")
            owner_el = _find(elem, "owner")
            adv_block = _find(elem, "adventureLab")
            stages_total = stages_completed = None
            if adv_block is not None:
                stages_total = _safe_int(_child_text(adv_block, "stagesTotal"))
                stages_completed = _safe_int(_child_text(adv_block, "stagesCompleted"))
            if adventure_uuid is None:
                warnings.append(_("UUID d'Adventure absent — contrôle de cohérence impossible"))

            res.stages.append(StageCoord(
                index=idx,
                stage_uuid=stage_uuid,
                adventure_uuid=adventure_uuid,
                stage_title=_clean_str(desc),
                adventure_url=_clean_str(url),
                latitude=cc.latitude,
                longitude=cc.longitude,
                found_flag=(sym or "").strip() == "Geocache Found",
                stages_total=stages_total,
                stages_completed=stages_completed,
                warnings=warnings,
                owner=_clean_str(owner_el.text if owner_el is not None else None),
                published_date=_leading_date(_child_text(elem, "time")),
            ))
            elem.clear()
    except ET.ParseError as exc:
        res.errors.append({"field": None, "reason": _("XML illisible : %(error)s", error=exc)})
        return res

    res.meta = {"format": FORMAT_LAB2GPX_GPX, "wpt_seen": len(res.stages) + len(res.rejected)}
    res.ok = True
    return res
