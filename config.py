import os


class Config:
    SQLALCHEMY_DATABASE_URI = os.getenv('DATABASE_URI', 'sqlite:///geocaching.db')
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    BABEL_DEFAULT_LOCALE = 'fr'
    BABEL_SUPPORTED_LOCALES = ['en', 'fr']
    BABEL_TRANSLATION_DIRECTORIES = 'translations'
    APP_VERSION = '1.0'
