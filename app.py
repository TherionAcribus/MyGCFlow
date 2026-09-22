from flask import Flask
from flask_babel import gettext as _

import migrations
import paths
from config import Config
import security
from extensions import babel, compress, db
from localization import get_locale
from blueprints import register_blueprints

gettext = _


def create_app(config_object=None):
    # Racines explicites : les ressources (templates, static, translations) sont
    # lues à côté du code, l'instance (base SQLite) vit dans le dossier de
    # données de l'utilisateur — cf. paths.py.
    app = Flask(
        __name__,
        root_path=str(paths.resource_dir()),
        instance_path=str(paths.ensure_dir(paths.instance_dir())),
    )
    app.config.from_object(Config)
    if config_object:
        if isinstance(config_object, dict):
            app.config.update(config_object)
        else:
            app.config.from_object(config_object)

    security.init_app(app)
    babel.init_app(app, locale_selector=get_locale)
    db.init_app(app)
    # Compression HTTP (gzip/deflate/brotli) pour toutes les réponses — le
    # GeoJSON (10+ Mo pour un gros compte) compresse à ~10–15 % de sa taille.
    compress.init_app(app)

    register_blueprints(app)

    app.jinja_env.globals['_'] = _
    with app.app_context():
        db.create_all()
        migrations.upgrade(db)

    return app


app = create_app()


if __name__ == '__main__':
    app.run(debug=True)
