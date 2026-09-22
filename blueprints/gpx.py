import tempfile

from flask import Blueprint, current_app, jsonify, request
from flask_babel import gettext as _

import paths
from bdd import TASK_TYPE_IMPORT, analyse, db_infos, get_progress_step, run_import_task, geojson_cache
from extensions import db
from localization import get_locale
from models import Geocache
from task_manager import task_manager

gpx_bp = Blueprint('gpx', __name__)


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
