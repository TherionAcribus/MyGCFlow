"""API locale Adventure Lab — preview/commit d'imports, statut, corrections.

Fichiers acceptés (détection sur le contenu, pas l'extension) :

- `mygcflow-lab-finds` v1 (JSON historique `labs.geocaching.com/logs`) ;
- GPX Lab2Gpx « un waypoint par étape » (coordonnées + flags Found).

Le commit ne reçoit jamais les enregistrements : `preview` enregistre les
fichiers validés dans un dossier temporaire indexé par un jeton opaque
(TTL, taille bornée, consommé une fois). La tâche d'import relit ces
fichiers, reparse puis applique les upserts — les diffs sont donc toujours
recalculés sur l'état courant de la base (révision vérifiée, avertissement
si elle a bougé depuis l'aperçu).
"""

from __future__ import annotations

import io
import json
import shutil
import tempfile
import uuid
import zipfile
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request
from flask_babel import force_locale, gettext as _

import lab_formats as lf
import lab_store
import paths
from bdd import geojson_cache
from extensions import db
from localization import get_locale
from models import LabDiscovery
from task_manager import TaskAlreadyRunning, task_manager

labs_bp = Blueprint('labs', __name__)

TASK_TYPE_LAB_IMPORT = "lab_import"

# Jetons d'import en attente : dossier temporaire dédié, TTL court.
PENDING_TTL_SECONDS = 30 * 60
MAX_LAB_FILE_BYTES = 64 * 1024 * 1024       # loin au-dessus des exports réels
MAX_LAB_FILES = 64                           # les exports Lab2Gpx sont batchés
MAX_DETAIL_ITEMS = 100                       # bornage des diagnostics renvoyés
PENDING_ROOT = Path(tempfile.gettempdir()) / "mygcflow-lab-imports"

# Ordre d'application : l'historique crée les découvertes, les coordonnées
# les enrichissent — un GPX seul ne doit jamais créer de find.
_FORMAT_ORDER = {lf.FORMAT_LAB_FINDS: 0, lf.FORMAT_LAB2GPX_GPX: 1}
_PARSE_BY_FORMAT = {
    lf.FORMAT_LAB_FINDS: lf.parse_lab_finds,
    lf.FORMAT_LAB2GPX_GPX: lf.parse_lab2gpx_gpx,
}
_APPLY_BY_FORMAT = {
    lf.FORMAT_LAB_FINDS: lab_store._apply_history,
    lf.FORMAT_LAB2GPX_GPX: lab_store._apply_coords,
}


def _invalidate_after_mutation(reason: str) -> None:
    """Invalidations post-mutation Labs : GeoJSON + arbre pays/régions (les
    Labs prêts ajoutent l'option « Non renseigné » — il sera reconstruit à
    la prochaine requête /api/country_state)."""
    geojson_cache.invalidate(reason)
    try:
        paths.country_state_path().unlink(missing_ok=True)
    except OSError:
        pass
_COMMIT_BY_FORMAT = {
    lf.FORMAT_LAB_FINDS: lab_store.commit_history,
    lf.FORMAT_LAB2GPX_GPX: lab_store.commit_coordinates,
}


# ---------------------------------------------------------------------------
# Jetons d'import en attente
# ---------------------------------------------------------------------------

def _purge_expired_pending():
    """Supprime les dossiers de jetons expirés (ménage opportuniste)."""
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=PENDING_TTL_SECONDS)
        for child in PENDING_ROOT.iterdir():
            manifest = child / "manifest.json"
            try:
                created = datetime.fromisoformat(
                    json.loads(manifest.read_text("utf-8"))["created_at"])
            except Exception:
                created = None
            if created is None or created < cutoff:
                shutil.rmtree(child, ignore_errors=True)
    except FileNotFoundError:
        pass
    except Exception as exc:
        print(f"[LABS] Purge des imports en attente impossible : {exc}")


def _extract_first_gpx(raw: bytes) -> bytes | None:
    """Extrait le premier .gpx d'un zip Lab2Gpx (aucune validation « My Finds »)."""
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for info in zf.infolist():
                if info.is_dir() or not info.filename.lower().endswith('.gpx') \
                        or info.filename.startswith('__MACOSX/'):
                    continue
                if info.file_size > MAX_LAB_FILE_BYTES:
                    return None
                return zf.read(info)
    except zipfile.BadZipFile:
        return None
    return None


def _store_pending(files: list[dict]) -> tuple[str, Path]:
    """Persiste les fichiers validés + manifest ; retourne (jeton, dossier)."""
    token = uuid.uuid4().hex
    folder = PENDING_ROOT / token
    folder.mkdir(parents=True, exist_ok=True)
    entries = []
    for i, f in enumerate(files):
        stored = f"f{i:02d}.bin"
        (folder / stored).write_bytes(f["raw"])
        entries.append({"stored": stored, "name": f["name"], "format": f["format"]})
    collection = lab_store.get_collection(db.session)
    manifest = {
        "token": token,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "collection_revision": collection.revision if collection else None,
        "files": entries,
    }
    (folder / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    return token, folder


def _load_pending(token: str) -> tuple[dict | None, Path | None, str | None]:
    """Charge un manifest valide : (manifest, dossier, erreur_msgid)."""
    if not token or not token.isalnum():
        return None, None, "Jeton d'import invalide"
    folder = PENDING_ROOT / token
    manifest_path = folder / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text("utf-8"))
    except Exception:
        return None, None, "Jeton d'import inconnu ou déjà consommé"
    if manifest.get("_consumed"):
        return None, None, "Jeton d'import déjà consommé"
    try:
        created = datetime.fromisoformat(manifest["created_at"])
    except Exception:
        return None, None, "Jeton d'import illisible"
    if datetime.now(timezone.utc) - created > timedelta(seconds=PENDING_TTL_SECONDS):
        shutil.rmtree(folder, ignore_errors=True)
        return None, None, "Jeton d'import expiré — relancer l'aperçu"
    return manifest, folder, None


def _cap_items(items, limit=MAX_DETAIL_ITEMS):
    return items[:limit] + ([{"truncated": len(items) - limit}] if len(items) > limit else [])


# ---------------------------------------------------------------------------
# Tâche d'import
# ---------------------------------------------------------------------------

def run_lab_import_task(status, app, folder_path: str, manifest_rev, locale=None):
    """Reparse et applique les fichiers d'un jeton consommé (thread de fond)."""
    folder = Path(folder_path)
    try:
        with app.app_context():
            ctx = force_locale(locale) if locale else nullcontext()
            with ctx:
                try:
                    manifest = json.loads((folder / "manifest.json").read_text("utf-8"))
                    files = sorted(
                        manifest["files"], key=lambda f: _FORMAT_ORDER.get(f["format"], 9))
                    results, totals = [], {"added": 0, "updated": 0, "unchanged": 0,
                                           "resolved": 0, "ignored": 0, "rejected": 0,
                                           "conflicts": 0}
                    warnings = []
                    n = len(files)
                    for i, entry in enumerate(files):
                        status.set_progress(
                            int(95 * i / max(n, 1)),
                            _("Import Labs : %(name)s", name=entry["name"]))
                        raw = (folder / entry["stored"]).read_bytes()
                        parsed = _PARSE_BY_FORMAT[entry["format"]](raw)
                        summary = _COMMIT_BY_FORMAT[entry["format"]](db.session, parsed)
                        results.append({"name": entry["name"], "format": entry["format"],
                                        "summary": _slim_summary(summary)})
                        for k in totals:
                            totals[k] += int(summary.get(k, 0))
                        warnings.extend(summary.get("warnings", []))

                    collection = lab_store.get_collection(db.session)
                    rev_now = collection.revision if collection else None
                    if manifest_rev is not None and rev_now is not None \
                            and rev_now != manifest_rev + n:
                        warnings.append({
                            "field": "collection_revision",
                            "reason": "la collection a été modifiée entre l'aperçu et "
                                      "l'enregistrement — diff recalculé sur l'état courant"})
                    status.set_progress(98, _("Import Labs : finalisation"))
                    _invalidate_after_mutation("labs_import")
                    stats = lab_store.collection_status(db.session)
                    status.set_result({
                        "success": True,
                        **totals,
                        "total": stats["total"],
                        "ready_total": stats["ready"],
                        "unresolved": stats["unresolved"],
                        "files": results,
                        "warnings": _cap_items(warnings),
                    })
                except Exception as exc:  # noqa: BLE001 — toute erreur doit passer en failed
                    db.session.rollback()
                    status.fail(exc)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def _slim_summary(summary: dict) -> dict:
    """Résumé de tâche borné : pas de détail exhaustif des conflits en mémoire."""
    slim = {k: v for k, v in summary.items()
            if k in ("added", "updated", "unchanged", "resolved", "ignored",
                     "rejected", "conflicts", "success")}
    detail = summary.get("conflicts_detail") or []
    slim["conflicts_detail"] = _cap_items(detail, 20)
    proposals = summary.get("proposals") or []
    slim["proposals"] = _cap_items(proposals, 20)
    return slim


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@labs_bp.route('/api/labs/import/preview', methods=['POST'])
def import_preview():
    uploads = request.files.getlist("files") or request.files.getlist("file")
    if not uploads:
        return jsonify({'success': False,
                        'message': _("Aucun fichier fourni")}), 400
    if len(uploads) > MAX_LAB_FILES:
        return jsonify({'success': False,
                        'message': _("Trop de fichiers (maximum %(max)s)", max=MAX_LAB_FILES)}), 400

    _purge_expired_pending()

    parsed_files = []   # {name, format, raw, parsed}
    file_reports = []
    for up in uploads:
        name = up.filename or "fichier"
        raw = up.read(MAX_LAB_FILE_BYTES + 1)
        report = {"name": name, "format": None, "status": "error"}
        if len(raw) > MAX_LAB_FILE_BYTES:
            report["error"] = _("Fichier trop volumineux")
            file_reports.append(report)
            continue
        fmt = lf.detect_lab_file_format(raw)
        if fmt is None and zipfile.is_zipfile(io.BytesIO(raw)):
            inner = _extract_first_gpx(raw)
            if inner is not None:
                raw, fmt = inner, lf.detect_lab_file_format(inner)
        if fmt is None:
            report["error"] = _("Format non reconnu (ni export historique, ni GPX Lab2Gpx)")
            file_reports.append(report)
            continue
        parsed = _PARSE_BY_FORMAT[fmt](raw)
        report["format"] = fmt
        if not parsed.ok:
            report["error"] = "; ".join(e["reason"] for e in parsed.errors[:3])
            file_reports.append(report)
            continue
        report["status"] = "ok"
        parsed_files.append({"name": name, "format": fmt, "raw": raw, "parsed": parsed,
                             "report": report})
        file_reports.append(report)

    if not parsed_files:
        return jsonify({'success': False,
                        'message': _("Aucun fichier exploitable"),
                        'files': file_reports}), 400

    # Aperçu du lot complet : les fichiers sont appliqués dans l'ordre dans
    # UNE transaction unique — l'aperçu des coordonnées voit l'historique du
    # même lot — puis tout est annulé par un seul rollback.
    parsed_files.sort(key=lambda f: _FORMAT_ORDER[f["format"]])
    totals = {"added": 0, "updated": 0, "unchanged": 0, "resolved": 0,
              "ignored": 0, "rejected": 0, "conflicts": 0}
    warnings, conflicts_detail, proposals = [], [], []
    try:
        for f in parsed_files:
            summary = _APPLY_BY_FORMAT[f["format"]](db.session, f["parsed"], commit=True)
            f["report"]["summary"] = _slim_summary(summary)
            for k in totals:
                totals[k] += int(summary.get(k, 0))
            warnings.extend(summary.get("warnings", []))
            conflicts_detail.extend(summary.get("conflicts_detail", []))
            proposals.extend(summary.get("proposals", []))
        # État projeté si le lot était enregistré tel quel.
        _coll = lab_store.get_collection(db.session)
        projected = lab_store._collection_stats(db.session, _coll.id) \
            if _coll else {"total": 0, "ready": 0, "unresolved": 0}
    except Exception as exc:
        current_app.logger.error(f"[LABS] preview failed: {exc}")
        return jsonify({'success': False,
                        'message': _("Erreur lors de l'analyse : %(error)s", error=str(exc))}), 500
    finally:
        db.session.rollback()  # l'aperçu ne persiste rien

    token, _folder = _store_pending(parsed_files)

    status = lab_store.collection_status(db.session)
    return jsonify({
        'success': True,
        'import_token': token,
        'expires_in_seconds': PENDING_TTL_SECONDS,
        'collection_revision': status["collection"]["revision"] if status["collection"] else 0,
        'files': file_reports,
        'totals': totals,
        'conflicts_detail': _cap_items(conflicts_detail),
        'proposals': _cap_items(proposals),
        'warnings': _cap_items(warnings),
        'projected': projected,
        'current': status,
    })


@labs_bp.route('/api/labs/import/commit', methods=['POST'])
def import_commit():
    token = (request.get_json(silent=True) or {}).get("import_token") \
        or request.form.get("import_token")
    manifest, folder, error = _load_pending(token)
    if error:
        return jsonify({'success': False, 'message': _(error)}), 400

    # Refus avant de consommer le jeton : l'utilisateur garde la main.
    if task_manager.get_active(TASK_TYPE_LAB_IMPORT) is not None:
        return jsonify({'success': False,
                        'message': _("Un import Labs est déjà en cours")}), 409

    # Le jeton est consommé dès la soumission : un second commit avec le même
    # jeton échouera, même si la tâche plante ensuite.
    manifest["_consumed"] = True
    try:
        (folder / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False), "utf-8")
    except OSError:
        pass

    app_obj = current_app._get_current_object()
    locale = get_locale()
    try:
        task_status = task_manager.submit(
            TASK_TYPE_LAB_IMPORT, run_lab_import_task,
            app_obj, str(folder), manifest.get("collection_revision"), locale,
            exclusive=True)
    except TaskAlreadyRunning as e:
        shutil.rmtree(folder, ignore_errors=True)
        return jsonify({'success': False, 'message': str(e)}), 409

    return jsonify({
        'success': True,
        'message': _("Import Labs lancé en tâche de fond"),
        'task_id': task_status.id,
        'state': task_status.state,
    }), 202


@labs_bp.route('/api/labs/status')
def labs_status():
    return jsonify({'success': True,
                    **lab_store.collection_status(db.session)})


@labs_bp.route('/api/labs/unresolved')
def labs_unresolved():
    try:
        limit = max(1, min(int(request.args.get('limit', 200)), 500))
        offset = max(0, int(request.args.get('offset', 0)))
    except ValueError:
        return jsonify({'success': False, 'message': _("Pagination invalide")}), 400
    items = lab_store.unresolved_discoveries(db.session, limit=limit, offset=offset)
    return jsonify({'success': True, 'items': items,
                    'limit': limit, 'offset': offset, 'count': len(items)})


@labs_bp.route('/api/labs/discoveries/<local_uid>/resolve', methods=['POST'])
def resolve_discovery(local_uid):
    """Correction manuelle : coordonnées et/ou date confirmées par l'utilisateur."""
    body = request.get_json(silent=True) or {}
    has_coords = body.get("latitude") is not None or body.get("longitude") is not None
    has_date = bool(body.get("found_date"))
    if not has_coords and not has_date:
        return jsonify({'success': False,
                        'message': _("Aucune correction fournie")}), 400

    collection = lab_store.get_collection(db.session)
    row = None
    if collection:
        row = db.session.query(LabDiscovery).filter_by(
            collection_id=collection.id, local_uid=local_uid).one_or_none()
    if row is None:
        return jsonify({'success': False, 'message': _("Découverte inconnue")}), 404

    with lab_store.LAB_MUTATION_LOCK:
        if has_coords:
            cc = lf.validate_coordinates(body.get("latitude"), body.get("longitude"))
            if not cc.ok:
                return jsonify({'success': False,
                                'message': _("Coordonnées invalides"),
                                'warnings': cc.warnings}), 400
            row.latitude, row.longitude = cc.latitude, cc.longitude
            row.coordinate_scope = "stage"
            row.coordinate_source = lab_store.USER_CORRECTION
            row.coordinate_status = LabDiscovery.COORD_RESOLVED
        if has_date:
            pd = lf.parse_lab_datetime(body.get("found_date"))
            if pd.found_date is None:
                return jsonify({'success': False,
                                'message': _("Date invalide (format attendu : AAAA-MM-JJ)")}), 400
            row.found_date = pd.found_date
            row.date_precision = "day"
            row.date_basis = "user_correction"
        row.updated_at = lab_store._utcnow()
        collection.revision = (collection.revision or 0) + 1
        db.session.commit()
        _invalidate_after_mutation("labs_resolve")

    return jsonify({'success': True,
                    'discovery': {
                        'local_uid': row.local_uid,
                        'latitude': row.latitude,
                        'longitude': row.longitude,
                        'found_date': row.found_date.isoformat() if row.found_date else None,
                        'coordinate_status': row.coordinate_status,
                    },
                    **lab_store.collection_status(db.session)})


@labs_bp.route('/api/labs/clear', methods=['POST'])
def labs_clear():
    result = lab_store.clear_labs(db.session)
    _invalidate_after_mutation("labs_clear")
    return jsonify({'success': True,
                    'deleted': result["deleted"],
                    'message': _("Collection Labs vidée (%(count)s entrées supprimées).",
                                 count=result["deleted"])})


@labs_bp.route('/api/labs/export')
def labs_export():
    """Réexport `mygcflow-lab-finds` enrichi des coordonnées stockées."""
    collection = lab_store.get_collection(db.session)
    if collection is None:
        return jsonify({'success': False,
                        'message': _("Aucune collection Labs à exporter")}), 404
    rows = db.session.query(LabDiscovery).filter_by(
        collection_id=collection.id).order_by(
        LabDiscovery.found_date.is_(None), LabDiscovery.found_date,
        LabDiscovery.id).all()
    discoveries = [{
        "adventure_id": r.adventure_uuid,
        "stage_id": r.stage_uuid,
        "adventure_title": r.adventure_title,
        "stage_title": r.stage_title,
        "found_date": r.found_date.isoformat() if r.found_date else None,
        "found_at": r.source_date_text,
        "date_precision": r.date_precision,
        "date_basis": r.date_basis,
        "latitude": r.latitude,
        "longitude": r.longitude,
        "coordinate_scope": r.coordinate_scope,
        "coordinate_source": r.coordinate_source,
        "adventure_url": r.adventure_url,
        "log_id": int(r.source_record_key[4:])
        if r.source_record_key and r.source_record_key.startswith("log:")
        and r.source_record_key[4:].isdigit() else None,
        "is_archived": bool(r.is_archived),
    } for r in rows]
    payload = {
        "format": lf.FORMAT_LAB_FINDS,
        "schema_version": lf.LAB_FINDS_SCHEMA_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "account": {"username": collection.account_label},
        "source": "mygcflow",
        "coverage": collection.last_coverage or "unknown",
        "discoveries": discoveries,
    }
    response = current_app.response_class(
        json.dumps(payload, ensure_ascii=False, indent=2),
        mimetype='application/json')
    response.headers['Content-Disposition'] = \
        'attachment; filename="mygcflow-lab-finds-export.json"'
    return response
