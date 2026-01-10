import json

from flask import Blueprint, jsonify, request, current_app

from settings_manager import AppSettings, SettingsManager

profiles_bp = Blueprint('profiles', __name__)
settings_manager = SettingsManager()


@profiles_bp.route('/api/settings', methods=['GET'])
def api_get_settings():
    s = settings_manager.get_app_settings()
    default_profile_name = None
    if s.default_profile_uid:
        default_profile_name = settings_manager.get_profile_name_by_uid(s.default_profile_uid)

    response = jsonify({
        'version': s.version,
        'language': s.language,
        'check_updates': s.check_updates,
        'default_profile_uid': s.default_profile_uid,
        'default_profile_name': default_profile_name,
        'map_default_center': list(s.map_default_center) if s.map_default_center else None,
        'map_default_zoom': s.map_default_zoom,
    })
    response.set_cookie(
        'gcmap_lang',
        s.language,
        max_age=60 * 60 * 24 * 365,
        samesite='Lax',
        path='/'
    )
    return response


@profiles_bp.route('/api/settings', methods=['PUT'])
def api_put_settings():
    data = request.get_json(silent=True) or {}
    current = settings_manager.get_app_settings()
    language = data.get('language', current.language)
    check_updates = bool(data.get('check_updates', current.check_updates))

    default_profile_uid = data.get('default_profile_uid')

    map_default_center = current.map_default_center
    if 'map_default_center' in data:
        raw_center = data.get('map_default_center')
        if isinstance(raw_center, (list, tuple)) and len(raw_center) == 2:
            try:
                map_default_center = (float(raw_center[0]), float(raw_center[1]))
            except Exception:
                map_default_center = current.map_default_center
        else:
            map_default_center = None

    map_default_zoom = current.map_default_zoom
    if 'map_default_zoom' in data:
        raw_zoom = data.get('map_default_zoom')
        if raw_zoom is None:
            map_default_zoom = None
        else:
            try:
                map_default_zoom = int(raw_zoom)
            except Exception:
                map_default_zoom = current.map_default_zoom

    if not default_profile_uid and data.get('default_profile'):
        profile_name = data.get('default_profile')
        try:
            from settings_manager import PROFILES_DIR
            for profile_file in PROFILES_DIR.glob("*.json"):
                try:
                    profile_data = json.loads(profile_file.read_text(encoding="utf-8"))
                    if profile_data.get("name") == profile_name:
                        default_profile_uid = profile_data.get("uid")
                        break
                except Exception:
                    continue
        except Exception as e:
            print(f"Erreur lors de la rÇ¸solution du nom de profil '{profile_name}': {e}")

    updated = AppSettings(
        version=current.version,
        language=language,
        check_updates=check_updates,
        default_profile_uid=default_profile_uid,
        map_default_center=map_default_center,
        map_default_zoom=map_default_zoom,
    )
    settings_manager.save_app_settings(updated)
    response = jsonify({'success': True, 'language': language})
    response.set_cookie(
        'gcmap_lang',
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
    prof = settings_manager.load_profile(name)
    print(f"ÐY\"Ï SERVEUR - Envoi profil '{name}' avec flash: mode={prof.flash.mode}, duration={prof.flash.duration}, size={prof.flash.size}, color={prof.flash.color}, color_type={getattr(prof.flash, 'color_type', 'fix')}")
    return jsonify({
        'version': prof.version,
        'name': prof.name,
        'uid': prof.uid,
        'map': {
            'tile_provider': prof.map.tile_provider,
            'default_center': list(prof.map.default_center),
            'default_zoom': prof.map.default_zoom,
            'vector_options': {
                'stroke_color': prof.map.vector_options.stroke_color,
                'fill_color': prof.map.vector_options.fill_color,
                'background_color': prof.map.vector_options.background_color,
                'stroke_width': prof.map.vector_options.stroke_width,
            },
            'toner_options': {
                'variant': prof.map.toner_options.variant,
            },
        },
        'animation': {
            'enabled': prof.animation.enabled,
            'speed': prof.animation.speed,
        },
        'points': {
            'size': prof.points.size,
            'color': prof.points.color,
            'shape': prof.points.shape,
            'halo': prof.points.halo,
            'border_color': prof.points.border_color,
            'border_size': prof.points.border_size,
            'fill_color_type': prof.points.fill_color_type,
            'border_color_type': prof.points.border_color_type,
            'mode': getattr(prof.points, 'mode', 'vectoriel'),
            'icon_set': getattr(prof.points, 'icon_set', 'geocaching'),
            'icon_size': getattr(prof.points, 'icon_size', 24),
        },
        'flash': {
            'mode': prof.flash.mode,
            'duration': prof.flash.duration,
            'size': prof.flash.size,
            'color': prof.flash.color,
            'color_type': getattr(prof.flash, 'color_type', 'fix'),
        },
        'infos': {
            'title': {
                'display': prof.infos.title.display,
                'text': prof.infos.title.text,
            },
            'number_of_caches': prof.infos.number_of_caches,
            'current_date': prof.infos.current_date,
            'title_css': prof.infos.title_css,
            'infos_css': prof.infos.infos_css,
        }
    })


@profiles_bp.route('/api/profiles/uid/<uid>', methods=['GET'])
def api_get_profile_by_uid(uid: str):
    try:
        prof = settings_manager.load_profile_by_uid(uid)
    except FileNotFoundError as e:
        return jsonify({'error': 'Profile not found', 'message': str(e)}), 404
    print(f"ÐY\"Ï SERVEUR - Envoi profil par UUID '{uid}' (nom: '{prof.name}'), flash.color_type={getattr(prof.flash, 'color_type', 'fix')}")
    return jsonify({
        'version': prof.version,
        'name': prof.name,
        'uid': prof.uid,
        'map': {
            'tile_provider': prof.map.tile_provider,
            'default_center': list(prof.map.default_center),
            'default_zoom': prof.map.default_zoom,
            'vector_options': {
                'stroke_color': prof.map.vector_options.stroke_color,
                'fill_color': prof.map.vector_options.fill_color,
                'background_color': prof.map.vector_options.background_color,
                'stroke_width': prof.map.vector_options.stroke_width,
            },
            'toner_options': {
                'variant': prof.map.toner_options.variant,
            },
        },
        'animation': {
            'enabled': prof.animation.enabled,
            'speed': prof.animation.speed,
        },
        'points': {
            'size': prof.points.size,
            'color': prof.points.color,
            'shape': prof.points.shape,
            'halo': prof.points.halo,
            'border_color': prof.points.border_color,
            'border_size': prof.points.border_size,
            'fill_color_type': prof.points.fill_color_type,
            'border_color_type': prof.points.border_color_type,
            'mode': getattr(prof.points, 'mode', 'vectoriel'),
            'icon_set': getattr(prof.points, 'icon_set', 'geocaching'),
            'icon_size': getattr(prof.points, 'icon_size', 24),
        },
        'flash': {
            'mode': prof.flash.mode,
            'duration': prof.flash.duration,
            'size': prof.flash.size,
            'color': prof.flash.color,
            'color_type': getattr(prof.flash, 'color_type', 'fix'),
        },
        'infos': {
            'title': {
                'display': prof.infos.title.display,
                'text': prof.infos.title.text,
            },
            'number_of_caches': prof.infos.number_of_caches,
            'current_date': prof.infos.current_date,
            'title_css': prof.infos.title_css,
            'infos_css': prof.infos.infos_css,
        }
    })


@profiles_bp.route('/api/profiles', methods=['POST'])
def api_create_profile():
    data = request.get_json(silent=True) or {}
    name = data.get('name') or 'NewProfile'
    base = data.get('base')
    prof = settings_manager.create_profile(name, base)
    return jsonify({'success': True, 'name': prof.name})


@profiles_bp.route('/api/profiles/<name>', methods=['PUT'])
def api_save_profile(name: str):
    data = request.get_json(silent=True) or {}
    print(f"SERVEUR - Sauvegarde profil '{name}': {data}")
    prof = settings_manager.load_profile(name)
    prof.name = data.get('name', prof.name)

    if data.get('uid'):
        prof.uid = data.get('uid')
    m = data.get('map', {})
    prof.map.tile_provider = m.get('tile_provider', prof.map.tile_provider)
    if 'default_center' in m:
        try:
            dc = m['default_center']
            prof.map.default_center = (float(dc[0]), float(dc[1]))
        except Exception:
            pass
    if 'default_zoom' in m:
        try:
            prof.map.default_zoom = int(m['default_zoom'])
        except Exception:
            pass
    vm = m.get('vector_options') or m.get('vectorOptions') or {}
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
    tm = m.get('toner_options') or m.get('tonerOptions') or {}
    if isinstance(tm, dict):
        if 'variant' in tm:
            prof.map.toner_options.variant = tm['variant']
    a = data.get('animation', {})
    if 'enabled' in a:
        prof.animation.enabled = bool(a['enabled'])
    if 'speed' in a:
        try:
            prof.animation.speed = float(a['speed'])
        except Exception:
            pass
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
    if 'icon_set' in pt or 'iconSet' in pt:
        prof.points.icon_set = pt.get('icon_set', pt.get('iconSet')) or getattr(prof.points, 'icon_set', 'geocaching')
    if 'icon_size' in pt or 'iconSize' in pt:
        try:
            prof.points.icon_size = int(pt.get('icon_size', pt.get('iconSize')))
        except Exception:
            pass

    f = data.get('flash', {})
    if 'mode' in f:
        prof.flash.mode = f['mode']
    if 'duration' in f:
        try:
            prof.flash.duration = int(f['duration'])
        except Exception:
            pass
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
                prof.infos.title.text = t['text']
        if 'number_of_caches' in i:
            prof.infos.number_of_caches = bool(i['number_of_caches'])
        if 'current_date' in i:
            prof.infos.current_date = bool(i['current_date'])
        if 'title_css' in i:
            prof.infos.title_css = i['title_css'] or ''
        if 'infos_css' in i:
            prof.infos.infos_css = i['infos_css'] or ''

    print(f"ÐY'ó SERVEUR - Profil sauvegardÇ¸ avec flash: mode={prof.flash.mode}, duration={prof.flash.duration}, size={prof.flash.size}, color={prof.flash.color}, color_type={getattr(prof.flash, 'color_type', 'fix')} | infos: title.display={prof.infos.title.display}, title.text={prof.infos.title.text}, number_of_caches={prof.infos.number_of_caches}, current_date={prof.infos.current_date}, title_css_len={len(prof.infos.title_css or '')}, infos_css_len={len(prof.infos.infos_css or '')}")
    settings_manager.save_profile(prof)
    return jsonify({'success': True})


@profiles_bp.route('/api/profiles/<name>/duplicate', methods=['POST'])
def api_duplicate_profile(name: str):
    data = request.get_json(silent=True) or {}
    new_name = data.get('new_name') or f"{name}_copy"
    prof = settings_manager.duplicate_profile(name, new_name)
    return jsonify({'success': True, 'name': prof.name})


@profiles_bp.route('/api/profiles/<name>', methods=['DELETE'])
def api_delete_profile(name: str):
    settings_manager.delete_profile(name)
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
        return jsonify({'success': False, 'message': f"Profil '{name}' introuvable"}), 404
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
