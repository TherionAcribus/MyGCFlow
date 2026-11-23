from extensions import db


class Geocache(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)
    gc_code = db.Column(db.String(255))
    cache_name = db.Column(db.String(255))
    date_find = db.Column(db.DateTime)
    time_find = db.Column(db.String(16))
    found = db.Column(db.Boolean, default=False)
    published_date = db.Column(db.DateTime)
    cache_type = db.Column(db.String(50))
    terrain = db.Column(db.Float)
    difficulty = db.Column(db.Float)
    container = db.Column(db.String(50))
    country = db.Column(db.String(100))
    state = db.Column(db.String(100))
    owner = db.Column(db.String(255))
    placed_by = db.Column(db.String(255))
    attributes = db.Column(db.Text)

    __table_args__ = (
        db.Index('ix_geocache_date_find', 'date_find'),
        db.Index('ix_geocache_published_date', 'published_date'),
        db.Index('ix_geocache_type_date', 'cache_type', 'date_find'),
        db.Index('ix_geocache_country_state', 'country', 'state'),
    )

    def __repr__(self):
        return f"<Geocache {self.id}, {self.latitude}, {self.longitude}, {self.gc_code}, {self.cache_name}, {self.date_find}, {self.cache_type}>"


class LabCollection(db.Model):
    """Historique Adventure Lab importé d'un joueur (une collection en V1)."""
    __tablename__ = 'lab_collection'

    id = db.Column(db.Integer, primary_key=True)
    uid = db.Column(db.String(64), unique=True, nullable=False)
    account_label = db.Column(db.String(255))
    # Révision incrémentée à chaque mutation : contrôle optimiste du commit.
    revision = db.Column(db.Integer, nullable=False, default=0)
    last_import_at = db.Column(db.DateTime)
    last_exported_at = db.Column(db.DateTime)
    last_coverage = db.Column(db.String(16))
    last_import_summary = db.Column(db.Text)
    created_at = db.Column(db.DateTime)


class LabDiscovery(db.Model):
    """Une étape Adventure Lab découverte — une ligne = une étape trouvée."""
    __tablename__ = 'lab_discovery'

    COORD_MISSING = 'missing'
    COORD_RESOLVED = 'resolved'
    COORD_AMBIGUOUS = 'ambiguous'
    COORD_INVALID = 'invalid'

    id = db.Column(db.Integer, primary_key=True)
    collection_id = db.Column(db.Integer, db.ForeignKey('lab_collection.id'), nullable=False)
    local_uid = db.Column(db.String(64), nullable=False)
    adventure_uuid = db.Column(db.String(64))
    stage_uuid = db.Column(db.String(64))
    adventure_title = db.Column(db.String(255))
    stage_title = db.Column(db.String(255))
    adventure_url = db.Column(db.String(512))
    # Date civile de découverte utilisée par l'animation (nullable : une
    # ligne sans date reste stockée, jamais affichée comme faux point).
    found_date = db.Column(db.Date)
    # Pour /logs : instant calculé depuis une heure locale étiquetée avec
    # l'offset du Pacifique — décalé de plusieurs heures, il ne sert qu'à
    # comparer deux imports (docs/notes/lab-caches-sources.md).
    found_at_utc = db.Column(db.DateTime)
    found_at_offset_minutes = db.Column(db.Integer)
    date_precision = db.Column(db.String(16))
    date_basis = db.Column(db.String(32))
    source_date_text = db.Column(db.String(64))
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)
    coordinate_scope = db.Column(db.String(16))
    coordinate_source = db.Column(db.String(32))
    coordinate_status = db.Column(db.String(16), default=COORD_MISSING)
    # Dernière récupération lab2gpx restée sans résultat pour cette étape :
    # Adventure que le service n'a pas su servir (archivée, cassée), ou
    # servie sans cette étape (remaniée depuis). Elle n'est alors ni
    # redemandée tout de suite, ni proposée à nouveau à l'utilisateur.
    coord_fetch_failed_at = db.Column(db.DateTime)
    # Coordonnées proposées (même titre dans l'Adventure, UUID d'étape
    # différent) : jamais appliquées seules, l'utilisateur les valide.
    suggested_latitude = db.Column(db.Float)
    suggested_longitude = db.Column(db.Float)
    # Portés par le fichier coordonnées (GPX Lab2Gpx), absents de l'historique.
    owner = db.Column(db.String(255))
    published_date = db.Column(db.Date)   # publication de l'Adventure
    # Rang de l'étape et nombre d'étapes de l'Adventure (GPX Lab2Gpx) ;
    # images d'étape et d'Adventure (historique /logs, hôte vérifié).
    # Affichage seulement : le popup de l'étape.
    stage_number = db.Column(db.Integer)
    stages_total = db.Column(db.Integer)
    stage_image_url = db.Column(db.String(512))
    adventure_image_url = db.Column(db.String(512))
    source_format = db.Column(db.String(32))
    source_record_key = db.Column(db.String(128))
    is_archived = db.Column(db.Boolean, default=False)
    imported_at = db.Column(db.DateTime)
    updated_at = db.Column(db.DateTime)

    collection = db.relationship(
        'LabCollection',
        backref=db.backref('discoveries', cascade='all, delete-orphan'),
    )

    __table_args__ = (
        # SQLite autorise plusieurs NULL : la contrainte n'agit que pour les
        # stage_uuid présents ; les lignes sans UUID s'appuient sur local_uid.
        db.UniqueConstraint('collection_id', 'stage_uuid', name='uq_lab_discovery_stage'),
        db.UniqueConstraint('collection_id', 'local_uid', name='uq_lab_discovery_local_uid'),
        db.Index('ix_lab_discovery_found_date', 'collection_id', 'found_date'),
        db.Index('ix_lab_discovery_adventure', 'collection_id', 'adventure_uuid'),
        db.Index('ix_lab_discovery_coord_status', 'collection_id', 'coordinate_status'),
    )

    # Les trois états qui pilotent tout le reste (compteurs, GeoJSON, liste
    # des étapes en attente, récupération) : définis ici une seule fois.
    # Écrits sans négation SQL — un coordinate_status NULL compte comme
    # « non résolu », ce qu'un simple `!=` laisserait passer.

    @classmethod
    def coords_missing_clause(cls):
        """Étape sans position exploitable."""
        return db.or_(cls.coordinate_status.is_(None),
                      cls.coordinate_status != cls.COORD_RESOLVED,
                      cls.latitude.is_(None), cls.longitude.is_(None))

    @classmethod
    def ready_clause(cls):
        """Étape affichable : position résolue ET date de découverte."""
        return db.and_(cls.coordinate_status == cls.COORD_RESOLVED,
                       cls.latitude.isnot(None), cls.longitude.isnot(None),
                       cls.found_date.isnot(None))

    @classmethod
    def unresolved_clause(cls):
        """Complément exact de `ready_clause`."""
        return db.or_(cls.found_date.is_(None), cls.coords_missing_clause())

    def __repr__(self):
        return f"<LabDiscovery {self.id}, {self.latitude}, {self.longitude}, {self.local_uid}, {self.stage_title}, {self.found_date}, {self.coordinate_status}>"


# Logs Geocaching (docs/logs-geocaching.md) : DNF, actions de poseur, logs
# des autres sur ses caches. Rattachés aux caches par `gc_code`, jamais par
# `geocache.id` — l'import My Finds réécrit toutes les lignes de `geocache`.

class LogCollection(db.Model):
    """Logs importés d'un joueur (une collection = un compte en v1)."""
    __tablename__ = 'log_collection'

    id = db.Column(db.Integer, primary_key=True)
    uid = db.Column(db.String(64), unique=True, nullable=False)
    # « Moi » : comparé à log_event.author_id et cache_ref.owner_id.
    account_user_id = db.Column(db.Integer)
    account_username = db.Column(db.String(255))
    # Incrémentée à chaque import ou suppression : contrôle optimiste du commit.
    revision = db.Column(db.Integer, nullable=False, default=0)
    last_import_at = db.Column(db.DateTime)
    last_import_summary = db.Column(db.Text)
    # Instant `exported_at` jusqu'auquel les DNF du compte sont connus :
    # horizon de la collecte incrémentale du favori. Il n'avance que sur
    # un export à couverture DNF complète — une collecte « caches posées
    # seulement » ne le fait pas bouger, sinon la fenêtre incrémentale
    # suivante sauterait les DNF parus entre-temps.
    dnf_covered_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime)


class LogEvent(db.Model):
    """Un log Geocaching (une cache, un auteur, un type, une date civile)."""
    __tablename__ = 'log_event'

    id = db.Column(db.Integer, primary_key=True)
    collection_id = db.Column(db.Integer, db.ForeignKey('log_collection.id'), nullable=False)
    log_id = db.Column(db.Integer, nullable=False)       # identifiant Geocaching
    gc_code = db.Column(db.String(16), nullable=False)
    # Identifiant de type Geocaching (2 Found it, 3 DNF…) ; la catégorie
    # (find, dnf, owner…) se déduit, voir log_formats.log_category.
    type_id = db.Column(db.Integer, nullable=False)
    log_date = db.Column(db.Date, nullable=False)
    author_id = db.Column(db.Integer)
    author_name = db.Column(db.String(255))
    favorite = db.Column(db.Boolean)                     # NULL = inconnu
    source_format = db.Column(db.String(32))
    # `exported_at` du fichier qui a fourni la version retenue : départage
    # deux versions d'un même log (la plus récente l'emporte).
    source_exported_at = db.Column(db.DateTime)
    imported_at = db.Column(db.DateTime)
    updated_at = db.Column(db.DateTime)

    __table_args__ = (
        db.UniqueConstraint('collection_id', 'log_id', name='uq_log_event_log_id'),
        db.Index('ix_log_event_cache', 'collection_id', 'gc_code', 'log_date'),
        db.Index('ix_log_event_author', 'collection_id', 'author_id', 'type_id', 'log_date'),
        db.Index('ix_log_event_date', 'collection_id', 'log_date'),
    )


class CacheRef(db.Model):
    """Fiche d'une cache vue dans les logs (DNF jamais résolus, caches posées…)."""
    __tablename__ = 'cache_ref'

    id = db.Column(db.Integer, primary_key=True)
    collection_id = db.Column(db.Integer, db.ForeignKey('log_collection.id'), nullable=False)
    gc_code = db.Column(db.String(16), nullable=False)
    name = db.Column(db.String(255))
    cache_type = db.Column(db.String(50))
    container = db.Column(db.String(50))
    difficulty = db.Column(db.Float)
    terrain = db.Column(db.Float)
    country = db.Column(db.String(100))
    state = db.Column(db.String(100))
    # Coordonnées publiées ; `coordinate_source` vaut le format du fichier,
    # ou 'user_correction' — prioritaire sur tout import ultérieur.
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)
    coordinate_source = db.Column(db.String(32))
    # Coordonnées corrigées par le joueur (mystery résolue), usage à décider.
    corrected_latitude = db.Column(db.Float)
    corrected_longitude = db.Column(db.Float)
    owner_id = db.Column(db.Integer)
    owner_name = db.Column(db.String(255))
    placed_date = db.Column(db.Date)
    status = db.Column(db.String(16))                    # active/disabled/archived/unknown
    status_at = db.Column(db.DateTime)                   # export qui atteste l'état
    favorite_points = db.Column(db.Integer)
    # Logs de trouvaille de la fiche (Found it, Attended, Webcam), à la
    # date de l'export — comme favorite_points.
    found_count = db.Column(db.Integer)
    source_format = db.Column(db.String(32))
    source_exported_at = db.Column(db.DateTime)
    imported_at = db.Column(db.DateTime)
    updated_at = db.Column(db.DateTime)

    __table_args__ = (
        db.UniqueConstraint('collection_id', 'gc_code', name='uq_cache_ref_gc_code'),
        db.Index('ix_cache_ref_owner', 'collection_id', 'owner_id'),
    )


class CacheWaypoint(db.Model):
    """Waypoint d'une cache lu sur sa fiche par le favori « Mes logs »
    (contrat `caches[].waypoints`) : les parkings seulement. Ceux d'une
    cache sont remplacés en bloc à chaque import de sa fiche."""
    __tablename__ = 'cache_waypoint'

    id = db.Column(db.Integer, primary_key=True)
    collection_id = db.Column(db.Integer, db.ForeignKey('log_collection.id'), nullable=False)
    gc_code = db.Column(db.String(16), nullable=False)
    kind = db.Column(db.String(16), nullable=False)
    name = db.Column(db.String(255))
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)

    __table_args__ = (
        db.Index('ix_cache_waypoint_code', 'collection_id', 'gc_code'),
    )


class Parcours(db.Model):
    """Un parcours : une journée ou des vacances rejouées cache par cache
    (MyGCFlow_Plan_Parcours.md). On stocke la sélection et, plus tard, les
    ajustements de l'utilisateur — jamais l'ordre ni les heures reconstruits,
    recalculés à chaque ouverture."""
    __tablename__ = 'parcours'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    date_start = db.Column(db.Date, nullable=False)
    date_end = db.Column(db.Date, nullable=False)
    # Sources retenues en plus des trouvailles.
    include_labs = db.Column(db.Boolean, nullable=False, default=True)
    include_dnf = db.Column(db.Boolean, nullable=False, default=True)
    # Décalage UTC des traces GPS (lot 5), en minutes ; null : déduit
    # (photos, Labs sur la trace, fuseau de l'ordinateur).
    utc_offset_minutes = db.Column(db.Integer)
    # Réglages de lecture propres au parcours : JSON épars des clés
    # explicitement réglées ; les autres suivent la préférence globale
    # `parcours_playback` (le défaut). NULL : aucune surcharge.
    playback = db.Column(db.Text)
    # Affichage des photos propre au parcours : même principe, défaut global
    # `parcours_photo_display`. NULL : aucune surcharge.
    photo_display = db.Column(db.Text)
    created_at = db.Column(db.DateTime)
    updated_at = db.Column(db.DateTime)


class ParcoursOverride(db.Model):
    """Ajustement manuel d'une étape d'un parcours (lot 3) : rang forcé dans
    sa journée, heure épinglée, journée corrigée, exclusion. Une ligne sans
    aucun ajustement est supprimée."""
    __tablename__ = 'parcours_override'

    id = db.Column(db.Integer, primary_key=True)
    parcours_id = db.Column(db.Integer, db.ForeignKey('parcours.id'), nullable=False)
    # Clé d'étape (parcours_dataset.py) : code GC, `lab:<uuid>`, `dnf:<log_id>`.
    stop_key = db.Column(db.String(96), nullable=False)
    rank = db.Column(db.Integer)
    pinned_time = db.Column(db.String(5))      # « HH:MM », heure locale
    day = db.Column(db.Date)                   # journée corrigée
    excluded = db.Column(db.Boolean, nullable=False, default=False)
    # Mode du trajet vers l'étape suivante (lot 6) : walk, bike, car, straight.
    leg_mode = db.Column(db.String(8))
    # Durée de visite imposée (minutes) ; null : durée estimée selon le type.
    visit_min = db.Column(db.Integer)
    # Position posée à la main en glissant l'étape sur la carte (lot 15) :
    # prime sur toute autre (mystery résolue jamais corrigée sur le site).
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)

    __table_args__ = (
        db.UniqueConstraint('parcours_id', 'stop_key', name='uq_parcours_override_key'),
    )


class ParcoursPlace(db.Model):
    """Lieu posé par l'utilisateur sur un parcours (lot 3) : `place` (point de
    vue, restaurant… : une étape de plus) ou `base` (hôtel, domicile : départ
    et retour de la journée)."""
    __tablename__ = 'parcours_place'

    id = db.Column(db.Integer, primary_key=True)
    parcours_id = db.Column(db.Integer, db.ForeignKey('parcours.id'), nullable=False)
    kind = db.Column(db.String(8), nullable=False)
    name = db.Column(db.String(80))
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)
    # Journée concernée ; une base sans date vaut pour toutes les journées.
    date = db.Column(db.Date)
    time = db.Column(db.String(5))             # « HH:MM » : heure sûre du lieu
    # Rôle d'une base : « both » (départ et retour), « start » (départ seul)
    # ou « end » (retour seul) — partir d'un hôtel, dormir au camping.
    role = db.Column(db.String(8), nullable=False, default='both')
    # Catégorie d'affichage (parking, repas, hébergement…) : icône dans la
    # liste et sur la carte ; le comportement reste celui du `kind`.
    category = db.Column(db.String(16), nullable=False, default='other')
    # Icône Tabler libre (« ti-… ») pour la catégorie « custom », sinon NULL.
    icon = db.Column(db.String(48))
    created_at = db.Column(db.DateTime)


class ParcoursPhoto(db.Model):
    """Photo d'un parcours (lot 4), normalisée dans parcours_photos/<id>/.
    L'EXIF est lu à l'envoi (la normalisation le retire) : heure murale de
    l'appareil, décalage horaire s'il est connu, position, appareil."""
    __tablename__ = 'parcours_photo'

    id = db.Column(db.Integer, primary_key=True)
    parcours_id = db.Column(db.Integer, db.ForeignKey('parcours.id'), nullable=False)
    file = db.Column(db.String(40), nullable=False)        # <empreinte>.jpg|png
    original_name = db.Column(db.String(255))
    taken_at = db.Column(db.String(19))                    # « AAAA-MM-JJTHH:MM:SS », heure de l'appareil
    offset_minutes = db.Column(db.Integer)                 # OffsetTimeOriginal, si présent
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)
    camera = db.Column(db.String(120))                     # « marque modèle »
    camera_serial = db.Column(db.String(40))               # BodySerialNumber, si présent
    width = db.Column(db.Integer)
    height = db.Column(db.Integer)
    # Étape rattachée à la main (null : rattachement automatique, calculé).
    stop_key = db.Column(db.String(96))
    created_at = db.Column(db.DateTime)
    # Affichage dans la lecture (lot 8) : masquée (reste un indice), légende,
    # cadrage (proportions, point focal en %, zoom en %). Null : défaut.
    hidden = db.Column(db.Boolean, nullable=False, default=False)
    # Favorite : orne les cartons, passe en premier au-delà du plafond.
    favorite = db.Column(db.Boolean, nullable=False, default=False)
    caption = db.Column(db.String(200))
    aspect = db.Column(db.String(8))
    focus_x = db.Column(db.Integer)
    focus_y = db.Column(db.Integer)
    zoom = db.Column(db.Integer)


class ParcoursCamera(db.Model):
    """Décalage de l'horloge d'un appareil photo pour un parcours (lot 4) :
    minutes à ajouter à l'heure de ses photos. `camera` est la clé
    d'appareil : « marque modèle », suivie de « #numéro de série » quand
    l'EXIF le donne (cameraKey de parcours_photos.mjs)."""
    __tablename__ = 'parcours_camera'

    id = db.Column(db.Integer, primary_key=True)
    parcours_id = db.Column(db.Integer, db.ForeignKey('parcours.id'), nullable=False)
    camera = db.Column(db.String(200), nullable=False)
    offset_minutes = db.Column(db.Integer, nullable=False, default=0)

    __table_args__ = (
        db.UniqueConstraint('parcours_id', 'camera', name='uq_parcours_camera'),
    )


class ParcoursTrack(db.Model):
    """Trace GPS d'un parcours (lot 5), simplifiée à l'import
    (parcours_tracks.py). `segments` : JSON [[[lon, lat, t], ...], ...], t en
    secondes UTC depuis l'époque Unix."""
    __tablename__ = 'parcours_track'

    id = db.Column(db.Integer, primary_key=True)
    parcours_id = db.Column(db.Integer, db.ForeignKey('parcours.id'), nullable=False)
    name = db.Column(db.String(255))
    segments = db.Column(db.Text, nullable=False)
    point_count = db.Column(db.Integer, nullable=False, default=0)
    source_point_count = db.Column(db.Integer, nullable=False, default=0)
    start_utc = db.Column(db.DateTime)
    end_utc = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime)


class RouteLegCache(db.Model):
    """Itinéraire d'un trajet calculé par un fournisseur (lot 6,
    parcours_routing.py), partagé par tous les parcours. `geometry` null :
    pas de route possible (ligne droite), à ne plus redemander."""
    __tablename__ = 'route_leg_cache'

    id = db.Column(db.Integer, primary_key=True)
    provider = db.Column(db.String(16), nullable=False)
    profile = db.Column(db.String(8), nullable=False)
    leg_key = db.Column(db.String(40), nullable=False)    # sha1 des extrémités arrondies
    geometry = db.Column(db.Text)                           # JSON [[lon, lat], ...]
    distance_m = db.Column(db.Float)
    duration_s = db.Column(db.Float)
    fetched_at = db.Column(db.DateTime)

    __table_args__ = (
        db.UniqueConstraint('provider', 'profile', 'leg_key', name='uq_route_leg_cache'),
    )
