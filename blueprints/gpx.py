import os

from flask import Blueprint, current_app, jsonify, request
from flask_cors import cross_origin

from bdd import analyse, db_infos, get_progress_step, uploadBdd
from extensions import db
from models import Geocache

gpx_bp = Blueprint('gpx', __name__)


@gpx_bp.route('/progressBar')
def get_progress():
    loading_progress, loading_message = get_progress_step()
    return jsonify({'progress': loading_progress, 'message': loading_message})


@gpx_bp.route('/upload', methods=['POST'])
@cross_origin()
def handle_upload():
    uploadBdd(request, Geocache, db)
    return jsonify({'message': 'Fichier reÇõu avec succÇùs'})


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
            'message': f'Base de donnÇ¸es vidÇ¸e avec succÇùs. {num_deleted} entrÇ¸es supprimÇ¸es.'
        })

    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False,
            'message': f'Erreur lors du vidage de la base de donnÇ¸es: {str(e)}'
        }), 500
