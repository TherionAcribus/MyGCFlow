"""Page « Statistiques » : tableaux de bord de graphiques, sans carte.

Plan et décisions : MyGCFlow_Plan_Statistiques.md ; doc technique :
docs/page-statistiques.md. Les graphiques sont calculés côté navigateur
(modules purs `static/js/chart_*.mjs`) et dessinés par ECharts
(`static/vendor/echarts/`) : le serveur sert la page, les données en
colonnes et le fichier des tableaux de bord.
"""

import hashlib
import threading
from collections import OrderedDict

from flask import Blueprint, current_app, jsonify, make_response, request

import dashboards_store
import dnf_geojson
import evolution_store
import lab_geojson
import owner_geojson
import stats_finds
import zone_share
import zones
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


def _finds_digest(features, db_mtime):
    return hashlib.sha1(repr((db_mtime, len(features))).encode('utf-8')).hexdigest()[:16]


@statistics_bp.route('/api/stats/finds', methods=['GET'])
def stats_finds_data():
    features, db_mtime = _base_features()
    digest = _finds_digest(features, db_mtime)
    etag = f"finds-{digest}-p{stats_finds.PAYLOAD_VERSION}"
    # Version déjà connue du navigateur : 304 SANS construire les colonnes
    # (~60 ms et 1,7 Mo de JSON pour 20 000 trouvailles, jetés sinon).
    if request.if_none_match.contains_weak(etag):
        response = make_response('', 304)
    else:
        response = make_response(jsonify(stats_finds.build_finds_payload(features)))
    # Faible : Flask-Compress le conserve tel quel sur la réponse compressée.
    response.set_etag(etag, weak=True)
    response.headers['Cache-Control'] = 'no-cache'
    return response


# Part des caches trouvées par zone (couche de zones de la carte, mesure
# « found_share ») : une charge par (jeu, révision, zones, trouvailles, niveau,
# taille de case). Quelques-unes gardées : un retour sur la carte, ou un
# changement de niveau aller-retour, ne relit pas les 400 000 caches.
_SHARE_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_SHARE_CACHE_SIZE = 6
_share_lock = threading.Lock()


def _has_subregions(cc):
    index = zones.get_index()
    if not index.available():
        return True
    country = index.country(cc)
    return bool(country and 'subregion' in country.levels)


@statistics_bp.route('/api/stats/found_share', methods=['GET'])
def stats_found_share():
    from .evolution import _db_path, _store_error
    dataset_id = request.args.get('dataset', type=int)
    level = request.args.get('level', 'subregion')
    grid = request.args.get('grid', type=int) or zone_share.GRID_DEFAULT_SIZE
    if not dataset_id or level not in zone_share.LEVELS:
        return jsonify({'success': False, 'error': 'bad-request'}), 400
    if level != 'grid':
        grid = None
    elif grid not in zone_share.GRID_SIZES:
        grid = zone_share.GRID_DEFAULT_SIZE
    db_path = _db_path()
    try:
        dataset = evolution_store.get_dataset(db_path, dataset_id)
    except evolution_store.EvolutionStoreError as exc:
        return _store_error(exc)
    features, db_mtime = _base_features()
    etag = (f"share-{dataset['id']}-{dataset['revision']}-{_finds_digest(features, db_mtime)}"
            f"-{level}-{grid}-v{zone_share.FORMAT_VERSION}-z{zones.data_signature()}")
    if request.if_none_match.contains_weak(etag):
        response = make_response('', 304)
    else:
        with _share_lock:
            payload = _SHARE_CACHE.get(etag)
            if payload is not None:
                _SHARE_CACHE.move_to_end(etag)
        if payload is None:
            try:
                dataset, rows = evolution_store.load_share_rows(db_path, dataset_id)
            except evolution_store.EvolutionStoreError as exc:
                return _store_error(exc)
            payload = zone_share.build_share_payload(
                rows, zone_share.found_days(features), level=level,
                grid_size=grid or zone_share.GRID_DEFAULT_SIZE, has_subregions=_has_subregions)
            payload['dataset'] = {'id': dataset['id'], 'name': dataset['name'], 'revision': dataset['revision']}
            with _share_lock:
                _SHARE_CACHE[etag] = payload
                while len(_SHARE_CACHE) > _SHARE_CACHE_SIZE:
                    _SHARE_CACHE.popitem(last=False)
        response = make_response(jsonify(payload))
    response.set_etag(etag, weak=True)
    response.headers['Cache-Control'] = 'no-cache'
    return response


# Rapport de rattachement (onglet Zones, zone_report.py) : noms de
# Geocaching.com non reconnus, pour mes trouvailles ou un jeu Évolution.
@statistics_bp.route('/api/zones/report', methods=['GET'])
def zones_report():
    import zone_report
    source = request.args.get('source', 'finds')
    if source == 'finds':
        features, _ = _base_features()
        report = zone_report.build_report(zone_report.finds_groups(features))
    elif source == 'evolution':
        from .evolution import _db_path, _store_error
        dataset_id = request.args.get('dataset', type=int)
        if not dataset_id:
            return jsonify({'success': False, 'error': 'bad-request'}), 400
        try:
            dataset, groups = evolution_store.zone_name_groups(_db_path(), dataset_id)
        except evolution_store.EvolutionStoreError as exc:
            return _store_error(exc)
        report = zone_report.build_report(groups)
        report['dataset'] = {'id': dataset['id'], 'name': dataset['name']}
    else:
        return jsonify({'success': False, 'error': 'bad-request'}), 400
    report['source'] = source
    report['app_version'] = current_app.config.get('APP_VERSION')
    response = make_response(jsonify(report))
    response.headers['Cache-Control'] = 'no-store'
    return response


@statistics_bp.route('/api/stats/dnf')
def stats_dnf_data():
    """Tous les logs DNF — indépendant de la carte : aucune position requise,
    aucun filtrage par la résolution (dnf_geojson.build_dnf_stats)."""
    return jsonify(dnf_geojson.build_dnf_stats(db.session))


@statistics_bp.route('/api/stats/owned')
def stats_owned_data():
    """Toutes les caches posées — position non requise
    (owner_geojson.build_owner_stats)."""
    return jsonify(owner_geojson.build_owner_stats(db.session))


@statistics_bp.route('/api/dashboards', methods=['GET'])
def get_dashboards():
    return jsonify({'success': True, **dashboards_store.read_status()})


@statistics_bp.route('/api/dashboards', methods=['PUT'])
def put_dashboards():
    doc = request.get_json(silent=True)
    # En-tête de comparaison : la révision que le client a chargée ('none'
    # = fichier absent à ce moment-là). Sans en-tête, l'écriture reste
    # inconditionnelle (anciens clients, outils).
    # Comparaison et écriture sous un même verrou (dashboards_store).
    expected = request.headers.get('X-Dashboard-Rev')
    try:
        rev = dashboards_store.save_document(doc, expected_rev=expected)
    except dashboards_store.RevisionConflict as conflict:
        return _conflict(conflict)
    except dashboards_store.InvalidDocument as error:
        status = 413 if error.code == 'too-large' else 400
        return jsonify({'success': False, 'error': error.code}), status
    return jsonify({'success': True, 'rev': rev})


def _conflict(conflict):
    return jsonify({'success': False, 'error': 'conflict', 'rev': conflict.rev}), 409


@statistics_bp.route('/api/dashboards/<dashboard_id>', methods=['PUT'])
def put_one_dashboard(dashboard_id):
    """Sauvegarde de secours à la fermeture de la page : un seul tableau
    ({dashboard, active}), quand le document entier dépasse la limite d'un
    envoi `keepalive` (64 Ko). Même contrôle de révision que le PUT complet."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get('dashboard'), dict)             or body['dashboard'].get('id') != dashboard_id:
        return jsonify({'success': False, 'error': 'bad-dashboard'}), 400
    try:
        rev = dashboards_store.save_dashboard(
            body['dashboard'], active=body.get('active'),
            expected_rev=request.headers.get('X-Dashboard-Rev'))
    except dashboards_store.RevisionConflict as conflict:
        return _conflict(conflict)
    except dashboards_store.InvalidDocument as error:
        status = {'too-large': 413, 'no-document': 404, 'unknown-dashboard': 404}.get(error.code, 400)
        return jsonify({'success': False, 'error': error.code}), status
    return jsonify({'success': True, 'rev': rev})


@statistics_bp.route('/api/dashboards/restore', methods=['POST'])
def restore_dashboards():
    """Rétablit le document depuis la copie `.bak` (fichier corrompu)."""
    try:
        doc = dashboards_store.restore_backup()
    except dashboards_store.InvalidDocument as error:
        return jsonify({'success': False, 'error': error.code}), 404
    return jsonify({'success': True, 'document': doc,
                    'rev': dashboards_store.read_status()['rev']})


@statistics_bp.route('/api/dashboards', methods=['DELETE'])
def delete_dashboards():
    dashboards_store.delete_document()
    return jsonify({'success': True})
