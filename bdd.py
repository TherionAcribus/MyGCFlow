from flask_sqlalchemy import SQLAlchemy
from flask import jsonify
import xml.etree.ElementTree as ET
from datetime import datetime
import os
import json


# Objet dédié pour gérer l'état du chargement
class LoadingState:
    def __init__(self):
        self.progress = 0
        self.message = ""

    def reset(self):
        self.progress = 0
        self.message = ""

    def update(self, progress, message):
        self.progress = progress
        self.message = message

    def complete(self):
        self.progress = 101  # Valeur > 100 pour indiquer la fin

# Instance globale pour l'état du chargement
loading_state = LoadingState()

# analyse le fichier transmit pour peupler La BDD
def analyse(request):
    if 'file' not in request.files:
        return jsonify({'message': 'Aucun fichier envoyé'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'message': 'Aucun fichier sélectionné'}), 400
    
    # verification du fichier envoyé
    checkFile = checkFileNameAndDesc(request)

    if checkFile["success"]:
        return jsonify(checkFile), 200
    else:
        return jsonify(checkFile), 400
    

def checkFileNameAndDesc(request):
    """ Vérifie que le fichier envoyé est bien un GPX "My Finds" """
    try:
        # Essayer de parser le fichier comme un XML
        gpxfile = request.files['file']
        tree = ET.parse(gpxfile)
        root = tree.getroot()
        
        # Trouver les éléments <name> et <desc> dans le fichier GPX
        name = root.find('{http://www.topografix.com/GPX/1/0}name')
        desc = root.find('{http://www.topografix.com/GPX/1/0}desc')

        if name is None or "My Finds Pocket Query" not in name.text and "Groundspeak" in desc.text:
            return {'success': False, 'message': "Le fichier GPX est une Pocket Query."}
        elif "Groundspeak" not in desc.text:
            return {'success': False, 'message': 'Le fichier GPX n\'est pas un fichier produit par Groundspeak.'}
        
    except ET.ParseError:
        return {'success': False, 'message': 'Le fichier fourni n\'est pas un fichier GPX valide'}
    
    return {'success': True, 'message': 'Fichier reçu avec succès'}


def uploadBdd(request, Geocache, db):
    # initialisation de l'état du chargement
    loading_state.reset()
    loading_state.message = "Lecture du fichier GPX..."

    # Assurez-vous que la table existe
    db.create_all()

    # Videz la table si elle contient déjà des données
    db.session.query(Geocache).delete()
    db.session.commit()

    gpxfile = request.files['file']
    tree = ET.parse(gpxfile)
    root = tree.getroot()

    ns = {'default': 'http://www.topografix.com/GPX/1/0',
        'groundspeak': 'http://www.groundspeak.com/cache/1/0/1'}

    total_waypoints = len(root.findall('default:wpt', ns))

    for index, waypoint in enumerate(root.findall('default:wpt', ns)):
        date_find = None
        cache_data = waypoint.find('groundspeak:cache', ns)
        if cache_data is not None:
            logs = cache_data.find('groundspeak:logs', ns)
            cache_type = cache_data.find('groundspeak:type', ns).text
            container = cache_data.find('groundspeak:container', ns).text
            terrain = cache_data.find('groundspeak:terrain', ns).text
            difficulty = cache_data.find('groundspeak:difficulty', ns).text
            if logs is not None:
                for log_entry in logs.findall('groundspeak:log', ns):
                    date_find_str = log_entry.find('groundspeak:date', ns).text
                    if date_find_str:
                        date_find = datetime.strptime(date_find_str, '%Y-%m-%dT%H:%M:%SZ')


        new_geocache = Geocache(
            latitude=waypoint.attrib['lat'],
            longitude=waypoint.attrib['lon'],
            name=waypoint.find('default:name', ns).text,
            date_find=date_find,
            cache_type = cache_type,
            terrain = terrain,
            difficulty = difficulty,
            container = container
        )
        db.session.add(new_geocache)

        # Commit tous les 100 points
        if (index + 1) % 100 == 0:
            db.session.commit()
            loading_state.update(
                index / total_waypoints * 100,
                f'Ajout du point {index + 1} sur {total_waypoints} à la base de données'
            )

    # Pour s'assurer que les derniers points sont également enregistrés
    db.session.commit()
    # On marque le chargement comme terminé
    loading_state.complete()


def get_progress_step():
    """ Sert à récupérer l'état d'avancement du chargement depuis l'objet dédié
    Utilise maintenant une classe LoadingState au lieu de variables globales """
    return loading_state.progress, loading_state.message


def db_infos(Geocache):
    """UTilisé pour voir si une BDD existe. Pour l'instant uniquement pour la BDD SQLLite geocaching.db"""
    db_path = 'instance/geocaching.db'  # Chemin de la base de données
    exists = database_exists(db_path)
    size = get_database_size(db_path)
    if exists:
        startDate, endDate = get_database_start_end(Geocache)
        return jsonify({'exists': exists, 'size': size, 'startDate': startDate, 'endDate': endDate})
    return jsonify({'exists': exists, 'size': size, 'startDate': None, 'endDate': None})


def get_database_size(db_path):
    return os.path.getsize(db_path) if os.path.exists(db_path) else 0


def get_database_start_end(Geocache):
    """Premiere et derniere date de la base de données"""
    first_entry = Geocache.query.order_by(Geocache.date_find).first()
    last_entry = Geocache.query.order_by(Geocache.date_find.desc()).first()
    startDate = first_entry.date_find if first_entry else None
    endDate = last_entry.date_find if last_entry else None
    return startDate, endDate


def database_exists(db_path):
    return os.path.exists(db_path)


def create_geojson(query, Geocache, app):
    query = query.order_by(Geocache.date_find)
    
    # Récupérer les données du formulaire
    #form_data = request.json
    #cache_types = form_data.get('cacheType', [])
    #print('cache_types',cache_types)
    
    # Filtrer la requête si cache_types ne contient pas "all"
    #if "all" not in cache_types and cache_types:
    #    query = query.filter(Geocache.type.in_(cache_types))
        
        # Exécutez la requête pour obtenir la liste des points
        #query = query.all()

    # Créez une structure GeoJSON pour les points
    geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [point.longitude, point.latitude]
                },
                "properties": {
                    "date_find": point.date_find.strftime('%Y-%m-%d') if point.date_find else None,
                    "cache_type": point.cache_type
                }
            } for point in query
        ]
    }

    # Chemin du fichier où sauvegarder le GeoJSON
    file_path = os.path.join(app.root_path, 'static', 'geojson_data.json')

    # Sauvegarde du GeoJSON dans un fichier
    with open(file_path, 'w') as f:
        json.dump(geojson, f, indent=4)

    return geojson


# TODO : C'est Pas terrible de récupérer infos depuis GeoJSON. Ce serait plus logique de les récupérer depuis la BDD
def get_metadata_from_geojson(features):
    # Vérifier que la liste des features n'est pas vide
    if features:
        # Récupérer les dates du premier et du dernier élément
        start_date = datetime.strptime(features[0]["properties"]["date_find"], '%Y-%m-%d')
        end_date = datetime.strptime(features[-1]["properties"]["date_find"], '%Y-%m-%d')
        delta_days = (end_date - start_date).days
    else:
        start_date, end_date, delta_days = None, None, None

    metadata = {
        "startDate": start_date.strftime('%Y-%m-%d') if start_date else None,
        "endDate": end_date.strftime('%Y-%m-%d') if end_date else None,
        "deltaDays": delta_days,
        "numberOfCaches": len(features)
    }

    return metadata


def filter_session(app, db, Geocache, selectedValues):
    """ Filtre de la BDD et retourne une query qui sera transformée plus tard en GeoJSON """
    print('selectedValues',selectedValues)

    query = db.session.query(Geocache)
    # Utilisez db.session pour faire la requête
    query = query.filter(Geocache.cache_type.in_(selectedValues["type"]))
    query = query.filter(Geocache.terrain.in_(selectedValues["terrain"]))
    query = query.filter(Geocache.difficulty.in_(selectedValues["difficulty"]))
    query = query.filter(Geocache.container.in_(selectedValues["container"]))

    # Filtrage par plage de dates
    start_date = convert_str_to_date(selectedValues["dates"]['startDate'])
    end_date = convert_str_to_date(selectedValues["dates"]['endDate'])
    query = query.filter(Geocache.date_find >= start_date, Geocache.date_find <= end_date)
    
    geocaches_data = create_geojson(query, Geocache, app)

    return geocaches_data


def convert_str_to_date(date_str):
    return datetime.strptime(date_str, '%Y-%m-%d').date()