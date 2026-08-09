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
from task_manager import TaskAlreadyRunning, task_manager

media_bp = Blueprint('media', __name__)

# FPS d'assemblage par défaut (utilisé si le client n'en fournit pas)
DEFAULT_FPS = 30


def _parse_fps(raw, default=DEFAULT_FPS):
    """Convertit une valeur FPS reçue du client en entier valide (borné 1..60)."""
    try:
        fps = int(round(float(raw)))
    except (TypeError, ValueError):
        return default
    return max(1, min(60, fps))


def _busy_response(running, message):
    """Réponse 409 pour une opération en conflit avec un assemblage en cours.

    Volontairement sans champ `task_id` : les clients l'utilisent pour suivre
    *leur* tâche, et le renvoyer ici les ferait suivre celle d'un autre puis
    conclure à tort que leur propre demande a abouti. L'identifiant est exposé
    sous `running_task_id` à titre informatif.
    """
    return jsonify({
        'success': False,
        'busy': True,
        'message': message,
        'running_task_id': running.id if running else None,
        'progress': running.progress if running else None,
    }), 409


# Message unique pour les deux points d'entrée d'assemblage
_BUSY_MESSAGE = (
    "Un assemblage vidéo est déjà en cours. Attendez sa fin avant d'en lancer "
    "un autre ou de relancer une capture (les deux utilisent le dossier captured/)."
)


@media_bp.route('/upload_image', methods=['POST'])
@cross_origin()
def get_upload_image():
    return upload_image(request)


# POST et non GET : la route déclenche un encodage (effet de bord durable). En
# GET, un préchargement de lien, un scanner d'URL ou une simple réouverture
# d'historique suffisait à lancer un assemblage.
@media_bp.route('/start_create_video', methods=['POST'])
@cross_origin()
def start_create_video():
    try:
        # Paramètres en JSON, avec repli sur la query string (idem
        # /assemble_pictures_directory) pour rester tolérant côté client.
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            payload = {}

        def _param(key, default=None):
            value = payload.get(key)
            if value is None:
                value = request.args.get(key)
            return default if value is None else value

        audio = _param('audio')
        try:
            vol = float(_param('audio_volume', 1.0))
        except (TypeError, ValueError):
            vol = 1.0
        # FPS configurable côté client : sans cela la vitesse de lecture est
        # fausse dès qu'on change le FPS (le client calcule les frames avec son FPS).
        fps = _parse_fps(_param('fps'))
        # Assemblage lancé en tâche de fond : évite l'expiration du fetch HTTP
        # sur les vidéos longues. Le client suit l'avancement via /tasks/<id>.
        output_video = default_video_output("mp4")
        # exclusive : deux assemblages simultanés liraient le même dossier captured/
        try:
            status = task_manager.submit(
                TASK_TYPE_VIDEO, run_assemble_video_task,
                "captured", output_video, fps, audio, vol,
                exclusive=True,
            )
        except TaskAlreadyRunning as exc:
            return _busy_response(exc.status, _BUSY_MESSAGE)
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
    # Vider captured/ pendant un assemblage supprimerait les images sous les pieds
    # de ffmpeg (la liste est figée au démarrage, mais les fichiers sont lus au
    # fil de l'encodage) → échec en plein encodage.
    running = task_manager.get_active(TASK_TYPE_VIDEO)
    if running is not None:
        return _busy_response(
            running,
            "Un assemblage vidéo est en cours : le dossier captured/ ne peut pas "
            "être vidé maintenant.",
        )
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
    try:
        status = task_manager.submit(
            TASK_TYPE_VIDEO, run_assemble_video_task,
            "captured", output_video, fps,
            exclusive=True,
        )
    except TaskAlreadyRunning as exc:
        return _busy_response(exc.status, _BUSY_MESSAGE)
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
