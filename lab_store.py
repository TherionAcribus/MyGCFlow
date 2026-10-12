"""Stockage Adventure Lab — collection, upserts historique, enrichissement.

Séparé de l'import GPX (`bdd.uploadBdd`) : ces fonctions ne lisent et ne
modifient que `lab_collection`/`lab_discovery`, jamais `geocache`.

Règles du plan implémentées :

- import additif — jamais de suppression implicite ;
- même UUID / même identité locale → mise à jour idempotente ;
- un champ entrant vide n'écrase jamais une donnée fiable connue ;
- conflit date/coordonnées entre deux sources fiables → signalé, valeur
  existante conservée, traçable dans le résumé ;
- le fichier coordonnées enrichit sans jamais créer de découverte ;
- `coordinate_source == 'user_correction'` a priorité sur tout
  enrichissement fichier ultérieur ;
- correspondance par UUID d'étape uniquement (automatique) ; le titre dans
  une Adventure connue n'est qu'une proposition listée, jamais appliquée.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone

from lab_formats import (
    SOURCE_LAB2GPX, SOURCE_LAB_FINDS, normalize_title,
)
from models import LabCollection, LabDiscovery

COLLECTION_UID = "default"
USER_CORRECTION = "user_correction"

# Les mutations Labs (imports, résolutions, clear) se font sous ce verrou :
# l'exclusivité ne peut pas reposer sur les seuls boutons désactivés côté UI.
LAB_MUTATION_LOCK = threading.Lock()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def get_collection(session) -> LabCollection | None:
    return session.query(LabCollection).filter_by(uid=COLLECTION_UID).one_or_none()


def get_or_create_collection(session) -> LabCollection:
    collection = get_collection(session)
    if collection is None:
        collection = LabCollection(uid=COLLECTION_UID, revision=0, created_at=_utcnow())
        session.add(collection)
        session.flush()
    return collection


# ---------------------------------------------------------------------------
# Diff historique
# ---------------------------------------------------------------------------

def _index_existing(session, collection_id):
    by_uuid, by_local = {}, {}
    for row in session.query(LabDiscovery).filter_by(collection_id=collection_id):
        if row.stage_uuid:
            by_uuid[row.stage_uuid] = row
        by_local[row.local_uid] = row
    return by_uuid, by_local


def _diff_draft(draft, row) -> tuple[dict, list]:
    """Calcule les champs à écrire et les conflits pour un existant.

    Retourne (updates, conflicts) — updates vide signifie 'unchanged'.
    """
    updates, conflicts = {}, []

    def fill_or_keep(attr, incoming):
        if incoming in (None, ""):
            return
        current = getattr(row, attr)
        if current in (None, ""):
            updates[attr] = incoming
        elif current != incoming:
            updates[attr] = incoming  # un libellé entrant non vide rafraîchit

    def fill_or_conflict(attr, incoming, label):
        # Identifiant contradictoire : jamais remplacé silencieusement.
        if incoming in (None, ""):
            return
        current = getattr(row, attr)
        if current in (None, ""):
            updates[attr] = incoming
        elif current != incoming:
            conflicts.append({"field": label, "existing": current, "incoming": incoming})

    fill_or_conflict("adventure_uuid", draft.adventure_uuid, "adventure_uuid")
    fill_or_conflict("stage_uuid", draft.stage_uuid, "stage_uuid")
    fill_or_keep("adventure_title", draft.adventure_title)
    fill_or_keep("stage_title", draft.stage_title)
    fill_or_keep("adventure_url", draft.adventure_url)
    fill_or_keep("source_record_key", draft.source_record_key)

    # Date : deux valeurs fiables différentes → conflit, on conserve l'existante.
    # Précision, base, texte source et offset décrivent `found_date` : ils ne
    # sont écrits qu'avec elle, jamais rafraîchis seuls — sinon une date
    # conservée (conflit, correction manuelle) porterait la provenance d'une autre.
    date_meta = {
        "date_precision": draft.date_precision,
        "date_basis": draft.date_basis,
        "source_date_text": draft.source_date_text,
        "found_at_offset_minutes": draft.found_at_offset_minutes,
    }
    if draft.found_date is None:
        if row.found_date is None:
            # Aucune date exploitable des deux côtés : garder la trace source.
            fill_or_keep("source_date_text", draft.source_date_text)
    elif row.found_date is None:
        updates["found_date"] = draft.found_date
        updates["found_at_utc"] = draft.found_at_utc
        updates.update(date_meta)
    elif row.date_basis == USER_CORRECTION:
        # Correction manuelle : prioritaire, comme pour les coordonnées.
        if row.found_date != draft.found_date:
            conflicts.append({
                "field": "found_date", "existing": str(row.found_date),
                "incoming": str(draft.found_date),
                "protected": USER_CORRECTION,
            })
    elif row.found_date != draft.found_date or (
        row.found_at_utc and draft.found_at_utc and row.found_at_utc != draft.found_at_utc
    ):
        conflicts.append({
            "field": "found_date", "existing": str(row.found_date),
            "incoming": str(draft.found_date),
        })
    elif draft.found_at_utc is not None or row.found_at_utc is None:
        # Même date : la source peut préciser (instant, offset), jamais
        # dégrader un instant connu en simple date.
        if row.found_at_utc is None and draft.found_at_utc is not None:
            updates["found_at_utc"] = draft.found_at_utc
        for attr, incoming in date_meta.items():
            fill_or_keep(attr, incoming)

    # Coordonnées portées par l'historique (rare) : même règle de conflit.
    if draft.latitude is not None and draft.longitude is not None:
        if row.latitude is None or row.longitude is None:
            updates.update({
                "latitude": draft.latitude, "longitude": draft.longitude,
                "coordinate_scope": draft.coordinate_scope or "stage",
                "coordinate_source": SOURCE_LAB_FINDS,
                "coordinate_status": LabDiscovery.COORD_RESOLVED,
            })
        elif (row.latitude != draft.latitude or row.longitude != draft.longitude) \
                and row.coordinate_source != USER_CORRECTION:
            conflicts.append({
                "field": "coordinates",
                "existing": [row.latitude, row.longitude],
                "incoming": [draft.latitude, draft.longitude],
            })

    if draft.is_archived and not row.is_archived:
        updates["is_archived"] = True

    return updates, conflicts


def _apply_history(session, parsed, commit: bool) -> dict:
    collection = get_or_create_collection(session) if commit else get_collection(session)
    collection_id = collection.id if collection else None
    by_uuid, by_local = _index_existing(session, collection_id) if collection_id else ({}, {})

    counts = {"added": 0, "updated": 0, "unchanged": 0, "conflicts": 0}
    conflicts = []
    warnings = list(parsed.errors)
    seen_keys = set()  # dédoublonnage défensif (le parseur dédoublonne déjà)

    for draft in parsed.drafts:
        if draft.local_key in seen_keys:
            continue
        seen_keys.add(draft.local_key)
        row = None
        if draft.stage_uuid:
            row = by_uuid.get(draft.stage_uuid)
        if row is None:
            row = by_local.get(draft.local_key)
        if row is None:
            counts["added"] += 1
            if commit:
                session.add(LabDiscovery(
                    collection_id=collection_id,
                    local_uid=draft.local_key,
                    adventure_uuid=draft.adventure_uuid,
                    stage_uuid=draft.stage_uuid,
                    source_record_key=draft.source_record_key,
                    adventure_title=draft.adventure_title,
                    stage_title=draft.stage_title,
                    adventure_url=draft.adventure_url,
                    found_date=draft.found_date,
                    found_at_utc=draft.found_at_utc,
                    found_at_offset_minutes=draft.found_at_offset_minutes,
                    date_precision=draft.date_precision,
                    date_basis=draft.date_basis,
                    source_date_text=draft.source_date_text,
                    latitude=draft.latitude,
                    longitude=draft.longitude,
                    coordinate_scope=draft.coordinate_scope,
                    coordinate_source=SOURCE_LAB_FINDS if draft.latitude is not None else None,
                    coordinate_status=(
                        LabDiscovery.COORD_RESOLVED if draft.latitude is not None
                        else LabDiscovery.COORD_MISSING
                    ),
                    source_format=SOURCE_LAB_FINDS,
                    is_archived=draft.is_archived,
                    imported_at=_utcnow(),
                    updated_at=_utcnow(),
                ))
            continue

        updates, row_conflicts = _diff_draft(draft, row)
        if row_conflicts:
            counts["conflicts"] += 1
            conflicts.extend({**c, "local_uid": row.local_uid} for c in row_conflicts)
        if updates:
            counts["updated"] += 1
            if commit:
                for attr, value in updates.items():
                    setattr(row, attr, value)
                row.updated_at = _utcnow()
        else:
            counts["unchanged"] += 1

    rejected = len(parsed.rejected)
    if parsed.duplicates:
        warnings.append({"field": "discoveries",
                         "reason": f"{parsed.duplicates} doublon(s) dédoublonné(s)"})

    summary = {**counts, "rejected": rejected, "conflicts_detail": conflicts,
               "warnings": warnings}
    if commit:
        collection.last_import_at = _utcnow()
        if parsed.meta.get("exported_at"):
            collection.last_exported_at = parsed.meta["exported_at"]
        collection.last_coverage = parsed.meta.get("coverage")
        label = parsed.meta.get("account_label")
        if label:
            if not collection.account_label:
                collection.account_label = label
            elif collection.account_label != label:
                warnings.append({"field": "account",
                                 "reason": "pseudo différent de la collection — mélange possible"})
        collection.revision = (collection.revision or 0) + 1
    return summary


def _collection_stats(session, collection_id) -> dict:
    rows = session.query(LabDiscovery).filter_by(collection_id=collection_id)
    total = unresolved = ready = 0
    for r in rows:
        total += 1
        if r.found_date and r.coordinate_status == LabDiscovery.COORD_RESOLVED \
                and r.latitude is not None and r.longitude is not None:
            ready += 1
        else:
            unresolved += 1
    return {"total": total, "ready": ready, "unresolved": unresolved}


def commit_history(session, parsed) -> dict:
    """Applique un export historique analysé. Retourne le résumé complet."""
    if not parsed.ok:
        raise ValueError("import refusé : le fichier a des erreurs structurelles")
    with LAB_MUTATION_LOCK:
        summary = _apply_history(session, parsed, commit=True)
        collection = get_collection(session)
        stats = _collection_stats(session, collection.id)
        summary.update(stats)
        summary["collection_revision"] = collection.revision
        collection.last_import_summary = json.dumps(summary, default=str)
        session.commit()
    summary["success"] = True
    return summary


def preview_history(session, parsed) -> dict:
    """Même diff que commit_history sans écrire (transaction annulée)."""
    if not parsed.ok:
        raise ValueError("import refusé : le fichier a des erreurs structurelles")
    with LAB_MUTATION_LOCK:
        collection = get_or_create_collection(session)
        summary = _apply_history(session, parsed, commit=True)
        stats = _collection_stats(session, collection.id)
        summary.update(stats)
        session.rollback()  # l'aperçu ne persiste rien
    return summary


# ---------------------------------------------------------------------------
# Enrichissement coordonnées
# ---------------------------------------------------------------------------

def _proposals(session, collection_id, coords_by_adv, resolved_uuids):
    """Propositions titre-dans-Adventure (règle 3) : listées, jamais appliquées."""
    proposals = []
    rows = session.query(LabDiscovery).filter(
        LabDiscovery.collection_id == collection_id,
        LabDiscovery.coordinate_status != LabDiscovery.COORD_RESOLVED,
        LabDiscovery.adventure_uuid.isnot(None),
        LabDiscovery.stage_title.isnot(None),
    )
    for row in rows:
        candidates = [
            s for s in coords_by_adv.get(row.adventure_uuid, [])
            if s.stage_uuid not in resolved_uuids
            and normalize_title(s.stage_title) == normalize_title(row.stage_title)
        ]
        if not candidates:
            continue
        proposals.append({
            "local_uid": row.local_uid,
            "stage_title": row.stage_title,
            "adventure_uuid": row.adventure_uuid,
            "candidates": [
                {"stage_uuid": s.stage_uuid, "latitude": s.latitude, "longitude": s.longitude}
                for s in candidates
            ],
            "unique": len(candidates) == 1,
        })
    return proposals


def _apply_coords(session, parsed, commit: bool) -> dict:
    collection = get_or_create_collection(session) if commit else get_collection(session)
    collection_id = collection.id if collection else None
    by_uuid = {}
    if collection_id:
        for row in session.query(LabDiscovery).filter(
            LabDiscovery.collection_id == collection_id,
            LabDiscovery.stage_uuid.isnot(None),
        ):
            by_uuid[row.stage_uuid] = row

    counts = {"resolved": 0, "unchanged": 0, "ignored": 0, "conflicts": 0}
    conflicts, warnings = [], list(parsed.errors)
    resolved_uuids = set()
    coords_by_adv = {}
    found_flag_mismatch = 0

    for stage in parsed.stages:
        if stage.adventure_uuid:
            coords_by_adv.setdefault(stage.adventure_uuid, []).append(stage)
        row = by_uuid.get(stage.stage_uuid)
        if row is None:
            counts["ignored"] += 1  # étape sans découverte : jamais un find
            continue
        resolved_uuids.add(stage.stage_uuid)
        if not stage.found_flag:
            found_flag_mismatch += 1

        if (row.adventure_uuid and stage.adventure_uuid
                and row.adventure_uuid != stage.adventure_uuid):
            counts["conflicts"] += 1
            conflicts.append({"local_uid": row.local_uid, "field": "adventure_uuid",
                              "existing": row.adventure_uuid, "incoming": stage.adventure_uuid})
            continue

        if row.coordinate_source == USER_CORRECTION:
            if row.latitude != stage.latitude or row.longitude != stage.longitude:
                counts["conflicts"] += 1
                conflicts.append({"local_uid": row.local_uid, "field": "coordinates",
                                  "existing": [row.latitude, row.longitude],
                                  "incoming": [stage.latitude, stage.longitude],
                                  "protected": "user_correction"})
            else:
                counts["unchanged"] += 1
            continue

        if row.latitude is not None and row.longitude is not None:
            if row.latitude == stage.latitude and row.longitude == stage.longitude:
                counts["unchanged"] += 1
            else:
                counts["conflicts"] += 1
                conflicts.append({"local_uid": row.local_uid, "field": "coordinates",
                                  "existing": [row.latitude, row.longitude],
                                  "incoming": [stage.latitude, stage.longitude]})
            continue

        counts["resolved"] += 1
        if commit:
            row.latitude = stage.latitude
            row.longitude = stage.longitude
            row.coordinate_scope = "stage"
            row.coordinate_source = SOURCE_LAB2GPX
            row.coordinate_status = LabDiscovery.COORD_RESOLVED
            if not row.adventure_uuid:
                row.adventure_uuid = stage.adventure_uuid
            if not row.adventure_url and stage.adventure_url:
                row.adventure_url = stage.adventure_url
            if not row.stage_title and stage.stage_title:
                row.stage_title = stage.stage_title
            row.updated_at = _utcnow()

    if found_flag_mismatch:
        warnings.append({"field": "sym",
                         "reason": f"{found_flag_mismatch} étape(s) de l'historique "
                                   "non marquées trouvées dans le GPX"})

    proposals = _proposals(session, collection_id, coords_by_adv, resolved_uuids) \
        if collection_id else []

    summary = {**counts, "rejected": len(parsed.rejected),
               "conflicts_detail": conflicts, "warnings": warnings,
               "proposals": proposals}
    if commit:
        collection.revision = (collection.revision or 0) + 1
        collection.last_import_at = _utcnow()
    return summary


def commit_coordinates(session, parsed) -> dict:
    """Enrichit les découvertes avec un fichier coordonnées analysé."""
    if not parsed.ok:
        raise ValueError("import refusé : le fichier a des erreurs structurelles")
    with LAB_MUTATION_LOCK:
        summary = _apply_coords(session, parsed, commit=True)
        collection = get_collection(session)
        stats = _collection_stats(session, collection.id) if collection else \
            {"total": 0, "ready": 0, "unresolved": 0}
        summary.update(stats)
        summary["collection_revision"] = collection.revision if collection else 0
        if collection:
            collection.last_import_summary = json.dumps(summary, default=str)
        session.commit()
    summary["success"] = True
    return summary


def preview_coordinates(session, parsed) -> dict:
    """Même diff que commit_coordinates sans écrire."""
    if not parsed.ok:
        raise ValueError("import refusé : le fichier a des erreurs structurelles")
    with LAB_MUTATION_LOCK:
        collection = get_or_create_collection(session)
        summary = _apply_coords(session, parsed, commit=True)
        stats = _collection_stats(session, collection.id)
        summary.update(stats)
        session.rollback()
    return summary


# ---------------------------------------------------------------------------
# Lecture / suppression
# ---------------------------------------------------------------------------

def lab_date_bounds(session) -> tuple:
    """(min, max) des found_date des découvertes exploitables — db_infos."""
    from sqlalchemy import func
    collection = get_collection(session)
    if collection is None:
        return (None, None)
    row = session.query(
        func.min(LabDiscovery.found_date),
        func.max(LabDiscovery.found_date),
    ).filter(
        LabDiscovery.collection_id == collection.id,
        LabDiscovery.coordinate_status == LabDiscovery.COORD_RESOLVED,
        LabDiscovery.found_date.isnot(None),
    ).one()
    return (row[0], row[1])


def collection_status(session) -> dict:
    """Compteurs pour /api/labs/status : importées, exploitables, en attente."""
    collection = get_collection(session)
    if collection is None:
        return {"collection": None, "total": 0, "ready": 0, "unresolved": 0}
    stats = _collection_stats(session, collection.id)
    return {
        "collection": {
            "uid": collection.uid,
            "account_label": collection.account_label,
            "revision": collection.revision,
            "last_import_at": collection.last_import_at.isoformat() if collection.last_import_at else None,
            "last_exported_at": collection.last_exported_at.isoformat() if collection.last_exported_at else None,
            "last_coverage": collection.last_coverage,
        },
        **stats,
    }


def unresolved_discoveries(session, limit=200, offset=0) -> list:
    collection = get_collection(session)
    if collection is None:
        return []
    rows = session.query(LabDiscovery).filter(
        LabDiscovery.collection_id == collection.id,
    ).order_by(LabDiscovery.found_date.is_(None), LabDiscovery.found_date,
               LabDiscovery.id).all()
    out = []
    for r in rows:
        reasons = []
        if r.found_date is None:
            reasons.append("missing_date")
        if r.latitude is None or r.longitude is None:
            reasons.append("missing_coordinates")
        elif r.coordinate_status != LabDiscovery.COORD_RESOLVED:
            reasons.append(f"coordinate_{r.coordinate_status}")
        if reasons:
            out.append({
                "local_uid": r.local_uid,
                "adventure_uuid": r.adventure_uuid,
                "stage_uuid": r.stage_uuid,
                "adventure_title": r.adventure_title,
                "stage_title": r.stage_title,
                "found_date": r.found_date.isoformat() if r.found_date else None,
                "is_archived": r.is_archived,
                "reasons": reasons,
            })
    return out[offset:offset + limit]


def clear_labs(session) -> dict:
    """Supprime la collection Labs et ses découvertes — jamais `geocache`."""
    with LAB_MUTATION_LOCK:
        collection = get_collection(session)
        if collection is None:
            return {"success": True, "deleted": 0}
        deleted = session.query(LabDiscovery).filter_by(collection_id=collection.id).count()
        session.delete(collection)  # cascade delete-orphan
        session.commit()
    return {"success": True, "deleted": deleted}
