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
  une Adventure connue n'est qu'une proposition, mémorisée sur l'étape quand
  elle est unique et jamais appliquée sans validation ;
- un conflit de date ou de coordonnées ne cède que sur choix explicite
  (`overrides`), valable pour la seule valeur montrée à l'aperçu.
"""

from __future__ import annotations

import json
import threading
from collections import Counter
from datetime import datetime, timezone

from flask_babel import gettext as _
from sqlalchemy import func

from lab_formats import (
    SOURCE_LAB2GPX, SOURCE_LAB_FINDS, normalize_title,
)
from models import LabCollection, LabDiscovery

COLLECTION_UID = "default"
USER_CORRECTION = "user_correction"

# Conflits que l'utilisateur peut trancher en faveur de la valeur reçue ; un
# identifiant contradictoire (adventure_uuid, stage_uuid) n'en fait pas partie.
OVERRIDABLE_FIELDS = ("found_date", "coordinates")
# ~1 m : en deçà, deux positions sont la même (arrondis d'une source à l'autre).
COORD_TOLERANCE_DEG = 1e-5

# Les mutations Labs (imports, résolutions, clear) se font sous ce verrou :
# l'exclusivité ne peut pas reposer sur les seuls boutons désactivés côté UI.
LAB_MUTATION_LOCK = threading.Lock()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def override_key(local_uid, field, incoming) -> tuple:
    """Clé d'un choix « remplacer ». La valeur reçue en fait partie : le
    choix ne vaut que pour le conflit montré, pas pour une autre valeur
    qu'apporterait un fichier différent. Lève TypeError/ValueError si
    `incoming` n'a pas la forme du champ."""
    if field == "coordinates":
        lat, lon = incoming
        return (local_uid, field, (float(lat), float(lon)))
    return (local_uid, field, str(incoming))


def _same_coords(lat_a, lon_a, lat_b, lon_b) -> bool:
    if None in (lat_a, lon_a, lat_b, lon_b):
        return False
    return (abs(lat_a - lat_b) <= COORD_TOLERANCE_DEG
            and abs(lon_a - lon_b) <= COORD_TOLERANCE_DEG)


def _conflict(row, field, existing, incoming, **extra) -> dict:
    """Conflit décrit pour l'interface : de quoi nommer l'étape et rejouer
    le choix (`local_uid` + `field` + `incoming`)."""
    return {"local_uid": row.local_uid, "stage_title": row.stage_title,
            "adventure_title": row.adventure_title, "field": field,
            "existing": existing, "incoming": incoming, **extra}


def _reason_counts(field, reasons) -> list:
    """Avertissements par ligne regroupés : une entrée par raison, comptée."""
    return [{"field": field, "reason": reason, "count": count}
            for reason, count in Counter(reasons).most_common()]


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


def _diff_draft(draft, row, overrides=frozenset()) -> tuple[dict, list]:
    """Calcule les champs à écrire et les conflits pour un existant.

    Retourne (updates, conflicts) — updates vide signifie 'unchanged'.
    """
    updates, conflicts = {}, []

    def date_conflict(**extra):
        incoming = str(draft.found_date)
        if override_key(row.local_uid, "found_date", incoming) in overrides:
            updates["found_date"] = draft.found_date
            updates["found_at_utc"] = draft.found_at_utc
            updates.update(date_meta)
        else:
            conflicts.append(_conflict(row, "found_date", str(row.found_date),
                                       incoming, **extra))

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
            conflicts.append(_conflict(row, label, current, incoming))

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
            date_conflict(protected=USER_CORRECTION)
    elif row.found_date != draft.found_date or (
        row.found_at_utc and draft.found_at_utc and row.found_at_utc != draft.found_at_utc
    ):
        date_conflict()
    elif draft.found_at_utc is not None or row.found_at_utc is None:
        # Même date : la source peut préciser (instant, offset), jamais
        # dégrader un instant connu en simple date.
        if row.found_at_utc is None and draft.found_at_utc is not None:
            updates["found_at_utc"] = draft.found_at_utc
        for attr, incoming in date_meta.items():
            fill_or_keep(attr, incoming)

    # Coordonnées portées par l'historique (rare) : même règle de conflit.
    if draft.latitude is not None and draft.longitude is not None:
        incoming = [draft.latitude, draft.longitude]
        take = row.latitude is None or row.longitude is None
        if not take and row.coordinate_source != USER_CORRECTION and not _same_coords(
                row.latitude, row.longitude, draft.latitude, draft.longitude):
            if override_key(row.local_uid, "coordinates", incoming) in overrides:
                take = True
            else:
                conflicts.append(_conflict(
                    row, "coordinates", [row.latitude, row.longitude], incoming))
        if take:
            updates.update({
                "latitude": draft.latitude, "longitude": draft.longitude,
                "coordinate_scope": draft.coordinate_scope or "stage",
                "coordinate_source": SOURCE_LAB_FINDS,
                "coordinate_status": LabDiscovery.COORD_RESOLVED,
                "coord_fetch_failed_at": None,
                "suggested_latitude": None, "suggested_longitude": None,
            })

    if draft.is_archived and not row.is_archived:
        updates["is_archived"] = True

    return updates, conflicts


def _apply_history(session, parsed, commit: bool, overrides=frozenset()) -> dict:
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

        updates, row_conflicts = _diff_draft(draft, row, overrides)
        if row_conflicts:
            counts["conflicts"] += 1
            conflicts.extend(row_conflicts)
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
                         "reason": _("%(n)s doublon(s) dédoublonné(s)",
                                     n=parsed.duplicates)})
    warnings.extend(_reason_counts(
        "discoveries",
        [w for d in parsed.drafts for w in d.warnings]
        + [reason for _idx, reason in parsed.rejected]))

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
                                 "reason": _("pseudo différent de la collection — mélange possible")})
        collection.revision = (collection.revision or 0) + 1
    return summary


def _collection_stats(session, collection_id) -> dict:
    # Deux comptages SQL : /api/labs/status est interrogé à chaque retour
    # sur l'onglet, la table n'a pas à être chargée pour autant.
    base = session.query(func.count(LabDiscovery.id)).filter(
        LabDiscovery.collection_id == collection_id)
    total = base.scalar() or 0
    ready = base.filter(LabDiscovery.ready_clause()).scalar() or 0
    return {"total": total, "ready": ready, "unresolved": total - ready}


def commit_history(session, parsed, overrides=frozenset()) -> dict:
    """Applique un export historique analysé. Retourne le résumé complet."""
    if not parsed.ok:
        raise ValueError("import refusé : le fichier a des erreurs structurelles")
    with LAB_MUTATION_LOCK:
        summary = _apply_history(session, parsed, commit=True, overrides=overrides)
        collection = get_collection(session)
        stats = _collection_stats(session, collection.id)
        summary.update(stats)
        summary["collection_revision"] = collection.revision
        collection.last_import_summary = json.dumps(summary, default=str)
        session.commit()
    summary["success"] = True
    return summary


# ---------------------------------------------------------------------------
# Enrichissement coordonnées
# ---------------------------------------------------------------------------

def _proposals(session, collection_id, coords_by_adv, resolved_uuids, store):
    """Propositions titre-dans-Adventure (règle 3) : listées, jamais appliquées.

    `store` mémorise sur l'étape la proposition unique, pour la soumettre à
    l'utilisateur plus tard ; plusieurs candidates ne désignent rien."""
    proposals = []
    rows = session.query(LabDiscovery).filter(
        LabDiscovery.collection_id == collection_id,
        LabDiscovery.coords_missing_clause(),
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
        if store and len(candidates) == 1:
            row.suggested_latitude = candidates[0].latitude
            row.suggested_longitude = candidates[0].longitude
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


def _apply_coords(session, parsed, commit: bool, overrides=frozenset()) -> dict:
    collection = get_or_create_collection(session) if commit else get_collection(session)
    collection_id = collection.id if collection else None
    by_uuid = {}
    if collection_id:
        for row in session.query(LabDiscovery).filter(
            LabDiscovery.collection_id == collection_id,
            LabDiscovery.stage_uuid.isnot(None),
        ):
            by_uuid[row.stage_uuid] = row

    counts = {"resolved": 0, "updated": 0, "unchanged": 0, "ignored": 0,
              "conflicts": 0}
    conflicts, warnings = [], list(parsed.errors)
    resolved_uuids = set()
    coords_by_adv = {}
    found_flag_mismatch = 0

    def describe(row, stage) -> bool:
        # Propriétaire et publication décrivent l'étape quelle que soit la
        # position retenue : complétés aussi sur une étape déjà résolue, ce
        # qui rattrape les imports antérieurs à ces champs.
        changed = False
        if stage.owner and row.owner != stage.owner:
            row.owner, changed = stage.owner, True
        if stage.published_date and row.published_date != stage.published_date:
            row.published_date, changed = stage.published_date, True
        if changed:
            row.updated_at = _utcnow()
        return changed

    def write(row, stage):
        row.latitude = stage.latitude
        row.longitude = stage.longitude
        row.coordinate_scope = "stage"
        row.coordinate_source = SOURCE_LAB2GPX
        row.coordinate_status = LabDiscovery.COORD_RESOLVED
        row.coord_fetch_failed_at = None
        row.suggested_latitude = row.suggested_longitude = None
        if not row.adventure_uuid:
            row.adventure_uuid = stage.adventure_uuid
        if not row.adventure_url and stage.adventure_url:
            row.adventure_url = stage.adventure_url
        if not row.stage_title and stage.stage_title:
            row.stage_title = stage.stage_title
        row.updated_at = _utcnow()

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
            conflicts.append(_conflict(row, "adventure_uuid",
                                       row.adventure_uuid, stage.adventure_uuid))
            continue

        described = describe(row, stage) if commit else False

        if row.latitude is not None and row.longitude is not None:
            incoming = [stage.latitude, stage.longitude]
            if _same_coords(row.latitude, row.longitude, *incoming):
                counts["updated" if described else "unchanged"] += 1
            elif override_key(row.local_uid, "coordinates", incoming) in overrides:
                # Choix explicite de l'aperçu — prime aussi sur une
                # correction manuelle, puisque l'utilisateur la remplace.
                counts["updated"] += 1
                if commit:
                    write(row, stage)
            else:
                counts["conflicts"] += 1
                protected = {"protected": USER_CORRECTION} \
                    if row.coordinate_source == USER_CORRECTION else {}
                conflicts.append(_conflict(
                    row, "coordinates", [row.latitude, row.longitude], incoming,
                    **protected))
            continue

        counts["resolved"] += 1
        if commit:
            write(row, stage)

    if found_flag_mismatch:
        warnings.append({"field": "sym",
                         "reason": _("%(n)s étape(s) de l'historique non marquées "
                                     "trouvées dans le GPX", n=found_flag_mismatch)})
    warnings.extend(_reason_counts(
        "stages",
        [w for s in parsed.stages for w in s.warnings]
        + [reason for _idx, reason in parsed.rejected]))

    proposals = _proposals(session, collection_id, coords_by_adv, resolved_uuids,
                           store=commit) if collection_id else []

    summary = {**counts, "rejected": len(parsed.rejected),
               "conflicts_detail": conflicts, "warnings": warnings,
               "proposals": proposals}
    if commit:
        collection.revision = (collection.revision or 0) + 1
        collection.last_import_at = _utcnow()
    return summary


def commit_coordinates(session, parsed, overrides=frozenset()) -> dict:
    """Enrichit les découvertes avec un fichier coordonnées analysé."""
    if not parsed.ok:
        raise ValueError("import refusé : le fichier a des erreurs structurelles")
    with LAB_MUTATION_LOCK:
        summary = _apply_coords(session, parsed, commit=True, overrides=overrides)
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


def mark_coords_fetch_failed(session, adventure_uuids) -> int:
    """Date la tentative sur les étapes encore sans coordonnées des
    Adventures données — celles que le service a refusées comme celles
    auxquelles il a répondu sans fournir l'étape. Retourne le nombre d'étapes
    marquées."""
    uuids = list(dict.fromkeys(u for u in adventure_uuids if u))
    if not uuids:
        return 0
    with LAB_MUTATION_LOCK:
        collection = get_collection(session)
        if collection is None:
            return 0
        marked, now = 0, _utcnow()
        for i in range(0, len(uuids), 500):   # borne des variables SQLite
            marked += session.query(LabDiscovery).filter(
                LabDiscovery.collection_id == collection.id,
                LabDiscovery.adventure_uuid.in_(uuids[i:i + 500]),
                LabDiscovery.coords_missing_clause(),
            ).update({LabDiscovery.coord_fetch_failed_at: now},
                     synchronize_session=False)
        session.commit()
    return marked


# ---------------------------------------------------------------------------
# Lecture / suppression
# ---------------------------------------------------------------------------

def lab_date_bounds(session) -> tuple:
    """(min, max) des found_date des découvertes exploitables — db_infos."""
    collection = get_collection(session)
    if collection is None:
        return (None, None)
    row = session.query(
        func.min(LabDiscovery.found_date),
        func.max(LabDiscovery.found_date),
    ).filter(
        LabDiscovery.collection_id == collection.id,
        LabDiscovery.ready_clause(),
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
    # Filtre et pagination en SQL : seule la page demandée est chargée.
    rows = session.query(LabDiscovery).filter(
        LabDiscovery.collection_id == collection.id,
        LabDiscovery.unresolved_clause(),
    ).order_by(LabDiscovery.found_date.is_(None), LabDiscovery.found_date,
               LabDiscovery.id).offset(offset).limit(limit).all()
    out = []
    for r in rows:
        reasons = []
        if r.found_date is None:
            reasons.append("missing_date")
        if r.latitude is None or r.longitude is None:
            reasons.append("missing_coordinates")
            if r.coord_fetch_failed_at is not None:
                reasons.append("coordinates_unavailable")
        elif r.coordinate_status != LabDiscovery.COORD_RESOLVED:
            reasons.append(f"coordinate_{r.coordinate_status or LabDiscovery.COORD_MISSING}")
        out.append({
            "local_uid": r.local_uid,
            "adventure_uuid": r.adventure_uuid,
            "stage_uuid": r.stage_uuid,
            "adventure_title": r.adventure_title,
            "stage_title": r.stage_title,
            "found_date": r.found_date.isoformat() if r.found_date else None,
            "is_archived": r.is_archived,
            "reasons": reasons,
            "suggestion": (
                {"latitude": r.suggested_latitude,
                 "longitude": r.suggested_longitude}
                if r.suggested_latitude is not None
                and r.suggested_longitude is not None
                and (r.latitude is None or r.longitude is None) else None),
        })
    return out


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
