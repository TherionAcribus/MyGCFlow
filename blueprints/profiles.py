import logging

from flask import Blueprint, jsonify, request, current_app
from flask_babel import gettext as _babel_gettext


def _(msgid, **kwargs):
    """gettext avec repli sur le msgid brut quand Babel n'est pas initialisé
    (tests unitaires sur une app Flask nue)."""
    try:
        return _babel_gettext(msgid, **kwargs)
    except Exception:
        return msgid % kwargs if kwargs else msgid

from dataclasses import asdict

from settings_manager import (
    AppSettings,
    InvalidProfileNameError,
    coerce_animation_settings,
    coerce_date_format,
    coerce_map_center,
    coerce_map_zoom,
    coerce_overlay_title,
    coerce_recording_settings,
    coerce_theme,
    get_settings_manager,
    sanitize_overlay_css,
)

profiles_bp = Blueprint('profiles', __name__)
settings_manager = get_settings_manager()


@profiles_bp.route('/api/settings', methods=['GET'])
def api_get_settings():
    s = settings_manager.get_app_settings()
    default_profile_name = None
    if s.default_profile_uid:
        default_profile_name = settings_manager.get_profile_name_by_uid(s.default_profile_uid)
    last_profile_name = None
    if s.last_profile_uid:
        last_profile_name = settings_manager.get_profile_name_by_uid(s.last_profile_uid)

    response = jsonify({
        'version': s.version,
        'language': s.language,
        'check_updates': s.check_updates,
        'skipped_update_version': s.skipped_update_version,
        'theme': s.theme,
        'date_format': s.date_format,
        'default_profile_uid': s.default_profile_uid,
        'default_profile_name': default_profile_name,
        'last_profile_uid': s.last_profile_uid,
        'last_profile_name': last_profile_name,
        'map_default_center': list(s.map_default_center) if s.map_default_center else None,
        'map_default_zoom': s.map_default_zoom,
        'recording': asdict(s.recording),
        'recording_configured': s.recording_configured,
        'animation': asdict(s.animation),
        'show_control_bar': s.show_control_bar,
    })
    response.set_cookie(
        'mygcflow_lang',
        s.language,
        max_age=60 * 60 * 24 * 365,
        samesite='Lax',
        path='/'
    )
    return response


@profiles_bp.route('/api/settings', methods=['PUT'])
def api_put_settings():
    data = request.get_json(silent=True) or {}

    def merge(current: AppSettings) -> AppSettings:
        language = data.get('language', current.language)
        check_updates = bool(data.get('check_updates', current.check_updates))
        show_control_bar = bool(data.get('show_control_bar', current.show_control_bar))
        theme = coerce_theme(data.get('theme'), current.theme) if 'theme' in data else current.theme
        date_format = (
            coerce_date_format(data.get('date_format'), current.date_format)
            if 'date_format' in data else current.date_format
        )

        # Version ignorée : envoyée par le bouton « Ignorer cette version » de la
        # modale de mise à jour, et remise à null quand l'utilisateur veut de
        # nouveau être averti. `last_update_check` n'est pas repris du client :
        # seul /check_version l'écrit, après une vérification aboutie.
        skipped_update_version = current.skipped_update_version
        if 'skipped_update_version' in data:
            raw_skipped = data.get('skipped_update_version')
            skipped_update_version = raw_skipped if isinstance(raw_skipped, str) and raw_skipped.strip() else None

        # Les réglages d'enregistrement acceptent un patch partiel : l'UI n'envoie
        # que le champ modifié, les autres doivent survivre.
        recording = current.recording
        recording_configured = current.recording_configured
        if 'recording' in data and isinstance(data.get('recording'), dict):
            merged_recording = asdict(current.recording)
            merged_recording.update(data['recording'])
            recording = coerce_recording_settings(merged_recording)
            recording_configured = True

        # Préférences d'animation (rythme, temps additionnel, suivi de caméra,
        # durée de flash) : préférences globales, patch partiel comme recording.
        animation = current.animation
        if 'animation' in data and isinstance(data.get('animation'), dict):
            merged_animation = asdict(current.animation)
            merged_animation.update(data['animation'])
            animation = coerce_animation_settings(merged_animation)

        # Ne modifier default_profile_uid que si le client l'a explicitement envoyé
        # (sinon un PUT partiel effacerait silencieusement le profil par défaut).
        default_profile_uid = current.default_profile_uid
        if 'default_profile_uid' in data:
            default_profile_uid = data.get('default_profile_uid')

        # Même règle pour le dernier profil actif : il n'est réécrit que si le
        # client l'envoie, sinon la moindre écriture d'une autre préférence
        # ferait oublier quel profil restaurer au prochain démarrage.
        last_profile_uid = current.last_profile_uid
        if 'last_profile_uid' in data:
            last_profile_uid = data.get('last_profile_uid')

        # Centre et zoom passent par les mêmes contrôles qu'à la relecture du
        # fichier : sans cela, l'écriture déposerait la valeur brute dans
        # settings.json et seul le chargement suivant la corrigerait. Une valeur
        # illisible ou hors plage laisse en place celle déjà enregistrée.
        map_default_center = current.map_default_center
        if 'map_default_center' in data:
            map_default_center = coerce_map_center(
                data.get('map_default_center'), current.map_default_center
            )

        map_default_zoom = current.map_default_zoom
        if 'map_default_zoom' in data:
            map_default_zoom = coerce_map_zoom(
                data.get('map_default_zoom'), current.map_default_zoom
            )

        return AppSettings(
            version=current.version,
            language=language,
            check_updates=check_updates,
            last_update_check=current.last_update_check,
            skipped_update_version=skipped_update_version,
            theme=theme,
            date_format=date_format,
            default_profile_uid=default_profile_uid,
            last_profile_uid=last_profile_uid,
            map_default_center=map_default_center,
            map_default_zoom=map_default_zoom,
            recording=recording,
            recording_configured=recording_configured,
            animation=animation,
            show_control_bar=show_control_bar,
            examples_seeded=current.examples_seeded,
            # Sans cette reprise, toute écriture de préférence ramenait le lot
            # d'exemples à 0 et réinstallait au démarrage suivant les profils
            # d'exemple ajoutés depuis la v1, y compris ceux supprimés.
            examples_version=current.examples_version,
        )

    # Fusion et écriture d'un seul tenant : le corps de la requête ne décrit que
    # les champs modifiés, tous les autres sont relus de l'existant. Un simple
    # get puis save laisserait une requête concurrente s'intercaler entre les
    # deux et perdre sa modification.
    updated = settings_manager.update_app_settings(merge)
    language = updated.language
    response = jsonify({'success': True, 'language': language})
    response.set_cookie(
        'mygcflow_lang',
        language,
        max_age=60 * 60 * 24 * 365,
        samesite='Lax',
        path='/'
    )
    return response


@profiles_bp.route('/api/settings/reset', methods=['POST'])
def api_reset_settings():
    settings_manager.reset_app_settings()
    return jsonify({'success': True})


@profiles_bp.route('/api/profiles', methods=['GET'])
def api_list_profiles():
    return jsonify(settings_manager.list_profiles())


@profiles_bp.route('/api/profiles/<name>', methods=['GET'])
def api_get_profile(name: str):
    try:
        prof = settings_manager.load_profile(name)
    except FileNotFoundError as e:
        return jsonify({'error': 'Profile not found', 'message': str(e)}), 404
    return jsonify(settings_manager._profile_to_dict(prof))


@profiles_bp.route('/api/profiles/uid/<uid>', methods=['GET'])
def api_get_profile_by_uid(uid: str):
    try:
        prof = settings_manager.load_profile_by_uid(uid)
    except FileNotFoundError as e:
        return jsonify({'error': 'Profile not found', 'message': str(e)}), 404
    return jsonify(settings_manager._profile_to_dict(prof))


@profiles_bp.route('/api/profiles', methods=['POST'])
def api_create_profile():
    data = request.get_json(silent=True) or {}
    name = data.get('name') or 'NewProfile'
    base = data.get('base')
    try:
        prof = settings_manager.create_profile(name, base)
    except InvalidProfileNameError as e:
        return jsonify({'success': False, 'message': str(e)}), 400
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e)}), 409
    # L'uid et la version sont renvoyés : le client en fait immédiatement le
    # profil actif et lui écrit les réglages affichés (PUT), ce qu'il ne peut
    # pas faire à partir du seul nom.
    return jsonify({'success': True, 'name': prof.name, 'uid': prof.uid, 'version': prof.version})


@profiles_bp.route('/api/profiles/<name>', methods=['PUT'])
def api_save_profile(name: str):
    data = request.get_json(silent=True) or {}
    logging.debug("Sauvegarde profil '%s': %s", name, data)
    try:
        prof = settings_manager.load_profile(name)
    except FileNotFoundError as e:
        return jsonify({'success': False, 'message': str(e)}), 404

    # Le renommage n'est pas géré ici (il déplacerait le fichier sous le nom
    # d'un profil potentiellement inexistant côté serveur) : passer par
    # POST /api/profiles/<name>/rename, qui gère la logique de façon atomique.
    new_name = data.get('name', prof.name)
    if new_name != prof.name:
        return jsonify({
            'success': False,
            'message': _("Le renommage n'est pas autorisé via cet endpoint, utilisez /api/profiles/<name>/rename")
        }), 400

    # L'uid identifie le profil de façon stable : on ignore toute valeur
    # envoyée par le client pour éviter des collisions entre profils.
    # Les clés legacy `map.default_center`/`default_zoom`, le bloc `animation`
    # et `flash.duration` ne sont volontairement pas traités : le centre et le
    # zoom sont un état de session, et le timing (rythme, suivi de caméra,
    # durée de flash) vit dans les préférences globales — jamais dans un thème.
    m = data.get('map', {})
    prof.map.tile_provider = m.get('tile_provider', prof.map.tile_provider)
    vm = m.get('vector_options') or {}
    if isinstance(vm, dict):
        if 'stroke_color' in vm:
            prof.map.vector_options.stroke_color = vm['stroke_color']
        if 'fill_color' in vm:
            prof.map.vector_options.fill_color = vm['fill_color']
        if 'background_color' in vm:
            prof.map.vector_options.background_color = vm['background_color']
        if 'stroke_width' in vm:
            try:
                prof.map.vector_options.stroke_width = float(vm['stroke_width'])
            except Exception:
                pass
    tm = m.get('toner_options') or {}
    if isinstance(tm, dict):
        if 'variant' in tm:
            prof.map.toner_options.variant = tm['variant']
    pt = data.get('points', {})
    if 'size' in pt:
        try:
            prof.points.size = int(pt['size'])
        except Exception:
            pass
    if 'color' in pt:
        prof.points.color = pt['color']
    if 'shape' in pt:
        prof.points.shape = pt['shape']
    if 'halo' in pt:
        prof.points.halo = bool(pt['halo'])
    if 'border_color' in pt:
        prof.points.border_color = pt['border_color']
    if 'border_size' in pt:
        try:
            prof.points.border_size = int(pt['border_size'])
        except Exception:
            pass
    if 'fill_color_type' in pt:
        prof.points.fill_color_type = pt['fill_color_type']
    if 'border_color_type' in pt:
        prof.points.border_color_type = pt['border_color_type']

    # Mode points + options icône
    if 'mode' in pt:
        prof.points.mode = pt['mode']
    if 'icon_set' in pt:
        prof.points.icon_set = pt.get('icon_set') or prof.points.icon_set
    if 'icon_size' in pt:
        try:
            prof.points.icon_size = int(pt.get('icon_size'))
        except Exception:
            pass
    if 'appear_animation' in pt:
        prof.points.appear_animation = bool(pt['appear_animation'])
    if 'recent_glow_days' in pt:
        try:
            prof.points.recent_glow_days = max(0, int(pt['recent_glow_days']))
        except Exception:
            pass

    f = data.get('flash', {})
    if 'mode' in f:
        prof.flash.mode = f['mode']
    if 'size' in f:
        try:
            prof.flash.size = int(f['size'])
        except Exception:
            pass
    if 'color' in f:
        prof.flash.color = f['color']
    if 'color_type' in f:
        prof.flash.color_type = f['color_type']

    i = data.get('infos', {}) or {}
    if isinstance(i, dict):
        t = i.get('title', {}) or {}
        if isinstance(t, dict):
            if 'display' in t:
                prof.infos.title.display = bool(t['display'])
            if 'text' in t:
                prof.infos.title.text = coerce_overlay_title(t['text'], prof.infos.title.text)
        if 'number_of_caches' in i:
            prof.infos.number_of_caches = bool(i['number_of_caches'])
        if 'current_date' in i:
            prof.infos.current_date = bool(i['current_date'])
        if 'title_css' in i:
            prof.infos.title_css = sanitize_overlay_css(i['title_css'])
        if 'infos_css' in i:
            prof.infos.infos_css = sanitize_overlay_css(i['infos_css'])

    logging.debug(
        "Profil sauvegardé avec flash: mode=%s, size=%s, color=%s, color_type=%s | "
        "infos: title.display=%s, title.text=%s, number_of_caches=%s, current_date=%s, "
        "title_css_len=%s, infos_css_len=%s",
        prof.flash.mode, prof.flash.size, prof.flash.color,
        getattr(prof.flash, 'color_type', 'fix'), prof.infos.title.display, prof.infos.title.text,
        prof.infos.number_of_caches, prof.infos.current_date,
        len(prof.infos.title_css or ''), len(prof.infos.infos_css or ''),
    )
    settings_manager.save_profile(prof)
    return jsonify({'success': True})


@profiles_bp.route('/api/profiles/<name>/rename', methods=['POST'])
def api_rename_profile(name: str):
    data = request.get_json(silent=True) or {}
    new_name = (data.get('new_name') or '').strip()
    if not new_name:
        return jsonify({'success': False, 'message': _('Nouveau nom manquant')}), 400
    try:
        prof = settings_manager.rename_profile(name, new_name)
    except FileNotFoundError as e:
        return jsonify({'success': False, 'message': str(e)}), 404
    except InvalidProfileNameError as e:
        return jsonify({'success': False, 'message': str(e)}), 400
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e)}), 409
    return jsonify({'success': True, 'name': prof.name, 'uid': prof.uid})


@profiles_bp.route('/api/profiles/<name>/duplicate', methods=['POST'])
def api_duplicate_profile(name: str):
    data = request.get_json(silent=True) or {}
    new_name = data.get('new_name') or f"{name}_copy"
    try:
        prof = settings_manager.duplicate_profile(name, new_name)
    except InvalidProfileNameError as e:
        return jsonify({'success': False, 'message': str(e)}), 400
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e)}), 404
    return jsonify({'success': True, 'name': prof.name})


@profiles_bp.route('/api/profiles/<name>', methods=['DELETE'])
def api_delete_profile(name: str):
    try:
        settings_manager.delete_profile(name)
    except FileNotFoundError as e:
        return jsonify({'success': False, 'message': str(e)}), 404
    return jsonify({'success': True})


@profiles_bp.route('/api/profiles/<name>/reset', methods=['POST'])
def api_reset_profile(name: str):
    settings_manager.reset_profile(name)
    return jsonify({'success': True})


@profiles_bp.route('/api/profiles/<name>/export', methods=['GET'])
def api_export_profile(name: str):
    try:
        current_version = current_app.config.get('APP_VERSION', '1.0')
        payload = settings_manager.export_profile_payload(name, current_version)
        return jsonify(payload)
    except FileNotFoundError:
        return jsonify({'success': False, 'message': _("Profil '%(name)s' introuvable", name=name)}), 404
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400


@profiles_bp.route('/api/profiles/import', methods=['POST'])
def api_import_profile():
    try:
        data = request.get_json(silent=True) or {}
        prof = settings_manager.import_profile_payload(data)
        return jsonify({'success': True, 'name': prof.name, 'uid': prof.uid})
    except ValueError as ve:
        return jsonify({'success': False, 'message': str(ve)}), 400
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500
