"""Parcours enregistrés : création, lecture, modification, suppression.

Un parcours est une sélection de trouvailles sur une plage de dates courte
(une journée, des vacances), rejouée cache par cache sur la page /parcours
(MyGCFlow_Plan_Parcours.md). Seule la sélection est stockée : l'ordre de
passage et les heures sont reconstruits à chaque ouverture.

Les ajustements manuels (lot 3 : rang, heure épinglée, journée, exclusion,
lieux et bases) sont stockés à part et appliqués par la reconstruction
(static/js/parcours_reconstruct.mjs) par-dessus son calcul.

Les erreurs de saisie lèvent `ParcoursError(code)` ; le blueprint traduit le
code en message (comme evolution_store).
"""

from __future__ import annotations

import json
import re
import threading
from collections import defaultdict
from datetime import date, datetime, time, timedelta

from sqlalchemy import func

from models import (Geocache, LabDiscovery, Parcours, ParcoursOverride,
                    ParcoursPhoto, ParcoursPlace, ParcoursTrack)
from settings_manager import (PARCOURS_CAMERA_MODES, PARCOURS_FRAMINGS,
                              PARCOURS_HEAD_STYLES,
                              PARCOURS_HOURS_DISPLAYS, PARCOURS_PACES,
                              PARCOURS_TITLE_SOURCES,
                              clean_parcours_photo_display_value)

NAME_MAX_LENGTH = 80
# Format pensé pour des sorties courtes : au-delà, l'animation cache par cache
# n'a plus de sens (l'animation jour par jour de la page principale s'impose).
MAX_DAYS = 92


class ParcoursError(Exception):
    def __init__(self, code: str, detail: dict | None = None):
        super().__init__(code)
        self.code = code
        # Compteurs ou détails renvoyés au client (ex. 'out-of-range').
        self.detail = detail or {}


# Les envois partent en parallèle côté page : sans sérialisation, deux envois
# d'un même fichier passeraient ensemble le contrôle « déjà là ? » puis
# s'inséreraient en doublon et écriraient le même .part. Le traitement lourd
# (normalisation, lecture GPX) reste hors du verrou.
_SAVE_LOCKS: dict[int, threading.Lock] = {}
_SAVE_LOCKS_GUARD = threading.Lock()


def save_lock(parcours_id: int) -> threading.Lock:
    """Verrou sérialisant les écritures (photos, traces) d'un parcours."""
    with _SAVE_LOCKS_GUARD:
        return _SAVE_LOCKS.setdefault(parcours_id, threading.Lock())


def _name(value) -> str:
    name = value.strip() if isinstance(value, str) else ''
    if not name:
        raise ParcoursError('name-empty')
    if len(name) > NAME_MAX_LENGTH:
        raise ParcoursError('name-too-long')
    return name


def _date(value) -> date:
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            pass
    raise ParcoursError('date-invalid')


def _bool(value, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _check_range(start: date, end: date) -> None:
    if end < start:
        raise ParcoursError('range-reversed')
    if (end - start).days + 1 > MAX_DAYS:
        raise ParcoursError('range-too-long')


# Réglages de lecture propres au parcours (colonne `playback`, JSON épars) :
# seules les clés explicitement réglées y vivent ; les autres suivent la
# préférence globale `parcours_playback` (le défaut). Mêmes domaines que
# `coerce_parcours_playback` de settings_manager.
_PLAYBACK_CHOICES = {
    'pace': PARCOURS_PACES,
    'hours': PARCOURS_HOURS_DISPLAYS,
    'camera': PARCOURS_CAMERA_MODES,
    'framing': PARCOURS_FRAMINGS,
    'head': PARCOURS_HEAD_STYLES,
    'title': PARCOURS_TITLE_SOURCES,
}
_PLAYBACK_FLAGS = ('day_cards', 'estimated_dashed')


def _playback_out(raw) -> dict:
    try:
        data = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        data = {}
    return data if isinstance(data, dict) else {}


def _playback_in(value) -> str | None:
    """Surcharges éparses : seules les clés connues et valides sont gardées ;
    rien de valable → NULL (le parcours suit alors le réglage global)."""
    if not isinstance(value, dict):
        return None
    kept = {key: item for key, item in value.items()
            if (key in _PLAYBACK_CHOICES and item in _PLAYBACK_CHOICES[key])
            or (key in _PLAYBACK_FLAGS and isinstance(item, bool))}
    return json.dumps(kept) if kept else None


# Affichage des photos propre au parcours (colonne `photo_display`, JSON
# épars) : même principe que `playback`, sur la préférence globale
# `parcours_photo_display`. Domaines : ceux de settings_manager.
def _photo_display_out(raw) -> dict:
    return _playback_out(raw)


def _photo_display_in(value) -> str | None:
    if not isinstance(value, dict):
        return None
    kept = {}
    for key, item in value.items():
        clean = clean_parcours_photo_display_value(key, item)
        if clean is not None:
            kept[key] = clean
    return json.dumps(kept) if kept else None


def to_dict(parcours: Parcours) -> dict:
    return {
        'id': parcours.id,
        'name': parcours.name,
        'date_start': parcours.date_start.isoformat(),
        'date_end': parcours.date_end.isoformat(),
        'include_labs': bool(parcours.include_labs),
        'include_dnf': bool(parcours.include_dnf),
        'utc_offset_minutes': parcours.utc_offset_minutes,
        'playback': _playback_out(parcours.playback),
        'photo_display': _photo_display_out(parcours.photo_display),
        'created_at': parcours.created_at.isoformat() if parcours.created_at else None,
        'updated_at': parcours.updated_at.isoformat() if parcours.updated_at else None,
    }


def list_parcours(session) -> list[dict]:
    """Les plus récents d'abord (plage), puis par nom, avec les compteurs
    affichés par la liste."""
    rows = session.query(Parcours).order_by(
        Parcours.date_start.desc(), Parcours.date_end.desc(), Parcours.name, Parcours.id).all()
    counts = _listing_counts(session, rows)
    return [{**to_dict(row), 'counts': counts[row.id]} for row in rows]


def _listing_counts(session, rows: list) -> dict[int, dict]:
    """{parcours_id → {stops, overrides, places, photos, tracks}} : quatre
    regroupements pour les objets rattachés, puis les étapes."""
    counts = {row.id: {'stops': 0, 'overrides': 0, 'places': 0,
                       'photos': 0, 'tracks': 0} for row in rows}
    if not rows:
        return counts
    ids = [row.id for row in rows]
    for model, key in ((ParcoursOverride, 'overrides'), (ParcoursPlace, 'places'),
                       (ParcoursPhoto, 'photos'), (ParcoursTrack, 'tracks')):
        for pid, n in session.query(model.parcours_id, func.count()).filter(
                model.parcours_id.in_(ids)).group_by(model.parcours_id):
            counts[pid][key] = n
    _listing_stops(session, rows, counts)
    return counts


def _listing_stops(session, rows: list, counts: dict) -> None:
    """Étapes de chaque parcours : trouvailles, Labs et DNF relevés par
    journée sur la réunion des plages (trois requêtes, quel que soit le
    nombre de parcours), puis répartis. Même règle que
    parcours_dataset.build_days — un DNF sur une cache trouvée le jour
    même ne compte pas — à une approximation près, assumée pour un badge :
    une cache sans position compterait."""
    lo = min(row.date_start for row in rows)
    hi = max(row.date_end for row in rows)
    with_labs = any(row.include_labs for row in rows)
    with_dnf = any(row.include_dnf for row in rows)

    finds: dict = defaultdict(int)
    found_keys: set = set()
    for code, found in session.query(Geocache.gc_code, Geocache.date_find).filter(
            Geocache.found.is_(True),
            Geocache.date_find >= datetime.combine(lo, time.min),
            Geocache.date_find < datetime.combine(hi + timedelta(days=1), time.min)):
        day = found.date() if isinstance(found, datetime) else found
        finds[day] += 1
        if with_dnf:
            found_keys.add((code, day))

    labs: dict = defaultdict(int)
    if with_labs:
        # Import local, comme dans parcours_dataset : lab_store importe
        # déjà les modèles.
        from lab_store import get_collection
        collection = get_collection(session)
        if collection is not None:
            for day, n in session.query(LabDiscovery.found_date, func.count()).filter(
                    LabDiscovery.collection_id == collection.id,
                    LabDiscovery.ready_clause(),
                    LabDiscovery.found_date >= lo, LabDiscovery.found_date <= hi,
                    ).group_by(LabDiscovery.found_date):
                labs[day] = n

    dnfs: dict = defaultdict(int)
    if with_dnf:
        # Import local : parcours_dataset importe ce module.
        from parcours_dataset import _my_logs
        for _, code, day in _my_logs(session, lo, hi)[1]:
            if (code, day) not in found_keys:
                dnfs[day] += 1

    for row in rows:
        day, total = row.date_start, 0
        while day <= row.date_end:
            total += finds[day]
            if row.include_labs:
                total += labs[day]
            if row.include_dnf:
                total += dnfs[day]
            day += timedelta(days=1)
        counts[row.id]['stops'] = total


def get(session, parcours_id: int) -> Parcours:
    row = session.get(Parcours, parcours_id)
    if row is None:
        raise ParcoursError('not-found')
    return row


def create(session, data: dict) -> Parcours:
    data = data if isinstance(data, dict) else {}
    start = _date(data.get('date_start'))
    end = _date(data.get('date_end', data.get('date_start')))
    _check_range(start, end)
    now = datetime.now()
    row = Parcours(
        name=_name(data.get('name')),
        date_start=start,
        date_end=end,
        include_labs=_bool(data.get('include_labs'), True),
        include_dnf=_bool(data.get('include_dnf'), True),
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    session.commit()
    return row


def _out_of_range(session, parcours: Parcours, start: date, end: date) -> tuple:
    """(lieux et bases datés, ajustements « journée ») hors de la plage."""
    places = session.query(ParcoursPlace).filter(
        ParcoursPlace.parcours_id == parcours.id, ParcoursPlace.date.isnot(None),
        (ParcoursPlace.date < start) | (ParcoursPlace.date > end)).all()
    days = session.query(ParcoursOverride).filter(
        ParcoursOverride.parcours_id == parcours.id, ParcoursOverride.day.isnot(None),
        (ParcoursOverride.day < start) | (ParcoursOverride.day > end)).all()
    return places, days


def _drop_out_of_range(session, parcours: Parcours, start: date, end: date) -> None:
    """Nettoie ce que la nouvelle plage laisse dehors : un lieu daté est
    supprimé (il n'a de sens que dans sa journée) ; l'ajustement « journée »
    est effacé — l'étape retrouve sa journée d'origine, le reste de
    l'ajustement est gardé."""
    places, days = _out_of_range(session, parcours, start, end)
    for place in places:
        session.delete(place)
    for override in days:
        override.day = None
        if _override_is_empty(override):
            session.delete(override)


def update(session, parcours_id: int, data: dict) -> Parcours:
    """Patch : une clé absente garde sa valeur."""
    row = get(session, parcours_id)
    data = data if isinstance(data, dict) else {}
    name = _name(data['name']) if 'name' in data else row.name
    start = _date(data['date_start']) if 'date_start' in data else row.date_start
    end = _date(data['date_end']) if 'date_end' in data else row.date_end
    _check_range(start, end)
    if (start, end) != (row.date_start, row.date_end):
        # Un rétrécissement qui laisserait des lieux ou des ajustements hors
        # de la plage est refusé sans `drop_orphans` (le client confirme) :
        # dehors, ils seraient invisibles tout en comptant dans les plafonds.
        if _bool(data.get('drop_orphans'), False):
            _drop_out_of_range(session, row, start, end)
        else:
            places, days = _out_of_range(session, row, start, end)
            if places or days:
                raise ParcoursError('out-of-range', {'places': len(places), 'days': len(days)})
    row.name = name
    row.date_start = start
    row.date_end = end
    row.include_labs = _bool(data.get('include_labs'), row.include_labs)
    row.include_dnf = _bool(data.get('include_dnf'), row.include_dnf)
    if 'utc_offset_minutes' in data:
        row.utc_offset_minutes = _utc_offset(data['utc_offset_minutes'])
    if 'playback' in data:
        row.playback = _playback_in(data['playback'])
    if 'photo_display' in data:
        row.photo_display = _photo_display_in(data['photo_display'])
    row.updated_at = datetime.now()
    session.commit()
    return row


# Décalages UTC réels : de −12 h à +14 h.
UTC_OFFSET_RANGE = (-12 * 60, 14 * 60)


def _utc_offset(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) \
            or not (UTC_OFFSET_RANGE[0] <= value <= UTC_OFFSET_RANGE[1]):
        raise ParcoursError('utc-offset-invalid')
    return value


def delete(session, parcours_id: int) -> None:
    # Imports locaux : parcours_photos et parcours_tracks importent ce module.
    import parcours_photos
    import parcours_tracks
    row = get(session, parcours_id)
    pid = row.id
    session.query(ParcoursOverride).filter_by(parcours_id=pid).delete()
    session.query(ParcoursPlace).filter_by(parcours_id=pid).delete()
    parcours_photos.delete_all(session, pid)
    parcours_tracks.delete_all(session, pid)
    session.delete(row)
    session.commit()
    # Fichiers après le commit : un échec laisserait des lignes sans fichiers.
    parcours_photos.delete_files(pid)


# ---------------------------------------------------------------------------
# Duplication et export/import : la sélection, les ajustements et les lieux
# (le travail manuel) — jamais les photos ni les traces, fichiers trop lourds.
# ---------------------------------------------------------------------------

EXPORT_FORMAT = 'mygcflow-parcours'
EXPORT_VERSION = 1


def _remap_place_key(key: str, place_ids: dict) -> str:
    """Clé « place:<ancien id> » recollée sur l'id du lieu copié (les lieux
    reçoivent un nouvel id à la duplication comme à l'import). Les autres
    clés — trouvailles, Labs, DNF, lieux disparus — restent telles quelles."""
    if key.startswith('place:') and key[6:].isdigit():
        mapped = place_ids.get(int(key[6:]))
        if mapped is not None:
            return f'place:{mapped}'
    return key


def duplicate(session, parcours_id: int) -> Parcours:
    """Copie un parcours et ses ajustements/lieux ; les photos et traces
    ne sont pas copiées."""
    src = get(session, parcours_id)
    now = datetime.now()
    row = Parcours(
        name=f'{src.name} (copie)'[:NAME_MAX_LENGTH],
        date_start=src.date_start,
        date_end=src.date_end,
        include_labs=src.include_labs,
        include_dnf=src.include_dnf,
        utc_offset_minutes=src.utc_offset_minutes,
        playback=src.playback,
        photo_display=src.photo_display,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    session.flush()                      # id de la copie pour ses enfants
    created = []
    for p in session.query(ParcoursPlace).filter_by(parcours_id=src.id).order_by(ParcoursPlace.id):
        place = ParcoursPlace(
            parcours_id=row.id, kind=p.kind, name=p.name,
            latitude=p.latitude, longitude=p.longitude,
            date=p.date, time=p.time, role=p.role or 'both',
            category=p.category, icon=p.icon, created_at=now)
        session.add(place)
        created.append((p.id, place))
    session.flush()                      # ids des lieux copiés
    place_ids = {old: new.id for old, new in created}
    for o in session.query(ParcoursOverride).filter_by(parcours_id=src.id):
        session.add(ParcoursOverride(
            parcours_id=row.id, stop_key=_remap_place_key(o.stop_key, place_ids), rank=o.rank,
            pinned_time=o.pinned_time, day=o.day, excluded=o.excluded,
            leg_mode=o.leg_mode, visit_min=o.visit_min,
            latitude=o.latitude, longitude=o.longitude))
    session.commit()
    return row


def export_payload(session, parcours_id: int) -> dict:
    """Le parcours en un fichier JSON réimportable (sans photos ni traces)."""
    parcours = get(session, parcours_id)
    return {
        'format': EXPORT_FORMAT,
        'version': EXPORT_VERSION,
        'parcours': {
            'name': parcours.name,
            'date_start': parcours.date_start.isoformat(),
            'date_end': parcours.date_end.isoformat(),
            'include_labs': bool(parcours.include_labs),
            'include_dnf': bool(parcours.include_dnf),
            'utc_offset_minutes': parcours.utc_offset_minutes,
            'playback': _playback_out(parcours.playback),
            'photo_display': _photo_display_out(parcours.photo_display),
        },
        'overrides': [override_to_dict(row) for row in
                      session.query(ParcoursOverride).filter_by(parcours_id=parcours.id)],
        'places': [place_to_dict(row) for row in
                   session.query(ParcoursPlace).filter_by(parcours_id=parcours.id)
                   .order_by(ParcoursPlace.id)],
    }


def import_parcours(session, data: dict) -> Parcours:
    """Recrée un parcours depuis un export : mêmes validations qu'à la
    création et aux ajustements ; tout ou rien (une entrée invalide n'importe
    rien)."""
    data = data if isinstance(data, dict) else {}
    p = data.get('parcours')
    if data.get('format') != EXPORT_FORMAT or data.get('version') != EXPORT_VERSION \
            or not isinstance(p, dict):
        raise ParcoursError('import-invalid')
    # Nom, dates, plage, options : la validation de `create`.
    start = _date(p.get('date_start'))
    end = _date(p.get('date_end', p.get('date_start')))
    _check_range(start, end)
    now = datetime.now()
    row = Parcours(
        name=_name(p.get('name')),
        date_start=start,
        date_end=end,
        include_labs=_bool(p.get('include_labs'), True),
        include_dnf=_bool(p.get('include_dnf'), True),
        utc_offset_minutes=_utc_offset(p.get('utc_offset_minutes')),
        playback=_playback_in(p.get('playback')),
        photo_display=_photo_display_in(p.get('photo_display')),
        created_at=now,
        updated_at=now,
    )
    overrides = data.get('overrides')
    places = data.get('places')
    if not isinstance(overrides, list) or len(overrides) > MAX_OVERRIDES \
            or not isinstance(places, list) or len(places) > MAX_PLACES:
        raise ParcoursError('import-invalid')
    session.add(row)
    try:
        session.flush()
        created = []
        for place in places:
            new_place = ParcoursPlace(parcours_id=row.id, created_at=now,
                                      **_place_fields(place, row))
            session.add(new_place)
            created.append((place.get('id'), new_place))
        session.flush()
        # Clés « place:<id> » des ajustements recollées sur les lieux recréés.
        place_ids = {}
        for src_id, new_place in created:
            if isinstance(src_id, int) and not isinstance(src_id, bool) and src_id not in place_ids:
                place_ids[src_id] = new_place.id
        for patch in overrides:
            columns = _override_columns(patch, row)
            columns['stop_key'] = _remap_place_key(columns['stop_key'], place_ids)
            o = ParcoursOverride(parcours_id=row.id, **columns)
            if o.excluded is None:
                o.excluded = False
            # Une ligne vide n'a pas de sens, comme dans patch_overrides.
            if not o.excluded and all(getattr(o, f) is None for f in
                                      ('rank', 'pinned_time', 'day', 'leg_mode', 'visit_min', 'latitude')):
                continue
            session.add(o)
        session.commit()
    except Exception:
        session.rollback()
        raise
    return row


# ---------------------------------------------------------------------------
# Ajustements manuels (lot 3) : on stocke les corrections, jamais le résultat
# ---------------------------------------------------------------------------

STOP_KEY_MAX_LENGTH = 96
PLACE_KINDS = ('base', 'place')
# Rôle d'une base : départ et retour, départ seul ou retour seul.
BASE_ROLES = ('both', 'start', 'end')
# Catégorie d'affichage d'un lieu ou d'une base : icône dans la liste et sur
# la carte — le comportement reste porté par `kind`.
PLACE_CATEGORIES = ('other', 'parking', 'meal', 'viewpoint', 'lodging', 'supply', 'custom')
# Icône Tabler libre pour la catégorie « custom » (« ti-flag »…).
_ICON_RE = re.compile(r'ti-[a-z0-9][a-z0-9-]{0,46}')
# Mode du trajet vers l'étape suivante (lot 6) ; `straight` : ligne droite,
# sans itinéraire (avion, ferry…).
LEG_MODES = ('walk', 'bike', 'car', 'straight')
MAX_VISIT_MIN = 12 * 60                    # douze heures de visite à une étape
MAX_OVERRIDES = 2000
MAX_PLACES = 200
_TIME_RE = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d')


def _time_or_none(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, str) and _TIME_RE.fullmatch(value.strip()):
        return value.strip()
    raise ParcoursError('time-invalid')


def _day_in_range(value, parcours: Parcours) -> date | None:
    if value is None:
        return None
    day = _date(value)
    if not (parcours.date_start <= day <= parcours.date_end):
        raise ParcoursError('day-out-of-range')
    return day


def override_to_dict(row: ParcoursOverride) -> dict:
    return {
        'key': row.stop_key,
        'rank': row.rank,
        'pinnedTime': row.pinned_time,
        'day': row.day.isoformat() if row.day else None,
        'excluded': bool(row.excluded),
        'legMode': row.leg_mode,
        'visitMin': row.visit_min,
        'position': ({'lat': row.latitude, 'lon': row.longitude}
                     if row.latitude is not None and row.longitude is not None else None),
    }


def place_to_dict(row: ParcoursPlace) -> dict:
    return {
        'id': row.id,
        'kind': row.kind,
        'name': row.name or '',
        'lat': row.latitude,
        'lon': row.longitude,
        'date': row.date.isoformat() if row.date else None,
        'time': row.time,
        'role': row.role or 'both',
        'category': row.category or 'other',
        'icon': row.icon,
    }


def _overrides(session, parcours_id: int) -> list[dict]:
    return [override_to_dict(row) for row in
            session.query(ParcoursOverride).filter_by(parcours_id=parcours_id)
            .order_by(ParcoursOverride.stop_key).all()]


def adjustments(session, parcours_id: int, with_tracks: bool = True) -> dict:
    """{overrides, places, photos, cameras[, tracks]} d'un parcours. Sans les
    traces (leurs points GPS pèsent lourd) pour les relectures de gestes qui
    n'y touchent pas."""
    import parcours_photos
    import parcours_tracks
    places = session.query(ParcoursPlace).filter_by(parcours_id=parcours_id) \
        .order_by(ParcoursPlace.id).all()
    payload = {
        'overrides': _overrides(session, parcours_id),
        'places': [place_to_dict(row) for row in places],
        **parcours_photos.list_photos(session, parcours_id),
    }
    if with_tracks:
        payload['tracks'] = parcours_tracks.list_tracks(session, parcours_id)
    return payload


# Colonnes d'un ajustement validé à partir d'un patch {key, rank?…} ; un
# champ présent est contrôlé, un absent n'apparaît pas dans le résultat.
def _override_columns(patch, parcours: Parcours) -> dict:
    if not isinstance(patch, dict):
        raise ParcoursError('override-invalid')
    key = patch.get('key')
    if not isinstance(key, str) or not key or len(key) > STOP_KEY_MAX_LENGTH:
        raise ParcoursError('override-invalid')
    columns = {'stop_key': key}
    if 'rank' in patch:
        rank = patch['rank']
        if rank is not None and (isinstance(rank, bool) or not isinstance(rank, int) or rank < 0):
            raise ParcoursError('override-invalid')
        columns['rank'] = rank
    if 'pinnedTime' in patch:
        columns['pinned_time'] = _time_or_none(patch['pinnedTime'])
    if 'day' in patch:
        columns['day'] = _day_in_range(patch['day'], parcours)
    if 'excluded' in patch:
        if not isinstance(patch['excluded'], bool):
            raise ParcoursError('override-invalid')
        columns['excluded'] = patch['excluded']
    if 'legMode' in patch:
        if patch['legMode'] is not None and patch['legMode'] not in LEG_MODES:
            raise ParcoursError('override-invalid')
        columns['leg_mode'] = patch['legMode']
    if 'visitMin' in patch:
        visit = patch['visitMin']
        if visit is not None and (isinstance(visit, bool) or not isinstance(visit, int)
                                  or visit < 0 or visit > MAX_VISIT_MIN):
            raise ParcoursError('override-invalid')
        columns['visit_min'] = visit
    if 'position' in patch:
        position = patch['position']
        if position is None:
            columns['latitude'] = columns['longitude'] = None
        else:
            values = [position.get(k) if isinstance(position, dict) else None for k in ('lat', 'lon')]
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in values) \
                    or not (-90 <= values[0] <= 90 and -180 <= values[1] <= 180):
                raise ParcoursError('override-invalid')
            columns['latitude'], columns['longitude'] = (round(float(v), 6) for v in values)
    return columns


def _override_is_empty(row: ParcoursOverride) -> bool:
    """Une ligne sans plus aucun ajustement n'a pas de sens : à retirer."""
    return (row.rank is None and row.pinned_time is None and row.day is None and not row.excluded
            and row.leg_mode is None and row.visit_min is None and row.latitude is None)


def patch_overrides(session, parcours_id: int, patches) -> dict:
    """Applique une liste de patchs {key, rank?, pinnedTime?, day?, excluded?} :
    un champ présent remplace la valeur (null l'efface), un champ absent la
    garde. Une étape sans plus aucun ajustement perd sa ligne. Tout ou rien :
    un patch invalide n'applique aucun des autres."""
    parcours = get(session, parcours_id)
    if not isinstance(patches, list) or len(patches) > MAX_OVERRIDES:
        raise ParcoursError('override-invalid')
    existing = {row.stop_key: row for row in
                session.query(ParcoursOverride).filter_by(parcours_id=parcours.id)}
    try:
        for patch in patches:
            columns = _override_columns(patch, parcours)
            key = columns.pop('stop_key')
            row = existing.get(key)
            if row is None:
                row = ParcoursOverride(parcours_id=parcours.id, stop_key=key, excluded=False)
                session.add(row)
                existing[key] = row
            for name, value in columns.items():
                setattr(row, name, value)
        for key, row in list(existing.items()):
            if _override_is_empty(row):
                if row.id is not None:
                    session.delete(row)
                else:
                    session.expunge(row)
        parcours.updated_at = datetime.now()
        session.commit()
    except Exception:
        session.rollback()
        raise
    # Seuls les ajustements changent : la réponse n'a pas à porter lieux,
    # photos et points GPS des traces à chaque geste.
    return {'overrides': _overrides(session, parcours.id)}


def clear_overrides(session, parcours_id: int) -> dict:
    parcours = get(session, parcours_id)
    session.query(ParcoursOverride).filter_by(parcours_id=parcours.id).delete()
    parcours.updated_at = datetime.now()
    session.commit()
    return {'overrides': _overrides(session, parcours.id)}


def _place_fields(data: dict, parcours: Parcours, current: ParcoursPlace | None = None) -> dict:
    data = data if isinstance(data, dict) else {}
    fields = {}
    kind = data.get('kind', current.kind if current else None)
    if kind not in PLACE_KINDS:
        raise ParcoursError('place-invalid')
    fields['kind'] = kind
    if 'name' in data or current is None:
        name = data.get('name')
        name = name.strip() if isinstance(name, str) else ''
        if len(name) > NAME_MAX_LENGTH:
            raise ParcoursError('name-too-long')
        fields['name'] = name
    for field, low, high in (('lat', -90, 90), ('lon', -180, 180)):
        if field in data or current is None:
            value = data.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not (low <= value <= high):
                raise ParcoursError('place-invalid')
            fields['latitude' if field == 'lat' else 'longitude'] = float(value)
    if 'date' in data or current is None:
        fields['date'] = _day_in_range(data.get('date'), parcours)
    if 'time' in data or current is None:
        fields['time'] = _time_or_none(data.get('time'))
    if 'role' in data or current is None:
        role = data.get('role', 'both')
        if role not in BASE_ROLES:
            raise ParcoursError('place-invalid')
        fields['role'] = role
    if 'category' in data or current is None:
        category = data.get('category', 'other')
        if category not in PLACE_CATEGORIES:
            raise ParcoursError('place-invalid')
        fields['category'] = category
    if 'icon' in data or current is None:
        icon = data.get('icon')
        icon = icon.strip() if isinstance(icon, str) else None
        if icon and not _ICON_RE.fullmatch(icon):
            raise ParcoursError('place-invalid')
        fields['icon'] = icon or None
    date_value = fields.get('date', current.date if current else None)
    # Un lieu est une étape d'une journée : sa date est requise. Une base
    # sans date vaut pour toutes les journées.
    if kind == 'place' and date_value is None:
        raise ParcoursError('place-invalid')
    # Le rôle ne vaut que pour les bases : un lieu (nouveau, converti, ou
    # rôle explicitement posé dessus) garde « both ».
    if kind == 'place' and ('role' in fields or 'kind' in fields):
        fields['role'] = 'both'
    # L'icône libre ne vaut que pour la catégorie « custom » : quitter cette
    # catégorie (ou l'icône envoyée sans elle) efface l'icône.
    category_value = fields.get('category', current.category if current else 'other')
    if category_value != 'custom' and ('category' in fields or 'icon' in fields):
        fields['icon'] = None
    return fields


def create_place(session, parcours_id: int, data: dict) -> dict:
    parcours = get(session, parcours_id)
    if session.query(ParcoursPlace).filter_by(parcours_id=parcours.id).count() >= MAX_PLACES:
        raise ParcoursError('place-invalid')
    row = ParcoursPlace(parcours_id=parcours.id, created_at=datetime.now(),
                        **_place_fields(data, parcours))
    session.add(row)
    parcours.updated_at = datetime.now()
    session.commit()
    return place_to_dict(row)


def _get_place(session, parcours: Parcours, place_id: int) -> ParcoursPlace:
    row = session.get(ParcoursPlace, place_id)
    if row is None or row.parcours_id != parcours.id:
        raise ParcoursError('place-not-found')
    return row


def update_place(session, parcours_id: int, place_id: int, data: dict) -> dict:
    parcours = get(session, parcours_id)
    row = _get_place(session, parcours, place_id)
    try:
        for name, value in _place_fields(data, parcours, row).items():
            setattr(row, name, value)
    except Exception:
        session.rollback()
        raise
    parcours.updated_at = datetime.now()
    session.commit()
    return place_to_dict(row)


def delete_place(session, parcours_id: int, place_id: int) -> None:
    parcours = get(session, parcours_id)
    session.delete(_get_place(session, parcours, place_id))
    parcours.updated_at = datetime.now()
    session.commit()
