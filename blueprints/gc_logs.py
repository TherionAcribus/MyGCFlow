"""API locale des logs Geocaching — aperçu/validation d'import, statut,
export, suppression (docs/logs-geocaching.md, lot B).

Fichiers acceptés (détection sur le contenu, pas l'extension) : contrat
`mygcflow-logs` v1 (.json) et logs Groundspeak d'un GPX (.gpx), éventuellement
dans un .zip. Même parcours que les Labs : l'aperçu enregistre le fichier
sous un jeton opaque (TTL, consommé une fois) ; la validation relit, reparse
et applique sur l'état courant, et refuse si les logs ont changé depuis
l'aperçu — les retraits annoncés doivent être ceux qui seront faits.
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

import dnf_geojson
import log_formats as lf
import log_store
from bdd import GPX_MAX_SIZE_BYTES
from extensions import db
from localization import get_locale
from models import CacheRef, LogEvent
from task_manager import TaskAlreadyRunning, task_manager

logs_bp = Blueprint('gc_logs', __name__)

TASK_TYPE_LOG_IMPORT = "log_import"
PENDING_TTL_SECONDS = 30 * 60
PENDING_ROOT = Path(tempfile.gettempdir()) / "mygcflow-log-imports"
MAX_DETAIL_ITEMS = 50


# ---------------------------------------------------------------------------
# Fichier reçu
# ---------------------------------------------------------------------------

def _read_upload(upload) -> tuple[bytes | None, str | None]:
    """Contenu exploitable d'un envoi : (octets, message d'erreur). Un .zip
    fournit son premier .json/.gpx, borné à la taille d'envoi décompressée."""
    raw = upload.read(GPX_MAX_SIZE_BYTES + 1)
    if len(raw) > GPX_MAX_SIZE_BYTES:
        return None, _("Fichier trop volumineux (200 Mo max)")
    if lf.detect_logs_file_format(raw) is not None or not zipfile.is_zipfile(io.BytesIO(raw)):
        return raw, None
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for info in archive.infolist():
                if info.is_dir() or not info.filename.lower().endswith((".json", ".gpx")):
                    continue
                if info.file_size > GPX_MAX_SIZE_BYTES:
                    return None, _("Fichier trop volumineux (200 Mo max)")
                with archive.open(info) as member:
                    data = member.read(GPX_MAX_SIZE_BYTES + 1)
                if len(data) > GPX_MAX_SIZE_BYTES:
                    return None, _("Fichier trop volumineux (200 Mo max)")
                return data, None
    except zipfile.BadZipFile:
        return None, _("Archive .zip illisible")
    return None, _("L'archive ne contient ni .json ni .gpx")


def _store_pending(raw: bytes, name: str, revision: int) -> str:
    token = uuid.uuid4().hex
    # Historique personnel : dossiers privés (le mode est ignoré sous Windows).
    PENDING_ROOT.mkdir(mode=0o700, exist_ok=True)
    folder = PENDING_ROOT / token
    folder.mkdir(mode=0o700)
    (folder / "file.bin").write_bytes(raw)
    (folder / "manifest.json").write_text(json.dumps({
        "created_at": datetime.now(timezone.utc).isoformat(),
        "name": name, "collection_revision": revision,
    }, ensure_ascii=False), "utf-8")
    return token


def _purge_expired_pending():
    """Ménage opportuniste des jetons expirés. Un dossier consommé (`-taken`)
    appartient à sa tâche, qui le supprime : seul un reliquat d'un jour (tâche
    interrompue par un arrêt brutal) est balayé."""
    now = datetime.now(timezone.utc)
    try:
        children = list(PENDING_ROOT.iterdir())
    except FileNotFoundError:
        return
    for child in children:
        ttl = timedelta(days=1) if child.name.endswith("-taken")             else timedelta(seconds=PENDING_TTL_SECONDS)
        try:
            created = datetime.fromisoformat(
                json.loads((child / "manifest.json").read_text("utf-8"))["created_at"])
        except Exception:
            created = None
        if created is None or now - created > ttl:
            shutil.rmtree(child, ignore_errors=True)


def _take_pending(token) -> tuple[Path | None, dict | None, str | None]:
    """Dossier et manifest d'un jeton valide, renommé pour n'être consommé
    qu'une fois : (dossier, manifest, message d'erreur)."""
    if not isinstance(token, str) or not token.isalnum():
        return None, None, _("Jeton d'import invalide")
    folder = PENDING_ROOT / token
    try:
        manifest = json.loads((folder / "manifest.json").read_text("utf-8"))
        created = datetime.fromisoformat(manifest["created_at"])
    except Exception:
        return None, None, _("Jeton d'import inconnu ou déjà consommé")
    if datetime.now(timezone.utc) - created > timedelta(seconds=PENDING_TTL_SECONDS):
        shutil.rmtree(folder, ignore_errors=True)
        return None, None, _("Jeton d'import expiré — relancer l'aperçu")
    taken = folder.with_name(token + "-taken")
    try:
        folder.rename(taken)
    except OSError:
        return None, None, _("Jeton d'import inconnu ou déjà consommé")
    return taken, manifest, None


def _cap(items, limit=MAX_DETAIL_ITEMS):
    return items[:limit] + ([{"truncated": len(items) - limit}] if len(items) > limit else [])


def _slim(summary: dict) -> dict:
    slim = dict(summary)
    for key in ("rejected_reasons", "warnings"):
        slim[key] = _cap(slim.get(key) or [])
    return slim


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@logs_bp.route('/api/logs/import/preview', methods=['POST'])
def import_preview():
    upload = request.files.get("file")
    if upload is None:
        return jsonify({'success': False, 'message': _("Aucun fichier fourni")}), 400
    name = upload.filename or "fichier"
    _purge_expired_pending()

    raw, error = _read_upload(upload)
    if error:
        return jsonify({'success': False, 'message': error}), 400
    parsed = lf.parse_logs_file(raw)
    if not parsed.ok:
        reasons = "; ".join(e["reason"] for e in parsed.errors[:3])
        return jsonify({'success': False,
                        'message': _("Fichier refusé : %(reasons)s", reasons=reasons)}), 400
    try:
        summary = log_store.preview_logs(db.session, parsed)
    except log_store.LogImportError as exc:
        return jsonify({'success': False, 'message': str(exc)}), 409
    finally:
        db.session.rollback()   # l'aperçu ne lit que, mais referme sa transaction

    token = _store_pending(raw, name, summary["collection_revision"])
    return jsonify({'success': True, 'import_token': token, 'name': name,
                    'format': parsed.meta.get("format"),
                    'expires_in_seconds': PENDING_TTL_SECONDS,
                    'summary': _slim(summary)})


@logs_bp.route('/api/logs/import/commit', methods=['POST'])
def import_commit():
    body = request.get_json(silent=True) or {}
    # Refus avant de consommer le jeton : l'utilisateur garde la main.
    if task_manager.get_active(TASK_TYPE_LOG_IMPORT) is not None:
        return jsonify({'success': False, 'message': _("Un import de logs est déjà en cours")}), 409
    folder, manifest, error = _take_pending(body.get("import_token"))
    if error:
        return jsonify({'success': False, 'message': error}), 400
    try:
        task = task_manager.submit(
            TASK_TYPE_LOG_IMPORT, run_log_import_task, current_app._get_current_object(),
            str(folder), manifest.get("collection_revision"), get_locale(), exclusive=True)
    except TaskAlreadyRunning as exc:
        shutil.rmtree(folder, ignore_errors=True)
        return jsonify({'success': False, 'message': str(exc)}), 409
    return jsonify({'success': True, 'task_id': task.id, 'state': task.state}), 202


def run_log_import_task(status, app, folder_path: str, expected_revision, locale=None):
    """Reparse et applique le fichier d'un jeton consommé (thread de fond)."""
    folder = Path(folder_path)
    try:
        with app.app_context():
            with force_locale(locale) if locale else nullcontext():
                try:
                    status.set_progress(10, _("Lecture du fichier de logs"))
                    parsed = lf.parse_logs_file((folder / "file.bin").read_bytes())
                    status.set_progress(40, _("Enregistrement des logs"))
                    summary = log_store.commit_logs(
                        db.session, parsed, expected_revision=expected_revision)
                    status.set_result(_slim(summary))
                except Exception as exc:  # noqa: BLE001 — toute erreur doit passer en failed
                    db.session.rollback()
                    status.fail(exc)
                finally:
                    db.session.remove()
    finally:
        shutil.rmtree(folder, ignore_errors=True)


@logs_bp.route('/api/logs/status')
def logs_status():
    payload = {'success': True, **log_store.collection_status(db.session)}
    active = task_manager.get_active(TASK_TYPE_LOG_IMPORT)
    if active is not None:
        payload['active_task'] = active.to_dict()
    return jsonify(payload)


@logs_bp.route('/api/logs/dnf_features')
def logs_dnf_features():
    """Points DNF de la carte, à part du jeu principal : jamais comptés comme
    des trouvailles (dnf_geojson.py)."""
    return jsonify({'success': True, **dnf_geojson.build_dnf_features(db.session)})


@logs_bp.route('/api/logs/clear', methods=['POST'])
def logs_clear():
    if task_manager.get_active(TASK_TYPE_LOG_IMPORT) is not None:
        return jsonify({'success': False, 'message': _("Un import de logs est déjà en cours")}), 409
    result = log_store.clear_logs(db.session)
    return jsonify({**result,
                    'message': _("%(count)s logs supprimés.", count=result["removed_logs"])})


def _iso(value):
    return value.isoformat() if value else None


@logs_bp.route('/api/logs/export')
def logs_export():
    """Réexport `mygcflow-logs` v1 de tout ce qui est stocké. Sans couverture :
    réimporté, il ne retire jamais rien. Son `exported_at` est celui des
    données les plus récentes, pas l'heure de l'export — sinon il passerait
    pour plus frais qu'un vrai export postérieur à ses données."""
    collection = log_store.get_collection(db.session)
    if collection is None:
        return jsonify({'success': False, 'message': _("Aucun log à exporter")}), 404
    logs = db.session.query(LogEvent).filter_by(collection_id=collection.id).order_by(
        LogEvent.log_date, LogEvent.log_id).all()
    caches = db.session.query(CacheRef).filter_by(collection_id=collection.id).order_by(
        CacheRef.gc_code).all()
    freshest = max((d for d in (*(r.source_exported_at for r in logs),
                                *(r.source_exported_at for r in caches)) if d), default=None)

    def cache_payload(r):
        item = {
            "gc_code": r.gc_code, "name": r.name, "type": r.cache_type,
            "latitude": r.latitude, "longitude": r.longitude,
            "difficulty": r.difficulty, "terrain": r.terrain, "container": r.container,
            "country": r.country, "state": r.state,
            "owner": {"id": r.owner_id, "name": r.owner_name},
            "placed_date": _iso(r.placed_date), "status": r.status,
            "favorite_points": r.favorite_points,
        }
        if r.corrected_latitude is not None and r.corrected_longitude is not None:
            item["corrected"] = {"latitude": r.corrected_latitude,
                                 "longitude": r.corrected_longitude}
        return item

    payload = {
        "format": lf.FORMAT_LOGS,
        "schema_version": lf.LOGS_SCHEMA_VERSION,
        "exported_at": freshest.isoformat() + "Z" if freshest else None,
        "generator": {"name": "mygcflow", "version": current_app.config.get("APP_VERSION") or ""},
        "account": {"user_id": collection.account_user_id,
                    "username": collection.account_username},
        "coverage": [],
        "caches": [cache_payload(r) for r in caches],
        "logs": [{
            "log_id": r.log_id, "gc_code": r.gc_code, "type_id": r.type_id,
            "date": r.log_date.isoformat(),
            "author": {"id": r.author_id, "name": r.author_name},
            "favorite": r.favorite,
        } for r in logs],
    }
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    response = current_app.response_class(
        json.dumps(payload, ensure_ascii=False, indent=2), mimetype='application/json')
    response.headers['Content-Disposition'] = \
        f'attachment; filename="mygcflow-logs-export-{stamp}.json"'
    return response
