import os
import tempfile

from flask import Blueprint, current_app, jsonify, request
from flask_cors import cross_origin

from bdd import TASK_TYPE_IMPORT, analyse, db_infos, get_progress_step, run_import_task
from extensions import db
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
@cross_origin()
def handle_upload():
    if 'file' not in request.files:
        return jsonify({'success': False, 'message': 'Aucun fichier fourni'}), 400

    uploaded_file = request.files['file']
    if uploaded_file.filename == '':
        return jsonify({'success': False, 'message': 'Nom de fichier vide'}), 400

    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".gpx")
    uploaded_file.save(tmp_file)
    tmp_file_path = tmp_file.name
    tmp_file.close()

    app_obj = current_app._get_current_object()
    status = task_manager.submit(TASK_TYPE_IMPORT, run_import_task, app_obj, tmp_file_path, Geocache, db)

    return jsonify({
        'success': True,
        'message': 'Import GPX lancé en tâche de fond',
        'task_id': status.id,
        'state': status.state,
    }), 202


@gpx_bp.route('/analyse_file', methods=['POST'])
@cross_origin()
def analyse_file():
    return analyse(request)


@gpx_bp.route('/db_status')
def db_status():
    return db_infos(Geocache)


@gpx_bp.route('/clear_database', methods=['POST'])
@cross_origin()
def clear_database():
    try:
        num_deleted = Geocache.query.delete()
        db.session.commit()
        try:
            path = os.path.join(current_app.root_path, 'static', 'json', 'country_state.json')
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            print(f"[CLEAR_DB] Could not remove country_state.json: {e}")

        return jsonify({
            'success': True,
            'message': f'Base de données vidée avec succès. {num_deleted} entrées supprimées.'
        })

    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False,
            'message': f'Erreur lors du vidage de la base de données: {str(e)}'
        }), 500
