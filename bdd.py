from flask_sqlalchemy import SQLAlchemy
from flask import jsonify
import xml.etree.ElementTree as ET
from datetime import datetime
import os
import json


# variable globale pour le chargement du fichier
loading_progress = 0
loading_message = ""

def uploadBdd(request, Geocache, db):
    # initialisation de la variable de chargement
    global loading_progress, loading_message
    loading_progress = 0
    loading_message = "Lecture du fichier GPX..."

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
            loading_message = f'Ajout du point {index + 1} sur {total_waypoints} à la base de données'
            loading_progress = index / total_waypoints * 100

    # Pour s'assurer que les derniers points sont également enregistrés
    db.session.commit()
    # On met à jour la variable de chargement > 100 pour être sûr d'arreter le processus de verification de l'avancement
    loading_progress = 101


def get_progress_step():
    """ Sert juste à servir les infos d'avancement car la variable loading_progress n'est pas dans le même fichier
    Pour l'instant une seule variable donc solution pratique. Si plus, penser à utiliser Redis """
    global loading_progress, loading_message
    return loading_progress, loading_message


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