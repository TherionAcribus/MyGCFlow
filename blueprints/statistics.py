"""Page « Statistiques » : tableaux de bord de graphiques, sans carte.

Plan et décisions : MyGCFlow_Plan_Statistiques.md ; doc technique :
docs/page-statistiques.md. Les graphiques sont calculés côté navigateur
(modules purs `static/js/chart_*.mjs`) et dessinés par ECharts
(`static/vendor/echarts/`) : le serveur sert la page, les données en
colonnes et le fichier des tableaux de bord.
"""

import hashlib

from flask import Blueprint, jsonify, make_response, request

import dashboards_store
import lab_geojson
import stats_finds
from bdd import create_geojson, geojson_cache, get_metadata_from_geojson
from extensions import db
from models import Geocache

from .core import render_page

statistics_bp = Blueprint('statistics', __name__)


@statistics_bp.route('/stats')
def stats_page():
    return render_page('stats_page.html', mode='stats')


def _base_features():
    """Jeu de base de la page carte (trouvailles + étapes Lab), depuis le
    cache GeoJSON s'il est à jour, sinon reconstruit et remis en cache —
    même chemin que la tâche `run_geojson_task`, sans progression."""
    db_mtime = geojson_cache.get_database_mtime()
    geojson_cache.invalidate_if_db_changed(db_mtime)
    cached = geojson_cache.get_base_dataset_if_current(db_mtime)
    if cached:
        return cached[0].get("features", []), db_mtime
    geojson = create_geojson(
        db.session.query(Geocache), Geocache,
        extra_features=lab_geojson.build_lab_features(db.session))
    features = geojson.get("features", [])
    geojson_cache.set_base_dataset(geojson, get_metadata_from_geojson(features), db_mtime)
    return features, db_mtime


@statistics_bp.route('/api/stats/finds', methods=['GET'])
def stats_finds_data():
    features, db_mtime = _base_features()
    response = make_response(jsonify(stats_finds.build_finds_payload(features)))
    # Faible : Flask-Compress le conserve tel quel sur la réponse compressée.
    digest = hashlib.sha1(repr((db_mtime, len(features))).encode('utf-8')).hexdigest()[:16]
    response.set_etag(f"finds-{digest}-p{stats_finds.PAYLOAD_VERSION}", weak=True)
    response.headers['Cache-Control'] = 'no-cache'
    return response.make_conditional(request)


@statistics_bp.route('/api/dashboards', methods=['GET'])
def get_dashboards():
    return jsonify({'success': True, 'document': dashboards_store.load_document()})


@statistics_bp.route('/api/dashboards', methods=['PUT'])
def put_dashboards():
    doc = request.get_json(silent=True)
    try:
        dashboards_store.save_document(doc)
    except dashboards_store.InvalidDocument as error:
        status = 413 if error.code == 'too-large' else 400
        return jsonify({'success': False, 'error': error.code}), status
    return jsonify({'success': True})


@statistics_bp.route('/api/dashboards', methods=['DELETE'])
def delete_dashboards():
    dashboards_store.delete_document()
    return jsonify({'success': True})
