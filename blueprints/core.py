import json
import gettext
import os

from dataclasses import replace

from flask import Blueprint, current_app, jsonify, make_response, render_template, request
from flask_babel import gettext as _

import options
from localization import get_locale
from settings_manager import get_settings_manager
from task_manager import task_manager

core_bp = Blueprint('core', __name__)
settings_manager = get_settings_manager()


@core_bp.route('/')
def index():
    current_locale = get_locale()
    # `can_quit` : le bouton « Quitter » n'a de sens que lancé par launcher.py.
    # Sous `python app.py`, le serveur de développement se ferme par sa console.
    response = make_response(render_template(
        'app.html',
        can_quit=bool(current_app.config.get('QUIT_HOOK')),
    ))
    if current_locale:
        response.set_cookie(
            'mygcflow_lang',
            current_locale,
            max_age=60 * 60 * 24 * 365,
            samesite='Lax',
            path='/'
        )
    return response


@core_bp.route('/guide')
def guide():
    """Mode d'emploi pas-à-pas, ouvert dans une page séparée."""
    current_locale = get_locale()
    response = make_response(render_template('guide.html'))
    if current_locale:
        response.set_cookie(
            'mygcflow_lang',
            current_locale,
            max_age=60 * 60 * 24 * 365,
            samesite='Lax',
            path='/'
        )
    return response


@core_bp.route('/api/ping', methods=['GET'])
def ping():
    # Le lanceur interroge cette route pour savoir si une instance de MyGCFlow
    # occupe déjà le port (instance unique) et si le serveur est prêt.
    return jsonify({'app': 'MyGCFlow', 'version': current_app.config.get('APP_VERSION')})


@core_bp.route('/api/quit', methods=['POST'])
def quit_app():
    """Arrête MyGCFlow depuis l'interface.

    L'icône de la zone de notification était jusqu'ici la seule sortie, et
    Windows 11 range les nouvelles icônes dans le débordement masqué : un
    utilisateur qui ne pense pas à déplier ce menu n'a aucun moyen de fermer
    l'application. Cette route en donne un second, là où il se trouve déjà.

    POST seulement, et `security.check_request` refuse déjà toute requête
    modifiante venue d'une autre origine : une page web ouverte à côté ne peut
    pas éteindre l'application.
    """
    quit_hook = current_app.config.get('QUIT_HOOK')
    if quit_hook is None:
        # Serveur de développement (`python app.py`) : pas de lanceur à arrêter.
        return jsonify({'quitting': False, 'reason': 'unavailable'}), 501

    forced = bool((request.get_json(silent=True) or {}).get('force'))
    active = task_manager.active_tasks()
    if active and not forced:
        # L'interface demande confirmation puis renvoie force=true. La question
        # est posée dans le navigateur plutôt que par une boîte de dialogue
        # native : celle du lanceur bloque la boucle de messages de l'icône.
        return jsonify({
            'quitting': False,
            'reason': 'busy',
            'tasks': [{'id': s.id, 'type': s.type} for s in active],
        }), 409

    quit_hook()
    return jsonify({'quitting': True})


@core_bp.route('/check_version', methods=['GET'])
def check_version():
    """État des mises à jour.

    `mode=init` est la vérification automatique du démarrage : espacée de
    `CHECK_INTERVAL`, pour ne pas interroger GitHub à chaque lancement ni
    rouvrir la même modale tous les jours. Tout autre mode vient d'un clic de
    l'utilisateur et vérifie sans condition.
    """
    current_version = current_app.config.get('APP_VERSION', '1.0')
    forced = request.args.get('mode') != 'init'
    settings = settings_manager.get_app_settings()

    if not options.should_check(settings.last_update_check, force=forced):
        return jsonify(options.throttled_payload(current_version))

    info = options.fetch_version_info(current_version)
    if info['error']:
        # Échec réseau : pas d'horodatage enregistré, le prochain démarrage
        # réessaiera au lieu d'attendre l'intervalle complet.
        return jsonify(info)

    if info['update_available']:
        info['skipped'] = (
            settings.skipped_update_version == info['latest_version']['version']
        )

    checked_at = options.now_iso()
    settings_manager.update_app_settings(
        lambda current: replace(current, last_update_check=checked_at)
    )
    return jsonify(info)


@core_bp.route('/test_translations')
def test_translations():
    return jsonify({
        'current_locale': get_locale(),
        'test_strings': {
            'base_de_donnees': _('Base de données'),
            'choisir_fichier': _('Choisir fichier'),
            'filtres': _('Filtres'),
            'cartes': _('Cartes'),
            'parametres': _('Paramètres'),
            'annuler': _('Cancel'),
            'graphisme_des_points': _('Graphisme des points'),
            'centre_du_point': _('Centre du point')
        }
    })


@core_bp.route('/api/locale')
def get_current_locale():
    locale = get_locale()
    return jsonify({
        'locale': locale,
        'language': (locale or 'fr').split('_')[0]
    })


@core_bp.route('/js_translations.js')
def js_translations():
    current_locale = get_locale() or 'fr'
    current_lang = (current_locale or 'fr').split('_')[0]

    translations = {
        'language_changed_message': _('La langue a été changée. La page va se recharger pour appliquer les modifications.'),
        'language_changed_message_en': 'The language has been changed. The page will reload to apply the changes.',
        'language_change_title': _('Changement de langue'),
        'language_change_title_en': 'Language Change',
        'language_change_message': _('La langue a été changée. L\'application va redémarrer pour appliquer les modifications.'),
        'language_change_message_en': 'The language has been changed. The application will restart to apply the changes.',
        'confirm': _('Confirmer'),
        'confirm_en': 'Confirm',
        'cancel': _('Annuler'),
        'cancel_en': 'Cancel',
        'current_lang': current_lang,
        'test_translation': _('Base de données')
    }

    localedir = current_app.config.get('BABEL_TRANSLATION_DIRECTORIES', 'translations')
    localedir = os.path.join(current_app.root_path, localedir)
    try:
        gt = gettext.translation('messages', localedir=localedir, languages=[current_lang], fallback=True)
        catalog = getattr(gt, '_catalog', {}) or {}
        js_messages = {k: v for k, v in catalog.items() if isinstance(k, str) and isinstance(v, str) and v}
    except Exception:
        js_messages = {}

    js_content = f"""
// Traductions JavaScript
window.TRANSLATIONS = window.TRANSLATIONS || {{}};
Object.assign(window.TRANSLATIONS, {json.dumps(translations, ensure_ascii=False)});
window.TRANSLATIONS.messages = {json.dumps(js_messages, ensure_ascii=False)};

window.t = function(msgid, vars) {{
    try {{
        const dict = (window.TRANSLATIONS && window.TRANSLATIONS.messages) ? window.TRANSLATIONS.messages : {{}};
        let s = (dict && Object.prototype.hasOwnProperty.call(dict, msgid)) ? dict[msgid] : msgid;
        if (vars && typeof vars === 'object') {{
            s = String(s).replace(/\\$\\{{(\\w+)\\}}/g, function(m, key) {{
                if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null) {{
                    return String(vars[key]);
                }}
                return m;
            }});
        }}
        return s;
    }} catch (_) {{
        return msgid;
    }}
}};
"""
    response = make_response(js_content)
    response.headers['Content-Type'] = 'application/javascript'
    response.headers['Cache-Control'] = 'public, max-age=3600'  # Cache 1 heure
    return response
