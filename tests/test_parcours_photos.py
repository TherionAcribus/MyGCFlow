"""Photos des parcours (parcours_photos.py, routes /api/parcours/<id>/photos)."""

import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image
from PIL.TiffImagePlugin import IFDRational

import parcours_photos
from app import create_app
from extensions import db
from models import ParcoursCamera, ParcoursPhoto

HOST = "http://127.0.0.1:51730"


def photo_bytes(color=(200, 10, 10), *, taken=None, offset=None, gps=None, make=None, model=None, serial=None,
                fmt='JPEG'):
    img = Image.new('RGB', (64, 48), color)
    exif = Image.Exif()
    if make:
        exif[271] = make
    if model:
        exif[272] = model
    sub = exif.get_ifd(0x8769)
    if taken:
        sub[36867] = taken
    if offset:
        sub[36881] = offset
    if serial:
        sub[0xA431] = serial
    if gps:
        lat, lon = gps
        g = exif.get_ifd(0x8825)

        def dms(value):
            value = abs(value)
            d = int(value)
            m = int((value - d) * 60)
            s = round(((value - d) * 60 - m) * 60 * 1000)
            return (IFDRational(d), IFDRational(m), IFDRational(s, 1000))
        g[1] = 'N' if lat >= 0 else 'S'
        g[2] = dms(lat)
        g[3] = 'E' if lon >= 0 else 'W'
        g[4] = dms(lon)
    buf = io.BytesIO()
    img.save(buf, fmt, exif=exif)
    return buf.getvalue()


class MetadataTests(unittest.TestCase):
    def test_time_offset_position_and_camera(self):
        meta = parcours_photos.read_metadata(photo_bytes(
            taken='2025:07:12 10:42:05', offset='+02:00', gps=(45.901, 6.12), make='Apple', model='iPhone 13'))
        self.assertEqual(meta['taken_at'], '2025-07-12T10:42:05')
        self.assertEqual(meta['offset_minutes'], 120)
        self.assertAlmostEqual(meta['lat'], 45.901, places=5)
        self.assertAlmostEqual(meta['lon'], 6.12, places=5)
        self.assertEqual(meta['camera'], 'Apple iPhone 13')

    def test_southern_and_western_hemispheres(self):
        meta = parcours_photos.read_metadata(photo_bytes(gps=(-33.86, -70.65)))
        self.assertAlmostEqual(meta['lat'], -33.86, places=5)
        self.assertAlmostEqual(meta['lon'], -70.65, places=5)

    def test_model_already_naming_the_maker_is_not_repeated(self):
        meta = parcours_photos.read_metadata(photo_bytes(make='Canon', model='Canon EOS 80D'))
        self.assertEqual(meta['camera'], 'Canon EOS 80D')

    def test_body_serial_number(self):
        read = lambda **kw: parcours_photos.read_metadata(photo_bytes(**kw))['serial']
        self.assertEqual(read(make='Canon', model='Canon EOS 80D', serial='012345678901'), '012345678901')
        # Champ laissé à zéro par certains boîtiers, ou numéro sans appareil
        # nommé : rien à distinguer.
        self.assertIsNone(read(make='Canon', model='Canon EOS 80D', serial='0000000000'))
        self.assertIsNone(read(serial='012345678901'))
        self.assertEqual(len(read(make='Canon', model='EOS', serial='9' * 60)), parcours_photos.SERIAL_MAX_LENGTH)

    def test_missing_or_invalid_exif_gives_none(self):
        meta = parcours_photos.read_metadata(photo_bytes(taken='2025:02:30 10:00:00', gps=(0, 0)))
        self.assertEqual(meta, {'taken_at': None, 'offset_minutes': None, 'lat': None, 'lon': None, 'camera': None,
                                'serial': None})
        self.assertIsNone(parcours_photos.read_metadata(b'pas une image')['taken_at'])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.photos_dir = Path(self.tmpdir.name) / 'parcours_photos'
        patcher = mock.patch('paths.parcours_photos_dir', return_value=self.photos_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app = create_app({"SQLALCHEMY_DATABASE_URI":
                               f"sqlite:///{os.path.join(self.tmpdir.name, 'g.db')}"})
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self._dispose)
        self.client = self.app.test_client()
        response = self.client.post('/api/parcours', json={'name': 'Vacances', 'date_start': '2025-07-12',
                                                           'date_end': '2025-07-13'},
                                    headers={'Origin': HOST}, base_url=HOST)
        self.pid = response.get_json()['parcours']['id']

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def call(self, method, url, **kwargs):
        return self.client.open(url, method=method, headers={'Origin': HOST}, base_url=HOST, **kwargs)

    def upload(self, data, name='IMG_0001.jpg'):
        return self.call('POST', f'/api/parcours/{self.pid}/photos',
                         data={'photo': (io.BytesIO(data), name)}, content_type='multipart/form-data')

    def test_upload_reads_exif_stores_file_and_thumbnail(self):
        response = self.upload(photo_bytes(taken='2025:07:12 10:42:05', gps=(45.9, 6.12), make='Apple',
                                           model='iPhone 13'))
        self.assertEqual(response.status_code, 201, response.get_json())
        photo = response.get_json()['photo']
        self.assertEqual((photo['takenAt'], photo['camera'], photo['name']),
                         ('2025-07-12T10:42:05', 'Apple iPhone 13', 'IMG_0001.jpg'))
        self.assertAlmostEqual(photo['lat'], 45.9, places=4)
        self.assertIsNone(photo['stopKey'])
        folder = self.photos_dir / str(self.pid)
        self.assertTrue((folder / photo['file']).is_file())
        self.assertTrue((folder / parcours_photos.thumb_name(photo['file'])).is_file())
        # Fichier normalisé : plus d'EXIF (position comprise).
        with Image.open(folder / photo['file']) as img:
            self.assertEqual(len(img.getexif()), 0)
        self.assertEqual(self.call('GET', f'/api/parcours/{self.pid}/photos/{photo["id"]}/file').status_code, 200)
        thumb = self.call('GET', f'/api/parcours/{self.pid}/photos/{photo["id"]}/thumb')
        self.assertEqual(thumb.status_code, 200)
        self.assertEqual(thumb.mimetype, 'image/jpeg')
        inputs = self.call('GET', f'/api/parcours/{self.pid}/inputs').get_json()
        self.assertEqual([p['id'] for p in inputs['photos']], [photo['id']])
        self.assertEqual(inputs['cameras'], [])

    def test_same_photo_twice_is_kept_once(self):
        data = photo_bytes(taken='2025:07:12 10:00:00')
        first = self.upload(data).get_json()['photo']
        second = self.upload(data, name='copie.jpg').get_json()['photo']
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(ParcoursPhoto.query.count(), 1)

    def test_refused_files(self):
        response = self.upload(b'pas une image', name='notes.txt')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['reason'], 'not_image')
        empty = self.call('POST', f'/api/parcours/{self.pid}/photos', data={}, content_type='multipart/form-data')
        self.assertEqual(empty.status_code, 400)
        self.assertEqual(self.upload(photo_bytes(), name='x.jpg').status_code, 201)
        self.assertEqual(self.call('POST', '/api/parcours/999/photos',
                                   data={'photo': (io.BytesIO(photo_bytes()), 'x.jpg')},
                                   content_type='multipart/form-data').status_code, 404)

    def test_manual_link_and_delete(self):
        photo = self.upload(photo_bytes()).get_json()['photo']
        url = f'/api/parcours/{self.pid}/photos/{photo["id"]}'
        linked = self.call('PATCH', url, json={'stopKey': 'GC1'}).get_json()['photo']
        self.assertEqual(linked['stopKey'], 'GC1')
        self.assertEqual(self.call('PATCH', url, json={'stopKey': ''}).get_json()['error'], 'photo-invalid')
        self.assertIsNone(self.call('PATCH', url, json={'stopKey': None}).get_json()['photo']['stopKey'])
        self.assertEqual(self.call('DELETE', url).status_code, 200)
        self.assertFalse((self.photos_dir / str(self.pid) / photo['file']).exists())
        self.assertEqual(self.call('DELETE', url).status_code, 404)
        self.assertEqual(self.call('GET', f'{url}/file').status_code, 404)

    def test_selection_link_hide_and_delete(self):
        ids = [self.upload(photo_bytes((i * 40, 10, 10)), name=f'{i}.jpg').get_json()['photo']['id']
               for i in range(3)]
        url = f'/api/parcours/{self.pid}/photos'
        payload = self.call('PATCH', url, json={'ids': ids[:2], 'changes': {'stopKey': 'GC1', 'hidden': True}}).get_json()
        by_id = {p['id']: p for p in payload['photos']}
        self.assertEqual([(by_id[i]['stopKey'], by_id[i]['hidden']) for i in ids],
                         [('GC1', True), ('GC1', True), (None, False)])
        self.assertEqual(payload['cameras'], [])
        # Tout ou rien : un id inconnu, en double ou une valeur refusée
        # ne change aucune photo.
        for body, error in (({'ids': [ids[2], 999], 'changes': {'hidden': True}}, 'photo-not-found'),
                            ({'ids': [ids[2], ids[2]], 'changes': {'hidden': True}}, 'photo-invalid'),
                            ({'ids': [], 'changes': {'hidden': True}}, 'photo-invalid'),
                            ({'ids': [ids[2]], 'changes': {'hidden': 'oui'}}, 'photo-invalid')):
            self.assertEqual(self.call('PATCH', url, json=body).get_json()['error'], error, body)
        self.assertFalse(db.session.get(ParcoursPhoto, ids[2]).hidden)
        # Retour au rattachement automatique.
        payload = self.call('PATCH', url, json={'ids': ids[:1], 'changes': {'stopKey': None}}).get_json()
        self.assertIsNone({p['id']: p for p in payload['photos']}[ids[0]]['stopKey'])

        files = [db.session.get(ParcoursPhoto, i).file for i in ids[:2]]
        self.assertEqual(self.call('POST', f'{url}/delete', json={'ids': [ids[0], 999]}).status_code, 404)
        self.assertEqual(ParcoursPhoto.query.count(), 3)
        payload = self.call('POST', f'{url}/delete', json={'ids': ids[:2]}).get_json()
        self.assertEqual([p['id'] for p in payload['photos']], [ids[2]])
        for file in files:
            self.assertFalse((self.photos_dir / str(self.pid) / file).exists())
        self.assertEqual(self.call('POST', f'/api/parcours/999/photos/delete', json={'ids': [ids[2]]}).status_code, 404)

    def test_display_settings(self):
        photo = self.upload(photo_bytes()).get_json()['photo']
        self.assertEqual((photo['hidden'], photo['caption'], photo['aspect'], photo['focusX'], photo['focusY'],
                          photo['zoom']), (False, '', 'original', 50, 50, 100))
        url = f'/api/parcours/{self.pid}/photos/{photo["id"]}'
        changed = self.call('PATCH', url, json={'hidden': True, 'caption': '  Vue sur\nle lac ', 'aspect': '4:3',
                                                'focusX': 20, 'focusY': 80, 'zoom': 150}).get_json()['photo']
        self.assertEqual((changed['hidden'], changed['caption'], changed['aspect'], changed['focusX'],
                          changed['focusY'], changed['zoom']), (True, 'Vue sur le lac', '4:3', 20, 80, 150))
        for bad in ({'hidden': 1}, {'caption': 'x' * 201}, {'caption': 3}, {'aspect': '2:1'}, {'focusX': 101},
                    {'zoom': 99}, {'zoom': 1.5}, {'focusY': True}):
            self.assertEqual(self.call('PATCH', url, json=bad).get_json().get('error'), 'photo-invalid', bad)
        # Une valeur refusée ne laisse rien à moitié appliqué.
        self.call('PATCH', url, json={'caption': 'Autre', 'zoom': 500})
        self.assertEqual(db.session.get(ParcoursPhoto, photo['id']).caption, 'Vue sur le lac')
        reset = self.call('PATCH', url, json={'caption': '', 'aspect': 'original'}).get_json()['photo']
        self.assertEqual((reset['caption'], reset['aspect'], reset['stopKey']), ('', 'original', None))

    def test_camera_offsets(self):
        url = f'/api/parcours/{self.pid}/cameras'
        payload = self.call('PUT', url, json={'camera': 'Canon EOS 80D', 'offsetMinutes': -62}).get_json()
        self.assertEqual(payload['cameras'], [{'camera': 'Canon EOS 80D', 'offsetMinutes': -62}])
        self.assertEqual(self.call('PUT', url, json={'camera': 'Canon EOS 80D', 'offsetMinutes': 4000}).get_json()['error'],
                         'camera-invalid')
        self.assertEqual(self.call('PUT', url, json={'camera': '', 'offsetMinutes': 5}).get_json()['error'],
                         'camera-invalid')
        cleared = self.call('PUT', url, json={'camera': 'Canon EOS 80D', 'offsetMinutes': None}).get_json()
        self.assertEqual(cleared['cameras'], [])
        # Clé d'un boîtier : modèle et numéro de série (cameraKey côté client).
        key = 'C' * parcours_photos.CAMERA_MAX_LENGTH + '#' + '1' * parcours_photos.SERIAL_MAX_LENGTH
        self.assertEqual(self.call('PUT', url, json={'camera': key, 'offsetMinutes': 5}).get_json()['cameras'],
                         [{'camera': key, 'offsetMinutes': 5}])
        self.assertEqual(self.call('PUT', url, json={'camera': key + '1', 'offsetMinutes': 5}).get_json()['error'],
                         'camera-invalid')

    def test_upload_keeps_the_body_serial_number(self):
        photo = self.upload(photo_bytes(taken='2025:07:12 10:00:00', make='Canon', model='Canon EOS 80D',
                                        serial='012345678901')).get_json()['photo']
        self.assertEqual((photo['camera'], photo['cameraSerial']), ('Canon EOS 80D', '012345678901'))
        self.assertIsNone(self.upload(photo_bytes((1, 2, 3), make='Apple', model='iPhone 13'))
                          .get_json()['photo']['cameraSerial'])

    def test_deleting_the_parcours_deletes_its_photos(self):
        self.upload(photo_bytes())
        self.call('PUT', f'/api/parcours/{self.pid}/cameras', json={'camera': 'X', 'offsetMinutes': 3})
        self.assertTrue((self.photos_dir / str(self.pid)).is_dir())
        self.assertEqual(self.call('DELETE', f'/api/parcours/{self.pid}').status_code, 200)
        self.assertFalse((self.photos_dir / str(self.pid)).exists())
        self.assertEqual(ParcoursPhoto.query.count(), 0)
        self.assertEqual(ParcoursCamera.query.count(), 0)


if __name__ == '__main__':
    unittest.main()
