from flask import current_app, request
from flask_babel import gettext as _

from settings_manager import SettingsManager

_settings_manager = SettingsManager()


def _normalize_locale(locale: str, supported_locales):
    """Return locale if supported (accepts fr/en or fr_FR)."""
    if not locale:
        return None

    normalized = locale.replace('-', '_')
    if normalized in supported_locales:
        return normalized

    short = normalized.split('_')[0]
    if short in supported_locales:
        return short

    return None


def get_locale():
    supported_locales = current_app.config.get('BABEL_SUPPORTED_LOCALES', [])

    # 1. Paramètre explicite (URL)
    locale = _normalize_locale(request.args.get('lang'), supported_locales)
    if locale:
        return locale

    # 2. Cookie (préférences utilisateur)
    locale = _normalize_locale(request.cookies.get('gcmap_lang'), supported_locales)
    if locale:
        return locale

    # 3. Paramètre persistant côté serveur (settings.json)
    try:
        stored_locale = _settings_manager.get_app_settings().language
        locale = _normalize_locale(stored_locale, supported_locales)
        if locale:
            return locale
    except Exception as exc:
        current_app.logger.warning("Failed to load stored locale: %s", exc)

    # 4. Fallback : langue du navigateur puis locale par défaut
    browser_locale = request.accept_languages.best_match(supported_locales)
    return browser_locale or current_app.config.get('BABEL_DEFAULT_LOCALE', 'fr')
