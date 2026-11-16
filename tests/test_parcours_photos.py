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


def photo_bytes(color=(200, 10, 10), *, taken=None, offset=None, gps=None, make=None, model=None, fmt='JPEG'):
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

    def test_missing_or_invalid_exif_gives_none(self):
        meta = parcours_photos.read_metadata(photo_bytes(taken='2025:02:30 10:00:00', gps=(0, 0)))
        self.assertEqual(meta, {'taken_at': None, 'offset_minutes': None, 'lat': None, 'lon': None, 'camera': None})
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
