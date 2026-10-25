"""Stockage des logs Geocaching — fusion, couverture, aperçu, statut.

Ne modifie que `log_collection` / `log_event` / `cache_ref` ; la table
`geocache` (My Finds) n'est lue que pour les coordonnées de repli. Règles
(docs/logs-geocaching.md) :

- un import **fusionne** : log nouveau ajouté, log connu mis à jour si la
  version entrante est au moins aussi récente (`exported_at` ; sans date
  d'export, l'ordre d'import fait foi) ; un champ absent n'efface jamais une
  valeur connue ;
- un log stocké n'est retiré que s'il entre dans une couverture complète
  déclarée par le fichier et en est absent ;
- une collection = un compte : un fichier d'un autre compte est refusé ;
- une correction manuelle de coordonnées survit à tout import ;
- aperçu et validation partagent le même calcul (`_plan`) ; seule la
  validation écrit.
"""

from __future__ import annotations

import json
import threading
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone

from flask_babel import gettext as _
from sqlalchemy import func

from log_formats import (
    SOURCE_GPX_MYFINDS, USER_CORRECTION, LogsParseResult, log_category,
)
from models import CacheRef, Geocache, LogCollection, LogEvent

COLLECTION_UID = "default"
# SQLite accepte 999 paramètres par requête : les IN (...) sont découpés.
_IN_CHUNK = 900
_WRITE_CHUNK = 1000
_SAMPLE = 20

# Les mutations (imports, suppression) se font sous ce verrou : l'import
# My Finds et un import de logs peuvent arriver de deux tâches différentes.
LOG_MUTATION_LOCK = threading.Lock()

_LOG_FIELDS = ("gc_code", "type_id", "log_date", "author_id", "author_name", "favorite")
# Champs requis par le contrat : toujours repris de la version retenue.
_LOG_REQUIRED = frozenset({"gc_code", "type_id", "log_date"})
_CACHE_FIELDS = ("name", "cache_type", "container", "difficulty", "terrain", "country",
                 "state", "latitude", "longitude", "corrected_latitude",
                 "corrected_longitude", "owner_id", "owner_name", "placed_date",
                 "status", "favorite_points")
_COORD_FIELDS = frozenset({"latitude", "longitude"})


class LogImportError(Exception):
    """Import refusé (le message est destiné à l'utilisateur)."""


class LogAccountMismatch(LogImportError):
    pass


class LogRevisionConflict(LogImportError):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _chunks(items, size):
    items = list(items)
    for start in range(0, len(items), size):
        yield items[start:start + size]


def get_collection(session) -> LogCollection | None:
    return session.query(LogCollection).filter_by(uid=COLLECTION_UID).one_or_none()


def _is_newer(incoming_at, stored_at) -> bool:
    """La version entrante l'emporte-t-elle ? Sans date d'export d'un côté
    ou de l'autre, l'ordre d'import fait foi (la plus récente importée)."""
    return incoming_at is None or stored_at is None or incoming_at >= stored_at


# ---------------------------------------------------------------------------
# Plan : tout le calcul, sans écriture
# ---------------------------------------------------------------------------

@dataclass
class _Plan:
    collection: LogCollection | None
    account_user_id: int | None
    account_username: str | None
    log_inserts: list = field(default_factory=list)
    log_updates: list = field(default_factory=list)
    log_removals: list = field(default_factory=list)      # ids de lignes
    cache_inserts: list = field(default_factory=list)
    cache_updates: list = field(default_factory=list)
    counts: Counter = field(default_factory=Counter)
    removed_sample: list = field(default_factory=list)
    pending_codes: int = 0


def _resolve_account(collection, meta) -> tuple:
    stored_id = collection.account_user_id if collection else None
    stored_name = collection.account_username if collection else None
    incoming_id = meta.get("account_user_id")
    incoming_name = meta.get("account_username")
    if stored_id is not None and incoming_id is not None and stored_id != incoming_id:
        raise LogAccountMismatch(_(
            "compte %(incoming)s différent de celui des logs déjà importés (%(stored)s)",
            incoming=incoming_id, stored=stored_id))
    user_id = stored_id if stored_id is not None else incoming_id
    # Un pseudo peut changer : il n'est repris que d'un fichier dont
    # l'identifiant confirme le compte (ou tant qu'aucun compte n'est connu).
    confirmed = user_id is None or (incoming_id is not None and incoming_id == user_id)
    name = incoming_name if incoming_name and confirmed else stored_name
    return user_id, name


def _existing_logs(session, collection_id, log_ids) -> dict:
    if collection_id is None:
        return {}
    columns = (LogEvent.id, LogEvent.log_id, LogEvent.source_exported_at) + tuple(
        getattr(LogEvent, f) for f in _LOG_FIELDS)
    found = {}
    for chunk in _chunks(log_ids, _IN_CHUNK):
        for row in session.query(*columns).filter(
                LogEvent.collection_id == collection_id, LogEvent.log_id.in_(chunk)):
            found[row.log_id] = row
    return found


def _existing_caches(session, collection_id, codes) -> dict:
    if collection_id is None:
        return {}
    found = {}
    for chunk in _chunks(codes, _IN_CHUNK):
        for row in session.query(CacheRef).filter(
                CacheRef.collection_id == collection_id, CacheRef.gc_code.in_(chunk)):
            found[row.gc_code] = row
    return found


def _plan_logs(plan, parsed, existing, incoming_at, source, now):
    for draft in parsed.logs:
        row = existing.get(draft.log_id)
        if row is None:
            plan.counts["added"] += 1
            plan.log_inserts.append({
                "log_id": draft.log_id, "gc_code": draft.gc_code, "type_id": draft.type_id,
                "log_date": draft.log_date, "author_id": draft.author_id,
                "author_name": draft.author_name, "favorite": draft.favorite,
                "source_format": source, "source_exported_at": incoming_at,
                "imported_at": now, "updated_at": now,
            })
            continue
        changes = {}
        for name in _LOG_FIELDS:
            value = getattr(draft, name)
            if (value is not None or name in _LOG_REQUIRED) and value != getattr(row, name):
                changes[name] = value
        newer = _is_newer(incoming_at, row.source_exported_at)
        if changes and not newer:
            plan.counts["stale"] += 1
            continue
        if changes:
            plan.counts["updated"] += 1
        else:
            plan.counts["unchanged"] += 1
            # Version confirmée par un export plus récent : on retient sa
            # date, sinon un export intermédiaire plus ancien l'écraserait.
            if incoming_at is None or (row.source_exported_at is not None
                                       and incoming_at <= row.source_exported_at):
                continue
        plan.log_updates.append({"id": row.id, **changes, "source_format": source,
                                 "source_exported_at": incoming_at, "updated_at": now})


def _plan_removals(plan, session, collection_id, parsed):
    scopes = parsed.meta.get("coverage") or []
    if collection_id is None or not scopes:
        return
    in_file = {d.log_id for d in parsed.logs}
    removed = set()
    for scope in scopes:
        query = session.query(LogEvent.id, LogEvent.log_id, LogEvent.gc_code, LogEvent.type_id,
                              LogEvent.log_date, LogEvent.author_id).filter(
            LogEvent.collection_id == collection_id)
        if scope.kind == "author":
            query = query.filter(LogEvent.author_id == scope.author_id)
        if scope.type_ids is not None:
            query = query.filter(LogEvent.type_id.in_(sorted(scope.type_ids)))
        if scope.since is not None:
            query = query.filter(LogEvent.log_date >= scope.since)
        if scope.kind == "caches":
            rows = []
            for chunk in _chunks(sorted(scope.gc_codes), _IN_CHUNK):
                rows.extend(query.filter(LogEvent.gc_code.in_(chunk)))
        else:
            rows = query.all()
        for row in rows:
            if row.log_id in in_file or row.id in removed:
                continue
            removed.add(row.id)
            if len(plan.removed_sample) < _SAMPLE:
                plan.removed_sample.append({
                    "log_id": row.log_id, "gc_code": row.gc_code, "type_id": row.type_id,
                    "date": row.log_date.isoformat()})
    plan.log_removals = sorted(removed)
    plan.counts["removed"] = len(removed)


def _plan_caches(plan, parsed, existing, incoming_at, source, now):
    for draft in parsed.caches:
        row = existing.get(draft.gc_code)
        values = {name: getattr(draft, name) for name in _CACHE_FIELDS}
        if row is None:
            plan.counts["caches_added"] += 1
            plan.cache_inserts.append({
                "gc_code": draft.gc_code, **values,
                "coordinate_source": source if draft.latitude is not None else None,
                "status_at": incoming_at if draft.status else None,
                "source_format": source, "source_exported_at": incoming_at,
                "imported_at": now, "updated_at": now,
            })
            continue
        protected = row.coordinate_source == USER_CORRECTION
        changes = {}
        for name, value in values.items():
            if value is None or (protected and name in _COORD_FIELDS):
                continue
            if value != getattr(row, name):
                changes[name] = value
        if not changes:
            plan.counts["caches_unchanged"] += 1
            continue
        if not _is_newer(incoming_at, row.source_exported_at):
            plan.counts["caches_stale"] += 1
            continue
        if "latitude" in changes or "longitude" in changes:
            changes["coordinate_source"] = source
        if "status" in changes:
            changes["status_at"] = incoming_at
        plan.counts["caches_updated"] += 1
        plan.cache_updates.append({"id": row.id, **changes, "source_format": source,
                                   "source_exported_at": incoming_at, "updated_at": now})


def _codes_with_coordinates(session, collection_id, codes) -> set:
    """Codes placés par une fiche `cache_ref` ou par une trouvaille My Finds."""
    found = set()
    for chunk in _chunks(codes, _IN_CHUNK):
        if collection_id is not None:
            found.update(code for (code,) in session.query(CacheRef.gc_code).filter(
                CacheRef.collection_id == collection_id, CacheRef.gc_code.in_(chunk),
                CacheRef.latitude.isnot(None), CacheRef.longitude.isnot(None)))
        found.update(code for (code,) in session.query(Geocache.gc_code).filter(
            Geocache.gc_code.in_(chunk),
            Geocache.latitude.isnot(None), Geocache.longitude.isnot(None)))
    return found


def _plan(session, parsed: LogsParseResult) -> _Plan:
    if not parsed.ok:
        raise LogImportError(_("import refusé : le fichier a des erreurs structurelles"))
    meta = parsed.meta
    collection = get_collection(session)
    collection_id = collection.id if collection else None
    user_id, username = _resolve_account(collection, meta)
    plan = _Plan(collection=collection, account_user_id=user_id, account_username=username)
    incoming_at = meta.get("exported_at")
    source = meta.get("source")
    now = _utcnow()

    log_ids = [d.log_id for d in parsed.logs]
    _plan_logs(plan, parsed, _existing_logs(session, collection_id, log_ids),
               incoming_at, source, now)
    _plan_removals(plan, session, collection_id, parsed)
    codes = [d.gc_code for d in parsed.caches]
    _plan_caches(plan, parsed, _existing_caches(session, collection_id, codes),
                 incoming_at, source, now)

    file_codes = {d.gc_code for d in parsed.logs}
    placed = {d.gc_code for d in parsed.caches if d.latitude is not None}
    plan.pending_codes = len(file_codes - placed
                             - _codes_with_coordinates(session, collection_id, file_codes - placed))
    return plan


def _summary(plan: _Plan, parsed: LogsParseResult) -> dict:
    counts = plan.counts
    categories = {"mine": Counter(), "others": Counter()}
    unknown = Counter()
    for draft in parsed.logs:
        category = log_category(draft.type_id)
        if category == "other":
            unknown[draft.type_id] += 1
        who = "mine" if plan.account_user_id is not None \
            and draft.author_id == plan.account_user_id else "others"
        categories[who][category] += 1
    return {
        "source": parsed.meta.get("source"),
        "generator": parsed.meta.get("generator"),
        "account": {"user_id": plan.account_user_id, "username": plan.account_username},
        "logs_in_file": len(parsed.logs),
        "added": counts["added"], "updated": counts["updated"],
        "unchanged": counts["unchanged"], "stale": counts["stale"],
        "removed": counts["removed"], "removed_sample": plan.removed_sample,
        "caches_in_file": len(parsed.caches),
        "caches_added": counts["caches_added"], "caches_updated": counts["caches_updated"],
        "caches_unchanged": counts["caches_unchanged"], "caches_stale": counts["caches_stale"],
        "rejected": len(parsed.rejected), "rejected_reasons": parsed.rejected_counts(),
        "duplicates": parsed.duplicates,
        "warnings": parsed.warning_counts(),
        "unknown_types": {str(k): v for k, v in sorted(unknown.items())},
        "categories": {who: dict(c) for who, c in categories.items()},
        "coverage": len(parsed.meta.get("coverage") or []),
        "pending_coordinates": plan.pending_codes,
    }


# ---------------------------------------------------------------------------
# Aperçu, validation
# ---------------------------------------------------------------------------

def preview_logs(session, parsed: LogsParseResult) -> dict:
    """Ce que ferait l'import, sans rien écrire."""
    plan = _plan(session, parsed)
    summary = _summary(plan, parsed)
    summary["collection_revision"] = plan.collection.revision if plan.collection else 0
    return summary


def _execute(session, plan: _Plan) -> LogCollection:
    collection = plan.collection
    if collection is None:
        collection = LogCollection(uid=COLLECTION_UID, revision=0, created_at=_utcnow())
        session.add(collection)
        session.flush()
    collection.account_user_id = plan.account_user_id
    collection.account_username = plan.account_username
    for chunk in _chunks(plan.log_removals, _IN_CHUNK):
        session.query(LogEvent).filter(LogEvent.id.in_(chunk)).delete(synchronize_session=False)
    for rows in _chunks(plan.log_updates, _WRITE_CHUNK):
        session.bulk_update_mappings(LogEvent, rows)
    for rows in _chunks(plan.log_inserts, _WRITE_CHUNK):
        session.bulk_insert_mappings(LogEvent, [{**r, "collection_id": collection.id} for r in rows])
    for rows in _chunks(plan.cache_updates, _WRITE_CHUNK):
        session.bulk_update_mappings(CacheRef, rows)
    for rows in _chunks(plan.cache_inserts, _WRITE_CHUNK):
        session.bulk_insert_mappings(CacheRef, [{**r, "collection_id": collection.id} for r in rows])
    collection.revision = (collection.revision or 0) + 1
    collection.last_import_at = _utcnow()
    return collection


def _slim_for_storage(summary: dict) -> dict:
    slim = dict(summary)
    for key in ("rejected_reasons", "warnings"):
        items = slim.get(key) or []
        if len(items) > 50:
            slim[key] = items[:50] + [{"truncated": len(items) - 50}]
    return slim


def commit_logs(session, parsed: LogsParseResult, expected_revision=None) -> dict:
    """Applique un import. `expected_revision` : celle vue à l'aperçu — un
    import intervenu entre-temps rend l'aperçu caduc."""
    with LOG_MUTATION_LOCK:
        try:
            plan = _plan(session, parsed)
            current = plan.collection.revision if plan.collection else 0
            if expected_revision is not None and expected_revision != current:
                raise LogRevisionConflict(_("les logs ont changé depuis l'aperçu : relancez-le"))
            summary = _summary(plan, parsed)
            collection = _execute(session, plan)
            summary["collection_revision"] = collection.revision
            collection.last_import_summary = json.dumps(_slim_for_storage(summary), default=str)
            session.commit()
        except Exception:
            session.rollback()
            raise
    summary["success"] = True
    summary["status"] = collection_status(session)
    return summary


def merge_myfinds_logs(session, parsed: LogsParseResult) -> dict:
    """Fusionne les logs collectés par l'import My Finds. Un My Finds d'un
    autre compte que celui des logs déjà importés est ignoré, sans erreur :
    l'import des trouvailles, lui, a déjà réussi."""
    if parsed.meta.get("source") != SOURCE_GPX_MYFINDS:
        raise ValueError("merge_myfinds_logs attend des logs My Finds")
    try:
        return commit_logs(session, parsed)
    except LogAccountMismatch as exc:
        return {"success": False, "skipped": "account_mismatch", "reason": str(exc)}


# ---------------------------------------------------------------------------
# Statut, suppression
# ---------------------------------------------------------------------------

def collection_status(session) -> dict:
    collection = get_collection(session)
    if collection is None:
        return {"exists": False, "logs": 0, "mine": 0, "mine_by_category": {}, "caches": 0,
                "pending_coordinates": 0, "revision": 0, "account": None}
    cid = collection.id
    total = session.query(LogEvent.id).filter(LogEvent.collection_id == cid).count()
    mine_by_category = Counter()
    if collection.account_user_id is not None:
        for type_id, n in session.query(LogEvent.type_id, func.count(LogEvent.id)).filter(
                LogEvent.collection_id == cid,
                LogEvent.author_id == collection.account_user_id).group_by(LogEvent.type_id):
            mine_by_category[log_category(type_id)] += n
    codes = {code for (code,) in session.query(LogEvent.gc_code).filter(
        LogEvent.collection_id == cid).distinct()}
    return {
        "exists": True,
        "account": {"user_id": collection.account_user_id,
                    "username": collection.account_username},
        "revision": collection.revision,
        "last_import_at": collection.last_import_at.isoformat() if collection.last_import_at else None,
        "logs": total,
        "mine": sum(mine_by_category.values()),
        "mine_by_category": dict(mine_by_category),
        "caches": session.query(CacheRef.id).filter(CacheRef.collection_id == cid).count(),
        "pending_coordinates": len(codes - _codes_with_coordinates(session, cid, codes)),
    }


def clear_logs(session) -> dict:
    """Supprime tous les logs, fiches et le compte associé (changement de compte)."""
    with LOG_MUTATION_LOCK:
        try:
            removed = session.query(LogEvent).delete(synchronize_session=False)
            caches = session.query(CacheRef).delete(synchronize_session=False)
            session.query(LogCollection).delete(synchronize_session=False)
            session.commit()
        except Exception:
            session.rollback()
            raise
    return {"success": True, "removed_logs": removed, "removed_caches": caches}
