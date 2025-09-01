#!/usr/bin/env python3

import os
import sys
from flask import Flask, request
from flask_babel import Babel, gettext as _

# Configuration minimale pour tester les traductions
app = Flask(__name__)
app.config['BABEL_DEFAULT_LOCALE'] = 'fr'
app.config['BABEL_SUPPORTED_LOCALES'] = ['en', 'fr']

def get_locale():
    locale = request.args.get('lang')
    if locale in app.config['BABEL_SUPPORTED_LOCALES']:
        return locale
    return request.accept_languages.best_match(app.config['BABEL_SUPPORTED_LOCALES'])

babel = Babel(app, locale_selector=get_locale)
app.jinja_env.globals['_'] = _

@app.route('/test')
def test():
    return {
        'locale': get_locale(),
        'translations': {
            'base_de_donnees': _('Base de données'),
            'filtres': _('Filtres'),
            'parametres': _('Paramètres'),
            'donnees': _('Données'),
            'style': _('Style'),
            'animation': _('Animation')
        }
    }

if __name__ == '__main__':
    with app.test_client() as client:
        print("=== Test Français ===")
        response = client.get('/test')
        print(response.get_json())

        print("\n=== Test Anglais ===")
        response = client.get('/test?lang=en')
        print(response.get_json())
