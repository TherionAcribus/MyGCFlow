import os
import tempfile
import unittest

import evolution_csv as ec

# En-tête réel des exports (première colonne sans nom).
HEADER = (',"GC code","Nom de la géocache",Type,Taille,Difficulté,Terrain,Propriétaire,'
          '"Placée par",Pays,Région,Département,Coordonnées,"Coordonnées corrigées",Latitude,'
          'Longitude,"Elévation (m)","Date de placement","Date de dernière publication",'
          '"Date de dernière trouvaille","Dernière date d\'archivage","Derniers logs",Trouvées,'
          'PF,PF%,"PF Wilson",Archivée,Verrouillée,Désactivée,Premium,Challenge,'
          '"Latitude corrigée","Longitude corrigée","Note de géocache","Ajouté par",Ajouté,Source')


def row(code='GC420', name='Go France Go', type_='Traditionnelle', size='Petite',
        d='1', t='1.5', lat='48.710167', lon='2.260833', placed='2001-03-07',
        archived_on='', archived='false', added='2026-09-30 06:09:21', region='Île-de-France'):
    return (f',{code},"{name}",{type_},{size},{d},{t},owner,"placed by",France,{region},Essonne,'
            f'"N 48° 42.610 E 002° 15.650",,{lat},{lon},72,{placed},{placed},,{archived_on},1,1,0,0,0,'
            f'{archived},false,false,false,false,49.0,3.0,false,Someone,"{added}",mapcompare')


class CsvTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, lines, name='export.csv', encoding='utf-8', bom=False):
        path = os.path.join(self.tmp.name, name)
        data = '\n'.join(lines) + '\n'
        with open(path, 'wb') as fh:
            if bom:
                fh.write(b'\xef\xbb\xbf')
            fh.write(data.encode(encoding))
        return path

    def parse(self, path):
        report = ec.FileReport(filename=os.path.basename(path))
        rows = [r for batch in ec.iter_batches(path, report, batch_size=2) for r in batch]
        return rows, report


class HeaderTests(CsvTestCase):
    def test_real_export_header_is_recognized(self):
        mapping, encoding, delimiter = ec.read_header(self.write([HEADER, row()]))
        self.assertEqual(delimiter, ',')
        self.assertEqual(encoding, 'utf-8-sig')
        for key in ('gc_code', 'latitude', 'longitude', 'placed', 'archived_on', 'archived',
                    'exported_at', 'type', 'size', 'country', 'region', 'county'):
            self.assertIn(key, mapping)
        # « Ajouté » et « Ajouté par » restent distincts ; la latitude corrigée est ignorée.
        names = HEADER.split(',')
        self.assertEqual(names[mapping['exported_at']], 'Ajouté')
        self.assertEqual(names[mapping['latitude']], 'Latitude')

    def test_missing_required_columns_are_listed(self):
        path = self.write(['"GC code",Nom,Latitude', 'GC1,x,48'])
        with self.assertRaises(ec.CsvFormatError) as ctx:
            ec.read_header(path)
        self.assertEqual(ctx.exception.missing, ['longitude', 'placed'])

    def test_semicolon_bom_and_cp1252_are_supported(self):
        lines = ['Code;Nom;Latitude;Longitude;Date de placement;Archivée;Dernière date d\'archivage',
                 'GC12AB;Église;48,5;2,25;15/06/2010;oui;01/02/2015']
        path = self.write(lines, encoding='cp1252')
        rows, report = self.parse(path)
        self.assertEqual(report.encoding, 'cp1252')
        self.assertEqual(report.delimiter, ';')
        self.assertEqual(rows[0][1], 'Église')
        self.assertEqual(rows[0][11:15], (48.5, 2.25, '2010-06-15', '2015-02-01'))

        path = self.write(lines, name='bom.csv', bom=True)
        rows, report = self.parse(path)
        self.assertEqual(report.encoding, 'utf-8-sig')
        self.assertEqual(rows[0][0], 'GC12AB')


class RowTests(CsvTestCase):
    def test_types_and_sizes_are_translated(self):
        path = self.write([
            HEADER,
            row('GC1', type_='Cache Mystère', size='Normale'),
            row('GC2', type_='Multi-cache', size='Large'),
            row('GC3', type_='Cache sans localisation', size='Non choisie'),
            row('GC4', type_='Tout nouveau type', size='Géante'),
        ])
        rows, report = self.parse(path)
        self.assertEqual([(r[2], r[3]) for r in rows], [
            ('Unknown Cache', 'Regular'),
            ('Multi-cache', 'Large'),
            ('Locationless (Reverse) Cache', 'Not chosen'),
            ('Tout nouveau type', 'Géante'),
        ])
        self.assertEqual(report.unknown_types, {'Tout nouveau type': 1})
        self.assertEqual(report.unknown_sizes, {'Géante': 1})

    def test_invalid_rows_are_counted_by_reason(self):
        path = self.write([
            HEADER,
            row('XX1'),
            row('GC5', lat='abc'),
            row('GC6', lat='0', lon='0'),
            row('GC7', lat='95'),
            row('GC8', placed=''),
            row('gc9'),
            '',
        ])
        rows, report = self.parse(path)
        self.assertEqual([r[0] for r in rows], ['GC9'])
        self.assertEqual(report.rows_read, 6)
        self.assertEqual(report.invalid, {'code': 1, 'coordinates': 3, 'placed': 1})

    def test_archive_cases(self):
        path = self.write([
            HEADER,
            row('GC1', archived='true', archived_on='2010-05-01'),
            row('GC2', archived='true', archived_on=''),
            row('GC3', archived='false', archived_on='2010-05-01'),
            row('GC4', archived='true', archived_on='2000-01-01'),
            row('GC5', archived='true', archived_on='pas une date'),
        ])
        rows, report = self.parse(path)
        by_code = {r[0]: (r[14], r[15]) for r in rows}
        self.assertEqual(by_code['GC1'], ('2010-05-01', 1))
        self.assertEqual(by_code['GC2'], (None, 1))
        # Réactivée : l'ancienne date d'archivage ne compte plus.
        self.assertEqual(by_code['GC3'], (None, 0))
        self.assertEqual(by_code['GC4'], ('2000-01-01', 1))
        self.assertEqual(by_code['GC5'], (None, 1))
        self.assertEqual(report.archived_without_date, 2)
        self.assertEqual(report.reactivated, 1)
        self.assertEqual(report.archive_before_placement, 1)
        self.assertEqual(report.bad_archive_date, 1)

    def test_values_are_normalized(self):
        path = self.write([HEADER, row('GC1', d='"2,5"', t='7', added='2026-09-30T06:09')])
        (r,), report = self.parse(path)
        self.assertEqual(r[4], 2.5)
        self.assertIsNone(r[5])
        self.assertEqual(r[16], '2026-09-30 06:09:00')
        self.assertEqual(report.rows_valid, 1)
        self.assertEqual(len(r), len(ec.ROW_FIELDS))

    def test_progress_reaches_the_end(self):
        path = self.write([HEADER] + [row(f'GC{i}A') for i in range(10)])
        seen = []
        report = ec.FileReport()
        for _batch in ec.iter_batches(path, report, on_progress=seen.append, batch_size=3):
            pass
        self.assertEqual(seen[-1], 1.0)
        self.assertEqual(seen, sorted(seen))


if __name__ == '__main__':
    unittest.main()
