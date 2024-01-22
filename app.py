import webview
import webbrowser
from flask import Flask, render_template, jsonify, request, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from flask_cors import cross_origin
from bdd import uploadBdd, get_progress_step, db_infos, create_geojson

app = Flask(__name__)

CORS(app)

app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///geocaching.db'
db = SQLAlchemy(app)

# VARIABLES GLOBALES
# Variable pour déterminer l'avancement du chargement du fichier gpx
loading_progress = 0

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

    def __repr__(self):
        return f"<Geocache {self.id}, {self.latitude}, {self.longitude}, {self.name}, {self.date_find}, {self.cache_type}>"  # noqa: E501
    

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
    if 'file' not in request.files:
        return jsonify({'message': 'Aucun fichier envoyé'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'message': 'Aucun fichier sélectionné'}), 400
    
    print("upload")
    uploadBdd(request, Geocache, db)

    return jsonify({'message': 'Fichier reçu avec succès'})


@app.route('/db_status')
def db_status():
    return db_infos()


@app.route('/get_geojson_points', methods=['POST', 'GET'])
def get_geojson_points():
    return create_geojson(Geocache, request, app)

if __name__ == '__main__':
    # ouverture automatique du navigateur, pour l'instant en pause
    #webview.start()
    #webbrowser.open('http://127.0.0.1:5000')
    app.run(debug=True)