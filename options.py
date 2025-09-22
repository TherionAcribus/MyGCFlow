import requests
import json
import logging
from flask import jsonify


current_version_adress = "http://blfa1842.odns.fr/app/GCMap/gcmap_versions.json"

# Paramètres HTTP pour la robustesse réseau
HTTP_TIMEOUT = 5
HTTP_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "GCMap/VersionCheck (+mailto:at_mop@gmail.com)"
}

# Parsing sémantique des versions avec fallback
try:
    from packaging.version import parse as _parse_version  # type: ignore
    def _v(version_string):
        return _parse_version(version_string or "0")
except Exception:
    def _v(version_string):
        parts = []
        for part in (version_string or "0").split("."):
            try:
                parts.append(int(part))
            except ValueError:
                parts.append(part)
        return tuple(parts)

def check_version_online(current_version, user_language='fr'):
    """Recherche une nouvelle version et retourne une réponse Flask (jsonify)."""
    return jsonify(fetch_version_info(current_version, user_language))


def fetch_version_info(current_version, user_language='fr'):
    """Retourne un dict avec l'état des mises à jour (fonction pure, testable)."""
    try:
        response = requests.get(
            current_version_adress,
            headers=HTTP_HEADERS,
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        updates = data.get('versions', [])
        # S'assure que les entrées ont bien une clé 'version'
        updates = [v for v in updates if isinstance(v, dict) and 'version' in v]
        new_versions = [v for v in updates if _v(v['version']) > _v(current_version)]
        return create_release_notes(new_versions, current_version, user_language)
    except requests.RequestException as error:
        logging.exception("Erreur réseau lors de la vérification des mises à jour.")
        return check_version_error(str(error))
    except (json.JSONDecodeError, ValueError):
        logging.exception("Réponse JSON invalide.")
        return check_version_error("Réponse invalide ou vide")

def create_release_notes(new_versions, current_version, user_language='fr'):
    print(f"DEBUG: create_release_notes appelée avec langue: {user_language}")

    if not new_versions:  # Aucune nouvelle version
        # Traductions pour le message "à jour"
        up_to_date_messages = {
            'fr': f"<h5>Votre version est actuellement à jour</h5><p> Vous possédez la version {current_version}.</p>",
            'en': f"<h5>Your version is currently up to date</h5><p> You have version {current_version}.</p>"
        }

        release_notes = up_to_date_messages.get(user_language, up_to_date_messages['fr'])

        return {
            "error": False,
            "update_available": False,
            "latest_version": None,
            "release_notes": release_notes,
            "versions": []
        }

    # Tri des versions par ordre décroissant pour obtenir la dernière
    new_versions.sort(key=lambda x: _v(x['version']), reverse=True)
    latest_version = new_versions[0]

    # Créer une copie des versions avec les traductions appliquées pour le frontend
    translated_versions = []
    for version in new_versions:
        translated_version = version.copy()
        # Appliquer les traductions du changelog
        changelog_translations = version.get('changelog_translations', {})
        translated_changelog = changelog_translations.get(user_language, version.get('changelog', []))
        translated_version['changelog'] = translated_changelog
        translated_versions.append(translated_version)

    notes = []
    for version in translated_versions:
        note = f"<h5>Version {version['version']}</h5>"
        note += f"{version.get('release_date', '')}"

        if version.get('changelog'):
            note += f"<p><ul><li>{'</li><li>'.join(version['changelog'])}</li></ul></p>"
        notes.append(note)

    # Traductions pour le message de mise à jour disponible
    update_messages = {
        'fr': f"""<div>
                        Vous possédez actuellement la version {current_version}.
                        Une nouvelle version {latest_version["version"]} est disponible.
                        Vous pouvez la télécharger à l'adresse : <a href="{latest_version.get("download_url","")}">{latest_version.get("download_url","")}</a>
                        </div>""",
        'en': f"""<div>
                        You currently have version {current_version}.
                        A new version {latest_version["version"]} is available.
                        You can download it at: <a href="{latest_version.get("download_url","")}">{latest_version.get("download_url","")}</a>
                        </div>"""
    }

    update_note = update_messages.get(user_language, update_messages['fr'])
    release_notes = update_note + f'<div>{"</div><div>".join(notes)}</div>'

    return {
        "error": False,
        "update_available": True,
        "latest_version": {
            "version": latest_version['version'],
            "date": latest_version.get('release_date', 'Non spécifiée'),
            "download_url": latest_version.get('download_url')
        },
        "release_notes": release_notes,
        "versions": translated_versions
    }


def check_version_error(error):
    release_notes = f"""Oups, une erreur est survenue lors de la vérification de la dernière version. 
                    Merci de me contacter à l'adresse <a href='mailto:at_mop@gmail.com'>mailto:at_mop@gmail.com</a>.
                    <br> Erreur : {error}
                    <br> Vous pouvez accéder à la page des dernières versions pour voir si une version corrige cette erreur."""
    logging.error(release_notes)
    return {
        "error": True,
        "update_available": False,
        "latest_version": None,
        "release_notes": release_notes
    }