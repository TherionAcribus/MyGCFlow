import webview
import webbrowser
import json
from flask import g, Flask, render_template, jsonify, request, send_from_directory, make_response
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from flask_cors import cross_origin
from bdd import uploadBdd, get_progress_step, db_infos, create_geojson, get_metadata_from_geojson, filter_session, analyse
from capture import upload_image, clear_pictures_directory, assemble_pictures_directory
from options import check_version_online
from flask_babel import Babel, gettext as _

# Créer un alias pour la fonction de traduction
gettext = _

app = Flask(__name__)

CORS(app)

current_version = "2.0"

# Configuration de la traduction
app.config['BABEL_DEFAULT_LOCALE'] = 'fr'  # Langue par défaut français
app.config['BABEL_SUPPORTED_LOCALES'] = ['en', 'fr']
app.config['BABEL_TRANSLATION_DIRECTORIES'] = 'translations'

def get_locale():
    # Essayer d'abord de récupérer la langue depuis les paramètres de la requête
    locale = request.args.get('lang')
    if locale in app.config['BABEL_SUPPORTED_LOCALES']:
        return locale
    # Sinon utiliser la langue du navigateur
    return request.accept_languages.best_match(app.config['BABEL_SUPPORTED_LOCALES'])

babel = Babel(app, locale_selector=get_locale)

# Assurer que la fonction gettext est disponible dans les templates
app.jinja_env.globals['_'] = _

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


@app.route('/start_create_video', methods=['GET'])
@cross_origin()
def start_create_video():
    try:
        result = assemble_pictures_directory("captured", "video/output.mp4", 24)
        return result
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


# @app.route('/clear_pictures_directory', methods=['POST'])
# @cross_origin()
# def clear_pictures():
#     return clear_pictures_directory()


# @app.route('/assemble_pictures_directory', methods=['POST'])
# @cross_origin()
# def assemble_pictures():
#     return assemble_pictures_directory("captured", "video/output.mp4", 24)


@app.route('/check_version', methods=['GET'])
@cross_origin()
def check_version():
    return check_version_online(current_version)


@app.route('/test_translations')
def test_translations():
    """Route de test pour vérifier que les traductions fonctionnent"""
    return jsonify({
        'current_locale': get_locale(),
        'test_strings': {
            'base_de_donnees': _('Base de données'),
            'choisir_fichier': _('Choisir fichier'),
            'filtres': _('Filtres'),
            'cartes': _('Cartes'),
            'parametres': _('Paramètres'),
            'annuler': _('Cancel')
        }
    })


@app.route('/js_translations.js')
def js_translations():
    """Sert les traductions JavaScript pour le frontend"""
    # Forcer le rechargement des traductions pour la locale actuelle
    current_lang = get_locale()

    translations = {
        'language_changed_message': _('La langue a été changée. La page va se recharger pour appliquer les modifications.'),
        'language_changed_message_en': _('The language has been changed. The page will reload to apply the changes.'),
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

if __name__ == '__main__':
    # ouverture automatique du navigateur, pour l'instant en pause
    #webview.start()
    #webbrowser.open('http://127.0.0.1:5000')
    app.run(debug=True)