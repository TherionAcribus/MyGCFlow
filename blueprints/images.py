"""Images de l'utilisateur posées sur la carte (onglet Images).

Envoi (normalisé par image_library.py), bibliothèque, lecture et retrait. Les
fichiers sont servis ici, par le serveur local : même origine que la page,
sans quoi le canvas de la vidéo serait contaminé et l'export impossible.
"""

from flask import Blueprint, abort, jsonify, request, send_from_directory
from flask_babel import gettext as _babel_gettext

import image_library
import paths
from settings_manager import get_settings_manager

images_bp = Blueprint('images', __name__)

# Le contenu d'un nom ne change jamais (empreinte) : cache d'un an.
IMAGE_CACHE_MAX_AGE_S = 365 * 24 * 3600


def _(msgid, **kwargs):
    """gettext avec repli sur le msgid brut quand Babel n'est pas initialisé
    (tests unitaires sur une app Flask nue)."""
    try:
        return _babel_gettext(msgid, **kwargs)
    except Exception:
        return msgid % kwargs if kwargs else msgid


def _referenced_image_files():
    settings = get_settings_manager().get_app_settings()
    return image_library.referenced_image_files(getattr(settings, 'images', None))


def _invalid_message(reason):
    if reason == 'too_large':
        return _("Image trop lourde : %(max)d Mo au maximum.",
                 max=image_library.IMAGE_MAX_UPLOAD_BYTES // (1024 * 1024))
    if reason == 'format':
        return _("Format non pris en charge : PNG, JPEG, WebP, GIF ou SVG.")
    if reason == 'too_many_pixels':
        return _("Image trop grande (dimensions démesurées).")
    return _("Ce fichier n'est pas une image lisible.")


@images_bp.route('/api/images', methods=['POST'])
def route_upload_image():
    upload = request.files.get('image') if request.files else None
    if upload is None:
        return jsonify({'success': False, 'message': _("Aucune image fournie")}), 400
    # Lecture bornée : un fichier démesuré n'est jamais chargé en entier.
    data = upload.stream.read(image_library.IMAGE_MAX_UPLOAD_BYTES + 1)
    try:
        saved = image_library.save_image(data, name=upload.filename or '')
    except image_library.InvalidImage as e:
        status = 413 if e.reason == 'too_large' else 415 if e.reason == 'format' else 400
        return jsonify({'success': False, 'reason': e.reason, 'message': _invalid_message(e.reason)}), status
    # Une nouvelle image arrive : les envois interrompus (.upload-*.part)
    # trop vieux sont balayés. Les images restent jusqu'au retrait manuel.
    try:
        image_library.sweep_partial_uploads()
    except Exception as e:
        print(f"[images] balayage impossible: {e}")
    return jsonify({'success': True, **saved})


@images_bp.route('/api/images', methods=['GET'])
def route_list_images():
    return jsonify({'success': True, **image_library.list_image_files(_referenced_image_files())})


@images_bp.route('/api/images/<name>', methods=['GET'])
def route_get_image(name):
    safe = image_library.safe_image_name(name)
    if not safe:
        abort(404)
    response = send_from_directory(paths.images_dir(), safe, max_age=IMAGE_CACHE_MAX_AGE_S)
    response.headers['Cache-Control'] = f'public, max-age={IMAGE_CACHE_MAX_AGE_S}, immutable'
    return response


@images_bp.route('/api/images/delete', methods=['POST'])
def route_delete_image():
    payload = request.get_json(silent=True) or {}
    name = image_library.safe_image_name(payload.get('file'))
    if not name:
        return jsonify({'success': False, 'message': _("Image inconnue")}), 400
    if name in _referenced_image_files():
        return jsonify({'success': False,
                        'message': _("Cette image est utilisée sur la carte ou dans une configuration.")}), 409
    try:
        found = image_library.delete_image_file(name)
    except OSError as e:
        return jsonify({'success': False, 'message': str(e)}), 500
    if not found:
        return jsonify({'success': False, 'message': _("Image inconnue")}), 404
    return jsonify({'success': True})
