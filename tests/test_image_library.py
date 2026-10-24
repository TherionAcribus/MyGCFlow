import io
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from flask import Flask
from PIL import Image

import image_library


def encode(img, fmt, **kwargs):
    buf = io.BytesIO()
    img.save(buf, fmt, **kwargs)
    return buf.getvalue()


try:
    import pillow_heif
    pillow_heif.register_heif_opener()

    def encode_heic(img):
        buf = io.BytesIO()
        pillow_heif.from_pillow(img).save(buf)
        return buf.getvalue()
except ImportError:
    encode_heic = None


def decode(data):
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


class ImageLibraryTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name) / "images"
        patcher = mock.patch.object(image_library.paths, "images_dir", return_value=self.folder)
        patcher.start()
        self.addCleanup(patcher.stop)


class NormalizeTests(ImageLibraryTestCase):
    """Normalisation à l'envoi : vérifiée, redressée, réduite, réencodée."""

    def test_transparency_keeps_png(self):
        img = Image.new('RGBA', (40, 30), (255, 0, 0, 0))
        img.putpixel((5, 5), (0, 128, 255, 255))
        data, ext, size = image_library.normalize_image(encode(img, 'PNG'))
        self.assertEqual((ext, size), ('png', (40, 30)))
        out = decode(data)
        self.assertEqual(out.mode, 'RGBA')
        self.assertEqual(out.getpixel((0, 0))[3], 0)

    def test_opaque_rgba_becomes_jpeg(self):
        # Canal alpha présent mais entièrement opaque : un JPEG suffit.
        img = Image.new('RGBA', (40, 30), (10, 200, 30, 255))
        data, ext, _ = image_library.normalize_image(encode(img, 'PNG'))
        self.assertEqual(ext, 'jpg')
        self.assertEqual(decode(data).format, 'JPEG')

    def test_palette_with_transparency_keeps_png(self):
        img = Image.new('P', (20, 20), 0)
        img.putpalette([255, 255, 255, 0, 0, 0] + [0] * 762)
        img.info['transparency'] = 0
        _, ext, _ = image_library.normalize_image(encode(img, 'PNG', transparency=0))
        self.assertEqual(ext, 'png')

    def test_large_image_is_reduced_keeping_its_ratio(self):
        img = Image.new('RGB', (3000, 1500), (30, 30, 30))
        _, _, size = image_library.normalize_image(encode(img, 'JPEG'))
        self.assertEqual(size, (2048, 1024))

    def test_small_image_is_not_enlarged(self):
        _, _, size = image_library.normalize_image(encode(Image.new('RGB', (64, 48)), 'PNG'))
        self.assertEqual(size, (64, 48))

    def test_exif_orientation_is_applied(self):
        # Photo de téléphone : pixels en paysage, EXIF « tourner de 90° ».
        img = Image.new('RGB', (200, 100), (200, 50, 50))
        exif = img.getexif()
        exif[0x0112] = 6
        _, _, size = image_library.normalize_image(encode(img, 'JPEG', exif=exif))
        self.assertEqual(size, (100, 200))

    def test_webp_and_gif_are_accepted(self):
        _, ext, _ = image_library.normalize_image(encode(Image.new('RGB', (30, 30), (1, 2, 3)), 'WEBP'))
        self.assertEqual(ext, 'jpg')
        frames = [Image.new('RGB', (30, 20), color) for color in ((255, 0, 0), (0, 0, 255))]
        buf = io.BytesIO()
        frames[0].save(buf, 'GIF', save_all=True, append_images=frames[1:], duration=100)
        data, _, size = image_library.normalize_image(buf.getvalue())
        self.assertEqual(size, (30, 20))
        # Première image seulement : rouge.
        r, g, b = decode(data).convert('RGB').getpixel((15, 10))
        self.assertGreater(r, 200)
        self.assertLess(b, 60)

    @unittest.skipUnless(encode_heic, "pillow-heif absent")
    def test_heic_is_accepted_and_normalized(self):
        # Photo iPhone bicolore : rouge à gauche, bleu à droite.
        img = Image.new('RGB', (96, 64))
        px = img.load()
        for x in range(96):
            for y in range(64):
                px[x, y] = (255, 0, 0) if x < 48 else (0, 0, 255)
        data, ext, size = image_library.normalize_image(encode_heic(img))
        self.assertEqual((ext, size), ('jpg', (96, 64)))
        out = decode(data).convert('RGB')
        self.assertEqual(out.getpixel((10, 32))[:2], (254, 0))
        self.assertEqual(out.getpixel((86, 32))[:2], (0, 0))

    @unittest.skipUnless(encode_heic, "pillow-heif absent")
    def test_heic_with_exif_normalizes(self):
        # L'orientation des HEIC n'est pas portée par l'EXIF mais par les
        # transformations irot/imir, que libheif applique au décodage : un
        # HEIC avec EXIF se normalise comme les autres.
        img = Image.new('RGB', (200, 100), (50, 50, 200))
        exif = img.getexif()
        exif[0x0112] = 1
        buf = io.BytesIO()
        pillow_heif.from_pillow(img).save(buf, exif=exif.tobytes())
        data, ext, size = image_library.normalize_image(buf.getvalue())
        self.assertEqual((ext, size), ('jpg', (200, 100)))

    def test_heif_signature_is_a_format_refusal_not_not_image(self):
        # La boîte « ftyp » d'un HEIC le fait reconnaître : sans le greffon
        # le message cible le format (pas « illisible ») ; avec le greffon,
        # un contenu tronqué refuse quand même proprement.
        fake = b'\x00\x00\x00\x1cftypheic' + b'\x00' * 16
        with self.assertRaises(image_library.InvalidImage) as ctx:
            image_library.normalize_image(fake)
        self.assertIn(ctx.exception.reason, ('format', 'not_image'))

    def test_refusals(self):
        cases = {
            'not_image': b'pas une image du tout',
            'format': encode(Image.new('RGB', (10, 10)), 'BMP'),
            'too_large': b'x' * (image_library.IMAGE_MAX_UPLOAD_BYTES + 1),
        }
        for reason, data in cases.items():
            with self.subTest(reason=reason):
                with self.assertRaises(image_library.InvalidImage) as ctx:
                    image_library.normalize_image(data)
                self.assertEqual(ctx.exception.reason, reason)

    def test_too_many_pixels_is_refused_before_decoding(self):
        # 8000 × 6400 = 51,2 Mpx en noir et blanc : quelques Ko en PNG.
        huge = encode(Image.new('1', (8000, 6400)), 'PNG')
        with self.assertRaises(image_library.InvalidImage) as ctx:
            image_library.normalize_image(huge)
        self.assertEqual(ctx.exception.reason, 'too_many_pixels')

    def test_truncated_file_is_refused(self):
        data = encode(Image.new('RGB', (200, 200), (9, 9, 9)), 'PNG')
        with self.assertRaises(image_library.InvalidImage):
            image_library.normalize_image(data[: len(data) // 2])


class StorageTests(ImageLibraryTestCase):
    """Enregistrement, inventaire, balayage, retrait."""

    def png(self, color=(255, 0, 0, 128), size=(20, 20)):
        return encode(Image.new('RGBA', size, color), 'PNG')

    def test_saved_name_is_the_content_hash_and_same_content_is_stored_once(self):
        first = image_library.save_image(self.png())
        self.assertRegex(first['file'], r'^[0-9a-f]{16}\.png$')
        self.assertEqual((first['width'], first['height']), (20, 20))
        second = image_library.save_image(self.png())
        self.assertEqual(second['file'], first['file'])
        self.assertEqual([p.name for p in self.folder.iterdir()], [first['file']])
        other = image_library.save_image(self.png(color=(0, 0, 255, 128)))
        self.assertNotEqual(other['file'], first['file'])

    def test_safe_name_accepts_only_names_of_the_folder(self):
        for bad in ('../x.png', 'abc.png', '0123456789abcdef.gif', '0123456789ABCDEF.png', None, 3):
            self.assertEqual(image_library.safe_image_name(bad), '', bad)
        self.assertEqual(image_library.safe_image_name('0123456789abcdef.jpg'), '0123456789abcdef.jpg')

    def test_referenced_files_come_from_items_and_configs(self):
        settings = {
            'items': [{'file': 'aaaaaaaaaaaaaaaa.png'}, {'file': ''}, {'file': '../evil.png'}],
            # Liste propre à /evolution : agrégée aussi, sinon une image posée
            # seulement dans ce mode passerait pour inutilisée.
            'evolution_items': [{'file': 'cccccccccccccccc.png'}],
            'configs': [{'name': 'Club', 'items': [{'file': 'bbbbbbbbbbbbbbbb.jpg'}]}],
        }
        expected = {'aaaaaaaaaaaaaaaa.png', 'bbbbbbbbbbbbbbbb.jpg', 'cccccccccccccccc.png'}
        self.assertEqual(image_library.referenced_image_files(settings), expected)
        as_object = SimpleNamespace(items=settings['items'],
                                    evolution_items=settings['evolution_items'],
                                    configs=settings['configs'])
        self.assertEqual(image_library.referenced_image_files(as_object), expected)
        self.assertEqual(image_library.referenced_image_files(None), set())

    def test_list_reports_sizes_dimensions_and_references(self):
        kept = image_library.save_image(self.png(size=(30, 10)))['file']
        loose = image_library.save_image(self.png(color=(0, 255, 0, 128)))['file']
        (self.folder / 'notes.txt').write_text('étranger')
        listing = image_library.list_image_files({kept})
        by_name = {f['file']: f for f in listing['files']}
        self.assertEqual(set(by_name), {kept, loose})
        self.assertEqual((by_name[kept]['width'], by_name[kept]['height']), (30, 10))
        self.assertTrue(by_name[kept]['referenced'])
        self.assertFalse(by_name[loose]['referenced'])
        self.assertEqual(listing['total_bytes'], sum(f['size_bytes'] for f in listing['files']))

    def test_sweep_removes_only_old_interrupted_uploads(self):
        old = time.time() - 2 * image_library.IMAGE_SWEEP_GRACE_S
        old_image = image_library.save_image(self.png())['file']
        fresh_image = image_library.save_image(self.png(color=(2, 2, 2, 128)))['file']
        old_part = self.folder / '.upload-abc.part'
        old_part.write_bytes(b'x')
        fresh_part = self.folder / '.upload-def.part'
        fresh_part.write_bytes(b'y')
        stranger = self.folder / 'notes.txt'
        stranger.write_text('à garder')
        os.utime(self.folder / old_image, (old, old))
        os.utime(old_part, (old, old))
        os.utime(stranger, (old, old))
        removed = image_library.sweep_partial_uploads()
        # Seul l'envoi interrompu ancien part ; une image n'est jamais balayée.
        self.assertEqual(removed, [old_part.name])
        self.assertTrue((self.folder / old_image).exists())
        self.assertTrue((self.folder / fresh_image).exists())
        self.assertTrue(fresh_part.exists())
        self.assertTrue(stranger.exists())

    def test_saving_again_refreshes_the_date_of_an_existing_image(self):
        name = image_library.save_image(self.png())['file']
        other = image_library.save_image(self.png(color=(1, 1, 1, 128)))['file']
        past = time.time() - 60
        os.utime(self.folder / name, (past, past))
        os.utime(self.folder / other, (past, past))
        image_library.save_image(self.png())
        # Date rafraîchie : l'image rechoisie repasse en tête de bibliothèque.
        listing = image_library.list_image_files(set())
        self.assertEqual([f['file'] for f in listing['files']], [name, other])
        self.assertGreater(listing['files'][0]['modified'], past)

    def test_delete(self):
        name = image_library.save_image(self.png())['file']
        self.assertTrue(image_library.delete_image_file(name))
        self.assertFalse(image_library.delete_image_file(name))
        self.assertFalse(image_library.delete_image_file('../image_library.py'))


class NamesTests(ImageLibraryTestCase):
    """names.json : la bibliothèque retient le nom d'origine des envois."""

    def png(self, color=(255, 0, 0, 128), size=(20, 20)):
        return encode(Image.new('RGBA', size, color), 'PNG')

    def names_file(self):
        return self.folder / 'names.json'

    def read_names(self):
        return json.loads(self.names_file().read_text(encoding='utf-8'))

    def test_name_saved_at_upload_is_reported_by_list(self):
        saved = image_library.save_image(self.png(), name='logo-club.png')
        listing = image_library.list_image_files(set())
        self.assertEqual(listing['files'][0]['name'], 'logo-club')
        # names.json est étranger au motif : jamais listé.
        self.assertEqual([f['file'] for f in listing['files']], [saved['file']])
        self.assertEqual(self.read_names(), {saved['file']: 'logo-club'})
        # Un nouvel envoi du même contenu met le nom à jour.
        image_library.save_image(self.png(), name='badge.png')
        self.assertEqual(image_library.list_image_files(set())['files'][0]['name'], 'badge')

    def test_name_is_cleaned(self):
        # Base du chemin (/ et \), sans l'extension finale, espaces bordant
        # retirés, 80 caractères au plus.
        image_library.save_image(self.png(), name='  C:\\divers\\logo club.png  ')
        self.assertEqual(image_library.list_image_files(set())['files'][0]['name'], 'logo club')
        image_library.save_image(self.png(color=(1, 2, 3, 128)), name='a' * 100 + '.png')
        self.assertEqual(image_library.list_image_files(set())['files'][0]['name'], 'a' * 80)

    def test_save_without_name_keeps_working(self):
        image_library.save_image(self.png())
        self.assertEqual(image_library.list_image_files(set())['files'][0]['name'], '')
        self.assertFalse(self.names_file().exists())

    def test_delete_forgets_the_name(self):
        name = image_library.save_image(self.png(), name='logo.png')['file']
        image_library.save_image(self.png(color=(9, 9, 9, 128)), name='reste.png')
        self.assertTrue(image_library.delete_image_file(name))
        names = self.read_names()
        self.assertNotIn(name, names)
        self.assertEqual(len(names), 1)

    def test_stale_entry_is_dropped_on_next_write(self):
        # Fichier retiré en dehors de delete_image_file : son entrée de
        # names.json est écartée à la prochaine écriture.
        gone = image_library.save_image(self.png(), name='parti.png')['file']
        os.remove(self.folder / gone)
        self.assertIn(gone, self.read_names())
        image_library.save_image(self.png(color=(8, 8, 8, 128)), name='nouveau.png')
        names = self.read_names()
        self.assertNotIn(gone, names)
        self.assertEqual(len(names), 1)


class RouteTests(ImageLibraryTestCase):
    """API /api/images : envoi, bibliothèque, lecture, retrait."""

    def setUp(self):
        super().setUp()
        from blueprints import images as images_bp_module

        self.images_settings = {'items': [], 'evolution_items': [], 'configs': []}
        manager = SimpleNamespace(
            get_app_settings=lambda: SimpleNamespace(images=self.images_settings))
        patcher = mock.patch.object(images_bp_module, 'get_settings_manager', return_value=manager)
        patcher.start()
        self.addCleanup(patcher.stop)
        app = Flask(__name__)
        app.register_blueprint(images_bp_module.images_bp)
        self.client = app.test_client()

    def upload(self, data, filename='logo.png'):
        return self.client.post('/api/images', data={'image': (io.BytesIO(data), filename)},
                                content_type='multipart/form-data')

    def test_upload_then_read_back(self):
        response = self.upload(encode(Image.new('RGBA', (50, 25), (0, 0, 0, 100)), 'PNG'))
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body['success'])
        self.assertEqual((body['width'], body['height']), (50, 25))
        served = self.client.get(f"/api/images/{body['file']}")
        self.assertEqual(served.status_code, 200)
        self.assertEqual(served.mimetype, 'image/png')
        self.assertIn('immutable', served.headers['Cache-Control'])
        self.assertEqual(decode(served.data).size, (50, 25))
        served.close()

    def test_upload_refusals_have_a_reason_and_a_status(self):
        self.assertEqual(self.client.post('/api/images').status_code, 400)
        bad = self.upload(b'texte', 'faux.png')
        self.assertEqual((bad.status_code, bad.get_json()['reason']), (400, 'not_image'))
        bmp = self.upload(encode(Image.new('RGB', (5, 5)), 'BMP'), 'x.bmp')
        self.assertEqual((bmp.status_code, bmp.get_json()['reason']), (415, 'format'))

    def test_reading_rejects_anything_but_folder_names(self):
        for name in ('..%2Fapp.py', 'logo.png', '0123456789abcdef.png'):
            self.assertEqual(self.client.get(f'/api/images/{name}').status_code, 404, name)

    def test_list_and_delete(self):
        name = self.upload(encode(Image.new('RGB', (8, 8), (4, 5, 6)), 'PNG')).get_json()['file']
        listing = self.client.get('/api/images').get_json()
        self.assertEqual([f['file'] for f in listing['files']], [name])
        # Utilisée sur la carte : retrait refusé.
        self.images_settings['items'] = [{'file': name}]
        self.assertEqual(self.client.post('/api/images/delete', json={'file': name}).status_code, 409)
        self.images_settings['items'] = []
        # Utilisée seulement par la liste du mode Évolution : retrait refusé.
        self.images_settings['evolution_items'] = [{'file': name}]
        self.assertEqual(self.client.post('/api/images/delete', json={'file': name}).status_code, 409)
        self.images_settings['evolution_items'] = []
        self.assertEqual(self.client.post('/api/images/delete', json={'file': name}).status_code, 200)
        self.assertEqual(self.client.post('/api/images/delete', json={'file': name}).status_code, 404)
        self.assertEqual(self.client.post('/api/images/delete', json={'file': '../x'}).status_code, 400)


if __name__ == '__main__':
    unittest.main()
