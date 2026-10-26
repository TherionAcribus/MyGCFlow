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
import re
import secrets
import shutil
import threading
import uuid
import zipfile
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request
from flask_babel import force_locale, gettext as _

import dnf_geojson
import owner_geojson
import log_formats as lf
import log_store
import paths
from lab_formats import parse_coordinates_text, validate_coordinates
from bdd import GPX_MAX_SIZE_BYTES
from extensions import db
from localization import get_locale
from models import CacheRef, LogEvent
from settings_manager import get_settings_manager
from task_manager import TaskAlreadyRunning, task_manager

logs_bp = Blueprint('gc_logs', __name__)

TASK_TYPE_LOG_IMPORT = "log_import"
PENDING_TTL_SECONDS = 30 * 60
# Fragments d'une collecte en cours du favori : ils doivent survivre à la
# nuit, contrairement à un aperçu en attente — TTL de 7 jours, aligné sur
# l'expiration du plan de reprise côté navigateur.
FRAGMENT_TTL_SECONDS = 7 * 24 * 3600
_RUN_ID_RE = re.compile(r"^[0-9a-zA-Z_-]{8,64}$")
_FRAGMENT_LOCK = threading.Lock()
# Redirigé par les tests ; sinon _pending_root() (sous les données).
PENDING_ROOT: Path | None = None
MAX_DETAIL_ITEMS = 50

# Seules origines autorisées à poster sur /api/logs/receive (le favori
# « Envoyer vers MyGCFlow » s'exécute sur geocaching.com — apex inclus,
# sa navigation finit sur www). Toute autre page web ne peut pas nous
# atteindre en CORS ; le jeton couvre les clients sans CORS (curl & co).
LOGS_ORIGINS = frozenset({
    "https://www.geocaching.com",
    "https://geocaching.com",
})


def _pending_root() -> Path:
    """Dossier des jetons d'aperçu, sous les données : %TEMP% est partagé
    entre la vraie application, pytest et le harnais e2e — un export reçu
    d'un run ressortait dans le suivant. MYGCFLOW_DATA_DIR l'isole."""
    return PENDING_ROOT or (paths.data_dir() / "pending_log_imports")


# ---------------------------------------------------------------------------
# Fichier reçu
# ---------------------------------------------------------------------------

def _read_upload(upload) -> tuple[bytes | None, str | None]:
    """Contenu exploitable d'un envoi : (octets, message d'erreur).

    Un .zip est parcouru en entier : chaque membre .json/.gpx est reconnu
    par son contenu (`detect_logs_file_format`), pas par sa place dans
    l'archive — une Pocket Query contient un « *-wpts.gpx » (waypoints,
    sans logs) qui peut arriver en premier. Ordre de préférence : un
    `mygcflow-logs` .json, puis un .gpx ordinaire, puis un « *-wpts.gpx »
    en dernier recours."""
    raw = upload.read(GPX_MAX_SIZE_BYTES + 1)
    if len(raw) > GPX_MAX_SIZE_BYTES:
        return None, _("Fichier trop volumineux (200 Mo max)")
    if lf.detect_logs_file_format(raw) is not None or not zipfile.is_zipfile(io.BytesIO(raw)):
        return raw, None
    best = None            # (priorité, octets) — la plus petite gagne
    size_error = False
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for info in archive.infolist():
                name = info.filename.lower()
                if info.is_dir() or not name.endswith((".json", ".gpx")):
                    continue
                if info.file_size > GPX_MAX_SIZE_BYTES:
                    size_error = True
                    continue
                with archive.open(info) as member:
                    data = member.read(GPX_MAX_SIZE_BYTES + 1)
                if len(data) > GPX_MAX_SIZE_BYTES:
                    size_error = True
                    continue
                if lf.detect_logs_file_format(data) is None:
                    continue
                rank = 0 if name.endswith(".json") else 2 if name.endswith("-wpts.gpx") else 1
                if best is None or rank < best[0]:
                    best = (rank, data)
                    if rank == 0:
                        break
    except zipfile.BadZipFile:
        return None, _("Archive .zip illisible")
    if best is not None:
        return best[1], None
    if size_error:
        return None, _("Fichier trop volumineux (200 Mo max)")
    return None, _("L'archive ne contient pas de fichier de logs exploitable")


def _store_pending(raw: bytes, name: str, revision: int,
                   received: bool = False, summary: dict | None = None) -> str:
    token = uuid.uuid4().hex
    # Historique personnel : dossiers privés (le mode est ignoré sous Windows).
    _pending_root().mkdir(mode=0o700, exist_ok=True)
    folder = _pending_root() / token
    folder.mkdir(mode=0o700)
    (folder / "file.bin").write_bytes(raw)
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "name": name, "collection_revision": revision,
    }
    if received:
        # Déposé par /api/logs/receive (favori) : le statut le remonte pour
        # que l'interface propose l'aperçu déjà calculé.
        manifest["received"] = True
        manifest["summary"] = summary
    (folder / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), "utf-8")
    return token


def _purge_expired_pending():
    """Ménage opportuniste des jetons expirés. Un dossier consommé (`-taken`)
    appartient à sa tâche, qui le supprime : seul un reliquat d'un jour (tâche
    interrompue par un arrêt brutal) est balayé."""
    now = datetime.now(timezone.utc)
    try:
        children = list(_pending_root().iterdir())
    except FileNotFoundError:
        return
    for child in children:
        if child.name.endswith("-taken"):
            ttl = timedelta(days=1)
        elif child.name.startswith("frag-"):
            ttl = timedelta(seconds=FRAGMENT_TTL_SECONDS)
        else:
            ttl = timedelta(seconds=PENDING_TTL_SECONDS)
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
    folder = _pending_root() / token
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


def _received_pending() -> dict | None:
    """L'aperçu déposé par /api/logs/receive le plus récent, s'il est encore
    valide : l'interface le propose à la validation (même parcours qu'un
    aperçu demandé depuis la carte)."""
    now = datetime.now(timezone.utc)
    try:
        children = list(_pending_root().iterdir())
    except FileNotFoundError:
        return None
    newest = None
    for child in children:
        if child.name.endswith("-taken"):
            continue
        try:
            manifest = json.loads((child / "manifest.json").read_text("utf-8"))
            if not manifest.get("received"):
                continue
            created = datetime.fromisoformat(manifest["created_at"])
        except Exception:
            continue
        if now - created > timedelta(seconds=PENDING_TTL_SECONDS):
            continue
        if newest is None or created > newest[0]:
            newest = (created, child.name, manifest)
    if newest is None:
        return None
    _, token, manifest = newest
    return {"import_token": token, "name": manifest.get("name"),
            "received_at": manifest["created_at"],
            "summary": manifest.get("summary")}


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
    payload['pending_import'] = _received_pending()
    payload['full_collect_planned'] = \
        get_settings_manager().get_app_settings().logs_collect_full_once
    return jsonify(payload)


@logs_bp.route('/api/logs/dnf_features')
def logs_dnf_features():
    """Points DNF de la carte, à part du jeu principal : jamais comptés comme
    des trouvailles (dnf_geojson.py)."""
    return jsonify({'success': True, **dnf_geojson.build_dnf_features(db.session)})


@logs_bp.route('/api/logs/owner_features')
def logs_owner_features():
    """Caches posées par le joueur et ses étapes de poseur (pose,
    maintenance, désactivation, archivage), à part du jeu principal :
    jamais comptées comme des trouvailles (owner_geojson.py)."""
    return jsonify({'success': True, **owner_geojson.build_owner_features(db.session)})


@logs_bp.route('/api/logs/pending_caches')
def logs_pending_caches():
    """Caches des logs sans position connue (modale de complétion), paginées."""
    try:
        limit = max(1, min(int(request.args.get('limit', 20)), 100))
        offset = max(0, int(request.args.get('offset', 0)))
    except ValueError:
        return jsonify({'success': False, 'message': _("Pagination invalide")}), 400
    page = log_store.pending_caches(db.session, limit=limit, offset=offset)
    return jsonify({'success': True, **page, 'limit': limit, 'offset': offset})


@logs_bp.route('/api/logs/caches/<gc_code>/resolve', methods=['POST'])
def logs_resolve_cache(gc_code):
    """Position manuelle d'une cache sans coordonnées connues : texte libre
    (`coordinates`, formats du géocacheur) ou couple `latitude`/`longitude`.
    La correction n'est jamais écrasée par un import ultérieur."""
    body = request.get_json(silent=True) or {}
    text = body.get("coordinates")
    if isinstance(text, str) and text.strip():
        cc = parse_coordinates_text(text)
    elif body.get("latitude") is not None or body.get("longitude") is not None:
        cc = validate_coordinates(body.get("latitude"), body.get("longitude"))
    else:
        return jsonify({'success': False,
                        'message': _("Aucune correction fournie")}), 400
    if not cc.ok:
        reason = cc.warnings[0] if cc.warnings else ""
        return jsonify({'success': False,
                        'message': _("Coordonnées invalides : %(reason)s", reason=reason),
                        'warnings': cc.warnings}), 400
    code = gc_code.strip().upper()
    if not log_store.resolve_cache_coordinates(
            db.session, code, cc.latitude, cc.longitude):
        return jsonify({'success': False, 'message': _("Cache inconnue")}), 404
    return jsonify({'success': True, 'gc_code': code,
                    'latitude': cc.latitude, 'longitude': cc.longitude})


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


# ---------------------------------------------------------------------------
# Réception directe du favori « Envoyer vers MyGCFlow »
# ---------------------------------------------------------------------------

def _receive_cors_headers(resp):
    """CORS + Private-Network-Access restreints à geocaching.com.

    Le bookmarklet poste depuis https://www.geocaching.com vers
    http://127.0.0.1 — Chrome exige une preflight PNA. Toute autre origine
    ne reçoit aucun en-tête : le navigateur bloque la requête."""
    origin = request.headers.get("Origin")
    if origin in LOGS_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = \
            "Content-Type, X-MyGCFlow-Token"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        resp.headers["Access-Control-Max-Age"] = "600"
        resp.headers["Vary"] = "Origin"
    return resp


@logs_bp.route('/api/logs/receive', methods=['POST', 'OPTIONS'])
def logs_receive():
    """Réception d'un export `mygcflow-logs` depuis le favori exécuté sur
    geocaching.com.

    Double protection : jeton local (anti-CSRF, généré par installation) et
    CORS limité aux origines officielles. Contrairement aux Labs, le fichier
    n'est PAS importé d'office : sa couverture complète peut retirer des
    logs, et l'aperçu garantit que les retraits annoncés sont vus avant
    validation. Le payload est donc prévisualisé puis conservé sous un
    jeton `received` que le statut remonte — la carte propose alors
    l'aperçu déjà calculé, et le commit suit le parcours habituel."""
    if request.method == 'OPTIONS':
        return _receive_cors_headers(current_app.make_response(('', 204)))

    def reject(message, code):
        return _receive_cors_headers(
            jsonify({'success': False, 'message': message})), code

    expected = get_settings_manager().get_app_settings().logs_receive_token
    token = request.headers.get('X-MyGCFlow-Token', '')
    if not expected or not secrets.compare_digest(token, expected):
        return reject(
            _("Jeton de réception invalide — régénérer le bookmarklet"), 403)

    raw = request.get_data(cache=False)
    if not raw or len(raw) > GPX_MAX_SIZE_BYTES:
        return reject(_("Contenu absent ou trop volumineux"), 400)
    if lf.detect_logs_file_format(raw) is None:
        return reject(_("Format non reconnu (export mygcflow-logs attendu)"), 400)

    if task_manager.get_active(TASK_TYPE_LOG_IMPORT) is not None:
        return reject(_("Un import de logs est déjà en cours"), 409)

    parsed = lf.parse_logs_file(raw)
    if not parsed.ok:
        reasons = "; ".join(e["reason"] for e in parsed.errors[:3])
        return reject(
            _("Fichier refusé : %(reasons)s", reasons=reasons), 400)
    try:
        summary = log_store.preview_logs(db.session, parsed)
    except log_store.LogImportError as exc:
        return reject(str(exc), 409)
    finally:
        db.session.rollback()   # l'aperçu ne lit que, mais referme sa transaction

    _purge_expired_pending()
    token = _store_pending(raw, _("export du favori"), summary["collection_revision"],
                           received=True, summary=_slim(summary))
    return _receive_cors_headers(jsonify({
        'success': True,
        'message': _("Export reçu — validez l'aperçu dans l'application"),
        'import_token': token})), 202


def _merge_fragment(folder: Path, incoming: dict):
    """Fusionne un fragment dans le document conservé pour cette collecte.

    Dédupliqué par `log_id` / `gc_code` — le dernier arrivé l'emporte ;
    les périmètres de couverture s'unissent (chaque fragment porte le
    périmètre `caches` des caches qu'il a entièrement relues). Renvoie
    (document fusionné, erreur éventuelle)."""
    created = datetime.now(timezone.utc).isoformat()
    merged = None
    try:
        merged = json.loads((folder / "doc.json").read_text("utf-8"))
        created = json.loads(
            (folder / "manifest.json").read_text("utf-8"))["created_at"]
    except Exception:
        pass
    if merged is None:
        merged = {"format": lf.FORMAT_LOGS,
                  "schema_version": lf.LOGS_SCHEMA_VERSION,
                  "logs": [], "caches": [], "coverage": []}

    account = incoming.get("account") or {}
    previous = merged.get("account") or {}
    if account.get("user_id") is not None:
        if (previous.get("user_id") is not None
                and previous["user_id"] != account["user_id"]):
            return None, _("un autre compte alimente déjà cette collecte")
        # Le compte réel (id lu sur une fiche) remplace le « pseudo seul »
        # des tout premiers fragments.
        merged["account"] = account
    elif not merged.get("account"):
        merged["account"] = account

    def _dedup(records, field):
        # Les enregistrements sans identifiant sont gardés tels quels —
        # le parseur complet les triera au scellement.
        seen = {}
        for rec in records:
            if not isinstance(rec, dict):
                continue
            seen[rec.get(field) if rec.get(field) is not None
                 else f"@{len(seen)}"] = rec
        return list(seen.values())

    merged["logs"] = _dedup(
        (merged.get("logs") or []) + (incoming.get("logs") or []), "log_id")
    merged["caches"] = _dedup(
        (merged.get("caches") or []) + (incoming.get("caches") or []), "gc_code")
    seen_scopes = {json.dumps(c, sort_keys=True, ensure_ascii=False)
                   for c in merged.get("coverage") or []}
    merged.setdefault("coverage", [])
    for scope in incoming.get("coverage") or []:
        key = json.dumps(scope, sort_keys=True, ensure_ascii=False)
        if key not in seen_scopes:
            seen_scopes.add(key)
            merged["coverage"].append(scope)
    stamps = [s for s in (merged.get("exported_at"), incoming.get("exported_at")) if s]
    merged["exported_at"] = max(stamps) if stamps else None
    if incoming.get("generator") and not merged.get("generator"):
        merged["generator"] = incoming["generator"]

    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    (folder / "doc.json").write_text(
        json.dumps(merged, ensure_ascii=False), "utf-8")
    (folder / "manifest.json").write_text(json.dumps({
        "created_at": created, "kind": "fragments",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False), "utf-8")
    return merged, None


@logs_bp.route('/api/logs/receive/fragment', methods=['POST', 'OPTIONS'])
def logs_receive_fragment():
    """Fragment d'une collecte longue du favori (mêmes jeton + CORS que
    /receive).

    `X-MyGCFlow-Run-Id` identifie le passage : chaque fragment est
    fusionné dans le document conservé sous `frag-<run>` (TTL 7 jours).
    `X-MyGCFlow-Final: 1` scelle : le document fusionné passe l'aperçu
    habituel et devient un import en attente, comme /receive. C'est ce
    qui rend une collecte interrompue reprenable — les données déjà lues
    sont côté application, pas dans le navigateur."""
    if request.method == 'OPTIONS':
        return _receive_cors_headers(current_app.make_response(('', 204)))

    def reject(message, code):
        return _receive_cors_headers(
            jsonify({'success': False, 'message': message})), code

    expected = get_settings_manager().get_app_settings().logs_receive_token
    token = request.headers.get('X-MyGCFlow-Token', '')
    if not expected or not secrets.compare_digest(token, expected):
        return reject(_("Jeton de réception invalide — régénérer le bookmarklet"), 403)

    run_id = request.headers.get('X-MyGCFlow-Run-Id', '')
    if not _RUN_ID_RE.match(run_id):
        return reject(_("Fragment sans identifiant de collecte valide"), 400)

    raw = request.get_data(cache=False)
    if not raw or len(raw) > GPX_MAX_SIZE_BYTES:
        return reject(_("Contenu absent ou trop volumineux"), 400)
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return reject(_("Fragment illisible (JSON attendu)"), 400)
    if (not isinstance(doc, dict)
            or doc.get("format") != lf.FORMAT_LOGS
            or doc.get("schema_version") != lf.LOGS_SCHEMA_VERSION
            or not isinstance(doc.get("logs"), list)
            or not isinstance(doc.get("caches"), list)):
        return reject(
            _("Fragment non conforme (export mygcflow-logs attendu)"), 400)

    final = request.headers.get('X-MyGCFlow-Final') == '1'
    if final and task_manager.get_active(TASK_TYPE_LOG_IMPORT) is not None:
        return reject(_("Un import de logs est déjà en cours"), 409)

    _purge_expired_pending()
    folder = _pending_root() / f"frag-{run_id}"
    with _FRAGMENT_LOCK:
        merged, error = _merge_fragment(folder, doc)
    if error:
        return reject(error, 409)
    if not final:
        return _receive_cors_headers(jsonify({
            'success': True, 'received': 'fragment',
            'logs': len(merged["logs"]),
            'caches': len(merged["caches"])})), 202

    # Scellement : le document fusionné reprend le parcours de /receive.
    payload = json.dumps(merged, ensure_ascii=False).encode("utf-8")
    parsed = lf.parse_logs_json(payload)
    if not parsed.ok:
        reasons = "; ".join(e["reason"] for e in parsed.errors[:3])
        return reject(
            _("Fichier refusé : %(reasons)s", reasons=reasons), 400)
    try:
        summary = log_store.preview_logs(db.session, parsed)
    except log_store.LogImportError as exc:
        return reject(str(exc), 409)
    finally:
        db.session.rollback()

    pending_token = _store_pending(
        payload, _("export du favori"), summary["collection_revision"],
        received=True, summary=_slim(summary))
    shutil.rmtree(folder, ignore_errors=True)
    return _receive_cors_headers(jsonify({
        'success': True,
        'message': _("Export reçu — validez l'aperçu dans l'application"),
        'import_token': pending_token})), 202


@logs_bp.route('/api/logs/receive/state', methods=['GET', 'OPTIONS'])
def logs_receive_state():
    """État lu par le favori avant de collecter (mêmes jeton + CORS que
    /receive ; une simple GET, donc rien à déclarer dans security.py — le
    contrôle inter-sites ne vise que les mutations).

    - `since` : horizon de connaissance = date du dernier export
      `mygcflow-logs` importé — le favori ne relit que les caches touchées
      depuis (collecte incrémentale). `null` → collecte complète ;
    - `pending` : un export précédent attend toujours sa validation — le
      favori le signale au lieu de repartir pour un tour ;
    - `logs_collect_full_once` (« forcer la prochaine collecte complète »)
      est consommé à la lecture : la requête suivante revoit `since`."""
    if request.method == 'OPTIONS':
        return _receive_cors_headers(current_app.make_response(('', 204)))

    expected = get_settings_manager().get_app_settings().logs_receive_token
    token = request.headers.get('X-MyGCFlow-Token', '')
    if not expected or not secrets.compare_digest(token, expected):
        return _receive_cors_headers(jsonify({
            'success': False,
            'message': _("Jeton de réception invalide — régénérer le bookmarklet")})), 403

    manager = get_settings_manager()
    full_once = manager.get_app_settings().logs_collect_full_once
    if full_once:
        from dataclasses import replace
        manager.update_app_settings(
            lambda s: replace(s, logs_collect_full_once=False))
    since = None if full_once else log_store.collection_since(db.session)
    pending = _received_pending()
    return _receive_cors_headers(jsonify({
        'success': True,
        'since': since.isoformat() if since else None,
        'pending': ({'name': pending['name'],
                     'received_at': pending['received_at']}
                    if pending else None),
    }))


# Favori « Envoyer vers MyGCFlow » (logs) : source JS lisible dans
# static/logs/, cœur de collecte inclus à son repère, comme pour les Labs.
_LOGS_JS_INCLUDE_MARKER = "// @include logs_collect_core.js"


def _logs_js_source(name: str) -> str:
    """Source `static/logs/<name>` avec le cœur partagé inclus à son repère."""
    folder = Path(current_app.static_folder) / "logs"
    source = (folder / name).read_text("utf-8")
    if source.count(_LOGS_JS_INCLUDE_MARKER) != 1:
        raise ValueError(f"{name} : repère d'inclusion absent ou répété")
    return source.replace(
        _LOGS_JS_INCLUDE_MARKER,
        (folder / "logs_collect_core.js").read_text("utf-8"))


def _single_line_js(source: str) -> str:
    """Met une source sur une ligne pour un lien `javascript:` (le navigateur
    y supprime les sauts de ligne : un commentaire `//` avalerait la suite).

    Volontairement naïf — lignes vides et lignes de commentaire retirées, le
    reste joint par une espace — d'où la contrainte d'écriture rappelée en
    tête des sources : commentaires en lignes entières, instructions
    terminées par un point-virgule, pas de chaîne multi-ligne. Même fonction
    côté Labs (blueprints/labs.py), dupliquée : chaque blueprint reste
    autonome."""
    lines = (line.strip() for line in source.splitlines())
    return " ".join(line for line in lines if line and not line.startswith("//"))


def _build_bookmarklet(origin: str, token: str) -> str:
    js = _single_line_js(_logs_js_source("logs_bookmarklet.src.js"))
    js = js.replace('__ORIGIN__', json.dumps(origin)) \
           .replace('__TOKEN__', json.dumps(token))
    for key, text in _bookmarklet_strings().items():
        js = js.replace(key, json.dumps(text))
    return "javascript:" + js


def _bookmarklet_strings():
    # Messages du favori, évalués à la requête : il s'affiche sur
    # geocaching.com, hors portée des catalogues JS du client — la
    # traduction se fait côté serveur, dans la langue de l'interface.
    # ${a}/${b}/${c} sont remplacés par le favori (compte, compteurs, code).
    return {
        '__T_START__': _("MyGCFlow : démarrage…"),
        '__T_ACCOUNT__': _("MyGCFlow : compte ${a} — lecture des listes…"),
        '__T_DNF__': _("MyGCFlow : ${a} cache(s) avec un DNF à relire…"),
        '__T_OWNED__': _("MyGCFlow : ${a} cache(s) posée(s) à relire…"),
        '__T_PLAN__': _("MyGCFlow : ${a} caches à lire (~${b} min)…"),
        '__T_CACHE__': _("MyGCFlow : cache ${a}/${b} — ${c}"),
        '__T_STOPPED__': _("MyGCFlow : arrêt après ${a}/${b} caches — envoi de ce qui a été lu…"),
        '__T_SENDING__': _("MyGCFlow : envoi à l'application…"),
        '__T_SENT__': _("✔ ${a} logs, ${b} caches envoyés à MyGCFlow"),
        '__T_ORDER__': _("MyGCFlow : ordre des dates indéterminé (${a}). Appelez mygcflowLogsFinish('DMY') ou mygcflowLogsFinish('MDY') dans la console."),
        '__T_ERROR__': _("MyGCFlow : erreur"),
        '__T_PREFIX__': _("MyGCFlow :"),
        '__T_WRONGSITE__': _("à lancer depuis une page de geocaching.com"),
        '__T_SINCE__': _("MyGCFlow : nouveautés depuis le ${a} seulement…"),
        '__T_PENDINGASK__': _("Un export attend déjà sa validation dans l'application — collecter quand même ?"),
        '__T_PENDINGSTOP__': _("Collecte annulée — ouvrez l'application pour valider l'aperçu en attente."),
        '__T_BADTOKEN__': _("jeton refusé — régénérez le favori dans l'application"),
        '__T_RESUMEASK__': _("Une collecte interrompue existe (${a}/${b} caches déjà lues) — reprendre là où elle s'était arrêtée ?"),
        '__T_RESUME__': _("MyGCFlow : reprise — ${a}/${b} caches déjà lues, on continue…"),
    }


@logs_bp.route('/api/logs/bookmarklet')
def logs_bookmarklet():
    """Renvoie le lien `javascript:` à glisser dans les favoris.

    Le jeton de réception est généré à la première demande et persiste dans
    les réglages : c'est un identifiant d'installation, révocable en le
    régénérant (le favori existant devient alors invalide)."""
    def ensure_token(s):
        if s.logs_receive_token:
            return s
        from dataclasses import replace
        return replace(s, logs_receive_token=secrets.token_urlsafe(24))

    settings = get_settings_manager().update_app_settings(ensure_token)
    origin = request.host_url.rstrip('/')
    js = _build_bookmarklet(origin, settings.logs_receive_token)
    return jsonify({'success': True, 'origin': origin, 'bookmarklet': js})


@logs_bp.route('/api/logs/bookmarklet/full-next', methods=['POST'])
def logs_bookmarklet_full_next():
    """Arme « la prochaine collecte sera complète » : l'incrémental ne
    détecte ni les logs anciens supprimés ni les retards d'une fenêtre,
    l'utilisateur doit pouvoir repartir d'un tour complet sans régénérer
    le favori. Le drapeau est consommé par /api/logs/receive/state."""
    from dataclasses import replace
    get_settings_manager().update_app_settings(
        lambda s: replace(s, logs_collect_full_once=True))
    return jsonify({'success': True})


@logs_bp.route('/api/logs/bookmarklet/regenerate', methods=['POST'])
def logs_bookmarklet_regenerate():
    """Remplace le jeton de réception et renvoie le favori régénéré.

    L'ancien `javascript:` devient immédiatement invalide côté /receive :
    l'interface le présente comme action destructive (options avancées) et
    recharge le lien à glisser avec cette réponse."""
    from dataclasses import replace
    settings = get_settings_manager().update_app_settings(
        lambda s: replace(s, logs_receive_token=secrets.token_urlsafe(24)))
    origin = request.host_url.rstrip('/')
    js = _build_bookmarklet(origin, settings.logs_receive_token)
    return jsonify({'success': True, 'origin': origin, 'bookmarklet': js})
