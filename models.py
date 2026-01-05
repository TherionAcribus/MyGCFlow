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

    def __repr__(self):
        return f"<Geocache {self.id}, {self.latitude}, {self.longitude}, {self.gc_code}, {self.cache_name}, {self.date_find}, {self.cache_type}>"
