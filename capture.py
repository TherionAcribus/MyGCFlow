from flask import jsonify, request
import os
import base64
from django.http import JsonResponse


def upload_image(requests):
    data = requests.json
    image_data = base64.b64decode(data['image'].split(',')[1])
    counter = data['counter']
    image_filename = f'image_{counter}.png'  # Nom unique pour chaque image
    # TODO Pouvoir choisir le repertoire tmp
    with open(os.path.join('captured/', image_filename), 'wb') as file:
        file.write(image_data)
    return jsonify({'message': 'Image reçue avec succès'})


def clear_pictures_directory(request):
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
                    return JsonResponse({'success': False, 'message': str(e)})
        # Si tout s'est bien passé, renvoyer un succès
        return JsonResponse({'success': True, 'message': 'Le répertoire a été vidé avec succès'})
    except Exception as e:
        # Gérer les exceptions imprévues
        return JsonResponse({'success': False, 'message': str(e)})