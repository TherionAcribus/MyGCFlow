from flask import jsonify, request
import os
import base64
from moviepy.editor import ImageSequenceClip


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
    

def assemble_pictures_directory(image_folder, output_video, fps=24):
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
        # Écrivez le clip vidéo dans un fichier
        clip.write_videofile(output_video, fps=fps)
        return jsonify({'success': True, 'message': 'Vidéo créée avec succès'})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})
