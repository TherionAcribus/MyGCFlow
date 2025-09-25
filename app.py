import json
from flask import Flask, render_template, jsonify, request, make_response
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from flask_cors import cross_origin
from bdd import uploadBdd, get_progress_step, db_infos, create_geojson, get_metadata_from_geojson, filter_session, analyse
from capture import upload_image, clear_pictures_directory, assemble_pictures_directory, upload_video, upload_audio
from options import check_version_online
from flask_babel import Babel, gettext as _
from settings_manager import SettingsManager, AppSettings

# Créer un alias pour la fonction de traduction
gettext = _

app = Flask(__name__)

CORS(app)

current_version = "1.0"
# Settings / Profiles manager (stdlib)
settings_manager = SettingsManager()


# Configuration de la traduction
app.config['BABEL_DEFAULT_LOCALE'] = 'fr'  # Langue par défaut français
app.config['BABEL_SUPPORTED_LOCALES'] = ['en', 'fr']
app.config['BABEL_TRANSLATION_DIRECTORIES'] = 'translations'

def get_locale():
    # Essayer d'abord de récupérer la langue depuis les paramètres de la requête
    locale = request.args.get('lang')
    if locale in app.config['BABEL_SUPPORTED_LOCALES']:
        print(f"DEBUG: Langue détectée depuis URL: {locale}")  # Debug
        return locale

    # Sinon utiliser la langue du navigateur
    browser_locale = request.accept_languages.best_match(app.config['BABEL_SUPPORTED_LOCALES'])
    print(f"DEBUG: Langue détectée depuis navigateur: {browser_locale}")  # Debug
    return browser_locale

babel = Babel(app, locale_selector=get_locale)

# Assurer que la fonction gettext est disponible dans les templates
app.jinja_env.globals['_'] = _

# Debug: Vérifier que les traductions sont chargées
print("DEBUG: Configuration Babel:")
print(f"  Default locale: {app.config['BABEL_DEFAULT_LOCALE']}")
print(f"  Supported locales: {app.config['BABEL_SUPPORTED_LOCALES']}")
print(f"  Translation directories: {app.config['BABEL_TRANSLATION_DIRECTORIES']}")
print(f"  Test traduction immédiate 'Données': {_('Données')}")
print(f"  Test traduction immédiate 'Style': {_('Style')}")

# Les traductions sont automatiquement chargées par Flask-Babel
# TODO Utiliser 1) json 2) get local


# Configuration de la BDD
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///geocaching.db'
db = SQLAlchemy(app)

# Les variables globales de chargement sont maintenant gérées dans bdd.py via LoadingState

# Initialisation de la base de données si n'existe pas, mais ne créera pas de doublon
with app.app_context():
    db.create_all()


# TODO Au 1er démarrage sans BDD prévoir un systeme pour éviter les erreurs "base de données geocacache inexistante"
# MODELES
class Geocache(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)
    name = db.Column(db.String(255))
    date_find = db.Column(db.DateTime)
    cache_type = db.Column(db.String(50))
    terrain = db.Column(db.Float)
    difficulty = db.Column(db.Float)
    container = db.Column(db.String(50))

    def __repr__(self):
        return f"<Geocache {self.id}, {self.latitude}, {self.longitude}, {self.name}, {self.date_find}, {self.cache_type}>" 
    

@app.route('/')
def index():
    current_lang = get_locale()
    print(f"DEBUG: Route / appelée avec langue: {current_lang}")  # Debug
    print(f"DEBUG: Test traduction 'Données': {_('Données')}")  # Debug
    print(f"DEBUG: Test traduction 'Style': {_('Style')}")  # Debug
    return render_template('app.html')


@app.route('/progressBar')
def get_progress():
    """ Permet de faire un lien entre le navigateur et le serveur pour obtenir l'avancement
    d'un processus pour afficher des messages et faire avancer une ProgressBar"""
    loading_progress, loading_message = get_progress_step()
    return jsonify({'progress': loading_progress, 'message': loading_message})


@app.route('/upload', methods=['POST'])
@cross_origin()
def handle_upload():
    # peuple la BDD, le check du fichier est fait en amont
    uploadBdd(request, Geocache, db)
    return jsonify({'message': 'Fichier reçu avec succès'})   


@app.route('/analyse_file', methods=['POST'])
@cross_origin()
def analyse_file():
    # peuple la BDD, le check du fichier est fait en amont
    return analyse(request)


@app.route('/db_status')
def db_status():
    return db_infos(Geocache)


@app.route('/filter_caches', methods=['POST'])
@cross_origin()
def filter_caches():
    data_request = request.json
    selected_types  = data_request.get('types', [])  # Récupère le tableau des types
    geojson = filter_session(app, db, Geocache, selected_types)
    metadata = get_metadata_from_geojson(geojson["features"])
    response_data = {
        'geojson': geojson,
        'metadata': metadata,
    }
    return jsonify(response_data)


@app.route('/get_geojson_points', methods=['POST', 'GET'])
def get_geojson_points():
    # passage G.query et G pour être compatible avec la fonction filter
    geojson = create_geojson(Geocache.query, Geocache, app)
    metadata = get_metadata_from_geojson(geojson["features"])
    response_data = {
        'geojson': geojson,
        'metadata': metadata,
    }
    return jsonify(response_data)


@app.route('/upload_image', methods=['POST'])
@cross_origin()
def get_upload_image():
    return upload_image(request)


@app.route('/clear_database', methods=['POST'])
@cross_origin()
def clear_database():
    """Vide complètement la base de données"""
    try:
        # Supprimer toutes les entrées de la base de données
        num_deleted = Geocache.query.delete()
        db.session.commit()
        
        return jsonify({
            'success': True, 
            'message': f'Base de données vidée avec succès. {num_deleted} entrées supprimées.'
        })
        
    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False, 
            'message': f'Erreur lors du vidage de la base de données: {str(e)}'
        }), 500


@app.route('/start_create_video', methods=['GET'])
@cross_origin()
def start_create_video():
    try:
        audio = request.args.get('audio')
        audio_volume = request.args.get('audio_volume', default='1.0')
        try:
            vol = float(audio_volume)
        except Exception:
            vol = 1.0
        result = assemble_pictures_directory("captured", "video/output.mp4", 24, audio_path=audio, audio_volume=vol)
        return result
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/clear_pictures_directory', methods=['POST'])
@cross_origin()
def clear_pictures():
    return clear_pictures_directory()


@app.route('/assemble_pictures_directory', methods=['POST'])
@cross_origin()
def assemble_pictures():
    return assemble_pictures_directory("captured", "video/output.mp4", 24)
@app.route('/upload_video', methods=['POST'])
@cross_origin()
def route_upload_video():
    return upload_video(request)

@app.route('/upload_audio', methods=['POST'])
@cross_origin()
def route_upload_audio():
    return upload_audio(request)



@app.route('/check_version', methods=['GET'])
@cross_origin()
def check_version():
    # Utiliser la langue détectée automatiquement (URL > navigateur)
    user_language = get_locale().split('_')[0]
    print(f"DEBUG: check_version appelée avec langue détectée: {user_language}")
    return check_version_online(current_version, user_language)


@app.route('/test_translations')
def test_translations():
    """Route de test pour vérifier que les traductions fonctionnent"""
    current_lang = get_locale()
    print(f"DEBUG: Route test_translations appelée avec langue: {current_lang}")  # Debug

    return jsonify({
        'current_locale': get_locale(),
        'test_strings': {
            'base_de_donnees': _('Base de données'),
            'choisir_fichier': _('Choisir fichier'),
            'filtres': _('Filtres'),
            'cartes': _('Cartes'),
            'parametres': _('Paramètres'),
            'annuler': _('Cancel'),
            'graphisme_des_points': _('Graphisme des points'),  # Test de la nouvelle traduction
            'centre_du_point': _('Centre du point')  # Test d'une autre nouvelle traduction
        }
    })

@app.route('/api/locale')
@cross_origin()
def get_current_locale():
    """Route pour récupérer la langue actuelle détectée"""
    return jsonify({
        'locale': get_locale(),
        'language': get_locale().split('_')[0]  # 'fr' ou 'en'
    })


@app.route('/js_translations.js')
def js_translations():
    """Sert les traductions JavaScript pour le frontend"""
    # Forcer le rechargement des traductions pour la locale actuelle
    current_lang = get_locale()

    translations = {
        'language_changed_message': _('La langue a été changée. La page va se recharger pour appliquer les modifications.'),
        'language_changed_message_en': _('The language has been changed. The page will reload to apply the changes.'),
        'language_change_title': _('Changement de langue'),
        'language_change_title_en': _('Language Change'),
        'language_change_message': _('La langue a été changée. L\'application va redémarrer pour appliquer les modifications.'),
        'language_change_message_en': _('The language has been changed. The application will restart to apply the changes.'),
        'confirm': _('Confirmer'),
        'confirm_en': _('Confirm'),
        'cancel': _('Annuler'),
        'cancel_en': _('Cancel'),
        'current_lang': current_lang,
        'test_translation': _('Base de données')  # Test pour voir si les traductions fonctionnent
    }

    js_content = f"""
// Traductions JavaScript
window.TRANSLATIONS = {json.dumps(translations)};
console.log('Traductions chargées pour la langue:', '{current_lang}');
console.log('Test de traduction:', '{_("Base de données")}');
"""

    response = make_response(js_content)
    response.headers['Content-Type'] = 'application/javascript'
    return response


# ------------------------
# API: App settings
# ------------------------
@app.route('/api/settings', methods=['GET'])
def api_get_settings():
    s = settings_manager.get_app_settings()
    # Récupérer le nom du profil par défaut si un UUID est défini
    default_profile_name = None
    if s.default_profile_uid:
        default_profile_name = settings_manager.get_profile_name_by_uid(s.default_profile_uid)

    return jsonify({
        'version': s.version,
        'language': s.language,
        'check_updates': s.check_updates,
        'default_profile_uid': s.default_profile_uid,
        'default_profile_name': default_profile_name,  # Pour compatibilité frontend
    })


@app.route('/api/settings', methods=['PUT'])
def api_put_settings():
    data = request.get_json(silent=True) or {}
    current = settings_manager.get_app_settings()
    language = data.get('language', current.language)
    check_updates = bool(data.get('check_updates', current.check_updates))

    # Gestion du profil par défaut
    default_profile_uid = data.get('default_profile_uid')

    # Si on reçoit un nom de profil au lieu d'un UUID (compatibilité)
    if not default_profile_uid and data.get('default_profile'):
        profile_name = data.get('default_profile')
        try:
            # Essayer de trouver l'UUID du profil par son nom
            from settings_manager import PROFILES_DIR
            for profile_file in PROFILES_DIR.glob("*.json"):
                try:
                    profile_data = json.loads(profile_file.read_text(encoding="utf-8"))
                    if profile_data.get("name") == profile_name:
                        default_profile_uid = profile_data.get("uid")
                        break
                except Exception:
                    continue
        except Exception as e:
            print(f"Erreur lors de la résolution du nom de profil '{profile_name}': {e}")

    updated = AppSettings(
        version=current.version,
        language=language,
        check_updates=check_updates,
        default_profile_uid=default_profile_uid
    )
    settings_manager.save_app_settings(updated)
    return jsonify({'success': True})


@app.route('/api/settings/reset', methods=['POST'])
def api_reset_settings():
    settings_manager.reset_app_settings()
    return jsonify({'success': True})


# ------------------------
# API: Profiles
# ------------------------
@app.route('/api/profiles', methods=['GET'])
def api_list_profiles():
    return jsonify(settings_manager.list_profiles())


@app.route('/api/profiles/<name>', methods=['GET'])
def api_get_profile(name: str):
    prof = settings_manager.load_profile(name)
    print(f"📤 SERVEUR - Envoi profil '{name}' avec flash: mode={prof.flash.mode}, duration={prof.flash.duration}, size={prof.flash.size}, color={prof.flash.color}, color_type={getattr(prof.flash, 'color_type', 'fix')}")
    return jsonify({
        'version': prof.version,
        'name': prof.name,
        'uid': prof.uid,
        'map': {
            'tile_provider': prof.map.tile_provider,
            'default_center': list(prof.map.default_center),
            'default_zoom': prof.map.default_zoom,
            'vector_options': {
                'stroke_color': prof.map.vector_options.stroke_color,
                'fill_color': prof.map.vector_options.fill_color,
                'background_color': prof.map.vector_options.background_color,
                'stroke_width': prof.map.vector_options.stroke_width,
            },
            'toner_options': {
                'variant': prof.map.toner_options.variant,
            },
        },
        'animation': {
            'enabled': prof.animation.enabled,
            'speed': prof.animation.speed,
        },
        'points': {
            'size': prof.points.size,
            'color': prof.points.color,
            'shape': prof.points.shape,
            'halo': prof.points.halo,
            'border_color': prof.points.border_color,
            'border_size': prof.points.border_size,
            'fill_color_type': prof.points.fill_color_type,
            'border_color_type': prof.points.border_color_type,
        },
        'flash': {
            'mode': prof.flash.mode,
            'duration': prof.flash.duration,
            'size': prof.flash.size,
            'color': prof.flash.color,
            'color_type': getattr(prof.flash, 'color_type', 'fix'),
        },
        'infos': {
            'title': {
                'display': prof.infos.title.display,
                'text': prof.infos.title.text,
            },
            'number_of_caches': prof.infos.number_of_caches,
            'current_date': prof.infos.current_date,
            'title_css': prof.infos.title_css,
            'infos_css': prof.infos.infos_css,
        }
    })


@app.route('/api/profiles/uid/<uid>', methods=['GET'])
def api_get_profile_by_uid(uid: str):
    """Charge un profil par son UUID"""
    prof = settings_manager.load_profile_by_uid(uid)
    print(f"📤 SERVEUR - Envoi profil par UUID '{uid}' (nom: '{prof.name}'), flash.color_type={getattr(prof.flash, 'color_type', 'fix')}")
    return jsonify({
        'version': prof.version,
        'name': prof.name,
        'uid': prof.uid,
        'map': {
            'tile_provider': prof.map.tile_provider,
            'default_center': list(prof.map.default_center),
            'default_zoom': prof.map.default_zoom,
            'vector_options': {
                'stroke_color': prof.map.vector_options.stroke_color,
                'fill_color': prof.map.vector_options.fill_color,
                'background_color': prof.map.vector_options.background_color,
                'stroke_width': prof.map.vector_options.stroke_width,
            },
            'toner_options': {
                'variant': prof.map.toner_options.variant,
            },
        },
        'animation': {
            'enabled': prof.animation.enabled,
            'speed': prof.animation.speed,
        },
        'points': {
            'size': prof.points.size,
            'color': prof.points.color,
            'shape': prof.points.shape,
            'halo': prof.points.halo,
            'border_color': prof.points.border_color,
            'border_size': prof.points.border_size,
            'fill_color_type': prof.points.fill_color_type,
            'border_color_type': prof.points.border_color_type,
        },
        'flash': {
            'mode': prof.flash.mode,
            'duration': prof.flash.duration,
            'size': prof.flash.size,
            'color': prof.flash.color,
            'color_type': getattr(prof.flash, 'color_type', 'fix'),
        },
        'infos': {
            'title': {
                'display': prof.infos.title.display,
                'text': prof.infos.title.text,
            },
            'number_of_caches': prof.infos.number_of_caches,
            'current_date': prof.infos.current_date,
            'title_css': prof.infos.title_css,
            'infos_css': prof.infos.infos_css,
        }
    })


@app.route('/api/profiles', methods=['POST'])
def api_create_profile():
    data = request.get_json(silent=True) or {}
    name = data.get('name') or 'NewProfile'
    base = data.get('base')
    prof = settings_manager.create_profile(name, base)
    return jsonify({'success': True, 'name': prof.name})


@app.route('/api/profiles/<name>', methods=['PUT'])
def api_save_profile(name: str):
    data = request.get_json(silent=True) or {}
    print(f"SERVEUR - Sauvegarde profil '{name}': {data}")
    prof = settings_manager.load_profile(name)
    prof.name = data.get('name', prof.name)

    # Gérer l'UUID si fourni (important pour le renommage)
    if data.get('uid'):
        prof.uid = data.get('uid')
    m = data.get('map', {})
    prof.map.tile_provider = m.get('tile_provider', prof.map.tile_provider)
    if 'default_center' in m:
        try:
            dc = m['default_center']
            prof.map.default_center = (float(dc[0]), float(dc[1]))
        except Exception:
            pass
    if 'default_zoom' in m:
        try:
            prof.map.default_zoom = int(m['default_zoom'])
        except Exception:
            pass
    # Options spécifiques cartes (vector/toner)
    vm = m.get('vector_options') or m.get('vectorOptions') or {}
    if isinstance(vm, dict):
        if 'stroke_color' in vm:
            prof.map.vector_options.stroke_color = vm['stroke_color']
        if 'fill_color' in vm:
            prof.map.vector_options.fill_color = vm['fill_color']
        if 'background_color' in vm:
            prof.map.vector_options.background_color = vm['background_color']
        if 'stroke_width' in vm:
            try:
                prof.map.vector_options.stroke_width = float(vm['stroke_width'])
            except Exception:
                pass
    tm = m.get('toner_options') or m.get('tonerOptions') or {}
    if isinstance(tm, dict):
        if 'variant' in tm:
            prof.map.toner_options.variant = tm['variant']
    a = data.get('animation', {})
    if 'enabled' in a:
        prof.animation.enabled = bool(a['enabled'])
    if 'speed' in a:
        try:
            prof.animation.speed = float(a['speed'])
        except Exception:
            pass
    pt = data.get('points', {})
    if 'size' in pt:
        try:
            prof.points.size = int(pt['size'])
        except Exception:
            pass
    if 'color' in pt:
        prof.points.color = pt['color']
    if 'shape' in pt:
        prof.points.shape = pt['shape']
    if 'halo' in pt:
        prof.points.halo = bool(pt['halo'])
    if 'border_color' in pt:
        prof.points.border_color = pt['border_color']
    if 'border_size' in pt:
        try:
            prof.points.border_size = int(pt['border_size'])
        except Exception:
            pass
    if 'fill_color_type' in pt:
        prof.points.fill_color_type = pt['fill_color_type']
    if 'border_color_type' in pt:
        prof.points.border_color_type = pt['border_color_type']

    # Gestion du champ flash
    f = data.get('flash', {})
    if 'mode' in f:
        prof.flash.mode = f['mode']
    if 'duration' in f:
        try:
            prof.flash.duration = int(f['duration'])
        except Exception:
            pass
    if 'size' in f:
        try:
            prof.flash.size = int(f['size'])
        except Exception:
            pass
    if 'color' in f:
        prof.flash.color = f['color']
    if 'color_type' in f:
        prof.flash.color_type = f['color_type']

    # Gestion du champ infos (titre, cases à cocher, CSS)
    i = data.get('infos', {}) or {}
    if isinstance(i, dict):
        t = i.get('title', {}) or {}
        if isinstance(t, dict):
            if 'display' in t:
                prof.infos.title.display = bool(t['display'])
            if 'text' in t:
                prof.infos.title.text = t['text']
        if 'number_of_caches' in i:
            prof.infos.number_of_caches = bool(i['number_of_caches'])
        if 'current_date' in i:
            prof.infos.current_date = bool(i['current_date'])
        if 'title_css' in i:
            prof.infos.title_css = i['title_css'] or ''
        if 'infos_css' in i:
            prof.infos.infos_css = i['infos_css'] or ''

    print(f"💾 SERVEUR - Profil sauvegardé avec flash: mode={prof.flash.mode}, duration={prof.flash.duration}, size={prof.flash.size}, color={prof.flash.color}, color_type={getattr(prof.flash, 'color_type', 'fix')} | infos: title.display={prof.infos.title.display}, title.text={prof.infos.title.text}, number_of_caches={prof.infos.number_of_caches}, current_date={prof.infos.current_date}, title_css_len={len(prof.infos.title_css or '')}, infos_css_len={len(prof.infos.infos_css or '')}")
    settings_manager.save_profile(prof)
    return jsonify({'success': True})


@app.route('/api/profiles/<name>/duplicate', methods=['POST'])
def api_duplicate_profile(name: str):
    data = request.get_json(silent=True) or {}
    new_name = data.get('new_name') or f"{name}_copy"
    prof = settings_manager.duplicate_profile(name, new_name)
    return jsonify({'success': True, 'name': prof.name})


@app.route('/api/profiles/<name>', methods=['DELETE'])
def api_delete_profile(name: str):
    settings_manager.delete_profile(name)
    return jsonify({'success': True})


@app.route('/api/profiles/<name>/reset', methods=['POST'])
def api_reset_profile(name: str):
    settings_manager.reset_profile(name)
    return jsonify({'success': True})


# ------------------------
# API: Profiles Import/Export
# ------------------------
@app.route('/api/profiles/<name>/export', methods=['GET'])
def api_export_profile(name: str):
    try:
        payload = settings_manager.export_profile_payload(name, current_version)
        return jsonify(payload)
    except FileNotFoundError:
        return jsonify({'success': False, 'message': f"Profil '{name}' introuvable"}), 404
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400


@app.route('/api/profiles/import', methods=['POST'])
def api_import_profile():
    try:
        data = request.get_json(silent=True) or {}
        prof = settings_manager.import_profile_payload(data)
        return jsonify({'success': True, 'name': prof.name, 'uid': prof.uid})
    except ValueError as ve:
        return jsonify({'success': False, 'message': str(ve)}), 400
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

if __name__ == '__main__':
    # ouverture automatique du navigateur, pour l'instant en pause
    #webview.start()
    #webbrowser.open('http://127.0.0.1:5000')
    app.run(debug=True)