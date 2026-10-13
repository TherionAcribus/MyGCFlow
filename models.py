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
    # Dernière fois où lab2gpx n'a pas su servir l'Adventure de cette étape
    # (archivée, cassée) : l'auto-fetch ne la redemande pas tout de suite.
    coord_fetch_failed_at = db.Column(db.DateTime)
    # Coordonnées proposées (même titre dans l'Adventure, UUID d'étape
    # différent) : jamais appliquées seules, l'utilisateur les valide.
    suggested_latitude = db.Column(db.Float)
    suggested_longitude = db.Column(db.Float)
    # Portés par le fichier coordonnées (GPX Lab2Gpx), absents de l'historique.
    owner = db.Column(db.String(255))
    published_date = db.Column(db.Date)   # publication de l'Adventure
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
