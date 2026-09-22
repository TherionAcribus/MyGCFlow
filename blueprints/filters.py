import json as _json

from flask import Blueprint, current_app, jsonify, request

import paths
from bdd import TASK_TYPE_GEOJSON, build_country_state_tree, run_geojson_task
from extensions import db
from models import Geocache
from task_manager import task_manager

filters_bp = Blueprint('filters', __name__)


@filters_bp.route('/filter_caches', methods=['POST'])
def filter_caches():
    data_request = request.json or {}
    print(f"[FILTER] Raw request data: {data_request}")
    # Clé 'filters' (nommage explicite). 'types' conservé pour compat arrière.
    selected_values = data_request.get('filters') or data_request.get('types') or {}
    print(f"[FILTER] Selected values: {selected_values}")
    print(f"[FILTER] Type of selected_values: {type(selected_values)}")

    app_obj = current_app._get_current_object()
    status = task_manager.submit(TASK_TYPE_GEOJSON, run_geojson_task, app_obj, Geocache, db, selected_values)
    return jsonify({
        'success': True,
        'task_id': status.id,
        'state': status.state,
    }), 202


@filters_bp.route('/get_geojson_points', methods=['POST', 'GET'])
def get_geojson_points():
    app_obj = current_app._get_current_object()
    status = task_manager.submit(TASK_TYPE_GEOJSON, run_geojson_task, app_obj, Geocache, db)
    return jsonify({
        'success': True,
        'task_id': status.id,
        'state': status.state,
    }), 202


@filters_bp.route('/api/country_state', methods=['GET'])
def api_country_state():
    try:
        path = paths.country_state_path()
        if not path.exists():
            # Cache absent (base importée par une version antérieure, fichier
            # supprimé…) : on le reconstruit depuis la base plutôt que de
            # laisser les filtres pays/région vides jusqu'au prochain import.
            build_country_state_tree(db, Geocache)
            if not path.exists():
                return jsonify({})
        with open(path, 'r', encoding='utf-8') as f:
            data = _json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
