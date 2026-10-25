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
    source_format = db.Column(db.String(32))
    source_exported_at = db.Column(db.DateTime)
    imported_at = db.Column(db.DateTime)
    updated_at = db.Column(db.DateTime)

    __table_args__ = (
        db.UniqueConstraint('collection_id', 'gc_code', name='uq_cache_ref_gc_code'),
        db.Index('ix_cache_ref_owner', 'collection_id', 'owner_id'),
    )
