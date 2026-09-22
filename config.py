import os

import paths
from version import __version__


class Config:
    # Chemin absolu : un `sqlite:///geocaching.db` relatif serait résolu dans le
    # dossier d'instance de Flask, c'est-à-dire à côté du code — en lecture
    # seule une fois l'application installée.
    SQLALCHEMY_DATABASE_URI = os.getenv(
        'DATABASE_URI', f"sqlite:///{paths.database_path().as_posix()}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    BABEL_DEFAULT_LOCALE = 'fr'
    BABEL_SUPPORTED_LOCALES = ['en', 'fr']
    BABEL_TRANSLATION_DIRECTORIES = 'translations'
    APP_VERSION = __version__
