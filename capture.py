from flask import jsonify, request
import os
import re
import base64
from datetime import datetime
import platform
import subprocess
from moviepy import ImageSequenceClip, AudioFileClip
from werkzeug.utils import secure_filename


def upload_image(request):
    try:
        # Vérifier si c'est du multipart/form-data (nouvelle méthode optimisée)
        if request.files and 'image' in request.files:
            image_file = request.files['image']
            counter = int(request.form.get('counter', 0))
            numberSize = int(request.form.get('numberSize', 4))

            # Utiliser le nom de fichier fourni ou en générer un
            if image_file.filename:
                image_filename = image_file.filename
            else:
                image_filename = f'image_{str(counter).zfill(numberSize)}.webp'

            # Sauvegarder directement le fichier binaire
            os.makedirs('captured', exist_ok=True)
            image_file.save(os.path.join('captured', image_filename))

        # Fallback pour l'ancienne méthode JSON/Base64 (compatibilité)
        elif request.is_json:
            data = request.json
            numberSize = int(data["numberSize"])
            image_data = base64.b64decode(data['image'].split(',')[1])
            counter = int(data['counter'])

            image_filename = f'image_{str(counter).zfill(numberSize)}.png'
            os.makedirs('captured', exist_ok=True)

            with open(os.path.join('captured/', image_filename), 'wb') as file:
                file.write(image_data)
        else:
            return jsonify({'success': False, 'message': 'Format de données non supporté'}), 400

        return jsonify({'success': True, 'message': 'Image reçue avec succès'})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


def open_video_folder():
    """Ouvre le dossier vidéo côté serveur (utile en déploiement local/desktop)."""
    try:
        folder = os.path.abspath('video')
        os.makedirs(folder, exist_ok=True)

        system = platform.system().lower()
        try:
            if system == 'windows':
                os.startfile(folder)  # type: ignore[attr-defined]
            elif system == 'darwin':
                subprocess.Popen(['open', folder])
            else:
                subprocess.Popen(['xdg-open', folder])
        except Exception:
            # Si l'ouverture échoue (serveur headless, etc.), on continue et on renvoie seulement le chemin
            pass

        return jsonify({'success': True, 'folder': folder})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


def clear_pictures_directory():
    directory_path = 'captured/'  # Chemin vers le répertoire à vider
    try:
        # Vérifiez si le répertoire existe pour éviter des erreurs
        if os.path.exists(directory_path):
            # Liste tous les fichiers dans le répertoire
            for filename in os.listdir(directory_path):
                file_path = os.path.join(directory_path, filename)
                try:
                    # Supprime chaque fichier trouvé
                    if os.path.isfile(file_path) or os.path.islink(file_path):
                        os.unlink(file_path)
                    elif os.path.isdir(file_path):
                        # Optionnel: Supprimer les sous-répertoires et leur contenu
                        # shutil.rmtree(file_path)
                        pass
                except Exception as e:
                    # En cas d'erreur lors de la suppression, renvoyer un message d'erreur
                    return jsonify({'success': False, 'message': str(e)})
        # Si tout s'est bien passé, renvoyer un succès
        return jsonify({'success': True, 'message': 'Le répertoire a été vidé avec succès'})
    except Exception as e:
        # Gérer les exceptions imprévues
        return jsonify({'success': False, 'message': str(e)})
    

def _timestamped_name(base: str, ext_fallback: str):
    """Return <base>_YYYYMMDD-HHMMSS.ext (ext from base or fallback)."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = base or "gcmap"
    name, ext = os.path.splitext(base)
    ext = ext.lstrip(".") or ext_fallback
    return f"{name}_{stamp}.{ext}"


def default_video_output(ext: str = "mp4"):
    """Return a default output path under video/ with timestamp."""
    base = f"gcmap.{ext}"
    return os.path.join("video", _timestamped_name(base, ext))


# Type de tâche de fond pour l'assemblage vidéo (utilisé par le TaskManager)
TASK_TYPE_VIDEO = "video_assembly"


# Logger optionnel qui relaie la progression d'encodage de MoviePy vers un TaskStatus.
# MoviePy s'appuie sur proglog ; on reste défensif si le module est absent.
try:
    from proglog import ProgressBarLogger

    class _StatusProgressLogger(ProgressBarLogger):
        """Relaie la progression d'encodage MoviePy vers un TaskStatus (bornée start..end)."""

        def __init__(self, status, start=10, end=99):
            super().__init__()
            self._status = status
            self._start = start
            self._end = end

        def bars_callback(self, bar, attr, value, old_value=None):
            if attr != 'index':
                return
            try:
                total = self.bars[bar].get('total') or 0
                if total <= 0:
                    return
                frac = max(0.0, min(1.0, value / total))
                pct = self._start + (self._end - self._start) * frac
                self._status.set_progress(pct, f"Encodage vidéo... {int(frac * 100)}%")
            except Exception:
                pass
except Exception:  # pragma: no cover - proglog devrait être fourni par moviepy
    ProgressBarLogger = None
    _StatusProgressLogger = None


def _assemble_pictures(image_folder, output_video, fps=24, audio_path=None, audio_volume=1.0, status=None):
    """Coeur de l'assemblage vidéo. Retourne un dict {'success', 'message', ...}.

    Met à jour un TaskStatus optionnel (`status`) pour le suivi de progression,
    ce qui permet de l'exécuter en tâche de fond sans bloquer la requête HTTP.
    """
    def _progress(p, msg):
        if status is not None:
            try:
                status.set_progress(p, msg)
            except Exception:
                pass

    # Inclure plusieurs formats d'images (webp par défaut côté client, mais aussi png et autres)
    exts = (".webp", ".png", ".jpg", ".jpeg")
    # Obtenez la liste des fichiers d'image dans le dossier
    image_files = [os.path.join(image_folder, img) for img in sorted(os.listdir(image_folder)) if img.lower().endswith(exts)]

    if not image_files:
        return {'success': False, 'message': 'Aucune image trouvée dans le dossier'}

    # Assurez-vous que le répertoire de sortie existe
    os.makedirs(os.path.dirname(output_video), exist_ok=True)

    _progress(5, "Préparation des images...")

    # Créez un clip vidéo à partir des images
    clip = ImageSequenceClip(image_files, fps=fps)
    audio_clip = None

    # Option: ajouter l'audio si fourni (audio_path est un nom de fichier dans 'audio/')
    print(f"[assemble] audio_path={audio_path!r} audio_volume={audio_volume!r}")
    if audio_path:
        try:
            os.makedirs('audio', exist_ok=True)
            safe_name = secure_filename(os.path.basename(audio_path))
            audio_file = os.path.join('audio', safe_name)
            print(f"[assemble] recherche audio: {audio_file} existe={os.path.exists(audio_file)}")
            if os.path.exists(audio_file):
                vol = 1.0
                try:
                    vol = max(0.0, float(audio_volume))
                except Exception:
                    vol = 1.0
                audio_clip = AudioFileClip(audio_file).with_volume_scaled(vol)
                if audio_clip.duration >= clip.duration:
                    audio_clip = audio_clip.subclipped(0, clip.duration)
                clip = clip.with_audio(audio_clip)
                print(f"[assemble] Audio attaché OK (vol={vol}, durée audio={audio_clip.duration:.1f}s, durée vidéo={clip.duration:.1f}s)")
            else:
                print(f"[assemble] FICHIER AUDIO INTROUVABLE: {audio_file}")
        except Exception as e:
            # En cas d'erreur audio, on continue avec la vidéo seule
            import traceback
            print(f"[assemble] Audio ignoré (ERREUR): {e}")
            traceback.print_exc()
    else:
        print("[assemble] Aucun audio demandé (audio_path vide)")

    _progress(10, "Encodage de la vidéo...")

    # Logger de progression si on suit une tâche de fond, sinon barre console MoviePy
    logger = 'bar'
    if status is not None and _StatusProgressLogger is not None:
        logger = _StatusProgressLogger(status)

    # Écrivez le clip vidéo dans un fichier
    # Codec 'libx264' + 'aac' pour compatibilité (nécessite ffmpeg)
    try:
        clip.write_videofile(output_video, fps=fps, codec='libx264', audio_codec='aac', logger=logger)
    finally:
        try:
            clip.close()
        except Exception:
            pass
        if audio_clip is not None:
            try:
                audio_clip.close()
            except Exception:
                pass

    _progress(100, "Vidéo créée avec succès")
    return {'success': True, 'message': 'Vidéo créée avec succès', 'output': output_video}


def assemble_pictures_directory(image_folder, output_video, fps=24, audio_path=None, audio_volume=1.0):
    """Assemblage synchrone (conservé pour compatibilité). Retourne une réponse JSON Flask."""
    try:
        result = _assemble_pictures(image_folder, output_video, fps, audio_path, audio_volume)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


def run_assemble_video_task(status, image_folder, output_video, fps=24, audio_path=None, audio_volume=1.0):
    """Tâche de fond : assemble la vidéo et met à jour la progression via TaskStatus.

    Exécutée par le TaskManager dans un thread, ce qui évite l'expiration du
    fetch HTTP côté client sur les assemblages longs (plusieurs minutes).
    """
    result = _assemble_pictures(image_folder, output_video, fps, audio_path, audio_volume, status=status)
    if not result.get('success'):
        status.fail(result.get('message', "Échec de l'assemblage"))
        return
    status.set_result(result)


# --------- Traitement vidéo MediaRecorder (normalisation vitesse + mux audio) ---------
# Type de tâche de fond pour le post-traitement d'un enregistrement MediaRecorder
TASK_TYPE_VIDEO_PROCESS = "video_processing"

_FFMPEG_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


def _get_ffmpeg_exe():
    """Chemin de l'exécutable ffmpeg fourni par imageio-ffmpeg (dépendance de moviepy)."""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"  # repli sur un ffmpeg système éventuel


def _probe_duration_seconds(input_path):
    """Durée du média en secondes, lue depuis l'en-tête via ffmpeg. None si inconnue."""
    try:
        proc = subprocess.run(
            [_get_ffmpeg_exe(), '-i', input_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            universal_newlines=True, encoding='utf-8', errors='replace',
        )
        m = _FFMPEG_DURATION_RE.search(proc.stderr or '')
        if m:
            h, mn, s = m.groups()
            return int(h) * 3600 + int(mn) * 60 + float(s)
    except Exception as e:
        print(f"[process] probe durée échoué: {e}")
    return None


def _process_recorded_video(input_path, output_path, slowdown=1.0, audio_path=None, audio_volume=1.0, fps=None, status=None):
    """Normalise la vitesse (setpts) et mux l'audio en UNE passe ffmpeg → MP4 H.264/AAC.

    Remplace l'ancien pipeline navigateur (jusqu'à 3 ré-encodages temps réel,
    onglet actif obligatoire). Met à jour un TaskStatus optionnel pour la progression.
    """
    def _progress(p, msg):
        if status is not None:
            try:
                status.set_progress(p, msg)
            except Exception:
                pass

    if not input_path or not os.path.exists(input_path):
        return {'success': False, 'message': 'Fichier vidéo introuvable'}

    try:
        sd = max(1.0, float(slowdown))
    except Exception:
        sd = 1.0
    try:
        vol = max(0.0, float(audio_volume))
    except Exception:
        vol = 1.0
    # fps de sortie : setpts accélère la vidéo sans redécimer (le framerate serait
    # multiplié par sd). On force le fps cible pour un résultat propre et compact.
    try:
        out_fps = int(round(float(fps))) if fps else None
        if out_fps is not None:
            out_fps = max(1, min(120, out_fps))
    except Exception:
        out_fps = None

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    ffmpeg = _get_ffmpeg_exe()

    # Résoudre le fichier audio (nom de fichier attendu dans audio/)
    audio_file = None
    if audio_path:
        safe_name = secure_filename(os.path.basename(audio_path))
        candidate = os.path.join('audio', safe_name)
        if os.path.exists(candidate):
            audio_file = candidate
        else:
            print(f"[process] audio introuvable, vidéo seule: {candidate}")

    # Durée de sortie attendue (pour la progression) = durée brute / facteur de ralentissement
    in_dur = _probe_duration_seconds(input_path)
    out_dur = (in_dur / sd) if (in_dur and sd > 0) else None

    # Construire la commande ffmpeg (une seule passe).
    # setpts=PTS/sd accélère la vidéo de sd pour revenir à la vitesse normale.
    cmd = [ffmpeg, '-y', '-i', input_path]
    if audio_file:
        cmd += ['-i', audio_file]
        if out_dur and out_dur > 0:
            # Durée vidéo connue : on borne la sortie à out_dur avec -t et on complète
            # l'audio par du silence (apad) si besoin. On N'utilise PAS -shortest avec apad
            # (l'audio paddé devient infini et -shortest ne le coupe pas de façon fiable
            # en filter_complex → encodage sans fin).
            cmd += [
                '-filter_complex', f"[0:v]setpts=PTS/{sd}[v];[1:a]volume={vol},apad[a]",
                '-map', '[v]', '-map', '[a]',
                '-t', f"{out_dur:.3f}",
                '-c:a', 'aac', '-b:a', '192k',
            ]
        else:
            # Durée inconnue : pas d'apad (sinon infini) ; -shortest coupe au flux le plus court.
            cmd += [
                '-filter_complex', f"[0:v]setpts=PTS/{sd}[v];[1:a]volume={vol}[a]",
                '-map', '[v]', '-map', '[a]',
                '-c:a', 'aac', '-b:a', '192k',
                '-shortest',
            ]
    else:
        cmd += ['-filter:v', f"setpts=PTS/{sd}", '-an']
    if out_fps:
        cmd += ['-r', str(out_fps)]
    cmd += [
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats',
        output_path,
    ]

    _progress(2, "Démarrage du traitement vidéo...")
    try:
        print("[process] ffmpeg:", " ".join(cmd))
    except Exception:
        pass

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True, encoding='utf-8', errors='replace',
    )

    tail_lines = []  # dernières lignes non-progress (pour message d'erreur)
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        if line.startswith('out_time_us=') or line.startswith('out_time_ms='):
            try:
                micros = float(line.split('=', 1)[1])
                cur = micros / 1_000_000.0
                if out_dur and out_dur > 0:
                    frac = max(0.0, min(1.0, cur / out_dur))
                    _progress(2 + frac * 96, f"Traitement vidéo... {int(frac * 100)}%")
                else:
                    _progress(50, "Traitement vidéo en cours...")
            except Exception:
                pass
        elif not line.startswith(('frame=', 'fps=', 'bitrate=', 'total_size=',
                                  'out_time=', 'dup_frames=', 'drop_frames=',
                                  'speed=', 'progress=', 'stream_')):
            tail_lines.append(line)
            if len(tail_lines) > 60:
                tail_lines.pop(0)

    # Fermer explicitement le pipe : les traitements répétés ne doivent pas
    # accumuler de descripteurs jusqu'au prochain passage du ramasse-miettes.
    if proc.stdout is not None:
        proc.stdout.close()
    proc.wait()
    if proc.returncode != 0:
        msg = "\n".join(tail_lines[-8:]) or f"ffmpeg a échoué (code {proc.returncode})"
        return {'success': False, 'message': f"Traitement ffmpeg échoué: {msg}"}

    # Nettoyer le .webm brut temporaire une fois le MP4 produit
    try:
        os.remove(input_path)
    except Exception:
        pass

    _progress(100, "Vidéo prête")
    return {
        'success': True,
        'message': 'Vidéo traitée avec succès',
        'output': output_path,
        'file': os.path.basename(output_path),
    }


def run_process_video_task(status, input_path, output_path, slowdown=1.0, audio_path=None, audio_volume=1.0, fps=None):
    """Tâche de fond : post-traite un enregistrement MediaRecorder via ffmpeg."""
    result = _process_recorded_video(input_path, output_path, slowdown, audio_path, audio_volume, fps=fps, status=status)
    if not result.get('success'):
        status.fail(result.get('message', "Échec du traitement vidéo"))
        return
    status.set_result(result)


def process_recorded_video(request):
    """Réceptionne le .webm brut (+ options) et lance le traitement ffmpeg en tâche de fond.

    Champs multipart attendus:
      - 'video': le .webm brut du MediaRecorder (obligatoire)
      - 'audio' (fichier) OU 'audio' (nom déjà présent dans audio/) : piste audio optionnelle
      - 'slowdown', 'audio_volume', 'fileName' : options
    """
    from task_manager import task_manager

    if not request.files or 'video' not in request.files:
        return jsonify({'success': False, 'message': 'Aucun fichier vidéo fourni'}), 400

    os.makedirs('video', exist_ok=True)
    raw_name = _timestamped_name("gcmap_raw.webm", "webm")
    raw_path = os.path.join('video', raw_name)
    request.files['video'].save(raw_path)

    # Audio : soit un fichier uploadé ici, soit un nom déjà présent dans audio/
    audio_path = None
    if 'audio' in request.files and request.files['audio'].filename:
        af = request.files['audio']
        os.makedirs('audio', exist_ok=True)
        aname = secure_filename(af.filename or 'music.mp3')
        af.save(os.path.join('audio', aname))
        audio_path = aname
    else:
        audio_path = request.form.get('audio') or None

    def _num(name, default):
        try:
            return float(request.form.get(name, default))
        except Exception:
            return default

    slowdown = _num('slowdown', 1.0)
    audio_volume = _num('audio_volume', 1.0)
    fps = _num('fps', 0) or None

    # Nom de sortie basé sur fileName fourni, forcé en .mp4
    suggested = request.form.get('fileName')
    if suggested:
        base = os.path.splitext(secure_filename(suggested))[0] + '.mp4'
        out_path = os.path.join('video', _timestamped_name(base, 'mp4'))
    else:
        out_path = default_video_output('mp4')

    status = task_manager.submit(
        TASK_TYPE_VIDEO_PROCESS, run_process_video_task,
        raw_path, out_path, slowdown, audio_path, audio_volume, fps,
    )
    return jsonify({
        'success': True,
        'message': 'Traitement vidéo lancé en tâche de fond',
        'task_id': status.id,
        'state': status.state,
    }), 202


def upload_video(request):
    """Réceptionne un fichier vidéo (ex: .webm) via multipart/form-data et l'enregistre dans le dossier video/.

    Champs attendus:
      - 'video': le fichier binaire
      - 'fileName' (optionnel): nom suggéré; sinon fallback sur nom horodaté
    """
    try:
        if not request.files or 'video' not in request.files:
            return jsonify({'success': False, 'message': 'Aucun fichier vidéo fourni'}), 400

        video_file = request.files['video']
        suggested = request.form.get('fileName') or video_file.filename

        # Sécuriser le nom fourni et horodater si absent
        safe_suggested = secure_filename(suggested) if suggested else None
        base = safe_suggested or _timestamped_name("gcmap.webm", "webm")
        ext = os.path.splitext(base)[1].lstrip(".") or "webm"

        os.makedirs('video', exist_ok=True)
        save_path = os.path.join('video', base)

        # Si le fichier existe déjà, suffixer avec un horodatage pour éviter l'écrasement
        if os.path.exists(save_path):
            file_name = _timestamped_name(base, ext)
            save_path = os.path.join('video', file_name)
        else:
            file_name = base
        video_file.save(save_path)

        return jsonify({'success': True, 'message': 'Vidéo reçue et sauvegardée', 'path': save_path})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


def upload_audio(request):
    """Réceptionne un fichier audio via multipart/form-data et l'enregistre dans audio/.

    Champs attendus:
      - 'audio': le fichier binaire
    Retourne:
      - { success: true, file: <nom de fichier>, path: <chemin> }
    """
    try:
        if not request.files or 'audio' not in request.files:
            return jsonify({'success': False, 'message': 'Aucun fichier audio fourni'}), 400

        audio_file = request.files['audio']
        file_name = secure_filename(audio_file.filename or 'music.mp3')
        os.makedirs('audio', exist_ok=True)
        save_path = os.path.join('audio', file_name)
        audio_file.save(save_path)
        return jsonify({'success': True, 'file': file_name, 'path': save_path})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500
