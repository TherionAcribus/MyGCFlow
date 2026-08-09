from flask import jsonify, request
import os
import re
import base64
from datetime import datetime
import platform
import subprocess
import tempfile
import threading
import time
from werkzeug.utils import secure_filename


CAPTURED_DIR = 'captured'


def _to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _save_uploaded_image(image_file, counter, number_size):
    """Écrit une image reçue en multipart dans captured/ et renvoie son nom de fichier.

    Le nom vient du client : `secure_filename` neutralise les traversées de chemin
    (..\\..\\x.webp) et peut renvoyer une chaîne vide sur un nom entièrement
    invalide → on retombe alors sur le compteur.
    """
    image_filename = secure_filename(image_file.filename or '')
    if not image_filename:
        image_filename = f'image_{str(counter).zfill(number_size)}.webp'

    os.makedirs(CAPTURED_DIR, exist_ok=True)
    image_file.save(os.path.join(CAPTURED_DIR, image_filename))
    return image_filename


def upload_images(request):
    """Réception groupée : plusieurs images dans un seul multipart.

    Le mode « images » produit une frame par capture (potentiellement des milliers) :
    une requête par image sature le serveur de dev Flask (mono-thread) en overhead
    HTTP pur. Un lot de N images ne coûte plus qu'un aller-retour.

    L'écriture étant nommée par compteur, un nouvel essai du même lot est idempotent :
    en cas d'erreur en cours de lot, le client peut le renvoyer entièrement.
    """
    try:
        image_files = request.files.getlist('images') if request.files else []
        if not image_files:
            return jsonify({'success': False, 'message': 'Aucune image dans la requête'}), 400

        counters = request.form.getlist('counters')
        number_size = _to_int(request.form.get('numberSize', 4), 4)

        saved = []
        for index, image_file in enumerate(image_files):
            counter = _to_int(counters[index], index) if index < len(counters) else index
            saved.append(_save_uploaded_image(image_file, counter, number_size))

        return jsonify({'success': True, 'count': len(saved), 'files': saved})

    except Exception as e:
        # Le client retentera le lot complet (écritures idempotentes).
        return jsonify({'success': False, 'message': str(e)}), 500


def upload_image(request):
    try:
        # Vérifier si c'est du multipart/form-data (nouvelle méthode optimisée)
        if request.files and 'image' in request.files:
            image_file = request.files['image']
            counter = _to_int(request.form.get('counter', 0))
            numberSize = _to_int(request.form.get('numberSize', 4), 4)
            _save_uploaded_image(image_file, counter, numberSize)

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


# --------- Socle ffmpeg commun aux deux pipelines vidéo ---------
# Les deux pipelines (assemblage d'images et post-traitement MediaRecorder) lancent
# un ffmpeg en une passe : ils partagent ici le lancement, le watchdog anti-blocage,
# le relais de progression et la remontée d'erreur.

_FFMPEG_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")

# Watchdog : avec '-progress pipe:1', ffmpeg écrit un bloc de progression toutes les
# ~0,5 s. Une absence totale de sortie pendant ce délai signale un processus figé
# (entrée corrompue) : sans watchdog, `for line in proc.stdout` bloque indéfiniment
# et le worker qui exécute la tâche est perdu pour toujours.
FFMPEG_STALL_TIMEOUT_S = 300      # 5 min sans la moindre ligne → on tue ffmpeg
FFMPEG_WATCHDOG_INTERVAL_S = 5    # période de vérification du watchdog
# Garde-fou sur la lecture d'en-tête (ffmpeg -i) : même entrée corrompue, même risque.
FFMPEG_PROBE_TIMEOUT_S = 60

# Réglages d'encodage partagés : une seule définition pour que les deux pipelines
# produisent des fichiers comparables (qualité, compatibilité, lecture en streaming).
_H264_OUTPUT_ARGS = [
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
]
_AAC_OUTPUT_ARGS = ['-c:a', 'aac', '-b:a', '192k']

# libx264 en yuv420p exige des dimensions paires : le sous-échantillonnage de la
# chrominance travaille par blocs de 2x2 pixels. Une capture en largeur ou hauteur
# impaire (fenêtre navigateur quelconque, canvas non arrondi) fait échouer l'encodeur
# avec « Could not open encoder before EOF / Invalid argument », sans que le message
# ne mentionne les dimensions. On rogne donc au multiple de 2 inférieur.
# `crop` plutôt que `scale` : on perd au pire une ligne et une colonne de bordure,
# là où une mise à l'échelle rééchantillonnerait toute l'image (texte et traits de
# carte adoucis) pour un seul pixel de trop.
_EVEN_DIMENSIONS_FILTER = "crop=trunc(iw/2)*2:trunc(ih/2)*2"

# Lignes de '-progress pipe:1' à ignorer dans la collecte des messages d'erreur.
_FFMPEG_PROGRESS_KEYS = (
    'frame=', 'fps=', 'bitrate=', 'total_size=', 'out_time=', 'dup_frames=',
    'drop_frames=', 'speed=', 'progress=', 'stream_',
)


def _get_ffmpeg_exe():
    """Chemin de l'exécutable ffmpeg fourni par imageio-ffmpeg."""
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
            timeout=FFMPEG_PROBE_TIMEOUT_S,
        )
        m = _FFMPEG_DURATION_RE.search(proc.stderr or '')
        if m:
            h, mn, s = m.groups()
            return int(h) * 3600 + int(mn) * 60 + float(s)
    except Exception as e:
        print(f"[ffmpeg] probe durée échoué: {e}")
    return None


def _safe_volume(audio_volume):
    """Volume audio normalisé (float >= 0), 1.0 si la valeur est inexploitable."""
    try:
        return max(0.0, float(audio_volume))
    except (TypeError, ValueError):
        return 1.0


def _resolve_audio_file(audio_path, log_prefix='ffmpeg'):
    """Chemin de la piste audio dans audio/, ou None si absente/non demandée.

    `audio_path` est un nom de fichier fourni par le client : `secure_filename`
    neutralise toute traversée de chemin avant la lecture.
    """
    if not audio_path:
        return None
    safe_name = secure_filename(os.path.basename(audio_path))
    candidate = os.path.join('audio', safe_name)
    if os.path.exists(candidate):
        return candidate
    print(f"[{log_prefix}] audio introuvable, vidéo seule: {candidate}")
    return None


def _run_ffmpeg(cmd, out_dur=None, status=None, progress_start=2.0, progress_end=98.0,
                progress_label="Traitement vidéo", error_label="Traitement ffmpeg",
                log_prefix="ffmpeg"):
    """Exécute ffmpeg en relayant sa progression, avec watchdog anti-blocage.

    `cmd` doit se terminer par '-progress pipe:1 -nostats <sortie>'. La progression
    est bornée à [progress_start, progress_end] et n'est calculable que si `out_dur`
    (durée attendue de la sortie, en secondes) est connue.

    Retourne {'success': bool, 'message': str}.
    """
    def _progress(p, msg):
        if status is not None:
            try:
                status.set_progress(p, msg)
            except Exception:
                pass

    try:
        print(f"[{log_prefix}] ffmpeg:", " ".join(cmd))
    except Exception:
        pass

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True, encoding='utf-8', errors='replace',
    )

    # Watchdog : tue ffmpeg s'il n'émet plus rien pendant FFMPEG_STALL_TIMEOUT_S.
    # Le pipe se ferme alors et la boucle de lecture ci-dessous se termine d'elle-même,
    # ce qui libère le worker au lieu de le bloquer indéfiniment.
    last_output = time.monotonic()
    stalled = threading.Event()
    finished = threading.Event()

    def _watchdog():
        while not finished.wait(FFMPEG_WATCHDOG_INTERVAL_S):
            if time.monotonic() - last_output > FFMPEG_STALL_TIMEOUT_S:
                stalled.set()
                try:
                    proc.kill()
                except Exception:
                    pass
                return

    threading.Thread(target=_watchdog, daemon=True).start()

    span = max(0.0, progress_end - progress_start)
    tail_lines = []  # dernières lignes non-progress (pour message d'erreur)
    try:
        for line in proc.stdout:
            last_output = time.monotonic()
            line = line.strip()
            if not line:
                continue
            if line.startswith('out_time_us=') or line.startswith('out_time_ms='):
                try:
                    micros = float(line.split('=', 1)[1])
                    cur = micros / 1_000_000.0
                    if out_dur and out_dur > 0:
                        frac = max(0.0, min(1.0, cur / out_dur))
                        _progress(progress_start + frac * span, f"{progress_label}... {int(frac * 100)}%")
                    else:
                        _progress(progress_start + span / 2, f"{progress_label} en cours...")
                except Exception:
                    pass
            elif not line.startswith(_FFMPEG_PROGRESS_KEYS):
                tail_lines.append(line)
                if len(tail_lines) > 60:
                    tail_lines.pop(0)
    finally:
        # Arrêter le watchdog même si la lecture lève, puis fermer explicitement le pipe :
        # les traitements répétés ne doivent pas accumuler de descripteurs jusqu'au
        # prochain passage du ramasse-miettes.
        finished.set()
        if proc.stdout is not None:
            proc.stdout.close()

    try:
        proc.wait(timeout=FFMPEG_WATCHDOG_INTERVAL_S * 4)
    except subprocess.TimeoutExpired:
        # Flux fermé mais ffmpeg toujours vivant : le watchdog est arrêté, on ne laisse
        # pas wait() bloquer le worker à son tour.
        print(f"[{log_prefix}] ffmpeg ne se termine pas après fermeture du flux → processus tué")
        try:
            proc.kill()
            proc.wait(timeout=10)
        except Exception:
            pass
        return {'success': False, 'message': f"{error_label} interrompu : le processus ne s'est pas terminé."}

    if stalled.is_set():
        minutes = max(1, int(FFMPEG_STALL_TIMEOUT_S // 60))
        print(f"[{log_prefix}] ffmpeg figé (aucune progression pendant {minutes} min) → processus tué")
        return {
            'success': False,
            'message': (f"{error_label} interrompu : aucune progression pendant {minutes} min. "
                        "Le fichier source est probablement corrompu."),
        }
    if proc.returncode != 0:
        msg = "\n".join(tail_lines[-8:]) or f"ffmpeg a échoué (code {proc.returncode})"
        return {'success': False, 'message': f"{error_label} échoué: {msg}"}

    return {'success': True, 'message': 'ok'}


# --------- Assemblage d'une séquence d'images (pipeline « images ») ---------
# Type de tâche de fond pour l'assemblage vidéo (utilisé par le TaskManager)
TASK_TYPE_VIDEO = "video_assembly"


def _concat_quote(path):
    """Chemin absolu échappé pour une entrée `file` d'un script ffconcat.

    Les séparateurs Windows sont convertis en '/' : dans un script concat, la
    contre-oblique est un caractère d'échappement.
    """
    absolute = os.path.abspath(path).replace('\\', '/')
    return "'" + absolute.replace("'", "'\\''") + "'"


def _write_concat_list(image_files, fps, list_path):
    """Écrit le script ffconcat décrivant la séquence d'images.

    On passe par une liste explicite plutôt que par un motif `image_%04d` (démuxeur
    image2) parce que le contenu de captured/ n'est pas assez régulier : les noms
    viennent du client, la largeur de numérotation est un paramètre client, et le
    dossier peut mélanger .webp/.png/.jpg. Surtout, image2 s'arrête au premier index
    manquant *sans code d'erreur* : un seul upload perdu produirait une vidéo
    tronquée silencieusement.
    """
    frame_duration = 1.0 / fps
    with open(list_path, 'w', encoding='utf-8') as handle:
        handle.write("ffconcat version 1.0\n")
        for path in image_files:
            handle.write(f"file {_concat_quote(path)}\n")
            handle.write(f"duration {frame_duration:.9f}\n")
        # Le démuxeur concat ignore la durée déclarée de la dernière entrée : on la
        # répète pour que l'image finale dure elle aussi une frame. L'option -t borne
        # ensuite la sortie, ce qui rend cette répétition sans effet sur la durée.
        handle.write(f"file {_concat_quote(image_files[-1])}\n")


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

    try:
        fps_value = int(round(float(fps)))
    except (TypeError, ValueError):
        fps_value = 24
    fps_value = max(1, min(120, fps_value))

    # Durée exacte de la sortie : contrairement au pipeline MediaRecorder, elle est
    # déterminée par le nombre d'images, aucun sondage du média n'est nécessaire.
    out_dur = len(image_files) / fps_value

    # Option : ajouter l'audio si fourni (audio_path est un nom de fichier dans 'audio/')
    print(f"[assemble] audio_path={audio_path!r} audio_volume={audio_volume!r}")
    audio_file = _resolve_audio_file(audio_path, log_prefix='assemble')
    vol = _safe_volume(audio_volume)

    ffmpeg = _get_ffmpeg_exe()
    # Le script ffconcat est temporaire et propre à cet encodage : il ne doit pas
    # atterrir dans captured/, que le client vide dès l'assemblage terminé.
    handle, list_path = tempfile.mkstemp(prefix='gcmap_concat_', suffix='.ffconcat', text=True)
    os.close(handle)

    try:
        _write_concat_list(image_files, fps_value, list_path)

        # -safe 0 : le script contient des chemins absolus, refusés par défaut.
        cmd = [ffmpeg, '-y', '-f', 'concat', '-safe', '0', '-i', list_path]
        if audio_file:
            # apad complète l'audio par du silence s'il est plus court que la vidéo ;
            # -t borne la sortie à la durée vidéo, ce qui coupe aussi un audio plus long.
            # On n'utilise PAS -shortest avec apad (l'audio paddé devient infini).
            cmd += [
                '-i', audio_file,
                '-filter_complex', f"[0:v]{_EVEN_DIMENSIONS_FILTER}[v];[1:a]volume={vol},apad[a]",
                '-map', '[v]', '-map', '[a]',
            ] + _AAC_OUTPUT_ARGS
            print(f"[assemble] Audio attaché (vol={vol}, durée vidéo={out_dur:.1f}s)")
        else:
            cmd += ['-filter:v', _EVEN_DIMENSIONS_FILTER, '-an']
        cmd += ['-t', f"{out_dur:.6f}", '-r', str(fps_value)]
        cmd += _H264_OUTPUT_ARGS
        cmd += ['-progress', 'pipe:1', '-nostats', output_video]

        _progress(10, "Encodage de la vidéo...")
        result = _run_ffmpeg(
            cmd, out_dur=out_dur, status=status,
            progress_start=10, progress_end=99,
            progress_label="Encodage vidéo", error_label="Assemblage ffmpeg",
            log_prefix="assemble",
        )
    finally:
        try:
            os.remove(list_path)
        except OSError:
            pass

    if not result.get('success'):
        return result

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
    vol = _safe_volume(audio_volume)
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
    audio_file = _resolve_audio_file(audio_path, log_prefix='process')

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
                '-filter_complex',
                f"[0:v]setpts=PTS/{sd},{_EVEN_DIMENSIONS_FILTER}[v];[1:a]volume={vol},apad[a]",
                '-map', '[v]', '-map', '[a]',
                '-t', f"{out_dur:.3f}",
            ] + _AAC_OUTPUT_ARGS
        else:
            # Durée inconnue : pas d'apad (sinon infini) ; -shortest coupe au flux le plus court.
            cmd += [
                '-filter_complex',
                f"[0:v]setpts=PTS/{sd},{_EVEN_DIMENSIONS_FILTER}[v];[1:a]volume={vol}[a]",
                '-map', '[v]', '-map', '[a]',
            ] + _AAC_OUTPUT_ARGS + ['-shortest']
    else:
        cmd += ['-filter:v', f"setpts=PTS/{sd},{_EVEN_DIMENSIONS_FILTER}", '-an']
    if out_fps:
        cmd += ['-r', str(out_fps)]
    cmd += _H264_OUTPUT_ARGS
    cmd += ['-progress', 'pipe:1', '-nostats', output_path]

    _progress(2, "Démarrage du traitement vidéo...")
    result = _run_ffmpeg(
        cmd, out_dur=out_dur, status=status,
        progress_start=2, progress_end=98,
        progress_label="Traitement vidéo", error_label="Traitement ffmpeg",
        log_prefix="process",
    )
    if not result.get('success'):
        return result

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
