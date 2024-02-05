from flask import jsonify, request
import os
import base64


def upload_image(requests):
    data = requests.json
    image_data = base64.b64decode(data['image'].split(',')[1])
    counter = data['counter']
    image_filename = f'image_{counter}.png'  # Nom unique pour chaque image
    # TODO Pouvoir choisir le repertoire tmp
    with open(os.path.join('captured/', image_filename), 'wb') as file:
        file.write(image_data)
    return jsonify({'message': 'Image reçue avec succès'})