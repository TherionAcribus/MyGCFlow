from flask import Blueprint, jsonify, request
from flask_cors import cross_origin

from capture import assemble_pictures_directory, clear_pictures_directory, default_video_output, open_video_folder, upload_audio, upload_image, upload_video

media_bp = Blueprint('media', __name__)

# FPS d'assemblage par défaut (utilisé si le client n'en fournit pas)
DEFAULT_FPS = 24


def _parse_fps(raw, default=DEFAULT_FPS):
    """Convertit une valeur FPS reçue du client en entier valide (borné 1..240)."""
    try:
        fps = int(round(float(raw)))
    except (TypeError, ValueError):
        return default
    return max(1, min(240, fps))


@media_bp.route('/upload_image', methods=['POST'])
@cross_origin()
def get_upload_image():
    return upload_image(request)


@media_bp.route('/start_create_video', methods=['GET'])
@cross_origin()
def start_create_video():
    try:
        audio = request.args.get('audio')
        audio_volume = request.args.get('audio_volume', default='1.0')
        try:
            vol = float(audio_volume)
        except Exception:
            vol = 1.0
        # FPS configurable côté client : sans cela la vitesse de lecture est
        # fausse dès qu'on change le FPS (le client calcule les frames avec son FPS).
        fps = _parse_fps(request.args.get('fps'))
        result = assemble_pictures_directory("captured", default_video_output("mp4"), fps, audio_path=audio, audio_volume=vol)
        return result
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@media_bp.route('/clear_pictures_directory', methods=['POST'])
@cross_origin()
def clear_pictures():
    return clear_pictures_directory()


@media_bp.route('/assemble_pictures_directory', methods=['POST'])
@cross_origin()
def assemble_pictures():
    # FPS envoyé par le client (JSON ou query), sinon valeur par défaut
    raw_fps = None
    payload = request.get_json(silent=True) or {}
    if isinstance(payload, dict):
        raw_fps = payload.get('fps')
    if raw_fps is None:
        raw_fps = request.args.get('fps')
    fps = _parse_fps(raw_fps)
    return assemble_pictures_directory("captured", default_video_output("mp4"), fps)


@media_bp.route('/open_video_folder', methods=['POST'])
@cross_origin()
def route_open_video_folder():
    return open_video_folder()


@media_bp.route('/upload_video', methods=['POST'])
@cross_origin()
def route_upload_video():
    return upload_video(request)


@media_bp.route('/upload_audio', methods=['POST'])
@cross_origin()
def route_upload_audio():
    return upload_audio(request)
