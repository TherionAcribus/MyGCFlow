"""Page « Mes poses » : vie des caches posées par le joueur.

Page /poses (même interface que les autres modes, onglet Données propre) et
API de lecture : données en colonnes pour la carte (`poses_dataset`), détails
d'une cache pour la popup. Les données viennent des logs importés par la carte
« Mes logs » de la page principale (docs/logs-geocaching.md) : rien ne
s'importe ici.
"""

import hashlib

from flask import Blueprint, jsonify, make_response, request

import poses_dataset
from extensions import db
from .core import render_app_page

poses_bp = Blueprint('poses', __name__)


@poses_bp.route('/poses')
def poses_page():
    return render_app_page('poses')


@poses_bp.route('/api/poses/data', methods=['GET'])
def poses_data():
    key, body = poses_dataset.load_payload(db.session)
    response = make_response(body)
    response.mimetype = 'application/json'
    # Faible : Flask-Compress le conserve tel quel sur la réponse compressée.
    # La clé du mémo (collection, révision, empreinte de `geocache`, version
    # du format) suffit à identifier le corps.
    digest = hashlib.sha1(repr(key).encode('utf-8')).hexdigest()[:16]
    response.set_etag(f"poses-{digest}-p{poses_dataset.PAYLOAD_VERSION}", weak=True)
    response.headers['Cache-Control'] = 'no-cache'
    return response.make_conditional(request)


@poses_bp.route('/api/poses/caches/<code>', methods=['GET'])
def poses_cache(code):
    details = poses_dataset.cache_details(db.session, code)
    if details is None:
        return jsonify({'success': False, 'error': 'cache-not-found'}), 404
    return jsonify({'success': True, 'cache': details})
