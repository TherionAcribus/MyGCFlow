import json
import os
import shutil
import tempfile
import uuid
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request
from flask_babel import gettext as _

import paths
from bdd import (
    TASK_TYPE_IMPORT, NS_GPX, analyse, db_infos, extract_gpx_from_zip,
    get_child_text_anyns, get_progress_step, run_import_task,
    validate_gpx_header, geojson_cache,
)
from extensions import db
from localization import get_locale
from models import Geocache
from task_manager import TaskAlreadyRunning, task_manager

gpx_bp = Blueprint('gpx', __name__)

# ---------------------------------------------------------------------------
# Aperçu diff d'un réimport « Mes Géocaches » (preview + commit)
#
# Quand la base est déjà chargée, un upload /upload la remplace intégralement
# (DELETE complet dans bdd.uploadBdd) : l'interface montre d'abord un diff
# (« +12 nouvelles, 0 retirée, 127 inchangées ») — même pattern que les Labs
# (blueprints/labs.py) et les logs (blueprints/gc_logs.py). /preview parse le
# fichier en version légère (codes GC seulement), le conserve sous un jeton
# opaque à durée limitée dans un dossier dédié sous les données (PAS %TEMP%,
# partagé entre app, pytest et harnais e2e — piège AGENTS.md), et /commit
# lance exactement la même tâche de fond que /upload.
# ---------------------------------------------------------------------------

PENDING_TTL_SECONDS = 30 * 60
REMOVED_SAMPLE_SIZE = 10
# Redirigé par les tests ; sinon _pending_root() (sous les données).
PENDING_ROOT: Path | None = None


def _pending_root() -> Path:
    """Dossier des jetons d'aperçu GPX, sous les données."""
    return PENDING_ROOT or (paths.data_dir() / "pending_gpx_imports")


def _purge_expired_pending():
    """Ménage opportuniste des jetons expirés. Un dossier consommé (`-taken`)
    appartient à sa tâche, qui supprime le fichier GPX ; le reliquat (manifest)
    est balayé passé un jour (tâche interrompue par un arrêt brutal)."""
    now = datetime.now(timezone.utc)
    try:
        children = list(_pending_root().iterdir())
    except FileNotFoundError:
        return
    for child in children:
        ttl = timedelta(days=1) if child.name.endswith("-taken") \
            else timedelta(seconds=PENDING_TTL_SECONDS)
        try:
            created = datetime.fromisoformat(
                json.loads((child / "manifest.json").read_text("utf-8"))["created_at"])
        except Exception:
            created = None
        if created is None or now - created > ttl:
            shutil.rmtree(child, ignore_errors=True)


def _store_pending(gpx_path: str, name: str) -> str:
    """Déplace le GPX extrait sous un dossier de jeton ; retourne le jeton."""
    token = uuid.uuid4().hex
    # Données personnelles : dossiers privés (le mode est ignoré sous Windows).
    _pending_root().mkdir(mode=0o700, exist_ok=True)
    folder = _pending_root() / token
    folder.mkdir(mode=0o700)
    shutil.move(gpx_path, folder / "import.gpx")
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "name": name,
    }
    (folder / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), "utf-8")
    return token


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


def _scan_gpx_for_preview(file_path: str) -> list[str]:
    """Codes GC des <wpt>, en une seule passe iterparse légère.

    Même structure que la passe 1 d'uploadBdd (bdd.py) : l'en-tête
    (<name>/<desc>/<author>) est lu jusqu'à l'OUVERTURE du premier <wpt> —
    chaque waypoint a lui-même un enfant <name> (le code GC) dont l'évènement
    'end' précéderait celui de son parent et écraserait sinon le titre du
    fichier — puis validé via validate_gpx_header : un fichier non « My
    Finds » reçoit le même rejet qu'un import direct.

    Le code est extrait à la fermeture du <wpt> via get_child_text_anyns —
    élément <name> du namespace GPX, enfant DIRECT du waypoint : le
    <groundspeak:name> du <groundspeak:cache> est un descendant plus profond
    et n'est pas candidat (même lecture qu'uploadBdd pour `gc_code`). Les
    éléments non-<wpt> ne sont jamais clear()és : les évènements 'end' des
    enfants précèdent celui de leur parent, les vider effacerait <name>
    avant sa lecture — le DOM du waypoint n'est libéré qu'à sa fermeture.

    Raises:
        ValueError: message traduit — en-tête non « My Finds » ou aucun
            waypoint.
        ET.ParseError: XML illisible.
    """
    header = {}
    validated = False
    header_closed = False
    wpt_tag = NS_GPX + 'wpt'
    codes = []
    for event, elem in ET.iterparse(file_path, events=('start', 'end')):
        if event == 'start':
            if elem.tag == wpt_tag:
                header_closed = True
            continue
        if not header_closed:
            if elem.tag == NS_GPX + 'name':
                header['name'] = elem.text
            elif elem.tag == NS_GPX + 'desc':
                header['desc'] = elem.text
            elif elem.tag == NS_GPX + 'author':
                header['author'] = elem.text
        if elem.tag != wpt_tag:
            continue
        if not validated:
            # Premier waypoint entièrement lu : l'en-tête est complet.
            check = validate_gpx_header(
                header.get('name'), header.get('desc'), header.get('author'))
            if not check.get('success'):
                raise ValueError(check.get('message', _('Fichier GPX invalide')))
            validated = True
        gc_code = get_child_text_anyns(elem, 'name')
        if gc_code:
            codes.append(gc_code.strip())
        elem.clear()
    if not validated:
        # Aucun <wpt> trouvé — l'en-tête n'a jamais pu être validé.
        raise ValueError(_('Aucun waypoint trouvé dans le fichier GPX'))
    return codes


@gpx_bp.route('/progressBar')
def get_progress():
    task_id = request.args.get('task_id')
    loading_progress, loading_message, state, effective_id, error = get_progress_step(task_id)
    return jsonify({
        'progress': loading_progress,
        'message': loading_message,
        'state': state,
        'task_id': effective_id,
        'error': error,
    })


@gpx_bp.route('/upload', methods=['POST'])
def handle_upload():
    if 'file' not in request.files:
        return jsonify({'success': False, 'message': _('Aucun fichier fourni')}), 400

    uploaded_file = request.files['file']
    if uploaded_file.filename == '':
        return jsonify({'success': False, 'message': _('Nom de fichier vide')}), 400

    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".gpx")
    uploaded_file.save(tmp_file)
    tmp_file_path = tmp_file.name
    tmp_file.close()

    # Pocket Query téléchargée telle quelle (.zip) : détectée sur le contenu
    # plutôt que sur l'extension, puis remplacée par le GPX qu'elle contient.
    # Fait ici, en synchrone : une archive invalide est signalée tout de suite
    # (400) au lieu d'échouer dans la tâche de fond.
    if zipfile.is_zipfile(tmp_file_path):
        zip_path = tmp_file_path
        fd, tmp_file_path = tempfile.mkstemp(suffix=".gpx")
        os.close(fd)
        try:
            extract_gpx_from_zip(zip_path, tmp_file_path)
        except ValueError as e:
            os.remove(tmp_file_path)
            return jsonify({'success': False, 'message': str(e)}), 400
        finally:
            os.remove(zip_path)

    app_obj = current_app._get_current_object()
    # Capturée ici (dans la requête, seul endroit où cookies/headers sont
    # lisibles) puis transmise à la tâche de fond : uploadBdd y valide l'en-tête
    # GPX et peut lever des messages d'erreur traduits, mais le thread de fond
    # n'a qu'un app_context (voir bdd.run_import_task pour le détail).
    current_locale = get_locale()
    status = task_manager.submit(
        TASK_TYPE_IMPORT, run_import_task, app_obj, tmp_file_path, Geocache, db, current_locale
    )

    return jsonify({
        'success': True,
        'message': _('Import GPX lancé en tâche de fond'),
        'task_id': status.id,
        'state': status.state,
    }), 202


@gpx_bp.route('/analyse_file', methods=['POST'])
def analyse_file():
    return analyse(request)


@gpx_bp.route('/db_status')
def db_status():
    return db_infos(Geocache)


@gpx_bp.route('/api/geocaches/import/preview', methods=['POST'])
def import_preview():
    """Aperçu diff d'un réimport : codes GC du fichier vs table Geocache.

    Reçoit le même fichier que /upload (garde-fous identiques, support ZIP
    Pocket Query), ne lance AUCUN import : le GPX extrait est conservé sous
    un jeton TTL que /commit reprendra. Renvoie le diff ({added, removed,
    unchanged, removed_sample}) affiché par la modale #gpxDiffModal.
    """
    if 'file' not in request.files:
        return jsonify({'success': False, 'message': _('Aucun fichier fourni')}), 400

    uploaded_file = request.files['file']
    if uploaded_file.filename == '':
        return jsonify({'success': False, 'message': _('Nom de fichier vide')}), 400

    _purge_expired_pending()

    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".gpx")
    uploaded_file.save(tmp_file)
    tmp_file_path = tmp_file.name
    tmp_file.close()

    # Pocket Query .zip : même extraction que /upload — une archive invalide
    # est signalée tout de suite (400).
    if zipfile.is_zipfile(tmp_file_path):
        zip_path = tmp_file_path
        fd, tmp_file_path = tempfile.mkstemp(suffix=".gpx")
        os.close(fd)
        try:
            extract_gpx_from_zip(zip_path, tmp_file_path)
        except ValueError as e:
            os.remove(tmp_file_path)
            return jsonify({'success': False, 'message': str(e)}), 400
        finally:
            os.remove(zip_path)

    try:
        codes = _scan_gpx_for_preview(tmp_file_path)
    except ET.ParseError:
        os.remove(tmp_file_path)
        return jsonify({'success': False,
                        'message': _("Le fichier fourni n'est pas un fichier GPX valide")}), 400
    except ValueError as e:
        # Non « My Finds » ou sans waypoint : même rejet que l'import direct.
        os.remove(tmp_file_path)
        return jsonify({'success': False, 'message': str(e)}), 400

    db_codes = {r[0] for r in db.session.query(Geocache.gc_code) if r[0]}
    file_codes = set(codes)
    removed_codes = sorted(db_codes - file_codes)
    summary = {
        'total': len(codes),
        'added': len(file_codes - db_codes),
        'removed': len(removed_codes),
        'unchanged': len(file_codes & db_codes),
        'removed_sample': removed_codes[:REMOVED_SAMPLE_SIZE],
    }

    token = _store_pending(tmp_file_path, uploaded_file.filename)
    return jsonify({
        'success': True,
        'import_token': token,
        'expires_in_seconds': PENDING_TTL_SECONDS,
        'name': uploaded_file.filename,
        'summary': summary,
    })


@gpx_bp.route('/api/geocaches/import/commit', methods=['POST'])
def import_commit():
    """Lance l'import réel du fichier conservé par /preview (même tâche que
    /upload : run_import_task sur le GPX déjà extrait)."""
    body = request.get_json(silent=True) or {}
    # Refus avant de consommer le jeton : l'utilisateur garde la main.
    if task_manager.get_active(TASK_TYPE_IMPORT) is not None:
        return jsonify({'success': False, 'message': _('Un import est déjà en cours')}), 409
    folder, _manifest, error = _take_pending(body.get("import_token"))
    if error:
        return jsonify({'success': False, 'message': error}), 400

    app_obj = current_app._get_current_object()
    # Locale capturée dans la requête (seul endroit où cookies/headers sont
    # lisibles), transmise à la tâche — voir handle_upload pour le détail.
    try:
        status = task_manager.submit(
            TASK_TYPE_IMPORT, run_import_task, app_obj,
            str(folder / "import.gpx"), Geocache, db, get_locale(), exclusive=True)
    except TaskAlreadyRunning as e:
        shutil.rmtree(folder, ignore_errors=True)
        return jsonify({'success': False, 'message': str(e)}), 409

    return jsonify({
        'success': True,
        'message': _('Import GPX lancé en tâche de fond'),
        'task_id': status.id,
        'state': status.state,
    }), 202


@gpx_bp.route('/clear_database', methods=['POST'])
def clear_database():
    try:
        num_deleted = Geocache.query.delete()
        db.session.commit()
        try:
            path = paths.country_state_path()
            if path.exists():
                path.unlink()
        except Exception as e:
            print(f"[CLEAR_DB] Could not remove country_state.json: {e}")

        try:
            geojson_cache.invalidate("clear_database")
        except Exception as e:
            print(f"[CLEAR_DB] Cache invalidation failed: {e}")

        return jsonify({
            'success': True,
            # %(count)s (pas un f-string) : le msgid doit rester statique pour
            # être traduisible par gettext, la valeur est substituée après coup.
            'message': _('Base de données vidée avec succès. %(count)s entrées supprimées.', count=num_deleted)
        })

    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False,
            'message': _('Erreur lors du vidage de la base de données: %(error)s', error=str(e))
        }), 500
