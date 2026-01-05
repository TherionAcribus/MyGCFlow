from .core import core_bp
from .filters import filters_bp
from .gpx import gpx_bp
from .media import media_bp
from .profiles import profiles_bp
from .tasks import tasks_bp


def register_blueprints(app):
    app.register_blueprint(core_bp)
    app.register_blueprint(gpx_bp)
    app.register_blueprint(filters_bp)
    app.register_blueprint(media_bp)
    app.register_blueprint(profiles_bp)
    app.register_blueprint(tasks_bp)
