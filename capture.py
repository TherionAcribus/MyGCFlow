from flask import current_app, jsonify, request
from flask_babel import gettext as _babel_gettext, force_locale


def _(msgid, **kwargs):
    """gettext avec repli sur le msgid brut quand Babel n'est pas initialisé
    (tests unitaires sur une app Flask nue)."""
    try:
        return _babel_gettext(msgid, **kwargs)
    except Exception:
        return msgid % kwargs if kwargs else msgid
import os
import re
import base64
import shutil
import uuid
from datetime import datetime
from pathlib import Path
import platform
import subprocess
import tempfile
import threading
import time
from werkzeug.utils import secure_filename

import paths
import recycle_bin
from localization import get_locale


# Formats écrits dans captured/ : webp par défaut côté client, png pour l'ancien
# envoi base64. Sert autant à l'assemblage qu'au comptage des images restantes.
CAPTURED_IMAGE_EXTENSIONS = ('.webp', '.png', '.jpg', '.jpeg')


def _to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def captured_session_dir(session=None):
    """Dossier d'images d'une session de capture (Path, non créé).

    Chaque enregistrement envoie un identifiant : ses frames vivent dans un
    sous-dossier de captured/, ce qui isole les captures successives — un upload
    tardif de la session précédente atterrit dans son propre dossier au lieu de
    se mélanger à la capture en cours. `secure_filename` borne le nom à un
    sous-dossier direct (pas de traversée de chemin), et la vérification du
    chemin résolu couvre les cas exotiques. Sans session (ancien client, route
    unitaire de compatibilité) : captured/ lui-même, comme avant.
    """
    root = paths.captured_dir()
    safe = secure_filename(session or '')
    if not safe or safe in ('.', '..'):
        return root
    candidate = (root / safe).resolve()
    if candidate.parent != root.resolve():
        return root
    return candidate


def _save_uploaded_image(image_file, counter, number_size, session=None):
    """Écrit une image reçue en multipart dans la session de capture et renvoie son nom de fichier.

    Le nom vient du client : `secure_filename` neutralise les traversées de chemin
    (..\\..\\x.webp) et peut renvoyer une chaîne vide sur un nom entièrement
    invalide → on retombe alors sur le compteur.
    """
    image_filename = secure_filename(image_file.filename or '')
    if not image_filename:
        image_filename = f'image_{str(counter).zfill(number_size)}.webp'

    image_file.save(os.path.join(paths.ensure_dir(captured_session_dir(session)), image_filename))
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
            return jsonify({'success': False, 'message': _('Aucune image dans la requête')}), 400

        counters = request.form.getlist('counters')
        number_size = _to_int(request.form.get('numberSize', 4), 4)
        session = request.form.get('session')

        saved = []
        for index, image_file in enumerate(image_files):
            counter = _to_int(counters[index], index) if index < len(counters) else index
            saved.append(_save_uploaded_image(image_file, counter, number_size, session))

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
            _save_uploaded_image(image_file, counter, numberSize, request.form.get('session'))

        # Fallback pour l'ancienne méthode JSON/Base64 (compatibilité)
        elif request.is_json:
            data = request.json
            numberSize = int(data["numberSize"])
            image_data = base64.b64decode(data['image'].split(',')[1])
            counter = int(data['counter'])

            image_filename = f'image_{str(counter).zfill(numberSize)}.png'
            session_dir = paths.ensure_dir(captured_session_dir(data.get('session')))
            with open(os.path.join(session_dir, image_filename), 'wb') as file:
                file.write(image_data)
        else:
            return jsonify({'success': False, 'message': _('Format de données non supporté')}), 400

        return jsonify({'success': True, 'message': _('Image reçue avec succès')})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


def _open_with_system(path):
    """Ouvre un dossier ou un fichier avec l'application associée du système."""
    system = platform.system().lower()
    if system == 'windows':
        os.startfile(path)  # type: ignore[attr-defined]
    elif system == 'darwin':
        subprocess.Popen(['open', path])
    else:
        subprocess.Popen(['xdg-open', path])


def open_video_folder():
    """Ouvre le dossier vidéo côté serveur (utile en déploiement local/desktop)."""
    try:
        folder = str(paths.ensure_dir(paths.video_dir()))

        try:
            _open_with_system(folder)
        except Exception:
            # Si l'ouverture échoue (serveur headless, etc.), on continue et on renvoie seulement le chemin
            pass

        return jsonify({'success': True, 'folder': folder})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


def describe_video(path):
    """Ce que l'écran « Vidéo prête » affiche d'un fichier produit : nom, dossier,
    taille et durée. Les champs illisibles valent None plutôt que de faire
    échouer un export par ailleurs réussi."""
    path = str(path)
    try:
        size = os.path.getsize(path)
    except OSError:
        size = None
    return {
        'file': os.path.basename(path),
        'folder': os.path.dirname(path),
        'size_bytes': size,
        'duration_seconds': _probe_duration_seconds(path),
    }


def resolve_video_file(name):
    """Chemin d'une vidéo du dossier des vidéos à partir de son nom, None si absente.

    secure_filename réduit l'entrée à un nom simple : aucune traversée hors du
    dossier n'est possible, quel que soit ce que le client envoie.
    """
    safe_name = secure_filename(os.path.basename(str(name or '')))
    if not safe_name:
        return None
    path = os.path.join(str(paths.video_dir()), safe_name)
    return path if os.path.isfile(path) else None


# Vidéos proposées dans « Dernières vidéos » : les conteneurs que l'application
# produit. Le préfixe écarte les .webm bruts que les versions antérieures
# déposaient dans ce dossier et qu'un traitement échoué a pu y laisser.
RECENT_VIDEO_EXTENSIONS = ('.mp4', '.webm')
RAW_VIDEO_PREFIX = 'mygcflow_raw'
RECENT_VIDEOS_DEFAULT_LIMIT = 8
RECENT_VIDEOS_MAX_LIMIT = 50


def list_recent_videos(limit=RECENT_VIDEOS_DEFAULT_LIMIT):
    """Vidéos du dossier des vidéos, de la plus récente à la plus ancienne.

    Sans la durée : la lire demanderait un ffmpeg par fichier à chaque
    affichage de l'onglet. Ne retient que les fichiers que resolve_video_file()
    sait retrouver, pour que chaque ligne affichée soit actionnable.
    """
    limit = max(1, min(RECENT_VIDEOS_MAX_LIMIT, _to_int(limit, RECENT_VIDEOS_DEFAULT_LIMIT)))
    folder = paths.video_dir()
    videos = []
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                name = entry.name
                if not name.lower().endswith(RECENT_VIDEO_EXTENSIONS) or name.startswith(RAW_VIDEO_PREFIX):
                    continue
                if secure_filename(name) != name or not entry.is_file():
                    continue
                stat = entry.stat()
                videos.append({'file': name, 'size_bytes': stat.st_size, 'modified': stat.st_mtime})
    except OSError:
        # Dossier pas encore créé (aucun export) ou devenu illisible : liste vide.
        pass
    videos.sort(key=lambda video: video['modified'], reverse=True)
    return {'success': True, 'folder': str(folder), 'videos': videos[:limit], 'total': len(videos)}


def delete_video(request):
    """Supprime une vidéo du dossier des vidéos (Corbeille quand c'est possible)."""
    path = _requested_video_file(request)
    if path is None:
        return jsonify({'success': False, 'message': _('Fichier vidéo introuvable')}), 404
    try:
        recoverable = recycle_bin.send_to_trash(path)
    except OSError as e:
        # Typiquement : fichier ouvert dans un lecteur vidéo.
        print(f"[videos] Suppression impossible ({path}): {e}")
        return jsonify({'success': False, 'message': _(
            "Impossible de supprimer cette vidéo : elle est peut-être ouverte dans un autre programme."
        )}), 409
    return jsonify({'success': True, 'file': os.path.basename(path), 'recoverable': recoverable})


def _requested_video_file(request):
    data = request.get_json(silent=True)
    name = data.get('file') if isinstance(data, dict) else None
    return resolve_video_file(name or request.form.get('file'))


def reveal_video(request):
    """Ouvre le dossier des vidéos avec le fichier demandé sélectionné."""
    path = _requested_video_file(request)
    if path is None:
        return jsonify({'success': False, 'message': _('Fichier vidéo introuvable')}), 404
    try:
        if platform.system().lower() == 'windows':
            # L'Explorateur n'accepte la sélection que sous cette forme ; ouvrir
            # le dossier seul laisserait chercher le fichier parmi les autres.
            subprocess.Popen(['explorer', '/select,', os.path.normpath(path)])
        elif platform.system().lower() == 'darwin':
            subprocess.Popen(['open', '-R', path])
        else:
            _open_with_system(os.path.dirname(path))
        return jsonify({'success': True, 'file': os.path.basename(path)})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


def open_video(request):
    """Ouvre la vidéo demandée dans le lecteur par défaut du système."""
    path = _requested_video_file(request)
    if path is None:
        return jsonify({'success': False, 'message': _('Fichier vidéo introuvable')}), 404
    try:
        _open_with_system(path)
        return jsonify({'success': True, 'file': os.path.basename(path)})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


def count_captured_pictures():
    """Nombre d'images restées dans captured/ (0 si le dossier est absent).

    Ne compte que les fichiers image : un `.gitkeep` ou un fichier système ne doit
    pas faire croire à l'utilisateur qu'il reste des captures à supprimer.
    """
    captured = paths.captured_dir()
    try:
        if not captured.is_dir():
            return 0
        # Récursif : chaque session de capture a son sous-dossier, et des frames
        # restantes y comptent autant que celles laissées à la racine.
        return sum(
            1
            for root, _dirs, files in os.walk(captured)
            for name in files
            if name.lower().endswith(CAPTURED_IMAGE_EXTENSIONS)
        )
    except OSError:
        return 0


def clear_pictures_directory():
    directory_path = paths.captured_dir()  # Chemin vers le répertoire à vider
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
                        # Sous-dossiers de sessions de capture : frames isolées
                        # d'un enregistrement précédent, à supprimer aussi.
                        shutil.rmtree(file_path)
                except Exception as e:
                    # En cas d'erreur lors de la suppression, renvoyer un message d'erreur
                    return jsonify({'success': False, 'message': str(e)})
        # `count` évite au client une requête de plus pour rafraîchir l'affichage
        # du bouton de suppression (masqué dès qu'il ne reste plus d'image).
        return jsonify({
            'success': True,
            'message': _('Le répertoire a été vidé avec succès'),
            'count': count_captured_pictures(),
        })
    except Exception as e:
        # Gérer les exceptions imprévues
        return jsonify({'success': False, 'message': str(e)})
    

# Extensions qu'un utilisateur peut avoir saisies avec son nom de fichier : le
# conteneur est imposé par l'export, elles sont donc retirées du nom de base.
_VIDEO_EXTENSIONS = ('.mp4', '.webm', '.mkv', '.mov')
VIDEO_BASE_NAME_DEFAULT = "mygcflow"
VIDEO_BASE_NAME_MAX_LENGTH = 80


def video_base_name(raw):
    """Nom de base d'une vidéo à partir d'une saisie libre (nom du thème, champ
    « Nom du fichier »).

    secure_filename ne garde que de l'ASCII sans espace : le nom reste lisible
    par tous les lecteurs et sites de partage, et resolve_video_file() le
    retrouve tel quel. Une saisie vide ou entièrement filtrée retombe sur le
    nom par défaut.
    """
    name = secure_filename(str(raw or ''))
    while name.lower().endswith(_VIDEO_EXTENSIONS):
        name = os.path.splitext(name)[0]
    # « Encre & Papier » : le caractère retiré laisse deux séparateurs d'affilée.
    name = re.sub(r'_{2,}', '_', name)
    name = name[:VIDEO_BASE_NAME_MAX_LENGTH].strip('._-')
    return name or VIDEO_BASE_NAME_DEFAULT


def video_output_path(base_name=None, ext: str = "mp4"):
    """Chemin d'une nouvelle vidéo : <nom>_AAAA-MM-JJ_HHhMM.<ext> dans le dossier
    des vidéos.

    Un seul horodatage, lisible et triable. Deux exports dans la même minute
    reçoivent un suffixe -2, -3… plutôt que des secondes dans tous les noms :
    un fichier existant n'est jamais écrasé.
    """
    video_dir = str(paths.video_dir())
    stem = f"{video_base_name(base_name)}_{datetime.now().strftime('%Y-%m-%d_%Hh%M')}"
    ext = (ext or 'mp4').lstrip('.')
    candidate = os.path.join(video_dir, f"{stem}.{ext}")
    counter = 2
    while os.path.exists(candidate):
        candidate = os.path.join(video_dir, f"{stem}-{counter}.{ext}")
        counter += 1
    return candidate


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
# CRF 18 (et non 20) : mesuré sur 40 frames réelles d'une animation dense (fond
# vectoriel sombre, points aux couleurs GC, cartouches), en comparant l'encodé
# aux images d'origine :
#
#   crf 20  1834 Ko  luma 39,0 dB  chroma 33,3 dB  SSIM 0,9616
#   crf 18  2172 Ko  luma 40,7 dB  chroma 33,6 dB  SSIM 0,9668   (+18 % de taille)
#   crf 16  2547 Ko  luma 42,4 dB  chroma 33,9 dB  SSIM 0,9706   (+39 %)
#
# Les frames étant désormais capturées sans perte (cf. capture_image_format.mjs),
# cet encodage est le dernier maillon qui dégrade l'image : +1,7 dB sur les
# contours (traits de carte, texte) pour 18 % de fichier en plus vaut la peine.
# CRF 16 coûte le double pour moitié moins de gain, et le preset « slow »
# n'apporte rien ici (-1 % de taille mesuré).
#
# La chrominance, elle, plafonne quel que soit le CRF (33,3 → 34,1 dB au mieux) :
# la perte vient du sous-échantillonnage de yuv420p (résolution de couleur
# divisée par deux), pas de la quantification. Seul yuv444p la corrige
# (chroma 38,2 dB pour +10 % de taille), mais il exige un profil H.264 que
# beaucoup de lecteurs et de téléviseurs refusent : yuv420p reste donc le défaut.
#
# La fidélité de couleur est donc un choix laissé à l'utilisateur, par défaut
# « compatible ». Miroir côté client : static/js/color_fidelity.mjs.
COLOR_FIDELITIES = ('compatible', 'fidele')
DEFAULT_COLOR_FIDELITY = 'compatible'
_PIX_FMT_BY_FIDELITY = {'compatible': 'yuv420p', 'fidele': 'yuv444p'}


def _h264_output_args(color_fidelity=DEFAULT_COLOR_FIDELITY):
    pix_fmt = _PIX_FMT_BY_FIDELITY.get(color_fidelity, _PIX_FMT_BY_FIDELITY[DEFAULT_COLOR_FIDELITY])
    return [
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', pix_fmt,
        '-movflags', '+faststart',
    ]


def coerce_color_fidelity(value):
    """Valeur inconnue (settings.json édité à la main, client plus ancien) : on
    retombe sur le format lisible partout plutôt que de produire un fichier que
    le lecteur de l'utilisateur refusera d'ouvrir."""
    return value if value in COLOR_FIDELITIES else DEFAULT_COLOR_FIDELITY
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


# Application fenêtrée (sans console) sous Windows : chaque lancement de ffmpeg
# ouvrirait sinon une fenêtre de console noire le temps de l'encodage.
_SUBPROCESS_FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

# Processus ffmpeg en cours : à la fermeture de l'application, le lanceur les
# arrête (sinon ils survivraient au serveur et continueraient d'écrire).
_running_procs = set()
_running_procs_lock = threading.Lock()


def kill_running_ffmpeg():
    with _running_procs_lock:
        procs = list(_running_procs)
    for proc in procs:
        try:
            proc.kill()
        except Exception:
            pass


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
            timeout=FFMPEG_PROBE_TIMEOUT_S, creationflags=_SUBPROCESS_FLAGS,
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
    candidate = os.path.join(paths.audio_dir(), safe_name)
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
        creationflags=_SUBPROCESS_FLAGS,
    )
    with _running_procs_lock:
        _running_procs.add(proc)

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
                        _progress(progress_start + frac * span,
                                  _("%(label)s... %(pct)s%%", label=progress_label, pct=int(frac * 100)))
                    else:
                        _progress(progress_start + span / 2, _("%(label)s en cours...", label=progress_label))
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
        with _running_procs_lock:
            _running_procs.discard(proc)

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
        return {'success': False,
                'message': _("%(label)s interrompu : le processus ne s'est pas terminé.", label=error_label)}

    if stalled.is_set():
        minutes = max(1, int(FFMPEG_STALL_TIMEOUT_S // 60))
        print(f"[{log_prefix}] ffmpeg figé (aucune progression pendant {minutes} min) → processus tué")
        return {
            'success': False,
            'message': _("%(label)s interrompu : aucune progression pendant %(minutes)s min. "
                         "Le fichier source est probablement corrompu.",
                         label=error_label, minutes=minutes),
        }
    if proc.returncode != 0:
        msg = "\n".join(tail_lines[-8:]) or _("ffmpeg a échoué (code %(code)s)", code=proc.returncode)
        return {'success': False,
                'message': _("%(label)s échoué : %(detail)s", label=error_label, detail=msg)}

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


def _assemble_pictures(image_folder, output_video, fps=24, audio_path=None, audio_volume=1.0, status=None,
                       color_fidelity=DEFAULT_COLOR_FIDELITY, expected_frames=0):
    """Coeur de l'assemblage vidéo. Retourne un dict {'success', 'message', ...}.

    Met à jour un TaskStatus optionnel (`status`) pour le suivi de progression,
    ce qui permet de l'exécuter en tâche de fond sans bloquer la requête HTTP.
    `expected_frames` (0 = inconnu) est le nombre de frames que le client a
    capturées : un écart signifie qu'au moins un upload s'est perdu.
    """
    def _progress(p, msg):
        if status is not None:
            try:
                status.set_progress(p, msg)
            except Exception:
                pass

    # Inclure plusieurs formats d'images (webp par défaut côté client, mais aussi png et autres)
    exts = CAPTURED_IMAGE_EXTENSIONS
    # Obtenez la liste des fichiers d'image dans le dossier. Un dossier de
    # session inexistant (aucune image n'a pu être enregistrée) se traduit en
    # liste vide, pas en exception.
    try:
        image_files = [os.path.join(image_folder, img) for img in sorted(os.listdir(image_folder)) if img.lower().endswith(exts)]
    except OSError:
        image_files = []

    if not image_files:
        return {'success': False, 'message': _('Aucune image trouvée dans le dossier')}

    # Complétude : sans cette vérification, un lot d'upload perdu (requête
    # abandonnée, disque plein) produisait une vidéo silencieusement plus courte.
    if expected_frames and len(image_files) != expected_frames:
        return {'success': False, 'message': _(
            "Assemblage refusé : %(expected)d images attendues, %(found)d trouvées dans la capture",
            expected=expected_frames, found=len(image_files))}

    # Continuité : quand tous les noms suivent le schéma image_<n>.<ext>, les
    # indices doivent être uniques et contigus — peu importe la valeur de départ.
    # Une frame manquante compensée par un doublon passerait sinon le contrôle
    # de nombre ci-dessus.
    indices = []
    for path in image_files:
        match = re.fullmatch(r'image_(\d+)\.[A-Za-z0-9]+', os.path.basename(path))
        if not match:
            indices = None
            break
        indices.append(int(match.group(1)))
    if indices is not None:
        unique = sorted(set(indices))
        contiguous = unique == list(range(unique[0], unique[0] + len(unique)))
        if len(unique) != len(image_files) or not contiguous:
            return {'success': False, 'message': _(
                "Assemblage refusé : la séquence d'images n'est pas continue (frames manquantes ou dupliquées)")}

    # Assurez-vous que le répertoire de sortie existe
    os.makedirs(os.path.dirname(output_video), exist_ok=True)

    _progress(5, _("Préparation des images..."))

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
    handle, list_path = tempfile.mkstemp(prefix='mygcflow_concat_', suffix='.ffconcat', text=True)
    os.close(handle)

    try:
        _write_concat_list(image_files, fps_value, list_path)

        # -safe 0 : le script contient des chemins absolus, refusés par défaut.
        # -r en ENTRÉE : le démuxeur concat a par défaut une base temporelle de
        # 25 fps, quelles que soient les durées déclarées. Sans cadence explicite,
        # l'échantillonnage vers une sortie à 30/60 fps dupliquait une image et
        # en omettait une autre (vérifié en décodant les frames), alors que le
        # fps et la durée du fichier restaient corrects.
        cmd = [ffmpeg, '-y', '-f', 'concat', '-safe', '0', '-r', str(fps_value), '-i', list_path]
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
        cmd += _h264_output_args(color_fidelity)
        cmd += ['-progress', 'pipe:1', '-nostats', output_video]

        _progress(10, _("Encodage de la vidéo..."))
        result = _run_ffmpeg(
            cmd, out_dur=out_dur, status=status,
            progress_start=10, progress_end=99,
            progress_label=_("Encodage vidéo"), error_label=_("Assemblage ffmpeg"),
            log_prefix="assemble",
        )
    finally:
        try:
            os.remove(list_path)
        except OSError:
            pass

    if not result.get('success'):
        return result

    _progress(100, _("Vidéo créée avec succès"))
    return {'success': True, 'message': _('Vidéo créée avec succès'), 'output': output_video,
            **describe_video(output_video)}


def assemble_pictures_directory(image_folder, output_video, fps=24, audio_path=None, audio_volume=1.0,
                                color_fidelity=DEFAULT_COLOR_FIDELITY):
    """Assemblage synchrone (conservé pour compatibilité). Retourne une réponse JSON Flask."""
    try:
        result = _assemble_pictures(image_folder, output_video, fps, audio_path, audio_volume,
                                    color_fidelity=color_fidelity)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


def run_assemble_video_task(status, app, image_folder, output_video, fps=24, audio_path=None,
                            audio_volume=1.0, color_fidelity=DEFAULT_COLOR_FIDELITY, locale=None,
                            expected_frames=0):
    """Tâche de fond : assemble la vidéo et met à jour la progression via TaskStatus.

    Exécutée par le TaskManager dans un thread, ce qui évite l'expiration du
    fetch HTTP côté client sur les assemblages longs (plusieurs minutes).
    `app`/`locale` viennent de la requête appelante : gettext en a besoin ici
    pour traduire les messages de progression dans la langue de l'utilisateur.
    """
    def _run():
        result = _assemble_pictures(image_folder, output_video, fps, audio_path, audio_volume,
                                    status=status, color_fidelity=color_fidelity,
                                    expected_frames=expected_frames)
        if not result.get('success'):
            status.fail(result.get('message', _("Échec de l'assemblage")))
            return
        status.set_result(result)

    with app.app_context():
        if locale:
            with force_locale(locale):
                _run()
        else:
            _run()


# --------- Traitement vidéo MediaRecorder (normalisation vitesse + mux audio) ---------
# Type de tâche de fond pour le post-traitement d'un enregistrement MediaRecorder
TASK_TYPE_VIDEO_PROCESS = "video_processing"


def _process_recorded_video(input_path, output_path, slowdown=1.0, audio_path=None, audio_volume=1.0, fps=None,
                            status=None, color_fidelity=DEFAULT_COLOR_FIDELITY):
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
        return {'success': False, 'message': _('Fichier vidéo introuvable')}

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
    cmd += _h264_output_args(color_fidelity)
    cmd += ['-progress', 'pipe:1', '-nostats', output_path]

    _progress(2, _("Démarrage du traitement vidéo..."))
    result = _run_ffmpeg(
        cmd, out_dur=out_dur, status=status,
        progress_start=2, progress_end=98,
        progress_label=_("Traitement vidéo"), error_label=_("Traitement ffmpeg"),
        log_prefix="process",
    )
    if not result.get('success'):
        return result

    # Nettoyer le .webm brut temporaire une fois le MP4 produit
    try:
        os.remove(input_path)
    except Exception:
        pass

    _progress(100, _("Vidéo prête"))
    return {
        'success': True,
        'message': _('Vidéo traitée avec succès'),
        'output': output_path,
        **describe_video(output_path),
    }


def run_process_video_task(status, app, input_path, output_path, slowdown=1.0, audio_path=None,
                           audio_volume=1.0, fps=None, color_fidelity=DEFAULT_COLOR_FIDELITY, locale=None):
    """Tâche de fond : post-traite un enregistrement MediaRecorder via ffmpeg.

    `app`/`locale` viennent de la requête appelante (même raison que
    run_assemble_video_task).
    """
    def _run():
        result = _process_recorded_video(input_path, output_path, slowdown, audio_path, audio_volume,
                                         fps=fps, status=status, color_fidelity=color_fidelity)
        if not result.get('success'):
            status.fail(result.get('message', _("Échec du traitement vidéo")))
            return
        status.set_result(result)

    with app.app_context():
        if locale:
            with force_locale(locale):
                _run()
        else:
            _run()


def process_recorded_video(request):
    """Réceptionne le .webm brut (+ options) et lance le traitement ffmpeg en tâche de fond.

    Source vidéo, au choix :
      - 'video' (fichier multipart) : le .webm brut du MediaRecorder ;
      - 'recorded_file' (champ) : nom d'un .webm déjà déposé côté serveur par
        un flux délesté (video_stream_*), qui évite de re-téléverser le fichier.
    Dans les deux cas le brut vit dans le dossier de travail (cf.
    recorded_video_path), jamais dans le dossier des vidéos de l'utilisateur.
    Autres champs :
      - 'audio' (fichier) OU 'audio' (nom déjà présent dans audio/) : piste audio optionnelle
      - 'slowdown', 'audio_volume', 'color_fidelity' : options
      - 'fileName' : nom de base de la vidéo (cf. video_output_path)
    """
    from task_manager import task_manager

    paths.ensure_dir(paths.video_dir())
    if request.files and 'video' in request.files:
        raw_path = new_recorded_video_path()
        request.files['video'].save(raw_path)
    elif recorded_video_path(request.form.get('recorded_file')):
        raw_path = recorded_video_path(request.form.get('recorded_file'))
    else:
        return jsonify({'success': False, 'message': _('Aucun fichier vidéo fourni')}), 400

    # Audio : soit un fichier uploadé ici, soit un nom déjà présent dans audio/
    audio_path = None
    if 'audio' in request.files and request.files['audio'].filename:
        af = request.files['audio']
        aname = secure_filename(af.filename or 'music.mp3')
        af.save(os.path.join(paths.ensure_dir(paths.audio_dir()), aname))
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
    color_fidelity = coerce_color_fidelity(request.form.get('color_fidelity'))

    # Le client fournit le nom de base (thème ou saisie) ; l'horodatage et
    # l'extension sont posés ici, comme pour l'assemblage d'images.
    out_path = video_output_path(request.form.get('fileName'), 'mp4')

    status = task_manager.submit(
        TASK_TYPE_VIDEO_PROCESS, run_process_video_task,
        current_app._get_current_object(),
        raw_path, out_path, slowdown, audio_path, audio_volume, fps, color_fidelity, get_locale(),
    )
    return jsonify({
        'success': True,
        'message': _('Traitement vidéo lancé en tâche de fond'),
        'task_id': status.id,
        'state': status.state,
    }), 202


def upload_video(request):
    """Réceptionne un fichier vidéo (ex: .webm) via multipart/form-data et l'enregistre dans le dossier video/.

    Champs attendus:
      - 'video': le fichier binaire
      - 'fileName' (optionnel): nom de base suggéré, avec l'extension du conteneur
    """
    try:
        if not request.files or 'video' not in request.files:
            return jsonify({'success': False, 'message': _('Aucun fichier vidéo fourni')}), 400

        video_file = request.files['video']
        suggested = request.form.get('fileName') or video_file.filename or ''

        # Le nom fourni porte l'extension du conteneur enregistré par le
        # navigateur ; le nom final suit la même règle que les autres exports.
        ext = os.path.splitext(secure_filename(suggested))[1].lstrip('.') or 'webm'
        paths.ensure_dir(paths.video_dir())
        save_path = video_output_path(suggested, ext)
        video_file.save(save_path)

        return jsonify({'success': True, 'message': _('Vidéo reçue et sauvegardée'), 'path': save_path,
                        **describe_video(save_path)})
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
            return jsonify({'success': False, 'message': _('Aucun fichier audio fourni')}), 400

        audio_file = request.files['audio']
        file_name = secure_filename(audio_file.filename or 'music.mp3')
        save_path = os.path.join(paths.ensure_dir(paths.audio_dir()), file_name)
        audio_file.save(save_path)
        return jsonify({'success': True, 'file': file_name, 'path': save_path})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


# --------- Flux vidéo MediaRecorder (délestage mémoire) ---------
#
# Sans flux, le navigateur accumule tous les fragments .webm en mémoire jusqu'à
# la fin de l'enregistrement (~225 Mo/min à 30 Mbit/s). Le flux les envoie au
# serveur au fil de l'eau : chaque fragment est ajouté au fichier dès réception,
# en respectant l'ordre strict exigé par le conteneur EBML. À la fin, le fichier
# est remuxé sans ré-encodage, toujours dans le dossier de travail — ce qui répare au passage l'élément
# « Duration » que MediaRecorder n'écrit pas.
#
# Le registre est en mémoire : un redémarrage serveur abandonne les flux, dont
# les fichiers orphelins sont balayés au prochain begin.

_video_streams = {}
_video_streams_lock = threading.Lock()
VIDEO_STREAM_MAX_AGE_S = 6 * 3600

# Enregistrement brut complet, en attente de son traitement ffmpeg : le flux
# remuxé, ou le .webm téléversé d'un bloc. Il vit dans le dossier de travail
# (paths.video_streams_dir) et non dans le dossier des vidéos : l'utilisateur
# n'y voit que des vidéos terminées, même si un traitement échoue.
RECORDED_VIDEO_PREFIX = 'raw_'


def new_recorded_video_path(identifier=None):
    """Chemin d'un nouvel enregistrement brut dans le dossier de travail."""
    streams_dir = paths.ensure_dir(paths.video_streams_dir())
    return os.path.join(str(streams_dir), f"{RECORDED_VIDEO_PREFIX}{identifier or uuid.uuid4().hex}.webm")


def recorded_video_path(name):
    """Chemin d'un enregistrement brut à partir de son nom, None s'il n'existe pas.

    secure_filename réduit l'entrée à un nom simple, et le préfixe écarte les
    flux encore ouverts (stream_*) : rien d'autre n'est atteignable.
    """
    safe_name = secure_filename(os.path.basename(str(name or '')))
    if not safe_name.startswith(RECORDED_VIDEO_PREFIX) or not safe_name.lower().endswith('.webm'):
        return None
    path = os.path.join(str(paths.video_streams_dir()), safe_name)
    return path if os.path.isfile(path) else None


def _sweep_video_streams(streams_dir):
    """Supprime les fichiers abandonnés : flux jamais refermés (crash, onglet
    fermé) et enregistrements bruts dont le traitement n'a pas abouti."""
    try:
        cutoff = time.time() - VIDEO_STREAM_MAX_AGE_S
        for path in Path(streams_dir).glob('*.webm'):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                pass
    except OSError:
        pass


def video_stream_begin():
    """Ouvre un flux d'écriture : crée le fichier vide et son entrée de registre."""
    try:
        streams_dir = paths.ensure_dir(paths.video_streams_dir())
        _sweep_video_streams(streams_dir)
        stream_id = uuid.uuid4().hex
        path = os.path.join(str(streams_dir), f"stream_{stream_id}.webm")
        open(path, 'wb').close()
        with _video_streams_lock:
            _video_streams[stream_id] = {'path': path, 'index': 0}
        return jsonify({'success': True, 'stream_id': stream_id})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


def video_stream_append(request):
    """Ajoute un fragment au flux. L'index impose l'ordre : un fragment hors
    séquence est refusé (409) plutôt que de corrompre le conteneur."""
    try:
        stream_id = request.form.get('stream_id') or ''
        with _video_streams_lock:
            entry = _video_streams.get(stream_id)
        if entry is None:
            return jsonify({'success': False, 'message': _('Flux vidéo inconnu')}), 404

        index = _to_int(request.form.get('index'), -1)
        if index != entry['index']:
            return jsonify({'success': False, 'expected': entry['index'],
                            'message': _('Fragment vidéo hors séquence')}), 409

        if not request.files or 'chunk' not in request.files:
            return jsonify({'success': False, 'message': _('Fragment vidéo absent')}), 400

        data = request.files['chunk'].read()
        with open(entry['path'], 'ab') as handle:
            handle.write(data)
        entry['index'] += 1
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


def video_stream_finish(request):
    """Referme le flux : remux sans ré-encodage, dans le dossier de travail.

    Le résultat est un enregistrement brut (raw_<id>.webm) que le client désigne
    ensuite à process_recorded_video ; il ne passe jamais par le dossier des
    vidéos.

    Le remux réécrit les timestamps et l'élément Duration que MediaRecorder
    omet (sans lui, les lecteurs n'affichent ni durée ni seekbar utilisable).
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    stream_id = data.get('stream_id') or request.form.get('stream_id') or ''

    with _video_streams_lock:
        entry = _video_streams.pop(stream_id, None)
    if entry is None:
        return jsonify({'success': False, 'message': _('Flux vidéo inconnu')}), 404

    raw_path = entry['path']
    try:
        out_path = new_recorded_video_path(secure_filename(stream_id))
        name = os.path.basename(out_path)

        ffmpeg = _get_ffmpeg_exe()
        proc = subprocess.run(
            [ffmpeg, '-y', '-i', raw_path, '-c', 'copy', out_path],
            capture_output=True, timeout=600,
        )
        if proc.returncode != 0:
            # Repli : le flux brut reste lisible, seule la durée manquera.
            print(f"[stream] Remux échoué (code {proc.returncode}), copie brute du flux")
            shutil.copyfile(raw_path, out_path)

        os.remove(raw_path)
        return jsonify({'success': True, 'file': name})
    except Exception as e:
        # Le fichier brut reste sur disque (diagnostic) ; le balayage le purgera.
        return jsonify({'success': False, 'message': str(e)}), 500


def video_stream_abort(request):
    """Abandonne un flux (enregistrement annulé) : registre + fichier supprimés."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    stream_id = data.get('stream_id') or request.form.get('stream_id') or ''

    with _video_streams_lock:
        entry = _video_streams.pop(stream_id, None)
    if entry is not None:
        try:
            os.remove(entry['path'])
        except OSError:
            pass
    return jsonify({'success': True})
