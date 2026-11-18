"""Page « Parcours » : une journée ou des vacances rejouées cache par cache
(MyGCFlow_Plan_Parcours.md).

Page /parcours (même interface que les autres modes, onglet Données propre)
et API des parcours enregistrés : liste, création, modification,
suppression, entrées de la reconstruction (`parcours_dataset`) et
ajustements manuels (rang, heure, journée, exclusion, lieux et bases).
"""

from flask import Blueprint, abort, jsonify, request, send_file
from flask_babel import gettext as _

import image_library
import parcours_dataset
import parcours_photos
import parcours_routing
import parcours_store as store
import parcours_suggest
import parcours_tracks
from settings_manager import get_settings_manager
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
        'time-invalid': (_('Heure invalide (HH:MM attendu)'), 400),
        'day-out-of-range': (_('Cette journée est hors du parcours'), 400),
        'override-invalid': (_('Ajustement invalide'), 400),
        'place-invalid': (_('Lieu invalide'), 400),
        'place-not-found': (_('Lieu introuvable'), 404),
        'photo-not-found': (_('Photo introuvable'), 404),
        'photo-invalid': (_('Rattachement invalide'), 400),
        'photos-full': (_('Un parcours garde %(max)s photos au plus', max=parcours_photos.MAX_PHOTOS), 400),
        'camera-invalid': (_("Décalage d'horloge invalide"), 400),
        'utc-offset-invalid': (_('Décalage UTC invalide (de −12 h à +14 h)'), 400),
        'tracks-full': (_('Un parcours garde %(max)s traces au plus', max=parcours_tracks.MAX_TRACKS), 400),
        'track-not-found': (_('Trace introuvable'), 404),
    }
    message, code = messages.get(exc.code, (str(exc), 400))
    return jsonify({'success': False, 'error': exc.code, 'message': message}), code


@parcours_bp.route('/parcours')
def parcours_page():
    return render_app_page('parcours')


@parcours_bp.route('/api/parcours', methods=['GET'])
def list_parcours():
    # Centre habituel des trouvailles : repère du client pour signaler un
    # fuseau « ordinateur » probablement faux sur un parcours lointain.
    home = parcours_suggest.home_center(parcours_suggest.find_days(db.session))
    return jsonify({
        'parcours': store.list_parcours(db.session),
        'finds': parcours_dataset.finds_extent(db.session),
        'maxDays': store.MAX_DAYS,
        'home': {'lat': home[0], 'lon': home[1]} if home else None,
    })


@parcours_bp.route('/api/parcours/suggestions', methods=['GET'])
def parcours_suggestions():
    """Séjours et grosses journées tirés des trouvailles (lot 7), hors plages
    déjà enregistrées."""
    limit = request.args.get('limit', default=parcours_suggest.LIMIT, type=int)
    if limit <= 0:
        limit = None
    return jsonify(parcours_suggest.suggestions(
        db.session, store.list_parcours(db.session),
        max_days=store.MAX_DAYS, limit=limit))


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


# --- Ajustements manuels (lot 3) ------------------------------------------------

@parcours_bp.route('/api/parcours/<int:parcours_id>/overrides', methods=['PATCH'])
def patch_overrides(parcours_id):
    data = request.get_json(silent=True) or {}
    try:
        payload = store.patch_overrides(db.session, parcours_id, data.get('overrides'))
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True, **payload})


@parcours_bp.route('/api/parcours/<int:parcours_id>/overrides', methods=['DELETE'])
def clear_overrides(parcours_id):
    try:
        payload = store.clear_overrides(db.session, parcours_id)
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True, **payload})


@parcours_bp.route('/api/parcours/<int:parcours_id>/places', methods=['POST'])
def create_place(parcours_id):
    try:
        place = store.create_place(db.session, parcours_id, request.get_json(silent=True))
    except store.ParcoursError as exc:
        db.session.rollback()
        return _store_error(exc)
    return jsonify({'success': True, 'place': place}), 201


@parcours_bp.route('/api/parcours/<int:parcours_id>/places/<int:place_id>', methods=['PATCH'])
def update_place(parcours_id, place_id):
    try:
        place = store.update_place(db.session, parcours_id, place_id, request.get_json(silent=True))
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True, 'place': place})


@parcours_bp.route('/api/parcours/<int:parcours_id>/places/<int:place_id>', methods=['DELETE'])
def delete_place(parcours_id, place_id):
    try:
        store.delete_place(db.session, parcours_id, place_id)
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True})


# --- Photos (lot 4) ----------------------------------------------------------------

def _photo_refused(reason):
    if reason == 'too_large':
        message = _("Photo trop lourde : %(max)d Mo au maximum.",
                    max=image_library.IMAGE_MAX_UPLOAD_BYTES // (1024 * 1024))
    elif reason == 'format':
        message = _("Format non pris en charge : JPEG, PNG, WebP, GIF ou HEIC.")
    elif reason == 'too_many_pixels':
        message = _("Image trop grande (dimensions démesurées).")
    else:
        message = _("Ce fichier n'est pas une image lisible.")
    status = 413 if reason == 'too_large' else 415 if reason == 'format' else 400
    return jsonify({'success': False, 'error': 'photo-refused', 'reason': reason, 'message': message}), status


@parcours_bp.route('/api/parcours/<int:parcours_id>/photos', methods=['POST'])
def upload_photo(parcours_id):
    upload = request.files.get('photo') if request.files else None
    if upload is None:
        return jsonify({'success': False, 'error': 'photo-refused', 'message': _("Aucune photo fournie")}), 400
    # Lecture bornée : un fichier démesuré n'est jamais chargé en entier.
    data = upload.stream.read(image_library.IMAGE_MAX_UPLOAD_BYTES + 1)
    try:
        photo = parcours_photos.save_photo(db.session, parcours_id, data, upload.filename or '')
    except image_library.InvalidImage as exc:
        return _photo_refused(exc.reason)
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True, 'photo': photo}), 201


def _send_photo(parcours_id, photo_id, thumb):
    try:
        path = parcours_photos.photo_path(db.session, parcours_id, photo_id, thumb=thumb)
    except store.ParcoursError:
        abort(404)
    if not path.is_file():
        abort(404)
    # Contenu immuable (le nom est l'empreinte du fichier normalisé).
    response = send_file(path, max_age=7 * 24 * 3600)
    response.headers['Cache-Control'] = 'public, max-age=604800, immutable'
    return response


@parcours_bp.route('/api/parcours/<int:parcours_id>/photos/<int:photo_id>/file', methods=['GET'])
def photo_file(parcours_id, photo_id):
    return _send_photo(parcours_id, photo_id, thumb=False)


@parcours_bp.route('/api/parcours/<int:parcours_id>/photos/<int:photo_id>/thumb', methods=['GET'])
def photo_thumb(parcours_id, photo_id):
    return _send_photo(parcours_id, photo_id, thumb=True)


@parcours_bp.route('/api/parcours/<int:parcours_id>/photos/<int:photo_id>', methods=['PATCH'])
def update_photo(parcours_id, photo_id):
    try:
        photo = parcours_photos.update_photo(db.session, parcours_id, photo_id, request.get_json(silent=True))
    except store.ParcoursError as exc:
        db.session.rollback()
        return _store_error(exc)
    return jsonify({'success': True, 'photo': photo})


@parcours_bp.route('/api/parcours/<int:parcours_id>/photos/<int:photo_id>', methods=['DELETE'])
def delete_photo(parcours_id, photo_id):
    try:
        parcours_photos.delete_photo(db.session, parcours_id, photo_id)
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True})


@parcours_bp.route('/api/parcours/<int:parcours_id>/cameras', methods=['PUT'])
def set_camera(parcours_id):
    data = request.get_json(silent=True) or {}
    try:
        payload = parcours_photos.set_camera_offset(db.session, parcours_id, data.get('camera'),
                                                    data.get('offsetMinutes'))
    except store.ParcoursError as exc:
        db.session.rollback()
        return _store_error(exc)
    return jsonify({'success': True, **payload})


# --- Traces GPS (lot 5) --------------------------------------------------------------

def _track_refused(reason):
    if reason == 'too_large':
        message = _("Trace trop lourde : %(max)d Mo au maximum.",
                    max=parcours_tracks.MAX_TRACK_BYTES // (1024 * 1024))
    elif reason == 'no_time':
        message = _("Cette trace n'a aucun point horodaté : impossible d'en tirer des heures.")
    else:
        message = _("Ce fichier n'est pas une trace GPX lisible.")
    status = 413 if reason == 'too_large' else 400
    return jsonify({'success': False, 'error': 'track-refused', 'reason': reason, 'message': message}), status


@parcours_bp.route('/api/parcours/<int:parcours_id>/tracks', methods=['POST'])
def upload_track(parcours_id):
    upload = request.files.get('track') if request.files else None
    if upload is None:
        return jsonify({'success': False, 'error': 'track-refused', 'message': _("Aucune trace fournie")}), 400
    data = upload.stream.read(parcours_tracks.MAX_TRACK_BYTES + 1)
    try:
        track = parcours_tracks.save_track(db.session, parcours_id, data, upload.filename or '')
    except parcours_tracks.InvalidTrack as exc:
        return _track_refused(exc.reason)
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True, 'track': track}), 201


@parcours_bp.route('/api/parcours/<int:parcours_id>/tracks/<int:track_id>', methods=['DELETE'])
def delete_track(parcours_id, track_id):
    try:
        parcours_tracks.delete_track(db.session, parcours_id, track_id)
    except store.ParcoursError as exc:
        return _store_error(exc)
    return jsonify({'success': True})


# --- Itinéraires (lot 6) -------------------------------------------------------------

_ROUTING_MESSAGES = {
    'unavailable': lambda: _("Service d'itinéraires injoignable : trajets en ligne droite."),
    'quota': lambda: _("Le service d'itinéraires limite les requêtes : réessayez plus tard."),
    'key': lambda: _("Clé openrouteservice absente ou refusée."),
}


@parcours_bp.route('/api/parcours/routes', methods=['POST'])
def compute_routes():
    """Itinéraires d'une suite de trajets de même profil : {profile,
    waypoints: [[lon, lat], ...], force?} → {legs, provider, requested,
    error, message}. Toujours 200 quand la requête est valide : un
    fournisseur en échec laisse ses trajets à None (ligne droite)."""
    data = request.get_json(silent=True) or {}
    config = get_settings_manager().get_app_settings().parcours_routing
    if not config.get('enabled'):
        return jsonify({'success': False, 'error': 'routing-disabled',
                        'message': _("Les itinéraires ne sont pas activés.")}), 409
    try:
        result = parcours_routing.route_legs(db.session, config, data.get('profile'), data.get('waypoints'),
                                             force=data.get('force') is True)
    except parcours_routing.RoutingError as exc:
        return jsonify({'success': False, 'error': 'routing-invalid', 'message': _("Requête d'itinéraire invalide")}), 400
    message = _ROUTING_MESSAGES[result['error']]() if result['error'] in _ROUTING_MESSAGES else None
    return jsonify({'success': True, **result, 'message': message})
