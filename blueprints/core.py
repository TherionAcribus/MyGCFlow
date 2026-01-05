import json

from flask import Blueprint, current_app, jsonify, make_response, render_template
from flask_babel import gettext as _
from flask_cors import cross_origin

from localization import get_locale
from options import check_version_online

core_bp = Blueprint('core', __name__)


@core_bp.route('/')
def index():
    return render_template('app.html')


@core_bp.route('/check_version', methods=['GET'])
@cross_origin()
def check_version():
    user_language = (get_locale() or 'fr').split('_')[0]
    current_version = current_app.config.get('APP_VERSION', '1.0')
    return check_version_online(current_version, user_language)


@core_bp.route('/test_translations')
def test_translations():
    return jsonify({
        'current_locale': get_locale(),
        'test_strings': {
            'base_de_donnees': _('Base de donnÇ¸es'),
            'choisir_fichier': _('Choisir fichier'),
            'filtres': _('Filtres'),
            'cartes': _('Cartes'),
            'parametres': _('ParamÇùtres'),
            'annuler': _('Cancel'),
            'graphisme_des_points': _('Graphisme des points'),
            'centre_du_point': _('Centre du point')
        }
    })


@core_bp.route('/api/locale')
@cross_origin()
def get_current_locale():
    locale = get_locale()
    return jsonify({
        'locale': locale,
        'language': (locale or 'fr').split('_')[0]
    })


@core_bp.route('/js_translations.js')
def js_translations():
    current_lang = get_locale()
    translations = {
        'language_changed_message': _('La langue a Ç¸tÇ¸ changÇ¸e. La page va se recharger pour appliquer les modifications.'),
        'language_changed_message_en': _('The language has been changed. The page will reload to apply the changes.'),
        'language_change_title': _('Changement de langue'),
        'language_change_title_en': _('Language Change'),
        'language_change_message': _('La langue a Ç¸tÇ¸ changÇ¸e. L\'application va redÇ¸marrer pour appliquer les modifications.'),
        'language_change_message_en': _('The language has been changed. The application will restart to apply the changes.'),
        'confirm': _('Confirmer'),
        'confirm_en': _('Confirm'),
        'cancel': _('Annuler'),
        'cancel_en': _('Cancel'),
        'current_lang': current_lang,
        'test_translation': _('Base de donnÇ¸es')
    }

    js_content = f"""
// Traductions JavaScript
window.TRANSLATIONS = {json.dumps(translations)};
console.log('Traductions chargÇ¸es pour la langue:', '{current_lang}');
console.log('Test de traduction:', '{_("Base de donnÇ¸es")}');
"""
    response = make_response(js_content)
    response.headers['Content-Type'] = 'application/javascript'
    return response
