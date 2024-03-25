from flask import jsonify, request
import os
import base64
from moviepy.editor import ImageSequenceClip


def upload_image(requests):
    data = requests.json
    numberSize = int(data["numberSize"])  # Le nombre total d'images prévu
    image_data = base64.b64decode(data['image'].split(',')[1])
    counter = int(data['counter'])
    
    # Calculer le nombre de zéros nécessaires pour le formatage
    # Utilisation de str.zfill() pour ajouter des zéros non significatifs
    image_filename = f'image_{str(counter).zfill(numberSize)}.png'

    # TODO: Pouvoir choisir le répertoire tmp
    with open(os.path.join('captured/', image_filename), 'wb') as file:
        file.write(image_data)

    return jsonify({'message': 'Image reçue avec succès'})


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
    # Obtenez la liste des fichiers d'image dans le dossier
    image_files = [os.path.join(image_folder, img) for img in sorted(os.listdir(image_folder)) if img.endswith(".png")]
    # Créez un clip vidéo à partir des images
    clip = ImageSequenceClip(image_files, fps=fps)
    # Écrivez le clip vidéo dans un fichier
    clip.write_videofile(output_video, fps=fps)
    return jsonify({'success': False})
