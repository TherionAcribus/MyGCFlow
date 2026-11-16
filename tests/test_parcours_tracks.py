"""Traces GPS des parcours (parcours_tracks.py, routes /api/parcours/<id>/tracks)."""

import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import parcours_tracks
from app import create_app
from extensions import db
from models import ParcoursTrack

HOST = "http://127.0.0.1:51730"


def gpx(segments, name='Balade', ns='http://www.topografix.com/GPX/1/1'):
    """GPX à partir de segments [[(lon, lat, datetime | None), ...], ...]."""
    out = [f'<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="test" xmlns="{ns}">',
           f'<trk><name>{name}</name>']
    for segment in segments:
        out.append('<trkseg>')
        for lon, lat, when in segment:
            time = f'<time>{when.strftime("%Y-%m-%dT%H:%M:%SZ")}</time>' if when else ''
            out.append(f'<trkpt lat="{lat}" lon="{lon}"><ele>450</ele>{time}</trkpt>')
        out.append('</trkseg>')
    out.append('</trk></gpx>')
    return ''.join(out).encode('utf-8')


START = datetime(2025, 7, 12, 8, 0, tzinfo=timezone.utc)


def straight_walk(n=600, step_s=1):
    """Marche en ligne droite, un point par seconde : ~1,4 m/s vers l'est."""
    return [(6.1 + i * 1.8e-5, 45.9, START + timedelta(seconds=i * step_s)) for i in range(n)]


class ParseTests(unittest.TestCase):
    def test_points_with_time_by_segment(self):
        data = gpx([[(6.1, 45.9, START), (6.2, 45.9, None), (6.3, 45.9, START + timedelta(minutes=1))],
                    [(6.4, 45.9, START + timedelta(minutes=5))]])
        name, segments, total = parcours_tracks.parse_gpx(data)
        self.assertEqual(name, 'Balade')
        self.assertEqual(total, 3)
        self.assertEqual([[p[0] for p in s] for s in segments], [[6.1, 6.3], [6.4]])
        self.assertEqual(segments[0][0][2], START.timestamp())

    def test_gpx_1_0_namespace(self):
        _, segments, _ = parcours_tracks.parse_gpx(gpx([[(6.1, 45.9, START)]], ns='http://www.topografix.com/GPX/1/0'))
        self.assertEqual(len(segments), 1)

    def test_refused_files(self):
        for data, reason in [
            (b'pas du xml', 'not_gpx'),
            (b'<?xml version="1.0"?><kml></kml>', 'not_gpx'),
            (gpx([[(6.1, 45.9, None)]]), 'no_time'),
        ]:
            with self.assertRaises(parcours_tracks.InvalidTrack) as ctx:
                parcours_tracks.parse_gpx(data)
            self.assertEqual(ctx.exception.reason, reason)

    def test_simplification_keeps_ends_and_corners(self):
        line = [[6.1 + i * 1e-5, 45.9, i] for i in range(1000)]
        self.assertEqual(parcours_tracks.simplify(line), [line[0], line[-1]])
        corner = line[:500] + [[6.105, 45.9 + i * 1e-5, 500 + i] for i in range(1, 500)]
        kept = parcours_tracks.simplify(corner)
        self.assertEqual(len(kept), 3)
        self.assertEqual(kept[1], corner[499])

    def test_simplification_keeps_a_pause_on_a_straight_line(self):
        # Marche vers l'est, arrêt de 10 min au milieu, puis reprise : les
        # points sont alignés, mais l'heure de l'arrêt doit survivre.
        walk = [[6.1 + i * 1e-5, 45.9, i] for i in range(500)]
        pause = [[walk[-1][0], 45.9, 500 + i] for i in range(1, 600)]
        rest = [[walk[-1][0] + i * 1e-5, 45.9, 1099 + i] for i in range(1, 500)]
        kept = parcours_tracks.simplify(walk + pause + rest)
        times = [p[2] for p in kept]
        self.assertIn(499, times)        # début de l'arrêt
        self.assertIn(1099, times)       # reprise
        self.assertLessEqual(len(kept), 6)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.app = create_app({"SQLALCHEMY_DATABASE_URI":
                               f"sqlite:///{os.path.join(self.tmpdir.name, 'g.db')}"})
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self._dispose)
        self.client = self.app.test_client()
        self.pid = self.call('POST', '/api/parcours', json={
            'name': 'Vacances', 'date_start': '2025-07-12', 'date_end': '2025-07-13'}).get_json()['parcours']['id']

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def call(self, method, url, **kwargs):
        return self.client.open(url, method=method, headers={'Origin': HOST}, base_url=HOST, **kwargs)

    def upload(self, data, name='balade.gpx'):
        return self.call('POST', f'/api/parcours/{self.pid}/tracks',
                         data={'track': (io.BytesIO(data), name)}, content_type='multipart/form-data')

    def test_upload_simplifies_and_serves_the_track_with_the_inputs(self):
        response = self.upload(gpx([straight_walk()]))
        self.assertEqual(response.status_code, 201, response.get_json())
        track = response.get_json()['track']
        self.assertEqual((track['name'], track['sourcePointCount']), ('Balade', 600))
        self.assertLess(track['pointCount'], 10)          # ligne droite : deux points suffisent
        self.assertEqual(track['start'], '2025-07-12T08:00:00+00:00')
        self.assertEqual(track['end'], '2025-07-12T08:09:59+00:00')
        inputs = self.call('GET', f'/api/parcours/{self.pid}/inputs').get_json()
        [served] = inputs['tracks']
        self.assertEqual(served['segments'][0][0], [6.1, 45.9, int(START.timestamp())])

    def test_refused_and_deleted(self):
        response = self.upload(gpx([[(6.1, 45.9, None)]]))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['reason'], 'no_time')
        self.assertEqual(self.upload(b'nope').get_json()['reason'], 'not_gpx')
        track = self.upload(gpx([straight_walk(10)])).get_json()['track']
        url = f'/api/parcours/{self.pid}/tracks/{track["id"]}'
        self.assertEqual(self.call('DELETE', url).status_code, 200)
        self.assertEqual(self.call('DELETE', url).status_code, 404)

    def test_utc_offset_of_the_parcours(self):
        url = f'/api/parcours/{self.pid}'
        self.assertIsNone(self.call('GET', url).get_json()['parcours']['utc_offset_minutes'])
        self.assertEqual(self.call('PATCH', url, json={'utc_offset_minutes': 120}).get_json()['parcours']['utc_offset_minutes'], 120)
        self.assertEqual(self.call('PATCH', url, json={'utc_offset_minutes': 15 * 60}).get_json()['error'], 'utc-offset-invalid')
        self.assertIsNone(self.call('PATCH', url, json={'utc_offset_minutes': None}).get_json()['parcours']['utc_offset_minutes'])

    def test_deleting_the_parcours_deletes_its_tracks(self):
        self.upload(gpx([straight_walk(10)]))
        self.call('DELETE', f'/api/parcours/{self.pid}')
        self.assertEqual(ParcoursTrack.query.count(), 0)


if __name__ == '__main__':
    unittest.main()
