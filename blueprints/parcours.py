"""Page « Parcours » : une journée ou des vacances rejouées cache par cache
(MyGCFlow_Plan_Parcours.md).

Page /parcours (même interface que les autres modes, onglet Données propre)
et API des parcours enregistrés : liste, création, modification,
suppression, et entrées de la reconstruction (`parcours_dataset`).
"""

from flask import Blueprint, jsonify, request
from flask_babel import gettext as _

import parcours_dataset
import parcours_store as store
from extensions import db
from .core import render_app_page

parcours_bp = Blueprint('parcours', __name__)


def _store_error(exc: store.ParcoursError):
    messages = {
        'not-found': (_('Parcours introuvable'), 404),
        'name-empty': (_('Le nom du parcours est obligatoire'), 400),
        'name-too-long': (_('Le nom du parcours est trop long (%(max)s caractères au plus)',
                            max=store.NAME_MAX_LENGTH), 400),
        'date-invalid': (_('Date invalide'), 400),
        'range-reversed': (_('La date de fin précède la date de début'), 400),
        'range-too-long': (_('Un parcours couvre %(max)s jours au plus', max=store.MAX_DAYS), 400),
    }
    message, code = messages.get(exc.code, (str(exc), 400))
    return jsonify({'success': False, 'error': exc.code, 'message': message}), code


@parcours_bp.route('/parcours')
def parcours_page():
    return render_app_page('parcours')


@parcours_bp.route('/api/parcours', methods=['GET'])
def list_parcours():
    return jsonify({
        'parcours': store.list_parcours(db.session),
        'finds': parcours_dataset.finds_extent(db.session),
        'maxDays': store.MAX_DAYS,
    })


@parcours_bp.route('/api/parcours', methods=['POST'])
def create_parcours():
    try:
        row = store.create(db.session, request.get_json(silent=True))
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True, 'parcours': store.to_dict(row)}), 201


@parcours_bp.route('/api/parcours/<int:parcours_id>', methods=['GET'])
def get_parcours(parcours_id):
    try:
        row = store.get(db.session, parcours_id)
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'parcours': store.to_dict(row)})


@parcours_bp.route('/api/parcours/<int:parcours_id>', methods=['PATCH'])
def update_parcours(parcours_id):
    try:
        row = store.update(db.session, parcours_id, request.get_json(silent=True))
    except store.ParcoursError as exc:
        db.session.rollback()
        return _store_error(exc)
    return jsonify({'success': True, 'parcours': store.to_dict(row)})


@parcours_bp.route('/api/parcours/<int:parcours_id>', methods=['DELETE'])
def delete_parcours(parcours_id):
    try:
        store.delete(db.session, parcours_id)
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True})


@parcours_bp.route('/api/parcours/<int:parcours_id>/inputs', methods=['GET'])
def parcours_inputs(parcours_id):
    try:
        payload = parcours_dataset.build_inputs(db.session, parcours_id)
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify(payload)
