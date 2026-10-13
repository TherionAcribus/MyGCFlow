"""API locale Adventure Lab — preview/commit d'imports, statut, corrections.

Fichiers acceptés (détection sur le contenu, pas l'extension) :

- `mygcflow-lab-finds` v1 (JSON historique `labs.geocaching.com/logs`) ;
- GPX Lab2Gpx « un waypoint par étape » (coordonnées + flags Found).

Le commit ne reçoit jamais les enregistrements : `preview` enregistre les
fichiers validés dans un dossier temporaire indexé par un jeton opaque
(TTL, taille bornée, consommé une fois). La tâche d'import relit ces
fichiers, reparse puis applique les upserts — les diffs sont donc toujours
recalculés sur l'état courant de la base (révision vérifiée, avertissement
si elle a bougé depuis l'aperçu). Le commit ne transmet que le jeton et les
conflits que l'utilisateur tranche pour la valeur reçue (`overrides`).
"""

from __future__ import annotations

import http.client
import io
import json
import secrets
import shutil
import tempfile
import uuid
import zipfile
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request
from flask_babel import force_locale, gettext as _

import lab_coords_provider
import lab_formats as lf
import lab_store
import paths
from bdd import geojson_cache
from extensions import db
from localization import get_locale
from models import LabDiscovery
from settings_manager import get_settings_manager
from task_manager import TaskAlreadyRunning, task_manager

labs_bp = Blueprint('labs', __name__)

TASK_TYPE_LAB_IMPORT = "lab_import"
TASK_TYPE_LAB_FETCH = "lab_fetch_coords"

# Une étape pour laquelle lab2gpx n'a rien donné (Adventure archivée ou
# cassée, étape absente de la réponse) n'est pas redemandée par l'auto-fetch
# avant ce délai — sinon chaque import rejouerait la même bissection — et
# l'interface cesse de proposer la récupération tant qu'il ne reste qu'elles.
# La relance explicite (options avancées), elle, retente tout.
FETCH_RETRY_AFTER_DAYS = 30

# Seule origine autorisée à poster sur /api/labs/receive (le bookmarklet
# s'exécute sur la page /logs). Toute autre page web ne peut pas nous atteindre
# en CORS ; le jeton couvre les clients sans CORS (curl & co).
LABS_ORIGIN = "https://labs.geocaching.com"

# Jetons d'import en attente : dossier temporaire dédié, TTL court.
PENDING_TTL_SECONDS = 30 * 60
MAX_LAB_FILE_BYTES = 64 * 1024 * 1024       # loin au-dessus des exports réels
MAX_LAB_FILES = 64                           # les exports Lab2Gpx sont batchés
MAX_DETAIL_ITEMS = 100                       # bornage des diagnostics renvoyés
MAX_OVERRIDES = 1000                         # choix « remplacer » par commit
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


class ArchiveTooLarge(ValueError):
    """Zip dont les GPX dépassent, décompressés, les bornes d'un import."""


def _zip_gpx_members(raw: bytes) -> list[tuple[str, bytes]]:
    """Tous les .gpx d'un zip Lab2Gpx, dans l'ordre de l'archive : (nom, contenu).

    Liste vide si l'archive est illisible ou n'en contient aucun. Les bornes
    portent sur les tailles réellement décompressées, pas sur celles que
    l'archive déclare — ArchiveTooLarge au-delà."""
    members, total = [], 0
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for info in zf.infolist():
                if info.is_dir() or not info.filename.lower().endswith('.gpx') \
                        or info.filename.startswith('__MACOSX/'):
                    continue
                if len(members) >= MAX_LAB_FILES:
                    raise ArchiveTooLarge(info.filename)
                with zf.open(info) as fh:
                    data = fh.read(MAX_LAB_FILE_BYTES - total + 1)
                total += len(data)
                if total > MAX_LAB_FILE_BYTES:
                    raise ArchiveTooLarge(info.filename)
                members.append((info.filename, data))
    except zipfile.BadZipFile:
        return []
    return members


def _store_pending(files: list[dict]) -> tuple[str, Path]:
    """Persiste les fichiers validés + manifest ; retourne (jeton, dossier)."""
    token = uuid.uuid4().hex
    # Historique de trouvailles : données personnelles, dossiers privés
    # (le mode est ignoré sous Windows).
    PENDING_ROOT.mkdir(mode=0o700, exist_ok=True)
    folder = PENDING_ROOT / token
    folder.mkdir(mode=0o700, exist_ok=True)
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
    """Charge un manifest valide : (manifest, dossier, message d'erreur)."""
    if not token or not token.isalnum():
        return None, None, _("Jeton d'import invalide")
    folder = PENDING_ROOT / token
    manifest_path = folder / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text("utf-8"))
    except Exception:
        return None, None, _("Jeton d'import inconnu ou déjà consommé")
    if manifest.get("_consumed"):
        return None, None, _("Jeton d'import déjà consommé")
    try:
        created = datetime.fromisoformat(manifest["created_at"])
    except Exception:
        return None, None, _("Jeton d'import illisible")
    if datetime.now(timezone.utc) - created > timedelta(seconds=PENDING_TTL_SECONDS):
        shutil.rmtree(folder, ignore_errors=True)
        return None, None, _("Jeton d'import expiré — relancer l'aperçu")
    return manifest, folder, None


def _clean_overrides(raw) -> list:
    """Choix « remplacer » reçus du client, réduits aux entrées bien formées
    (stockables telles quelles dans le manifest)."""
    kept = []
    for item in (raw if isinstance(raw, list) else [])[:MAX_OVERRIDES]:
        if not isinstance(item, dict):
            continue
        uid, field, incoming = (item.get(k) for k in ("local_uid", "field", "incoming"))
        if not isinstance(uid, str) or field not in lab_store.OVERRIDABLE_FIELDS:
            continue
        try:
            lab_store.override_key(uid, field, incoming)
        except (TypeError, ValueError):
            continue
        kept.append({"local_uid": uid, "field": field, "incoming": incoming})
    return kept


def _override_keys(items) -> frozenset:
    return frozenset(
        lab_store.override_key(o["local_uid"], o["field"], o["incoming"])
        for o in _clean_overrides(items))


def _submit_import(folder: Path, manifest: dict):
    """Consomme le jeton puis lance la tâche d'import des fichiers en attente.

    Le jeton est consommé dès la soumission : un second commit avec le même
    jeton échouera, même si la tâche plante ensuite. Si une tâche tourne
    déjà, le dossier est supprimé et TaskAlreadyRunning remonte."""
    manifest["_consumed"] = True
    try:
        (folder / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False), "utf-8")
    except OSError:
        pass
    try:
        return task_manager.submit(
            TASK_TYPE_LAB_IMPORT, run_lab_import_task,
            current_app._get_current_object(), str(folder),
            manifest.get("collection_revision"), get_locale(), exclusive=True)
    except TaskAlreadyRunning:
        shutil.rmtree(folder, ignore_errors=True)
        raise


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
                    overrides = _override_keys(manifest.get("overrides"))
                    n = len(files)
                    # Lecture et analyse de tout le lot d'abord : le commit
                    # applique ensuite l'ensemble en UNE transaction — tout
                    # ou rien, l'atomicité promise par l'aperçu.
                    batch = []
                    for i, entry in enumerate(files):
                        status.set_progress(
                            int(90 * i / max(n, 1)),
                            _("Import Labs : %(name)s", name=entry["name"]))
                        raw = (folder / entry["stored"]).read_bytes()
                        batch.append((entry["format"],
                                      _PARSE_BY_FORMAT[entry["format"]](raw)))

                    summaries = lab_store.commit_import_batch(
                        db.session, batch, overrides=overrides)
                    for entry, summary in zip(files, summaries):
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
                            "reason": _("la collection a été modifiée entre l'aperçu et "
                                        "l'enregistrement — diff recalculé sur l'état courant")})
                    status.set_progress(98, _("Import Labs : finalisation"))
                    _invalidate_after_mutation("labs_import")
                    stats = lab_store.collection_status(db.session)
                    # La récupération des coordonnées est lancée AVANT de
                    # publier le bilan, qui en porte l'identifiant : l'interface
                    # enchaîne ainsi son suivi sans trou, au lieu de croire
                    # l'opération terminée. Elle a sa propre tâche/session, et
                    # un lancement impossible n'invalide pas l'import réussi
                    # (_maybe_autofetch ne lève jamais).
                    fetch_task_id = _maybe_autofetch(app, locale)
                    status.set_result({
                        "success": True,
                        **totals,
                        "total": stats["total"],
                        "ready_total": stats["ready"],
                        "unresolved": stats["unresolved"],
                        "files": results,
                        "warnings": _cap_items(warnings),
                        "fetch_task_id": fetch_task_id,
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
# Récupération des coordonnées via lab2gpx (fournisseur fichier → réseau)
# ---------------------------------------------------------------------------

def _unresolved_coord_query(session, skip_recent_failures=False):
    """Requête `distinct` des UUID d'Adventures ayant au moins une
    découverte sans coordonnées — None sans collection.

    `skip_recent_failures` écarte les étapes dont l'Adventure a déjà été
    refusée par lab2gpx depuis moins de FETCH_RETRY_AFTER_DAYS."""
    collection = lab_store.get_collection(session)
    if collection is None:
        return None
    query = session.query(LabDiscovery.adventure_uuid).filter(
        LabDiscovery.collection_id == collection.id,
        LabDiscovery.adventure_uuid.isnot(None),
        LabDiscovery.coords_missing_clause(),
    )
    if skip_recent_failures:
        cutoff = lab_store._utcnow() - timedelta(days=FETCH_RETRY_AFTER_DAYS)
        query = query.filter(
            LabDiscovery.coord_fetch_failed_at.is_(None)
            | (LabDiscovery.coord_fetch_failed_at < cutoff))
    return query.distinct()


def _unresolved_coord_uuids(session, skip_recent_failures=False) -> list[str]:
    """UUID d'Adventures ayant au moins une découverte sans coordonnées."""
    query = _unresolved_coord_query(session, skip_recent_failures)
    return [r[0] for r in query.all()] if query is not None else []


def run_lab_fetch_task(status, app, uuids, user_guid, locale=None):
    """Télécharge les GPX lab2gpx par lots puis enrichit les découvertes
    (même chemin `commit_coordinates` que l'import GPX manuel)."""
    with app.app_context():
        ctx = force_locale(locale) if locale else nullcontext()
        with ctx:
            try:
                total = len(uuids)
                totals = {"resolved": 0, "ignored": 0, "updated": 0,
                          "unchanged": 0, "conflicts": 0}
                warnings = []
                committed = 0

                def progress(done, _total):
                    status.set_progress(
                        int(95 * done / max(_total, 1)),
                        _("Coordonnées Labs : %(done)s/%(total)s Adventures",
                          done=done, total=_total))

                def enrich(_name, raw):
                    # Enrichissement lot par lot : un abandon ultérieur du
                    # service ne perd pas ce qui est déjà téléchargé.
                    nonlocal committed
                    parsed = lf.parse_lab2gpx_gpx(raw)
                    summary = lab_store.commit_coordinates(db.session, parsed)
                    committed += 1
                    for k in totals:
                        totals[k] += int(summary.get(k, 0))
                    warnings.extend(summary.get("warnings", []))

                # Un échec isolé n'est retenu qu'une fois suivi d'un lot
                # réussi (ou de la fin normale) : ceux qui précèdent un
                # abandon sont plus probablement la panne que la donnée.
                failed_uuids, unconfirmed = [], []

                def confirm_failures():
                    failed_uuids.extend(unconfirmed)
                    unconfirmed.clear()

                # Adventures auxquelles le service a répondu : leurs étapes
                # encore sans position après coup ne sont pas dans sa réponse
                # (étape remaniée) — une nouvelle demande ne les donnerait pas.
                answered = []

                def on_payload(name, raw, batch):
                    enrich(name, raw)
                    answered.extend(batch)
                    confirm_failures()

                interrupted = None
                fetched = None
                try:
                    result = lab_coords_provider.fetch_gpx_batches(
                        uuids, user_guid=user_guid, progress=progress,
                        on_payload=on_payload,
                        on_failed=unconfirmed.append)
                    confirm_failures()
                    fetched = result.fetched_adventures
                except (OSError, http.client.HTTPException) as exc:
                    # Panne réseau/service : sans aucun lot enregistré,
                    # c'est un échec ; sinon un bilan partiel, relançable.
                    if not committed:
                        raise
                    interrupted = str(exc)
                finally:
                    if committed:
                        _invalidate_after_mutation("labs_fetch_coords")
                lab_store.mark_coords_fetch_failed(
                    db.session, failed_uuids + answered)

                stats = lab_store.collection_status(db.session)
                status.set_result({
                    "success": True,
                    "interrupted": interrupted is not None,
                    "error": interrupted,
                    "adventures_requested": total,
                    "adventures_fetched": fetched,
                    "failed_uuids": _cap_items(failed_uuids),
                    **totals,
                    "ready_total": stats["ready"],
                    "unresolved": stats["unresolved"],
                    "warnings": _cap_items(warnings),
                })
            except Exception as exc:  # noqa: BLE001 — échec visible en tâche
                db.session.rollback()
                status.fail(exc)


def _maybe_autofetch(app_obj, locale=None) -> str | None:
    """Enchaîne la récupération lab2gpx après un import si l'opt-in est actif
    et qu'il reste des coordonnées à résoudre. Renvoie l'id de tâche ou None."""
    try:
        if not get_settings_manager().get_app_settings().labs_auto_fetch_coords:
            return None
        with app_obj.app_context():
            uuids = _unresolved_coord_uuids(
                db.session, skip_recent_failures=True)
        if not uuids:
            return None
        task_status = task_manager.submit(
            TASK_TYPE_LAB_FETCH, run_lab_fetch_task,
            app_obj, uuids, None, locale, exclusive=True)
        return task_status.id
    except TaskAlreadyRunning:
        return None
    except Exception as exc:  # noqa: BLE001 — l'import reste valable sans fetch
        app_obj.logger.warning(f"[LABS] auto-fetch non lancé : {exc}")
        return None


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
    entries = []        # (nom affiché, contenu) — un zip en fournit plusieurs

    def too_large(name):
        file_reports.append({"name": name, "format": None, "status": "error",
                             "error": _("Fichier trop volumineux")})

    for up in uploads:
        name = up.filename or "fichier"
        raw = up.read(MAX_LAB_FILE_BYTES + 1)
        if len(raw) > MAX_LAB_FILE_BYTES:
            too_large(name)
            continue
        if lf.detect_lab_file_format(raw) is None and zipfile.is_zipfile(io.BytesIO(raw)):
            try:
                members = _zip_gpx_members(raw)
            except ArchiveTooLarge:
                too_large(name)
                continue
            if len(members) == 1:
                entries.append((name, members[0][1]))
                continue
            if members:
                # Chaque GPX de l'archive est un fichier du lot à part entière.
                entries.extend((f"{name} › {inner}", data) for inner, data in members)
                continue
        entries.append((name, raw))

    if len(entries) > MAX_LAB_FILES:
        return jsonify({'success': False,
                        'message': _("Trop de fichiers (maximum %(max)s)", max=MAX_LAB_FILES)}), 400

    for name, raw in entries:
        report = {"name": name, "format": None, "status": "error"}
        fmt = lf.detect_lab_file_format(raw)
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
    # Sous le verrou des mutations, rollback compris : l'aperçu écrit pour de
    # bon dans sa transaction et croiserait sinon un import ou une
    # récupération en cours (« database is locked »).
    parsed_files.sort(key=lambda f: _FORMAT_ORDER[f["format"]])
    totals = {"added": 0, "updated": 0, "unchanged": 0, "resolved": 0,
              "ignored": 0, "rejected": 0, "conflicts": 0}
    warnings, conflicts_detail, proposals = [], [], []
    with lab_store.LAB_MUTATION_LOCK:
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
    body = request.get_json(silent=True) or {}
    token = body.get("import_token") or request.form.get("import_token")
    manifest, folder, error = _load_pending(token)
    if error:
        return jsonify({'success': False, 'message': error}), 400

    # Refus avant de consommer le jeton : l'utilisateur garde la main.
    if task_manager.get_active(TASK_TYPE_LAB_IMPORT) is not None:
        return jsonify({'success': False,
                        'message': _("Un import Labs est déjà en cours")}), 409

    manifest["overrides"] = _clean_overrides(body.get("overrides"))
    try:
        task_status = _submit_import(folder, manifest)
    except TaskAlreadyRunning as e:
        return jsonify({'success': False, 'message': str(e)}), 409

    return jsonify({
        'success': True,
        'message': _("Import Labs lancé en tâche de fond"),
        'task_id': task_status.id,
        'state': task_status.state,
    }), 202


@labs_bp.route('/api/labs/status')
def labs_status():
    payload = {'success': True, **lab_store.collection_status(db.session)}
    # Adventures pour lesquelles une récupération a encore un sens : celles
    # déjà tentées sans résultat récemment n'en font pas partie, et
    # l'interface ne propose le bouton que s'il en reste. COUNT DISTINCT en
    # SQL : l'interface sonde ce endpoint en boucle, rien n'est chargé.
    query = _unresolved_coord_query(db.session, skip_recent_failures=True)
    payload['fetchable_adventures'] = query.count() if query is not None else 0
    # Un import peut être lancé hors de cet onglet (favori → /api/labs/
    # receive) : exposer la tâche en cours pour que l'UI la suive et
    # recharge la carte à sa fin.
    active = task_manager.get_active(TASK_TYPE_LAB_IMPORT) \
        or task_manager.get_active(TASK_TYPE_LAB_FETCH)
    if active is not None:
        payload['active_task'] = active.to_dict()
    return jsonify(payload)


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

    # Tout est validé avant de toucher la ligne : une date invalide ne laisse
    # pas des coordonnées à moitié appliquées dans la session.
    cc = pd = None
    if has_coords:
        cc = lf.validate_coordinates(body.get("latitude"), body.get("longitude"))
        if not cc.ok:
            return jsonify({'success': False,
                            'message': _("Coordonnées invalides"),
                            'warnings': cc.warnings}), 400
    if has_date:
        pd = lf.parse_lab_datetime(body.get("found_date"))
        if pd.found_date is None:
            return jsonify({'success': False,
                            'message': _("Date invalide (format attendu : AAAA-MM-JJ)")}), 400

    # Lecture comprise sous le verrou : la ligne modifiée est celle que
    # laisse l'import ou la récupération qui vient de s'achever.
    with lab_store.LAB_MUTATION_LOCK:
        collection = lab_store.get_collection(db.session)
        row = None
        if collection:
            row = db.session.query(LabDiscovery).filter_by(
                collection_id=collection.id, local_uid=local_uid).one_or_none()
        if row is None:
            db.session.rollback()
            return jsonify({'success': False, 'message': _("Découverte inconnue")}), 404

        if has_coords:
            row.latitude, row.longitude = cc.latitude, cc.longitude
            row.coordinate_scope = "stage"
            row.coordinate_source = lab_store.USER_CORRECTION
            row.coordinate_status = LabDiscovery.COORD_RESOLVED
            row.coord_fetch_failed_at = None
            row.suggested_latitude = row.suggested_longitude = None
        if has_date:
            row.found_date = pd.found_date
            row.date_precision = "day"
            row.date_basis = lab_store.USER_CORRECTION
            # L'instant et le texte source décrivaient l'ancienne date : le
            # texte doit décrire la nouvelle pour que l'export réémette une
            # valeur cohérente, l'instant précis n'a plus lieu d'être.
            row.source_date_text = pd.found_date.isoformat()
            row.found_at_utc = None
            row.found_at_offset_minutes = None
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
    # Un « Vider » entre deux fichiers d'un import (ou deux lots d'un fetch)
    # supprimerait la collection que le lot suivant recrée à moitié.
    if task_manager.get_active(TASK_TYPE_LAB_IMPORT) is not None \
            or task_manager.get_active(TASK_TYPE_LAB_FETCH) is not None:
        return jsonify({'success': False,
                        'message': _("Une opération Labs est déjà en cours")}), 409
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
        # Correction manuelle : le texte source peut décrire l'ancienne date
        # (lignes corrigées avant ce fix) — réémettre la date corrigée,
        # sinon le réimport ferait gagner l'ancien instant.
        "found_at": (r.found_date.isoformat() if r.found_date else None)
        if r.date_basis == lab_store.USER_CORRECTION else r.source_date_text,
        "date_precision": r.date_precision,
        "date_basis": r.date_basis,
        "latitude": r.latitude,
        "longitude": r.longitude,
        "coordinate_scope": r.coordinate_scope,
        "coordinate_source": r.coordinate_source,
        "owner": r.owner,
        "published_date": r.published_date.isoformat() if r.published_date else None,
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


# ---------------------------------------------------------------------------
# Récupération des coordonnées (opt-in) + réception directe bookmarklet
# ---------------------------------------------------------------------------

@labs_bp.route('/api/labs/fetch-coordinates', methods=['POST'])
def labs_fetch_coordinates():
    """Lance la récupération lab2gpx des coordonnées manquantes (opt-in UI)."""
    uuids = _unresolved_coord_uuids(db.session)
    if not uuids:
        return jsonify({'success': False,
                        'message': _("Aucune étape en attente de coordonnées")}), 400
    if task_manager.get_active(TASK_TYPE_LAB_IMPORT) is not None \
            or task_manager.get_active(TASK_TYPE_LAB_FETCH) is not None:
        return jsonify({'success': False,
                        'message': _("Une opération Labs est déjà en cours")}), 409
    data = request.get_json(silent=True) or {}
    user_guid = data.get("user_guid") or None
    app_obj = current_app._get_current_object()
    try:
        task_status = task_manager.submit(
            TASK_TYPE_LAB_FETCH, run_lab_fetch_task,
            app_obj, uuids, user_guid, get_locale(), exclusive=True)
    except TaskAlreadyRunning as e:
        return jsonify({'success': False, 'message': str(e)}), 409
    return jsonify({'success': True,
                    'message': _("Récupération des coordonnées lancée"),
                    'task_id': task_status.id,
                    'adventures': len(uuids)}), 202


def _receive_cors_headers(resp):
    """CORS + Private-Network-Access restreints à labs.geocaching.com.

    Le bookmarklet poste depuis https://labs.geocaching.com vers
    http://127.0.0.1 — Chrome exige une preflight PNA. Toute autre origine
    ne reçoit aucun en-tête : le navigateur bloque la requête."""
    if request.headers.get("Origin") == LABS_ORIGIN:
        resp.headers["Access-Control-Allow-Origin"] = LABS_ORIGIN
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = \
            "Content-Type, X-MyGCFlow-Token"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        resp.headers["Access-Control-Max-Age"] = "600"
        resp.headers["Vary"] = "Origin"
    return resp


@labs_bp.route('/api/labs/receive', methods=['POST', 'OPTIONS'])
def labs_receive():
    """Réception directe d'un export « mygcflow-lab-finds » depuis le
    bookmarklet exécuté sur labs.geocaching.com/logs.

    Double protection : jeton local (anti-CSRF, généré par installation) et
    CORS limité à l'origine officielle. Le payload est stocké puis importé
    par la tâche habituelle — l'auto-fetch enchaîne si l'opt-in est actif."""
    if request.method == 'OPTIONS':
        return _receive_cors_headers(current_app.make_response(('', 204)))

    def reject(message, code):
        return _receive_cors_headers(
            jsonify({'success': False, 'message': message})), code

    expected = get_settings_manager().get_app_settings().labs_receive_token
    token = request.headers.get('X-MyGCFlow-Token', '')
    if not expected or not secrets.compare_digest(token, expected):
        return reject(
            _("Jeton de réception invalide — régénérer le bookmarklet"), 403)

    raw = request.get_data(cache=False)
    if not raw or len(raw) > MAX_LAB_FILE_BYTES:
        return reject(_("Contenu absent ou trop volumineux"), 400)
    fmt = lf.detect_lab_file_format(raw)
    if fmt is None:
        return reject(_("Format non reconnu (export mygcflow-lab-finds attendu)"), 400)

    if task_manager.get_active(TASK_TYPE_LAB_IMPORT) is not None \
            or task_manager.get_active(TASK_TYPE_LAB_FETCH) is not None:
        return reject(_("Une opération Labs est déjà en cours"), 409)

    _purge_expired_pending()
    _token, folder = _store_pending(
        [{"name": "bookmarklet-lab-finds.json", "format": fmt, "raw": raw}])
    manifest = json.loads((folder / "manifest.json").read_text("utf-8"))
    try:
        task_status = _submit_import(folder, manifest)
    except TaskAlreadyRunning as e:
        return reject(str(e), 409)

    resp = jsonify({'success': True,
                    'message': _("Historique Labs reçu — import lancé"),
                    'task_id': task_status.id})
    return _receive_cors_headers(resp), 202


# Favori « Envoyer vers MyGCFlow » et script d'export manuel : sources JS
# lisibles dans static/labs/, assemblées à la demande. Les deux incluent
# lab_logs_core.js — seule copie de la boucle de pagination de /logs.
_JS_INCLUDE_MARKER = "// @include lab_logs_core.js"


def _labs_js_source(name: str) -> str:
    """Source `static/labs/<name>` avec le cœur partagé inclus à son repère."""
    folder = Path(current_app.static_folder) / "labs"
    source = (folder / name).read_text("utf-8")
    if source.count(_JS_INCLUDE_MARKER) != 1:
        raise ValueError(f"{name} : repère d'inclusion absent ou répété")
    return source.replace(
        _JS_INCLUDE_MARKER, (folder / "lab_logs_core.js").read_text("utf-8"))


def _single_line_js(source: str) -> str:
    """Met une source sur une ligne pour un lien `javascript:` (le navigateur
    y supprime les sauts de ligne : un commentaire `//` avalerait la suite).

    Volontairement naïf — lignes vides et lignes de commentaire retirées, le
    reste joint par une espace — d'où la contrainte d'écriture rappelée en
    tête des sources : commentaires en lignes entières, instructions
    terminées par un point-virgule, pas de chaîne multi-ligne."""
    lines = (line.strip() for line in source.splitlines())
    return " ".join(line for line in lines if line and not line.startswith("//"))


def _build_bookmarklet(origin: str, token: str) -> str:
    js = _single_line_js(_labs_js_source("bookmarklet.src.js"))
    js = js.replace('__ORIGIN__', json.dumps(origin)) \
           .replace('__TOKEN__', json.dumps(token))
    for key, text in _bookmarklet_strings().items():
        js = js.replace(key, json.dumps(text))
    return "javascript:" + js


def _bookmarklet_strings():
    # Messages du bookmarklet, évalués à la requête : le favori s'affiche sur
    # labs.geocaching.com, hors portée des catalogues JS du client — la
    # traduction se fait côté serveur, dans la langue de l'interface.
    return {
        '__T_START__': _("MyGCFlow : démarrage…"),
        '__T_PROMPT__': _("MyGCFlow — GUID public du joueur :"),
        '__T_CANCELLED__': _("Annulé."),
        '__T_GUIDBAD__': _("GUID refusé par le site."),
        '__T_PROGRESS__': _("MyGCFlow : ${adv} Adventures, ${disc} étapes…"),
        '__T_SENDING__': _("MyGCFlow : envoi à l'application…"),
        '__T_SCROLL__': _("MyGCFlow : faites défiler un peu votre historique "
                          "pour détecter votre compte…"),
        '__T_SENT__': _("✔ Envoyé à MyGCFlow — import en cours "
                        "(${adv} Adventures, ${disc} étapes)"),
        '__T_ERROR__': _("MyGCFlow : erreur"),
        '__T_PREFIX__': _("MyGCFlow :"),
    }


@labs_bp.route('/api/labs/bookmarklet')
def labs_bookmarklet():
    """Renvoie le lien `javascript:` à glisser dans les favoris.

    Le jeton de réception est généré à la première demande et persiste dans
    les réglages : c'est un identifiant d'installation, révocable en le
    régénérant (le favori existant devient alors invalide)."""
    def ensure_token(s):
        if s.labs_receive_token:
            return s
        from dataclasses import replace
        return replace(s, labs_receive_token=secrets.token_urlsafe(24))

    settings = get_settings_manager().update_app_settings(ensure_token)
    origin = request.host_url.rstrip('/')
    js = _build_bookmarklet(origin, settings.labs_receive_token)
    return jsonify({'success': True, 'origin': origin, 'bookmarklet': js})


@labs_bp.route('/api/labs/export-script')
def labs_export_script():
    """Script d'export manuel à coller dans la console de /logs — laissé
    lisible : l'utilisateur doit y renseigner son GUID joueur."""
    response = current_app.response_class(
        _labs_js_source("export_lab_logs.src.js"),
        mimetype='text/javascript')
    response.headers['Content-Disposition'] = \
        'attachment; filename="export_lab_logs.js"'
    return response