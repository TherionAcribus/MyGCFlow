import os
import json as _json

from flask import Blueprint, current_app, jsonify, request
from flask_cors import cross_origin

from bdd import create_geojson, filter_session, get_metadata_from_geojson
from extensions import db
from models import Geocache

filters_bp = Blueprint('filters', __name__)


@filters_bp.route('/filter_caches', methods=['POST'])
@cross_origin()
def filter_caches():
    data_request = request.json
    print(f"[FILTER] Raw request data: {data_request}")
    selected_values = data_request.get('types', {})
    print(f"[FILTER] Selected values: {selected_values}")
    print(f"[FILTER] Type of selected_values: {type(selected_values)}")
    geojson = filter_session(db, Geocache, selected_values)
    print(f"[FILTER] GeoJSON features count: {len(geojson['features'])}")
    webcam_count = len([f for f in geojson['features'] if f['properties']['cache_type'] == 'Webcam Cache'])
    print(f"[FILTER] Webcam caches in result: {webcam_count}")
    metadata = get_metadata_from_geojson(geojson["features"])
    response_data = {
        'geojson': geojson,
        'metadata': metadata,
    }
    return jsonify(response_data)


@filters_bp.route('/get_geojson_points', methods=['POST', 'GET'])
def get_geojson_points():
    geojson = create_geojson(Geocache.query, Geocache)
    metadata = get_metadata_from_geojson(geojson["features"])
    response_data = {
        'geojson': geojson,
        'metadata': metadata,
    }
    return jsonify(response_data)


@filters_bp.route('/api/country_state', methods=['GET'])
def api_country_state():
    try:
        path = os.path.join(current_app.root_path, 'static', 'json', 'country_state.json')
        if not os.path.exists(path):
            return jsonify({})
        with open(path, 'r', encoding='utf-8') as f:
            data = _json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
