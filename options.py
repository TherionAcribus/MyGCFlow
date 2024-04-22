import requests
import json
from flask import jsonify


current_version_adress = "http://blfa1842.odns.fr/app/GCMap/gcmap_versions.json"

def check_version_online(current_version):
    """ Recherche une nouvelle version de l'application sur le site web.
    Retourne True et un fichier json contenant les informations de la nouvelle version"""
    try:
        response = requests.get(current_version_adress)
        if response.status_code == 200:
            updates = response.json().get('versions', [])
            new_versions = [version for version in updates if version['version'] > current_version]
            print(f"Recherche de mises à jour : {new_versions}")
            return jsonify(create_release_notes(new_versions, current_version))
        else:
            return jsonify(check_version_error(f"Erreur HTTP: Statut {response.status_code}"))
    except requests.RequestException as error:
        print(f"Erreur lors de la vérification des mises à jour : {error}")
        return jsonify(check_version_error(str(error)))
    except json.JSONDecodeError as error:
        print(f"Erreur de décodage JSON : {error}")
        return jsonify(check_version_error("Réponse invalide ou vide"))
    

def create_release_notes(new_versions, current_version):
    if not new_versions:  # Aucune nouvelle version
        release_notes = f"""
                        <h5>Votre version est actuellement à jour</h5>
                        <p> Vous possedez la version {current_version}.</p>
                        """
        return {
            "error": False,
            "update_available": False,
            "latest_version": None,
            "release_notes": release_notes
        }

    # Tri des versions par ordre décroissant pour obtenir la dernière
    new_versions.sort(key=lambda x: x['version'], reverse=True)
    latest_version = new_versions[0]

    notes = []
    for version in new_versions:
        note = f"<h5>Version {version['version']}</h5>"
        note += f"{version['release_date']}"
        note += f"<p><ul><li>{'</li><li>'.join(version['changelog'])}</li></ul></p>"
        notes.append(note)

        update_note = f"""<div>
                        Vous possédez actuellement la version {current_version}. 
                        Une nouvelle version {latest_version["version"]} est disponible. 
                        Vous pouvez la télécharger à l'adresse : <a href="{latest_version["download_url"]}">{latest_version["download_url"]}</a>
                        </div>"""
        
        release_notes = update_note + f'<div>{"</div><div>".join(notes)}</div>'

    return {
        "error": False,
        "update_available": True,
        "latest_version": {
            "version": latest_version['version'],
            "date": latest_version.get('release_date', 'Non spécifiée')
        },
        "release_notes": release_notes
    }


def check_version_error(error):
    release_notes = f"""Oups, une erreur est survenue lors de la vérification de la dernière version. 
                    Merci de me contacter à l'adresse <a href='mailto:at_mop@gmail.com'>mailto:at_mop@gmail.com</a>.
                    <br> Erreur : {error}
                    <br> Vous pouvez acceder à la page des dernières versions pour voir si une version corrige cette erreur. METTRE PAGE """
    print(release_notes)
    return {
        "error": True,
        "update_available": error,
        "latest_version": None,
        "release_notes": release_notes
    }