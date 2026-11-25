"""Parcours suggérés : séjours loin du centre habituel et grosses journées
(parcours_suggest.py, GET /api/parcours/suggestions)."""

import unittest
from collections import Counter
from datetime import date, datetime, timedelta
from unittest import mock

import parcours_suggest as suggest
from extensions import db
from models import Geocache
from tests.test_parcours_api import _Base

ANNECY = (45.90, 6.12)
SPLIT = (43.51, 16.44)
ZAGREB = (45.81, 15.98)


def day(iso, where, finds=2, country='France', state='Auvergne-Rhône-Alpes'):
    return {
        'date': date.fromisoformat(iso), 'lat': where[0], 'lon': where[1], 'finds': finds,
        'countries': Counter({country: finds}),
        'states': Counter({(country, state): finds}),
    }


def home_weeks():
    """Dix samedis à la maison, un peu partout dans la case d'Annecy."""
    start = date(2025, 3, 1)
    return [day((start + timedelta(days=7 * k)).isoformat(), (ANNECY[0] + 0.01 * k, ANNECY[1]))
            for k in range(10)]


class SuggestTests(unittest.TestCase):
    def test_home_is_the_cell_with_most_days(self):
        days = home_weeks() + [day('2025-07-12', SPLIT, country='Croatia', state='Splitsko-dalmatinska')]
        lat, lon = suggest.home_center(days)
        self.assertAlmostEqual(lat, ANNECY[0] + 0.045, places=3)
        self.assertAlmostEqual(lon, ANNECY[1], places=3)
        self.assertIsNone(suggest.home_center([]))

    def test_trip_groups_consecutive_away_days_even_with_a_blank_day(self):
        croatia = dict(country='Croatia', state='Splitsko-dalmatinska')
        days = home_weeks() + [
            day('2025-07-12', SPLIT, 5, **croatia),
            day('2025-07-13', SPLIT, 4, **croatia),
            # 14 : pas de trouvaille ; 15 : toujours le séjour.
            day('2025-07-15', ZAGREB, 3, country='Croatia', state='Grad Zagreb'),
            # Trois jours plus tard : un autre séjour, trop court en trouvailles.
            day('2025-07-19', SPLIT, 2, **croatia),
        ]
        result = suggest.suggest(days)
        self.assertEqual(len(result), 1)
        trip = result[0]
        self.assertEqual(trip['kind'], 'trip')
        self.assertEqual((trip['start'], trip['end']), ('2025-07-12', '2025-07-15'))
        self.assertEqual((trip['days'], trip['findDays'], trip['finds']), (4, 3, 12))
        self.assertEqual(trip['place'], 'Splitsko-dalmatinska')

    def test_big_day_near_home_and_most_recent_first(self):
        days = home_weeks() + [
            day('2025-06-01', SPLIT, 6, country='Croatia', state='Splitsko-dalmatinska'),
            day('2025-08-15', (ANNECY[0], ANNECY[1] + 0.2), 25),
        ]
        result = suggest.suggest(days)
        self.assertEqual([(s['kind'], s['start']) for s in result], [('day', '2025-08-15'), ('trip', '2025-06-01')])
        self.assertEqual(result[0]['place'], 'Auvergne-Rhône-Alpes')

    def test_limit_and_unbounded(self):
        croatia = dict(country='Croatia', state='Split')
        months = [day(f'2025-{m:02d}-10', SPLIT, 5, **croatia) for m in range(1, 9)]
        days = home_weeks() + months
        self.assertEqual(len(suggest.suggest(days)), 6)
        self.assertEqual(len(suggest.suggest(days, limit=3)), 3)
        self.assertEqual(len(suggest.suggest(days, limit=None)), 8)

    def test_existing_ranges_are_not_suggested_again(self):
        days = home_weeks() + [day('2025-07-12', SPLIT, 5, country='Croatia', state='Split')]
        self.assertEqual(len(suggest.suggest(days)), 1)
        self.assertEqual(suggest.suggest(days, {('2025-07-12', '2025-07-12')}), [])

    def test_trip_is_cut_at_the_maximum_range(self):
        start = date(2025, 1, 1)
        far = [day((start + timedelta(days=k)).isoformat(), SPLIT, country='Croatia', state='Split')
               for k in range(10)]
        result = suggest.suggest(home_weeks() + far, max_days=4)
        self.assertEqual(sorted((s['start'], s['end']) for s in result),
                         [('2025-01-01', '2025-01-04'), ('2025-01-05', '2025-01-08'),
                          ('2025-01-09', '2025-01-10')])

    def test_place_name_region_country_or_two_countries(self):
        mixed = [day('2025-07-12', SPLIT, 6, country='Croatia', state='Split'),
                 day('2025-07-13', SPLIT, 5, country='Croatia', state='Zadar')]
        self.assertEqual(suggest.place_name(mixed), 'Croatia')
        two = [day('2025-07-12', SPLIT, 6, country='Croatia', state='Split'),
               day('2025-07-13', SPLIT, 4, country='Slovenia', state='Koper')]
        self.assertEqual(suggest.place_name(two), 'Croatia / Slovenia')
        self.assertEqual(suggest.place_name([day('2025-07-12', SPLIT, 0)]), '')


class SuggestApiTests(_Base):
    def add(self, code, iso, where, country='France', state='Haute-Savoie'):
        db.session.add(Geocache(
            gc_code=code, cache_name=code, latitude=where[0], longitude=where[1], found=True,
            cache_type='Traditional Cache', country=country, state=state,
            date_find=datetime.fromisoformat(f'{iso}T19:00:00')))

    def test_api_lists_trips_and_hides_created_ranges(self):
        for k in range(6):
            self.add(f'GCH{k}', f'2025-03-0{k + 1}', ANNECY)
        for k, iso in enumerate(['2025-07-12', '2025-07-12', '2025-07-13', '2025-07-13']):
            self.add(f'GCC{k}', iso, SPLIT, country='Croatia', state='Splitsko-dalmatinska')
        # Sans coordonnées : ignorée.
        db.session.add(Geocache(gc_code='GCX', found=True, cache_type='Traditional Cache',
                                date_find=datetime(2025, 7, 13, 19)))
        db.session.commit()
        payload = self.get('/api/parcours/suggestions').get_json()
        self.assertEqual(payload['suggestions'], [{
            'kind': 'trip', 'start': '2025-07-12', 'end': '2025-07-13', 'days': 2, 'findDays': 2,
            'finds': 4, 'place': 'Splitsko-dalmatinska',
        }])
        self.assertEqual(payload['total'], 1)
        self.create(name='Croatie', date_start='2025-07-12', date_end='2025-07-13')
        self.assertEqual(self.get('/api/parcours/suggestions').get_json()['suggestions'], [])

    def test_api_limit_and_total(self):
        # La maison domine la case du centre habituel ; sept séjours croates.
        for k in range(30):
            self.add(f'GCH{k}', f'2025-03-{(k % 28) + 1:02d}', ANNECY)
        for t in range(7):
            for k in range(3):
                self.add(f'GCT{t}{k}', f'2025-{t + 1:02d}-1{k + 2}', SPLIT,
                         country='Croatia', state='Split')
        db.session.commit()
        payload = self.get('/api/parcours/suggestions').get_json()
        self.assertEqual(len(payload['suggestions']), 6)
        self.assertEqual(payload['total'], 7)
        payload = self.get('/api/parcours/suggestions?limit=0').get_json()
        self.assertEqual(len(payload['suggestions']), 7)
        self.assertEqual(payload['total'], 7)

    def test_list_carries_suggestions_from_a_single_find_days(self):
        # Le centre habituel et les suggestions partagent le même relevé des
        # journées : une seule passe sur les trouvailles par GET /api/parcours.
        for k in range(6):
            self.add(f'GCH{k}', f'2025-03-0{k + 1}', ANNECY)
        for k, iso in enumerate(['2025-07-12', '2025-07-12', '2025-07-13', '2025-07-13']):
            self.add(f'GCC{k}', iso, SPLIT, country='Croatia', state='Splitsko-dalmatinska')
        db.session.commit()
        calls = 0
        real = suggest.find_days

        def counted(session):
            nonlocal calls
            calls += 1
            return real(session)

        with mock.patch.object(suggest, 'find_days', counted):
            payload = self.get('/api/parcours').get_json()
        self.assertEqual(calls, 1)
        self.assertEqual(payload['suggestions'], [{
            'kind': 'trip', 'start': '2025-07-12', 'end': '2025-07-13', 'days': 2, 'findDays': 2,
            'finds': 4, 'place': 'Splitsko-dalmatinska',
        }])
        self.assertEqual(payload['suggestionsTotal'], 1)
        self.assertEqual(payload['home'], {'lat': mock.ANY, 'lon': mock.ANY})
        # Une plage enregistrée n'y est plus proposée.
        self.create(name='Croatie', date_start='2025-07-12', date_end='2025-07-13')
        self.assertEqual(self.get('/api/parcours').get_json()['suggestions'], [])


if __name__ == '__main__':
    unittest.main()
