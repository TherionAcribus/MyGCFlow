from flask import jsonify, request
import os
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


def assemble_pictures_directory(image_folder, output_video, fps=24, audio_path=None, audio_volume=1.0):
    try:
        # Inclure plusieurs formats d'images (webp par défaut côté client, mais aussi png et autres)
        exts = (".webp", ".png", ".jpg", ".jpeg")
        # Obtenez la liste des fichiers d'image dans le dossier
        image_files = [os.path.join(image_folder, img) for img in sorted(os.listdir(image_folder)) if img.lower().endswith(exts)]

        if not image_files:
            return jsonify({'success': False, 'message': 'Aucune image trouvée dans le dossier'})

        # Assurez-vous que le répertoire de sortie existe
        os.makedirs(os.path.dirname(output_video), exist_ok=True)

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

        # Écrivez le clip vidéo dans un fichier
        # Codec 'libx264' + 'aac' pour compatibilité (nécessite ffmpeg)
        try:
            clip.write_videofile(output_video, fps=fps, codec='libx264', audio_codec='aac')
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
        return jsonify({'success': True, 'message': 'Vidéo créée avec succès'})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


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
