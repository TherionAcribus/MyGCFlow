from flask import current_app, request
from flask_babel import gettext as _


def get_locale():
    locale = request.args.get('lang')
    supported_locales = current_app.config.get('BABEL_SUPPORTED_LOCALES', [])
    if locale in supported_locales:
        return locale

    browser_locale = request.accept_languages.best_match(supported_locales)
    return browser_locale
