import os

from flask import Blueprint, abort, jsonify, request, send_from_directory
from flask_cors import cross_origin
from werkzeug.utils import secure_filename

from capture import (
    TASK_TYPE_VIDEO,
    clear_pictures_directory,
    default_video_output,
    open_video_folder,
    process_recorded_video,
    run_assemble_video_task,
    upload_audio,
    upload_image,
    upload_video,
)
from task_manager import task_manager

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
        # Assemblage lancé en tâche de fond : évite l'expiration du fetch HTTP
        # sur les vidéos longues. Le client suit l'avancement via /tasks/<id>.
        output_video = default_video_output("mp4")
        status = task_manager.submit(
            TASK_TYPE_VIDEO, run_assemble_video_task,
            "captured", output_video, fps, audio, vol,
        )
        return jsonify({
            'success': True,
            'message': 'Assemblage vidéo lancé en tâche de fond',
            'task_id': status.id,
            'state': status.state,
        }), 202
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
    # Tâche de fond + suivi via /tasks/<id> (idem start_create_video)
    output_video = default_video_output("mp4")
    status = task_manager.submit(
        TASK_TYPE_VIDEO, run_assemble_video_task,
        "captured", output_video, fps,
    )
    return jsonify({
        'success': True,
        'message': 'Assemblage vidéo lancé en tâche de fond',
        'task_id': status.id,
        'state': status.state,
    }), 202


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


@media_bp.route('/process_recorded_video', methods=['POST'])
@cross_origin()
def route_process_recorded_video():
    # Post-traitement serveur (ffmpeg) d'un enregistrement MediaRecorder :
    # normalisation de la vitesse + mux audio en une passe, en tâche de fond.
    return process_recorded_video(request)


@media_bp.route('/download_video/<path:filename>', methods=['GET'])
@cross_origin()
def route_download_video(filename):
    # Sert un fichier du dossier video/ pour téléchargement navigateur.
    safe_name = secure_filename(os.path.basename(filename))
    if not safe_name:
        abort(404)
    video_dir = os.path.abspath('video')
    if not os.path.exists(os.path.join(video_dir, safe_name)):
        abort(404)
    return send_from_directory(video_dir, safe_name, as_attachment=True)
