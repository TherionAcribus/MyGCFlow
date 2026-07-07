from flask_sqlalchemy import SQLAlchemy
from flask import jsonify, current_app
import xml.etree.ElementTree as ET
from datetime import datetime
import os
import json
from typing import Optional

from geojson_cache import GeojsonIndexCache, build_metadata_from_features
from task_manager import TaskStatus, task_manager

# Namespaces GPX en notation Clark ({uri}) — utilisés par ET.iterparse qui
# renvoie les tags sous cette forme, contrairement à ET.find avec dictionnaire ns.
NS_GPX = '{http://www.topografix.com/GPX/1/0}'
NS_GS = '{http://www.groundspeak.com/cache/1/0/1}'
# Dictionnaire équivalent pour elem.find() qui attend des préfixes
_NS_DICT = {'default': 'http://www.topografix.com/GPX/1/0',
            'groundspeak': 'http://www.groundspeak.com/cache/1/0/1'}


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

# Types de tâches connus pour les traitements lourds
TASK_TYPE_IMPORT = "gpx_import"
TASK_TYPE_GEOJSON = "geojson_generation"

geojson_cache = GeojsonIndexCache()


def _update_progress(status: Optional[TaskStatus], progress: float, message: str = ""):
    """Propagate progress to both the task status (if provided) and legacy loading_state."""
    if status:
        status.set_progress(progress, message)
    # L'état legacy n'est utilisé que pour l'import GPX (progressBar historique)
    if status is None or getattr(status, "type", None) == TASK_TYPE_IMPORT:
        loading_state.update(progress, message)
# --- Utils ---
def parse_gpx_time(text: str):
    """Parse GPX <time> values accepting with/without 'Z' and date-only.
    Returns a datetime or None.
    """
    if not text:
        return None
    s = text.strip()
    # Remove fractional seconds if present
    if '.' in s:
        # keep only up to seconds and optional trailing 'Z'
        base, rest = s.split('.', 1)
        # try to keep trailing 'Z'
        if rest.endswith('Z'):
            s = base + 'Z'
        else:
            s = base
    patterns = [
        '%Y-%m-%dT%H:%M:%SZ',  # with Z
        '%Y-%m-%dT%H:%M:%S',   # without Z
        '%Y-%m-%d',            # date only
    ]
    for p in patterns:
        try:
            return datetime.strptime(s, p)
        except Exception:
            continue
    return None

def get_child_text_anyns(element, local_name):
    """Return direct child text by local name regardless of namespace.
    Checks namespaced, non-namespaced, and any child whose tag endswith '}local'.
    """
    try:
        # Try common namespace prefixes
        # Note: callers generally pass 'default' and ns dict, but be resilient
        # 1) exact non-namespaced
        el = element.find(local_name)
        if el is not None and el.text:
            return el.text
        # 2) search namespaced children by suffix
        for child in list(element):
            tag = child.tag or ''
            if tag.endswith('}' + local_name) or tag == local_name:
                return child.text
    except Exception:
        pass
    return None

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
        gpxfile = request.files['file']
        name_text, desc_text, author_text = _read_gpx_header(gpxfile)
        return validate_gpx_header(name_text, desc_text, author_text)
    except ET.ParseError:
        return {'success': False, 'message': 'Le fichier fourni n\'est pas un fichier GPX valide'}


def validate_gpx_header(name_text, desc_text, author_text):
    """Valide qu'un en-tête GPX correspond à un fichier "My Finds" Groundspeak.

    Source unique de vérité pour la validation. Travailler sur les textes
    (et non sur un arbre XML) permet de l'appeler aussi bien depuis
    checkFileNameAndDesc (flux request) que depuis uploadBdd (iterparse).
    """
    # Vérifier la provenance Groundspeak (champ desc ou author)
    is_ground_speak = (
        (desc_text is not None and 'Groundspeak' in desc_text)
        or (author_text is not None and 'Groundspeak' in author_text)
    )

    if not is_ground_speak:
        return {'success': False, 'message': 'Le fichier GPX n\'est pas un fichier produit par Groundspeak.'}

    # Vérifier que le fichier est bien un "My Finds"
    if name_text is None or not name_text or "My Finds Pocket Query" not in name_text:
        return {'success': False, 'message': "Le fichier GPX est une Pocket Query et non un fichier My Finds."}

    return {'success': True, 'message': 'Fichier reçu avec succès'}


def _read_gpx_header(source):
    """Lit l'en-tête d'un GPX (<name>, <desc>, <author>) via ET.iterparse.

    S'arrête au premier <wpt> — ces éléments d'en-tête précèdent toujours les
    waypoints dans un GPX valide. Évite de charger tout le fichier en mémoire
    (ET.parse) juste pour valider l'en-tête.

    Args:
        source: chemin de fichier ou objet fichier (comme request.files['file']).

    Returns:
        (name_text, desc_text, author_text) — textes des éléments, ou None.
    """
    name_text = desc_text = author_text = None
    for event, elem in ET.iterparse(source, events=('end',)):
        if elem.tag == NS_GPX + 'name':
            name_text = elem.text
        elif elem.tag == NS_GPX + 'desc':
            desc_text = elem.text
        elif elem.tag == NS_GPX + 'author':
            author_text = elem.text
        elif elem.tag == NS_GPX + 'wpt':
            # Premier waypoint : l'en-tête est complet, on s'arrête ici.
            elem.clear()
            break
        elem.clear()
    return name_text, desc_text, author_text


def uploadBdd(file_path, Geocache, db, status: Optional[TaskStatus] = None):
    # initialisation de l'état du chargement
    loading_state.reset()
    _update_progress(status, 0, "Lecture du fichier GPX...")

    # Assurez-vous que la table existe
    db.create_all()
    print('[UPLOAD] DB schema check: ensuring columns and indexes...')
    try:
        ensure_geocache_columns(db)
        ensure_geocache_indexes(db)
    except Exception as e:
        print(f"[MIGRATION] Warning while ensuring schema: {e}")

    # --- Étape 1 : valider l'en-tête, compter les waypoints, puis construire
    # les objets en mémoire ---
    # On utilise ET.iterparse (streaming) au lieu de ET.parse (charge tout le
    # fichier en mémoire). Deux passes sur le fichier :
    #   Pass 1 : valide l'en-tête (<name>/<desc>/<author> avant le 1er <wpt>)
    #            et compte les waypoints pour la barre de progression.
    #   Pass 2 : traite chaque <wpt> en libérant la mémoire (elem.clear()).
    # Les objets Geocache sont construits AVANT de toucher à la base, afin qu'un
    # échec de parsing ne vide pas la BDD de l'utilisateur.
    try:
        ns = _NS_DICT
        wpt_tag = NS_GPX + 'wpt'

        # --- Pass 1 : validation + comptage ---
        header = {}
        validated = False
        total_waypoints = 0
        for event, elem in ET.iterparse(file_path, events=('end',)):
            if elem.tag == NS_GPX + 'name':
                header['name'] = elem.text
            elif elem.tag == NS_GPX + 'desc':
                header['desc'] = elem.text
            elif elem.tag == NS_GPX + 'author':
                header['author'] = elem.text
            elif elem.tag == wpt_tag:
                # Premier waypoint : l'en-tête est complet, on valide maintenant.
                if not validated:
                    check = validate_gpx_header(
                        header.get('name'), header.get('desc'), header.get('author')
                    )
                    if not check.get('success'):
                        raise ValueError(check.get('message', 'Fichier GPX invalide'))
                    validated = True
                total_waypoints += 1
            elem.clear()

        if not validated:
            # Aucun <wpt> trouvé — l'en-tête n'a jamais pu être validé.
            raise ValueError('Aucun waypoint trouvé dans le fichier GPX')

        print(f"[UPLOAD] GPX waypoints detected: {total_waypoints}")

        # --- Pass 2 : traitement des waypoints ---
        new_caches = []
        wpt_index = 0
        for event, waypoint in ET.iterparse(file_path, events=('end',)):
            if waypoint.tag != wpt_tag:
                waypoint.clear()
                continue

            wpt_index += 1

            # Coordonnées
            lat = waypoint.attrib.get('lat')
            lon = waypoint.attrib.get('lon')

            # Date de publication (du waypoint)
            published_date = None
            # Extraire time (<time>) quelle que soit la namespace
            time_text = get_child_text_anyns(waypoint, 'time')
            if time_text:
                parsed_pd = parse_gpx_time(time_text)
                published_date = parsed_pd
            else:
                parsed_pd = None

            # Codes/noms
            # Extraire name (<name>) et urlname (<urlname>) robustement
            gc_code = get_child_text_anyns(waypoint, 'name')
            urlname_text = get_child_text_anyns(waypoint, 'urlname')
            cache_data = waypoint.find('groundspeak:cache', ns)
            gs_name = cache_data.find('groundspeak:name', ns).text if (cache_data is not None and cache_data.find('groundspeak:name', ns) is not None) else None
            cache_name = (urlname_text if urlname_text is not None else gs_name)

            # Logs debug pour les 50 premiers (et ensuite tous les 200)
            if wpt_index <= 50 or (wpt_index % 200 == 0):
                print(f"[UPLOAD][{wpt_index}/{total_waypoints}] code={gc_code} lat={lat} lon={lon} time_raw={time_text} parsed_published={parsed_pd}")

            # Champs par défaut
            cache_type = None
            container = None
            terrain = None
            difficulty = None
            owner = None
            placed_by = None
            country = None
            state = None
            attributes = []
            found = False
            date_find = None
            time_find = None

            if cache_data is not None:
                # Champs primitifs
                ct = cache_data.find('groundspeak:type', ns)
                if ct is not None and ct.text:
                    cache_type = ct.text
                co = cache_data.find('groundspeak:container', ns)
                if co is not None and co.text:
                    container = co.text
                te = cache_data.find('groundspeak:terrain', ns)
                if te is not None and te.text:
                    try:
                        terrain = float(te.text)
                    except Exception:
                        terrain = None
                di = cache_data.find('groundspeak:difficulty', ns)
                if di is not None and di.text:
                    try:
                        difficulty = float(di.text)
                    except Exception:
                        difficulty = None
                ow = cache_data.find('groundspeak:owner', ns)
                if ow is not None and ow.text:
                    owner = ow.text
                pb = cache_data.find('groundspeak:placed_by', ns)
                if pb is not None and pb.text:
                    placed_by = pb.text
                co_ = cache_data.find('groundspeak:country', ns)
                if co_ is not None and co_.text:
                    country = co_.text
                st_ = cache_data.find('groundspeak:state', ns)
                if st_ is not None and st_.text:
                    state = st_.text

                # Attributs (peut être vide)
                attrs = cache_data.find('groundspeak:attributes', ns)
                if attrs is not None:
                    for a in attrs.findall('groundspeak:attribute', ns):
                        try:
                            attr_id = a.attrib.get('id')
                            inc = a.attrib.get('inc')
                            name_attr = a.text or ''
                            attributes.append({'id': attr_id, 'name': name_attr, 'inc': inc})
                        except Exception:
                            continue

                # Logs -> déterminer l'état trouvé et la datetime de référence
                logs = cache_data.find('groundspeak:logs', ns)
                if logs is not None:
                    # Types d'événements qui utilisent "Attended" au lieu de "Found it"
                    event_types = {
                        'Event Cache',
                        'Mega-Event Cache',
                        'Giga-Event Cache',
                        'Cache In Trash Out Event',
                        'Geocaching HQ Block Party',
                        'GPS Adventures Exhibit',
                        'Community Celebration Event'
                    }

                    # Types spéciaux avec leurs types de logs spécifiques
                    special_cache_types = {
                        'Webcam Cache': 'Webcam Photo Taken'
                    }

                    # Prendre la dernière entrée "Found it", "Attended" (pour les événements) ou type spécial comme référence
                    last_found_dt = None
                    for log_entry in logs.findall('groundspeak:log', ns):
                        type_el = log_entry.find('groundspeak:type', ns)
                        date_el = log_entry.find('groundspeak:date', ns)
                        if type_el is not None and date_el is not None and date_el.text:
                            log_type = type_el.text
                            # Pour les événements, considérer "Attended" comme équivalent à "Found it"
                            # Pour les caches spéciaux, considérer leur type de log spécifique
                            is_valid_log = (
                                log_type == 'Found it' or
                                (cache_type in event_types and log_type == 'Attended') or
                                (cache_type in special_cache_types and log_type == special_cache_types[cache_type])
                            )
                            if is_valid_log:
                                try:
                                    dt = datetime.strptime(date_el.text, '%Y-%m-%dT%H:%M:%SZ')
                                    if (last_found_dt is None) or (dt > last_found_dt):
                                        last_found_dt = dt
                                except Exception:
                                    continue
                    if last_found_dt is not None:
                        found = True
                        date_find = last_found_dt
                        time_find = last_found_dt.strftime('%H:%M:%S')

            new_geocache = {
                'latitude': lat,
                'longitude': lon,
                'gc_code': gc_code,
                'cache_name': cache_name,
                'date_find': date_find,
                'time_find': time_find,
                'found': found,
                'published_date': published_date,
                'cache_type': cache_type,
                'terrain': terrain,
                'difficulty': difficulty,
                'container': container,
                'owner': owner,
                'placed_by': placed_by,
                'country': country,
                'state': state,
                'attributes': json.dumps(attributes) if attributes else None
            }
            new_caches.append(new_geocache)

            # Mise à jour de la progression tous les 100 points (sans commit :
            # les objets sont accumulés en mémoire, la BDD n'est pas encore touchée)
            count = len(new_caches)
            if count % 100 == 0:
                progress_value = (count / max(total_waypoints, 1)) * 100
                _update_progress(
                    status,
                    progress_value,
                    f'Ajout du point {count} sur {total_waypoints} à la base de données'
                )

            # Libérer la mémoire de l'élément traité (avantage clé d'iterparse
            # vs ET.parse : le DOM du waypoint est libéré au fur et à mesure).
            waypoint.clear()

    except Exception as exc:
        # Parsing/processing échoué : la base existante est intacte, aucun
        # DELETE ni INSERT n'a été émis. On rollback par sécurité et on propage.
        db.session.rollback()
        print(f"[UPLOAD] Parsing/processing failed, DB left untouched: {exc}")
        raise

    # --- Étape 2 : remplacer le contenu en une seule transaction ---
    # Le DELETE et tous les INSERTs sont commités atomiquement. Si le commit
    # échoue, l'ancienne base est préservée (rollback automatique de SQLAlchemy).
    # On utilise bulk_insert_mappings (par lots de 1000) au lieu de add_all() :
    # cela bypass l'identity map de la session — pas d'objets ORM, pas de state
    # tracking, juste des INSERTs bruts. Typiquement 5–10× plus rapide sur SQLite.
    _update_progress(status, 99, "Enregistrement en base de données...")
    db.session.query(Geocache).delete()

    BATCH_SIZE = 1000
    total_mappings = len(new_caches)
    for i in range(0, total_mappings, BATCH_SIZE):
        batch = new_caches[i:i + BATCH_SIZE]
        db.session.bulk_insert_mappings(Geocache, batch)
        # flush pour que chaque lot soit envoyé à SQLite sans fermer la transaction
        db.session.flush()

    db.session.commit()

    try:
        non_null_pd = db.session.query(Geocache).filter(Geocache.published_date != None).count()
        total_rows = db.session.query(Geocache).count()
        print(f"[UPLOAD] Import finished. published_date non-null: {non_null_pd}/{total_rows}")
        # Générer l'arborescence Country > State une fois l'import terminé
        try:
            build_country_state_tree(db, Geocache)
        except Exception as e:
            print(f"[UPLOAD] build_country_state_tree error: {e}")
    except Exception as e:
        print(f"[UPLOAD] Post-import count error: {e}")
    # On marque le chargement comme terminé
    loading_state.complete()
    _update_progress(status, 100, "Import terminé")
    geojson_cache.invalidate("gpx_import")


def get_progress_step(task_id: Optional[str] = None):
    """Retourne l'état d'une tâche d'import (progression, message, état, id)."""
    task = None
    if task_id:
        task = task_manager.get(task_id)
    if task is None:
        task = task_manager.get_last(TASK_TYPE_IMPORT)
    if task:
        return task.progress, task.message, task.state, task.id, task.error
    return loading_state.progress, loading_state.message, "unknown", None, None


def db_infos(Geocache):
    """Utilisé pour voir si une BDD existe et obtenir ses informations détaillées"""
    db_path = 'instance/geocaching.db'  # Chemin de la base de données
    exists = database_exists(db_path)
    size = get_database_size(db_path)
    
    if exists:
        # Compter le nombre total d'entrées
        total_points = Geocache.query.count()
        
        if total_points > 0:
            # Base de données existe et contient des données
            startDate, endDate = get_database_start_end(Geocache)
            # Date de dernière modification du fichier de base de données
            import datetime
            modification_time = os.path.getmtime(db_path)
            load_date = datetime.datetime.fromtimestamp(modification_time).strftime('%Y-%m-%d %H:%M:%S')
            
            return jsonify({
                'exists': exists, 
                'size': size, 
                'isEmpty': False,
                'totalPoints': total_points,
                'startDate': startDate, 
                'endDate': endDate,
                'loadDate': load_date
            })
        else:
            # Base de données existe mais est vide
            return jsonify({
                'exists': exists, 
                'size': size, 
                'isEmpty': True,
                'totalPoints': 0,
                'startDate': None, 
                'endDate': None,
                'loadDate': None
            })
    else:
        # Base de données n'existe pas
        return jsonify({
            'exists': exists, 
            'size': 0, 
            'isEmpty': None,  # N/A car n'existe pas
            'totalPoints': 0,
            'startDate': None, 
            'endDate': None,
            'loadDate': None
        })


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


def create_geojson(query, Geocache, status: Optional[TaskStatus] = None, persist: bool = True):
    query = query.order_by(Geocache.date_find)
    total_points = query.count() if status else None

    features = []
    for idx, point in enumerate(query):
        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [point.longitude, point.latitude]
            },
            "properties": {
                "date_find": point.date_find.strftime('%Y-%m-%d') if point.date_find else None,
                "time_find": getattr(point, 'time_find', None),
                "found": bool(getattr(point, 'found', False)),
                "published_date": getattr(point, 'published_date', None).strftime('%Y-%m-%d') if getattr(point, 'published_date', None) else None,
                "cache_type": point.cache_type,
                "gc_code": getattr(point, 'gc_code', None),
                "name": getattr(point, 'cache_name', None),
                "difficulty": point.difficulty,
                "terrain": point.terrain,
                "container": point.container,
                "owner": getattr(point, 'owner', None),
                "placed_by": getattr(point, 'placed_by', None),
                "country": getattr(point, 'country', None),
                "state": getattr(point, 'state', None),
                "attributes": json.loads(point.attributes) if getattr(point, 'attributes', None) else None
            }
        }
        features.append(feature)

        if status and total_points:
            progress_value = ((idx + 1) / total_points) * 100
            _update_progress(status, progress_value, f"Génération du GeoJSON ({idx + 1}/{total_points})")

    geojson = {
        "type": "FeatureCollection",
        "features": features
    }

    if persist:
        file_path = os.path.join(current_app.root_path, 'static', 'geojson_data.json')
        with open(file_path, 'w') as f:
            json.dump(geojson, f)

    return geojson


# TODO : C'est Pas terrible de récupérer infos depuis GeoJSON. Ce serait plus logique de les récupérer depuis la BDD
def get_metadata_from_geojson(features):
    return build_metadata_from_features(features)


def ensure_geocache_columns(db):
    """Ajoute les colonnes manquantes dans la table geocache (SQLite)."""
    from sqlalchemy import text
    conn = db.engine.connect()
    try:
        res = conn.execute(text("PRAGMA table_info(geocache);"))
        cols = {row[1] for row in res}
        print(f"[MIGRATION] Existing columns: {sorted(list(cols))}")
        wanted = {
            'gc_code': "ALTER TABLE geocache ADD COLUMN gc_code VARCHAR(255)",
            'cache_name': "ALTER TABLE geocache ADD COLUMN cache_name VARCHAR(255)",
            'time_find': "ALTER TABLE geocache ADD COLUMN time_find VARCHAR(16)",
            'found': "ALTER TABLE geocache ADD COLUMN found BOOLEAN DEFAULT 0",
            'published_date': "ALTER TABLE geocache ADD COLUMN published_date DATETIME",
            'country': "ALTER TABLE geocache ADD COLUMN country VARCHAR(100)",
            'state': "ALTER TABLE geocache ADD COLUMN state VARCHAR(100)",
            'owner': "ALTER TABLE geocache ADD COLUMN owner VARCHAR(255)",
            'placed_by': "ALTER TABLE geocache ADD COLUMN placed_by VARCHAR(255)",
            'attributes': "ALTER TABLE geocache ADD COLUMN attributes TEXT"
        }
        for col, stmt in wanted.items():
            if col not in cols:
                try:
                    print(f"[MIGRATION] Adding missing column: {col}")
                    conn.execute(text(stmt))
                except Exception as e:
                    print(f"[MIGRATION] Could not add column {col}: {e}")
    finally:
        conn.close()


def ensure_geocache_indexes(db):
    """Crée les index manquants sur la table geocache (SQLite)."""
    from sqlalchemy import text
    conn = db.engine.connect()
    try:
        # Récupérer la liste des index existants
        res = conn.execute(text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='geocache';"))
        existing_indexes = {row[0] for row in res}
        print(f"[MIGRATION] Existing indexes: {sorted(list(existing_indexes))}")
        
        # Index à créer (nom -> statement SQL)
        wanted_indexes = {
            'ix_geocache_date_find': "CREATE INDEX IF NOT EXISTS ix_geocache_date_find ON geocache (date_find)",
            'ix_geocache_published_date': "CREATE INDEX IF NOT EXISTS ix_geocache_published_date ON geocache (published_date)",
            'ix_geocache_type_date': "CREATE INDEX IF NOT EXISTS ix_geocache_type_date ON geocache (cache_type, date_find)",
            'ix_geocache_country_state': "CREATE INDEX IF NOT EXISTS ix_geocache_country_state ON geocache (country, state)",
        }
        
        for idx_name, stmt in wanted_indexes.items():
            if idx_name not in existing_indexes:
                try:
                    print(f"[MIGRATION] Creating index: {idx_name}")
                    conn.execute(text(stmt))
                    conn.commit()
                except Exception as e:
                    print(f"[MIGRATION] Could not create index {idx_name}: {e}")
            else:
                print(f"[MIGRATION] Index {idx_name} already exists")
    finally:
        conn.close()


def filter_session(db, Geocache, selectedValues, status: Optional[TaskStatus] = None):
    """Filtre la BDD et retourne un GeoJSON généré en tâche de fond si status fourni."""
    print('selectedValues',selectedValues)

    query = db.session.query(Geocache)
    # Utilisez db.session pour faire la requête
    # Appliquer les filtres de type de cache
    types = selectedValues.get("type") or []
    if len(types) > 0:
        query = query.filter(Geocache.cache_type.in_(types))
    else:
        # Aucun type sélectionné => aucun résultat
        query = query.filter(Geocache.cache_type == '__NONE__')
    if selectedValues.get("terrain"):
        query = query.filter(Geocache.terrain.in_(selectedValues["terrain"]))
    if selectedValues.get("difficulty"):
        query = query.filter(Geocache.difficulty.in_(selectedValues["difficulty"]))
    if selectedValues.get("container"):
        query = query.filter(Geocache.container.in_(selectedValues["container"]))

    # Filtrage par pays
    countries = selectedValues.get("countries") or []
    if isinstance(countries, list):
        if len(countries) > 0:
            query = query.filter(Geocache.country.in_(countries))

    # Filtrage par états/régions
    states = selectedValues.get("states") or []
    if isinstance(states, list):
        if len(states) > 0:
            query = query.filter(Geocache.state.in_(states))

    # Filtrage par plage de dates (trouvaille)
    dates = selectedValues.get("dates") or {}
    if isinstance(dates, dict):
        start_date = convert_str_to_date(dates.get('startDate'))
        end_date = convert_str_to_date(dates.get('endDate'))
        if start_date and end_date:
            query = query.filter(Geocache.date_find >= start_date, Geocache.date_find <= end_date)

    # Filtrage par plage de dates de publication
    published_dates = selectedValues.get("published_dates") or {}
    if isinstance(published_dates, dict):
        published_start_date = convert_str_to_date(published_dates.get('startDate'))
        published_end_date = convert_str_to_date(published_dates.get('endDate'))
        if published_start_date and published_end_date:
            query = query.filter(Geocache.published_date >= published_start_date, Geocache.published_date <= published_end_date)
    
    geocaches_data = create_geojson(query, Geocache, status, persist=False)

    return geocaches_data


def convert_str_to_date(date_str):
    if not date_str:
        return None
    return datetime.strptime(date_str, '%Y-%m-%d').date()


def build_country_state_tree(db, Geocache):
    """Construit un dictionnaire Country -> [States] depuis la BDD et l'écrit dans static/json/country_state.json"""
    try:
        rows = db.session.query(Geocache.country, Geocache.state).distinct().all()
        tree = {}
        for country, state in rows:
            if not country:
                continue
            key = country.strip()
            val = (state or '').strip() if state else None
            if key not in tree:
                tree[key] = set()
            if val:
                tree[key].add(val)
        # Convertir les sets en listes triées
        tree_sorted = { c: sorted(list(states)) for c, states in sorted(tree.items(), key=lambda x: x[0].lower()) }

        # Écriture JSON
        out_dir = os.path.join(current_app.root_path, 'static', 'json')
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, 'country_state.json')
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(tree_sorted, f, ensure_ascii=False, indent=2)
        print(f"[UPLOAD] Country/State tree generated: {out_path} ({len(tree_sorted)} countries)")
    except Exception as e:
        print(f"[UPLOAD] build_country_state_tree failed: {e}")


def run_import_task(status: TaskStatus, app, file_path: str, Geocache, db):
    """Tâche de fond pour l'import GPX (exécutée dans un thread)."""
    try:
        with app.app_context():
            uploadBdd(file_path, Geocache, db, status=status)
            # SQLite WAL mode ne met pas à jour le mtime du fichier principal immédiatement.
            # Sans cette invalidation, run_geojson_task verrait le même mtime et servirait
            # le GeoJSON vide du cache de démarrage au lieu de régénérer.
            geojson_cache.invalidate("post_import")
            # pollGeojsonTask() côté JS vérifie status.result pour distinguer succès/échec.
            # Sans set_result(), la tâche serait traitée comme une erreur côté frontend.
            status.set_result({"success": True})
    finally:
        try:
            os.remove(file_path)
        except Exception:
            pass


def run_geojson_task(status: TaskStatus, app, Geocache, db, selected_values: Optional[dict] = None):
    """Tâche de fond pour générer le GeoJSON complet ou filtré."""
    with app.app_context():
        status.set_progress(1, "Préparation des données GeoJSON...")
        db_mtime = geojson_cache.get_database_mtime()
        geojson_cache.invalidate_if_db_changed(db_mtime)

        metadata = None

        if selected_values is None:
            cached_full = geojson_cache.get_base_dataset_if_current(db_mtime)
            if cached_full:
                _, metadata = cached_full
                status.set_progress(30, "GeoJSON servi depuis le cache")
            else:
                status.set_progress(5, "Génération du GeoJSON complet...")
                geojson = create_geojson(db.session.query(Geocache), Geocache, status)
                metadata = get_metadata_from_geojson(geojson["features"])
                geojson_cache.set_base_dataset(geojson, metadata, db_mtime)
        else:
            cached_filtered = geojson_cache.get_filtered_if_current(selected_values, db_mtime)
            if cached_filtered:
                _, metadata = cached_filtered
                status.set_progress(35, "Résultat filtré servi depuis le cache")
            else:
                if geojson_cache.get_base_dataset_if_current(db_mtime) is None:
                    status.set_progress(5, "Pré-calcul du GeoJSON complet pour indexer les filtres...")
                    base_geojson = create_geojson(db.session.query(Geocache), Geocache, status)
                    base_metadata = get_metadata_from_geojson(base_geojson["features"])
                    geojson_cache.set_base_dataset(base_geojson, base_metadata, db_mtime)
                status.set_progress(45, "Application des index mémoire (date/type/région)...")
                filtered = geojson_cache.filter_with_indexes(selected_values, db_mtime)
                if filtered is None:
                    status.set_progress(60, "Filtrage direct en base (fallback)...")
                    geojson = filter_session(db, Geocache, selected_values, status)
                    metadata = get_metadata_from_geojson(geojson["features"])
                    geojson_cache.store_filtered_result(selected_values, geojson, metadata, db_mtime)
                else:
                    _, metadata = filtered

        # Stocker seulement une référence légère au lieu du GeoJSON complet
        status.set_result({
            "cache_ref": {
                "type": "base" if selected_values is None else "filtered",
                "selected_values": selected_values,
                "db_mtime": db_mtime
            },
            "metadata": metadata
        })
