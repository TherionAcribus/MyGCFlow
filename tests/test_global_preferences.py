import json
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import (
    AnimationPrefs,
    RecordingSettings,
    SettingsManager,
    coerce_animation_settings,
    coerce_map_center,
    coerce_profile,
    coerce_recording_settings,
    coerce_settings,
)


class RecordingCoercionTests(unittest.TestCase):
    """Bornes des réglages vidéo lus depuis le disque.

    settings.json est un fichier éditable à la main : une valeur hors plage ne
    doit pas produire un enregistrement impossible (0 image/seconde, bitrate
    négatif, codec vide).
    """

    def test_out_of_range_values_are_clamped_to_the_ui_limits(self):
        r = coerce_recording_settings({
            "fps": 999,
            "bitrate_mbps": 0,
            "scale_factor": 12,
            "slowdown_factor": 0,
            "audio_volume": 4.5,
        })

        self.assertEqual(r.fps, 60)
        self.assertEqual(r.bitrate_mbps, 1)
        self.assertEqual(r.scale_factor, 3.0)
        self.assertEqual(r.slowdown_factor, 1)
        self.assertEqual(r.audio_volume, 1.0)

    def test_unknown_mode_and_empty_mime_fall_back_to_defaults(self):
        r = coerce_recording_settings({"mode": "quantique", "mime_type": ""})

        self.assertEqual(r.mode, "mediarecorder")
        self.assertEqual(r.mime_type, "video/webm;codecs=vp9")

    def test_unknown_color_fidelity_falls_back_to_the_compatible_format(self):
        # Le 4:4:4 n'est pas lu partout : il ne doit jamais s'appliquer par
        # accident (settings.json édité à la main, client plus ancien).
        self.assertEqual(coerce_recording_settings({}).color_fidelity, "compatible")
        self.assertEqual(coerce_recording_settings({"color_fidelity": "yuv444p"}).color_fidelity, "compatible")
        self.assertEqual(coerce_recording_settings({"color_fidelity": "fidele"}).color_fidelity, "fidele")

    def test_unknown_capture_resolution_falls_back_to_the_window_size(self):
        # La résolution pilote le facteur de rendu de la carte : une valeur
        # inventée doit ramener au comportement historique, pas à un rendu 8K.
        self.assertEqual(coerce_recording_settings({"capture_resolution": "8k"}).capture_resolution, "window")
        self.assertEqual(coerce_recording_settings({"capture_resolution": None}).capture_resolution, "window")
        self.assertEqual(coerce_recording_settings({"capture_resolution": "1440p"}).capture_resolution, "1440p")

    def test_garbage_payload_yields_defaults(self):
        self.assertEqual(coerce_recording_settings(None), coerce_recording_settings({}))


class RecordingDefaultsMatchTheClientTests(unittest.TestCase):
    """Défauts vidéo du serveur et du client, qui doivent coïncider.

    Tant que `recording_configured` est faux, le client n'applique pas les
    réglages du serveur : il garde ceux de static/json/defaultValues.json. Une
    divergence ne se voit donc que dans l'interface. C'est ainsi que le mode
    d'enregistrement s'affichait « Images + ffmpeg » chez tout nouvel
    utilisateur — le JSON disait "images", le serveur "mediarecorder" — et que
    les blocs `.mediarecorder-only` (qualité, réglages avancés, cases à cocher)
    restaient masqués.
    """

    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "static" / "json" / "defaultValues.json"
        cls.client_record = json.loads(path.read_text(encoding="utf-8"))["record"]

    def test_the_recording_mode_is_the_same_on_both_sides(self):
        self.assertEqual(self.client_record["mode"], RecordingSettings().mode)

    def test_the_shared_recording_defaults_are_the_same_on_both_sides(self):
        # Seuls les champs décrits des deux côtés : scale_factor et les réglages
        # audio n'ont pas d'équivalent dans le JSON client.
        server = RecordingSettings()
        media = self.client_record["mediaRecorder"]

        self.assertEqual(self.client_record["fps"], server.fps)
        self.assertEqual(self.client_record["captureResolution"], server.capture_resolution)
        self.assertEqual(self.client_record["colorFidelity"], server.color_fidelity)
        self.assertEqual(media["mimeType"], server.mime_type)
        self.assertEqual(media["videoBitsPerSecond"] / 1_000_000, server.bitrate_mbps)
        self.assertEqual(media["slowdownFactor"], server.slowdown_factor)
        self.assertEqual(media["offlineNormalization"], server.offline_normalization)


class ThemeCoercionTests(unittest.TestCase):
    def test_valid_themes_are_kept_and_others_fall_back_to_system(self):
        self.assertEqual(coerce_settings({"theme": "dark"}).theme, "dark")
        self.assertEqual(coerce_settings({"theme": "light"}).theme, "light")
        self.assertEqual(coerce_settings({"theme": "neon"}).theme, "system")
        self.assertEqual(coerce_settings({}).theme, "system")


class EvolutionInfosTemplateTests(unittest.TestCase):
    """Modèle de la ligne d'infos du mode Évolution, lu depuis le disque.

    Texte libre avec balises : settings.json édité à la main ou PUT d'un
    client inconnu ne doivent pas produire autre chose qu'une chaîne, ni
    dépasser la borne du champ de saisie (200 caractères).
    """

    def test_a_string_is_kept_as_is(self):
        self.assertEqual(
            coerce_settings({"evolution_infos_template": "{date} — {placees}/{total}"}).evolution_infos_template,
            "{date} — {placees}/{total}")

    def test_a_template_longer_than_the_field_is_truncated(self):
        self.assertEqual(
            len(coerce_settings({"evolution_infos_template": "x" * 500}).evolution_infos_template),
            200)

    def test_a_non_string_or_missing_value_falls_back_to_default(self):
        self.assertEqual(
            coerce_settings({"evolution_infos_template": 42}).evolution_infos_template,
            "{date} · {actives}")
        self.assertEqual(
            coerce_settings({"evolution_infos_template": None}).evolution_infos_template,
            "{date} · {actives}")
        self.assertEqual(coerce_settings({}).evolution_infos_template, "{date} · {actives}")

    def test_an_empty_string_is_kept(self):
        # Vide = ligne masquée : un choix de l'utilisateur, pas une erreur.
        self.assertEqual(
            coerce_settings({"evolution_infos_template": ""}).evolution_infos_template,
            "")

    def test_line_breaks_are_flattened_to_spaces(self):
        # Une seule ligne d'infos : un saut de ligne ne peut pas casser la
        # cartouche, il devient une espace.
        self.assertEqual(
            coerce_settings({"evolution_infos_template": "x\ny"}).evolution_infos_template,
            "x y")


class AnimationCoercionTests(unittest.TestCase):
    """Bornes des préférences d'animation lues depuis le disque.

    La clé `animation` de settings.json est une préférence GLOBALE (rythme,
    tempo, suivi de caméra, durée du flash) — jamais un réglage de thème.
    Les bornes répètent TIMING_LIMITS de static/js/video_timing.mjs : un
    fichier édité à la main ne doit pas produire une animation impossible.
    """

    def test_out_of_range_values_are_clamped_to_the_ui_limits(self):
        a = coerce_animation_settings({
            "days_per_second": 99999,
            "total_duration_seconds": 0,
            "extra_end_seconds": -5,
            "camera_dynamism": 99,
            "flash_duration_ms": 99999,
        })

        self.assertEqual(a.days_per_second, 1000.0)
        self.assertEqual(a.total_duration_seconds, 1.0)
        self.assertEqual(a.extra_end_seconds, 0.0)
        self.assertEqual(a.camera_dynamism, 4)
        self.assertEqual(a.flash_duration_ms, 10000)

    def test_unknown_rhythm_mode_falls_back_to_rate(self):
        self.assertEqual(coerce_animation_settings({"rhythm_mode": "waltz"}).rhythm_mode, "rate")
        self.assertEqual(coerce_animation_settings({"rhythm_mode": "music"}).rhythm_mode, "music")
        self.assertEqual(coerce_animation_settings({"rhythm_mode": "duration"}).rhythm_mode, "duration")

    def test_camera_follow_mode_accepts_only_known_values(self):
        self.assertEqual(coerce_animation_settings({"camera_follow_mode": "trail"}).camera_follow_mode, "trail")
        self.assertEqual(coerce_animation_settings({"camera_follow_mode": "days"}).camera_follow_mode, "days")
        self.assertEqual(coerce_animation_settings({"camera_follow_mode": "lune"}).camera_follow_mode, "days")
        self.assertEqual(coerce_animation_settings({"camera_follow_mode": 42}).camera_follow_mode, "days")
        self.assertEqual(coerce_animation_settings({}).camera_follow_mode, "days")

    def test_garbage_payload_yields_defaults(self):
        self.assertEqual(coerce_animation_settings(None), AnimationPrefs())

    def test_animation_block_survives_a_settings_round_trip(self):
        s = coerce_settings({"animation": {
            "days_per_second": 5.5,
            "camera_follow": True,
            "camera_dynamism": 3,
        }})

        self.assertEqual(s.animation.days_per_second, 5.5)
        self.assertTrue(s.animation.camera_follow)
        self.assertEqual(s.animation.camera_dynamism, 3)


class ThemeTimingIsolationTests(unittest.TestCase):
    """Un thème ne contient que des réglages visuels.

    Les anciens fichiers peuvent encore embarquer un bloc `animation` ou un
    centre/zoom de carte : ils restent chargeables, mais ces valeurs sont
    ignorées — jamais recopiées dans le profil ni dans les préférences
    globales. `flash.duration`, en revanche, est redevenue un réglage de
    thème : un ancien fichier qui la porte la voit lue et appliquée.
    """

    LEGACY_PROFILE = {
        "version": 2,
        "name": "Ancien",
        "uid": "legacy-uid",
        "map": {
            "tile_provider": "OSM",
            "default_center": [2.35, 48.85],
            "default_zoom": 9,
        },
        "animation": {"enabled": True, "speed": 2, "camera_follow": True},
        "flash": {"mode": "circle", "size": 30, "color": "#00FF00", "duration": 4500},
    }

    def test_a_legacy_profile_loads_without_its_timing_block(self):
        profile = coerce_profile(self.LEGACY_PROFILE)

        self.assertEqual(profile.name, "Ancien")
        self.assertFalse(hasattr(profile, "animation"))
        self.assertFalse(hasattr(profile.map, "center"))
        self.assertFalse(hasattr(profile.map, "zoom"))
        # La durée du flash fait partie du thème : lue comme la forme.
        self.assertEqual(profile.flash.duration, 4500)
        # Le reste du fichier est bien lu.
        self.assertEqual(profile.flash.size, 30)

    def test_a_serialized_theme_carries_no_timing_or_view_state(self):
        manager = SettingsManager.__new__(SettingsManager)
        payload = manager._profile_to_dict(coerce_profile(self.LEGACY_PROFILE))

        serialized = json.dumps(payload)
        # `flash.duration` est un réglage de thème légitime : seules les
        # clés temporelles ou de vue restent proscrites.
        for forbidden in ("animation", "default_center", "default_zoom", "speed"):
            self.assertNotIn(f'"{forbidden}"', serialized)
        self.assertEqual(payload["flash"]["duration"], 4500)

    def test_legacy_animation_does_not_leak_into_global_preferences(self):
        # Charger un ancien thème ne doit pas modifier les préférences
        # globales : deux thèmes pouvaient contenir des vitesses différentes.
        settings = coerce_settings({})
        coerce_profile(self.LEGACY_PROFILE)

        self.assertEqual(settings.animation, AnimationPrefs())


class MapZoomCoercionTests(unittest.TestCase):
    """Bornes du zoom par défaut.

    L'interface pose min=0/max=22 sur le champ, mais ni un settings.json édité à
    la main ni un PUT /api/settings ne passent par elle.
    """

    def test_out_of_range_zoom_is_clamped(self):
        self.assertEqual(coerce_settings({"map_default_zoom": 99}).map_default_zoom, 22)
        self.assertEqual(coerce_settings({"map_default_zoom": -5}).map_default_zoom, 0)

    def test_zoom_inside_the_range_is_kept(self):
        self.assertEqual(coerce_settings({"map_default_zoom": 12}).map_default_zoom, 12)

    def test_absent_or_unreadable_zoom_stays_none(self):
        self.assertIsNone(coerce_settings({}).map_default_zoom)
        self.assertIsNone(coerce_settings({"map_default_zoom": None}).map_default_zoom)
        self.assertIsNone(coerce_settings({"map_default_zoom": "loin"}).map_default_zoom)


class MapCenterCoercionTests(unittest.TestCase):
    """Plages du centre par défaut.

    Le client refuse déjà lat hors [-90, 90] et lon hors [-180, 180], mais ni un
    settings.json édité à la main ni un PUT /api/settings ne passent par lui.
    """

    def test_a_center_on_the_globe_is_kept(self):
        self.assertEqual(coerce_map_center([2.35, 48.85]), (2.35, 48.85))

    def test_out_of_range_values_are_refused_rather_than_clamped(self):
        # Ramener 400 à 180 désignerait un endroit que l'utilisateur n'a pas
        # choisi : on garde ce qui était en place.
        previous = (2.35, 48.85)
        self.assertEqual(coerce_map_center([400.0, 48.85], previous), previous)
        self.assertEqual(coerce_map_center([2.35, 200.0], previous), previous)
        self.assertIsNone(coerce_map_center([400.0, 48.85]))

    def test_non_finite_values_never_reach_the_settings_file(self):
        # json.dumps écrirait `NaN`, que les analyseurs stricts refusent.
        self.assertIsNone(coerce_map_center([float("nan"), 48.85]))
        self.assertIsNone(coerce_map_center([2.35, float("inf")]))

    def test_an_unusable_shape_clears_the_center(self):
        self.assertIsNone(coerce_map_center(None, (2.35, 48.85)))
        self.assertIsNone(coerce_map_center([1.0], (2.35, 48.85)))

    def test_unreadable_numbers_keep_the_previous_center(self):
        previous = (2.35, 48.85)
        self.assertEqual(coerce_map_center(["ici", "là"], previous), previous)

    def test_settings_on_disk_are_checked_after_the_v1_reordering(self):
        # v1 stockait [latitude, longitude] : une longitude de 150 est légitime,
        # elle ne doit pas être lue comme une latitude hors bornes.
        s = coerce_settings({"version": 1, "map_default_center": [45.0, 150.0]})
        self.assertEqual(s.map_default_center, (150.0, 45.0))

        s = coerce_settings({"version": 2, "map_default_center": [150.0, 45.0]})
        self.assertEqual(s.map_default_center, (150.0, 45.0))

    def test_an_out_of_range_center_on_disk_is_dropped(self):
        self.assertIsNone(coerce_settings({"map_default_center": [2.35, 200.0]}).map_default_center)


class MapFramingCoercionTests(unittest.TestCase):
    """Mode de cadrage de la carte au chargement des données.

    « fit » (vue ajustée sur l'emprise des caches) est le défaut des nouvelles
    installations ; un settings.json écrit avant l'apparition du mode et portant
    déjà un centre ou un zoom est relu comme « custom », pour ne pas changer le
    cadrage que l'utilisateur avait choisi à la main.
    """

    def test_the_default_is_fit_for_a_fresh_settings_file(self):
        self.assertEqual(coerce_settings({}).map_framing, "fit")

    def test_known_modes_are_kept(self):
        self.assertEqual(coerce_settings({"map_framing": "fit"}).map_framing, "fit")
        self.assertEqual(coerce_settings({"map_framing": "custom"}).map_framing, "custom")

    def test_an_unknown_mode_falls_back_to_fit(self):
        self.assertEqual(coerce_settings({"map_framing": "boussole"}).map_framing, "fit")

    def test_a_settings_file_with_a_saved_center_reads_as_custom(self):
        s = coerce_settings({"map_default_center": [2.35, 48.85]})
        self.assertEqual(s.map_framing, "custom")

    def test_a_settings_file_with_a_saved_zoom_reads_as_custom(self):
        s = coerce_settings({"map_default_zoom": 9})
        self.assertEqual(s.map_framing, "custom")

    def test_an_explicit_mode_wins_over_the_migration_default(self):
        s = coerce_settings({"map_framing": "fit", "map_default_center": [2.35, 48.85]})
        self.assertEqual(s.map_framing, "fit")


class LocationlessDisplayTests(unittest.TestCase):
    """Sort des caches sans localisation (position fictive dans le GPX).

    « hidden » est le défaut : les locationless restent comptées mais aucun
    point n'est dessiné à leur position factice. Une valeur inconnue —
    settings.json édité à la main, client plus ancien — retombe sur ce repli
    plutôt que d'afficher un point là où l'utilisateur n'est pas allé.
    """

    def test_the_default_hides_locationless_points(self):
        self.assertEqual(coerce_settings({}).locationless_display, "hidden")

    def test_known_values_are_kept(self):
        self.assertEqual(
            coerce_settings({"locationless_display": "shown"}).locationless_display, "shown")
        self.assertEqual(
            coerce_settings({"locationless_display": "hidden"}).locationless_display, "hidden")

    def test_an_unknown_value_falls_back_to_hidden(self):
        self.assertEqual(
            coerce_settings({"locationless_display": "partout"}).locationless_display, "hidden")
        self.assertEqual(
            coerce_settings({"locationless_display": 42}).locationless_display, "hidden")


class RecordingConfiguredFlagTests(unittest.TestCase):
    """Drapeau qui pilote la reprise des anciens réglages du localStorage.

    Le client ne doit pousser ses réglages locaux que tant que le serveur n'en a
    jamais reçu : sans ce drapeau, un bloc `recording` toujours rempli de valeurs
    par défaut rendrait « jamais configuré » indiscernable de « configuré ».
    """

    def test_settings_written_before_the_migration_count_as_unconfigured(self):
        self.assertFalse(coerce_settings({"language": "fr"}).recording_configured)

    def test_a_recording_block_on_disk_counts_as_configured(self):
        self.assertTrue(coerce_settings({"recording": {"fps": 24}}).recording_configured)


class SettingsApiTests(unittest.TestCase):
    def setUp(self):
        # Les préférences réelles vivent dans %APPDATA%\MyGCFlow : sans redirection
        # des constantes de module, ce test écraserait la configuration de
        # l'utilisateur (thème, langue, profil par défaut).
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-global-prefs-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        for name, value in {
            "CONFIG_DIR": tmp,
            "PROFILES_DIR": tmp / "profiles",
            "SETTINGS_PATH": tmp / "settings.json",
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {
            "examples_seeded": True,
            # Lot d'exemples à jour : sinon la migration installerait les
            # exemples ajoutés depuis (cf. EXAMPLES_VERSION).
            "examples_version": settings_manager.EXAMPLES_VERSION,
        })
        self.manager = SettingsManager()

        from blueprints import profiles as profiles_bp_module

        patcher = mock.patch.object(profiles_bp_module, 'settings_manager', self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.app = Flask(__name__)
        self.app.register_blueprint(profiles_bp_module.profiles_bp)
        self.client = self.app.test_client()

    def test_get_exposes_theme_and_recording(self):
        payload = self.client.get('/api/settings').get_json()

        self.assertEqual(payload['theme'], 'system')
        self.assertFalse(payload['recording_configured'])
        self.assertEqual(payload['recording']['fps'], 30)

    def test_theme_survives_a_round_trip(self):
        self.assertEqual(self.client.put('/api/settings', json={'theme': 'dark'}).status_code, 200)

        self.assertEqual(self.client.get('/api/settings').get_json()['theme'], 'dark')

    def test_an_invalid_theme_leaves_the_stored_one_untouched(self):
        self.client.put('/api/settings', json={'theme': 'dark'})
        self.client.put('/api/settings', json={'theme': 'chartreuse'})

        self.assertEqual(self.client.get('/api/settings').get_json()['theme'], 'dark')

    def test_get_exposes_the_date_format(self):
        # « auto » : le format affiché suit la langue de l'interface tant que
        # l'utilisateur n'a pas choisi explicitement « eu » ou « us ».
        self.assertEqual(self.client.get('/api/settings').get_json()['date_format'], 'auto')

    def test_date_format_survives_a_round_trip(self):
        self.assertEqual(self.client.put('/api/settings', json={'date_format': 'us'}).status_code, 200)

        self.assertEqual(self.client.get('/api/settings').get_json()['date_format'], 'us')

    def test_locationless_display_survives_a_round_trip(self):
        self.assertEqual(
            self.client.get('/api/settings').get_json()['locationless_display'], 'hidden')
        self.assertEqual(
            self.client.put('/api/settings', json={'locationless_display': 'shown'}).status_code, 200)
        self.assertEqual(
            self.client.get('/api/settings').get_json()['locationless_display'], 'shown')

    def test_an_invalid_locationless_display_leaves_the_stored_one_untouched(self):
        self.client.put('/api/settings', json={'locationless_display': 'shown'})
        self.client.put('/api/settings', json={'locationless_display': 'lune'})

        self.assertEqual(
            self.client.get('/api/settings').get_json()['locationless_display'], 'shown')

    def test_an_invalid_date_format_leaves_the_stored_one_untouched(self):
        self.client.put('/api/settings', json={'date_format': 'eu'})
        self.client.put('/api/settings', json={'date_format': 'yyyy'})

        self.assertEqual(self.client.get('/api/settings').get_json()['date_format'], 'eu')

    def test_a_patch_without_date_format_preserves_it(self):
        # Un patch partiel portant un autre champ ne doit pas effacer le
        # format de date choisi.
        self.client.put('/api/settings', json={'date_format': 'us'})
        self.client.put('/api/settings', json={'language': 'en'})

        self.assertEqual(self.client.get('/api/settings').get_json()['date_format'], 'us')

    def test_a_partial_recording_patch_keeps_the_other_video_settings(self):
        self.client.put('/api/settings', json={'recording': {'fps': 24, 'bitrate_mbps': 12}})
        self.client.put('/api/settings', json={'recording': {'file_name': '  Mes vacances  '}})

        recording = self.client.get('/api/settings').get_json()['recording']
        self.assertEqual(recording['fps'], 24)
        self.assertEqual(recording['bitrate_mbps'], 12)
        self.assertEqual(recording['file_name'], 'Mes vacances')

    def test_writing_recording_marks_the_settings_as_configured(self):
        self.client.put('/api/settings', json={'recording': {'fps': 24}})

        self.assertTrue(self.client.get('/api/settings').get_json()['recording_configured'])

    def test_a_patch_without_theme_or_recording_preserves_them(self):
        # Le cas réel : l'utilisateur change la langue depuis un autre écran, la
        # requête ne porte que `language`.
        self.client.put('/api/settings', json={'theme': 'light', 'recording': {'fps': 24}})
        self.client.put('/api/settings', json={'language': 'en'})

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['language'], 'en')
        self.assertEqual(payload['theme'], 'light')
        self.assertEqual(payload['recording']['fps'], 24)

    def test_an_animation_patch_survives_a_round_trip_and_merges(self):
        self.client.put('/api/settings', json={'animation': {
            'rhythm_mode': 'music', 'days_per_second': 7.5,
            'camera_follow': True, 'camera_dynamism': 3,
        }})
        # Patch partiel : une écriture ultérieure d'un autre champ ne doit pas
        # effacer le mode ni le rythme enregistrés.
        self.client.put('/api/settings', json={'animation': {'extra_end_seconds': 4}})

        animation = self.client.get('/api/settings').get_json()['animation']
        self.assertEqual(animation['rhythm_mode'], 'music')
        self.assertEqual(animation['days_per_second'], 7.5)
        self.assertTrue(animation['camera_follow'])
        self.assertEqual(animation['camera_dynamism'], 3)
        self.assertEqual(animation['extra_end_seconds'], 4)

    def test_an_animation_value_out_of_range_is_stored_clamped(self):
        self.client.put('/api/settings', json={'animation': {'days_per_second': -3}})

        animation = self.client.get('/api/settings').get_json()['animation']
        self.assertEqual(animation['days_per_second'], 0.01)
        stored = settings_manager.read_json(settings_manager.SETTINGS_PATH)
        self.assertEqual(stored['animation']['days_per_second'], 0.01)

    def test_a_zoom_sent_out_of_range_is_stored_clamped(self):
        self.client.put('/api/settings', json={'map_default_zoom': 99})

        self.assertEqual(self.client.get('/api/settings').get_json()['map_default_zoom'], 22)
        # Borné à l'écriture, pas seulement à la relecture : le fichier lui-même
        # ne doit pas contenir 99.
        stored = settings_manager.read_json(settings_manager.SETTINGS_PATH)
        self.assertEqual(stored['map_default_zoom'], 22)

    def test_a_center_sent_off_the_globe_leaves_the_stored_one_untouched(self):
        self.client.put('/api/settings', json={'map_default_center': [2.35, 48.85]})
        self.client.put('/api/settings', json={'map_default_center': [2.35, 200.0]})

        self.assertEqual(
            self.client.get('/api/settings').get_json()['map_default_center'], [2.35, 48.85]
        )

    def test_a_null_center_clears_the_setting(self):
        self.client.put('/api/settings', json={'map_default_center': [2.35, 48.85]})
        self.client.put('/api/settings', json={'map_default_center': None})

        self.assertIsNone(self.client.get('/api/settings').get_json()['map_default_center'])

    def test_get_exposes_the_map_framing(self):
        self.assertEqual(self.client.get('/api/settings').get_json()['map_framing'], 'fit')

    def test_map_framing_survives_a_round_trip(self):
        self.assertEqual(self.client.put('/api/settings', json={'map_framing': 'custom'}).status_code, 200)

        self.assertEqual(self.client.get('/api/settings').get_json()['map_framing'], 'custom')

    def test_an_invalid_map_framing_leaves_the_stored_one_untouched(self):
        self.client.put('/api/settings', json={'map_framing': 'custom'})
        self.client.put('/api/settings', json={'map_framing': 'boussole'})

        self.assertEqual(self.client.get('/api/settings').get_json()['map_framing'], 'custom')

    def test_a_patch_without_map_framing_preserves_it(self):
        # Le cas réel : un blur enregistre le centre de carte, la requête ne
        # porte que `map_default_center` — le mode choisi ne doit pas bouger.
        self.client.put('/api/settings', json={'map_framing': 'custom'})
        self.client.put('/api/settings', json={'map_default_center': [2.35, 48.85]})

        self.assertEqual(self.client.get('/api/settings').get_json()['map_framing'], 'custom')

    def test_two_simultaneous_patches_do_not_erase_each_other(self):
        """Deux écritures qui se croisent doivent toutes deux survivre.

        Le serveur de développement Flask traite les requêtes en parallèle. Un
        PUT partiel relit les champs absents de son corps : si deux requêtes
        lisent le même état de départ, la seconde réécrit l'ancienne valeur du
        champ modifié par la première (« lost update »). C'était observable en
        changeant la langue pendant qu'un blur enregistrait le centre de carte.

        L'écriture est ralentie pour élargir la fenêtre entre lecture et
        écriture : sans le verrou, ce test échoue de façon reproductible.
        """
        real_write_json = settings_manager.write_json

        def slow_write_json(path, obj):
            time.sleep(0.15)
            real_write_json(path, obj)

        # Un client par thread : ils partagent l'application, donc le même
        # gestionnaire de préférences, comme deux onglets du navigateur.
        def put(payload):
            self.app.test_client().put('/api/settings', json=payload)

        with mock.patch.object(settings_manager, 'write_json', slow_write_json):
            first = threading.Thread(target=put, args=({'theme': 'dark'},))
            second = threading.Thread(target=put, args=({'language': 'en'},))
            first.start()
            time.sleep(0.05)  # la seconde requête arrive pendant l'écriture de la première
            second.start()
            first.join()
            second.join()

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['theme'], 'dark')
        self.assertEqual(payload['language'], 'en')

    def test_creating_a_profile_returns_its_uid(self):
        # Le client fait immédiatement du profil créé le profil actif puis lui
        # écrit les réglages affichés : sans uid, il ne peut ni le mémoriser
        # comme dernier profil actif ni le retrouver par la suite.
        created = self.client.post('/api/profiles', json={'name': 'Alpha'}).get_json()

        self.assertTrue(created['success'])
        self.assertTrue(created['uid'])
        self.assertEqual(
            self.client.get(f"/api/profiles/uid/{created['uid']}").get_json()['name'], 'Alpha'
        )

    def test_the_last_active_profile_is_exposed_with_its_name(self):
        uid = self.client.post('/api/profiles', json={'name': 'Alpha'}).get_json()['uid']

        self.client.put('/api/settings', json={'last_profile_uid': uid})

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['last_profile_uid'], uid)
        self.assertEqual(payload['last_profile_name'], 'Alpha')

    def test_a_patch_without_the_last_active_profile_preserves_it(self):
        # Le cas réel : le profil actif est mémorisé, puis l'utilisateur change
        # la langue — une requête qui ne porte que `language` ne doit pas faire
        # oublier quel profil restaurer au prochain démarrage.
        uid = self.client.post('/api/profiles', json={'name': 'Alpha'}).get_json()['uid']
        self.client.put('/api/settings', json={'last_profile_uid': uid})

        self.client.put('/api/settings', json={'language': 'en'})

        self.assertEqual(self.client.get('/api/settings').get_json()['last_profile_uid'], uid)

    def test_a_deleted_last_active_profile_is_forgotten(self):
        uid = self.client.post('/api/profiles', json={'name': 'Alpha'}).get_json()['uid']
        self.client.put('/api/settings', json={'last_profile_uid': uid})

        self.assertEqual(self.client.delete('/api/profiles/Alpha').status_code, 200)

        payload = self.client.get('/api/settings').get_json()
        self.assertIsNone(payload['last_profile_uid'])
        self.assertIsNone(payload['last_profile_name'])

    def test_the_default_profile_is_forgotten_without_touching_the_last_active_one(self):
        # Les deux références sont nettoyées par la même relecture : celle qui
        # pointe encore sur un profil vivant doit y survivre.
        alpha = self.client.post('/api/profiles', json={'name': 'Alpha'}).get_json()['uid']
        beta = self.client.post('/api/profiles', json={'name': 'Beta'}).get_json()['uid']
        self.client.put('/api/settings', json={'default_profile_uid': alpha, 'last_profile_uid': beta})

        self.assertEqual(self.client.delete('/api/profiles/Alpha').status_code, 200)

        payload = self.client.get('/api/settings').get_json()
        self.assertIsNone(payload['default_profile_uid'])
        self.assertEqual(payload['last_profile_uid'], beta)

    def test_reset_returns_the_defaults_of_the_new_preferences(self):
        self.client.put('/api/settings', json={'theme': 'dark', 'recording': {'fps': 60}})
        self.assertEqual(self.client.post('/api/settings/reset').status_code, 200)

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['theme'], 'system')
        self.assertEqual(payload['recording']['fps'], 30)
        self.assertFalse(payload['recording_configured'])
    def test_evolution_rhythm_is_separate_from_the_main_one(self):
        self.client.put('/api/settings', json={'animation': {'days_per_second': 12}})
        self.client.put('/api/settings', json={'evolution_animation': {'days_per_second': 300}})
        self.client.put('/api/settings', json={'evolution_animation': {'extra_end_seconds': 2}})
        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['animation']['days_per_second'], 12)
        self.assertEqual(payload['evolution_animation']['days_per_second'], 300)
        self.assertEqual(payload['evolution_animation']['extra_end_seconds'], 2)
        self.assertEqual(payload['evolution_animation']['rhythm_mode'], 'duration')

    def test_last_dataset_survives_unrelated_writes(self):
        self.client.put('/api/settings', json={'evolution_dataset_id': 4})
        self.client.put('/api/settings', json={'theme': 'dark'})
        self.assertEqual(self.client.get('/api/settings').get_json()['evolution_dataset_id'], 4)
        self.client.put('/api/settings', json={'evolution_dataset_id': None})
        self.assertIsNone(self.client.get('/api/settings').get_json()['evolution_dataset_id'])

    def test_undated_archives_mode_survives_unrelated_writes(self):
        self.assertEqual(self.client.get('/api/settings').get_json()['evolution_undated_archives'], 'hide')
        self.client.put('/api/settings', json={'evolution_undated_archives': 'expire'})
        self.client.put('/api/settings', json={'theme': 'dark'})
        self.assertEqual(self.client.get('/api/settings').get_json()['evolution_undated_archives'], 'expire')
        self.client.put('/api/settings', json={'evolution_undated_archives': 'keep'})
        self.assertEqual(self.client.get('/api/settings').get_json()['evolution_undated_archives'], 'keep')


class EvolutionPreferencesTests(unittest.TestCase):
    """Préférences du mode Évolution : rythme séparé et dernière base ouverte."""

    def test_defaults_suit_decades_of_data(self):
        s = coerce_settings({})
        self.assertEqual(s.evolution_animation.rhythm_mode, "duration")
        self.assertEqual(s.evolution_animation.total_duration_seconds, 60.0)
        self.assertIsNone(s.evolution_dataset_id)
        # Les archivées sans date sont masquées par défaut.
        self.assertEqual(s.evolution_undated_archives, "hide")

    def test_camera_follow_is_never_enabled(self):
        s = coerce_settings({"evolution_animation": {"camera_follow": True, "days_per_second": 400}})
        self.assertFalse(s.evolution_animation.camera_follow)
        self.assertEqual(s.evolution_animation.days_per_second, 400)

    def test_dataset_id_must_be_a_positive_integer(self):
        for value, expected in ((3, 3), ("7", 7), (0, None), (-2, None), ("x", None), (True, None)):
            with self.subTest(value=value):
                self.assertEqual(coerce_settings({"evolution_dataset_id": value}).evolution_dataset_id, expected)

    def test_undated_archives_mode_is_whitelisted(self):
        for value in ("hide", "keep", "expire"):
            with self.subTest(value=value):
                self.assertEqual(
                    coerce_settings({"evolution_undated_archives": value}).evolution_undated_archives,
                    value)
        for value in ("oui", True, 0, None):
            with self.subTest(value=value):
                self.assertEqual(
                    coerce_settings({"evolution_undated_archives": value}).evolution_undated_archives,
                    "hide")


if __name__ == "__main__":
    unittest.main()
