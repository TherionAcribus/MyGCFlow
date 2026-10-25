// Tests des fonctions pures de l'exporteur (sans réseau ni DOM).
// node --test tools/gc_logs_exporter/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./export_gc_logs.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, console };
vm.runInNewContext(source, sandbox);
const H = sandbox.module.exports;

test('dates numériques selon l\'ordre', () => {
  assert.equal(H.parseDateText('20/08/2011', 'DMY'), '2011-08-20');
  assert.equal(H.parseDateText('08/20/2011', 'MDY'), '2011-08-20');
  assert.equal(H.parseDateText('2011-08-20', 'DMY'), '2011-08-20');
  assert.equal(H.parseDateText('2011/08/20', 'MDY'), '2011-08-20');
  assert.equal(H.parseDateText('20.08.2011', 'DMY'), '2011-08-20');
  assert.equal(H.parseDateText('20/08/2011', 'MDY'), null);
  assert.equal(H.parseDateText('31/02/2011', 'DMY'), null);
  assert.equal(H.parseDateText('', 'DMY'), null);
});

test('dates avec nom de mois (anglais, français)', () => {
  assert.equal(H.parseDateText('20 Aug 11', null), '2011-08-20');
  assert.equal(H.parseDateText('Aug/20/2011', null), '2011-08-20');
  assert.equal(H.parseDateText('20/Aug/2011', null), '2011-08-20');
  assert.equal(H.parseDateText('20 août 2011', null), '2011-08-20');
  assert.equal(H.parseDateText('5 juin 2012', null), '2012-06-05');
  assert.equal(H.parseDateText('5 juil. 2012', null), '2012-07-05');
  assert.equal(H.parseDateText('Saturday, 05 March 2011', null), '2011-03-05');
});

test('un instant ISO ne garde que sa date civile', () => {
  assert.equal(H.parseDateText('2012-01-08T20:00:00Z', null), '2012-01-08');
});

test('déduction de l\'ordre des dates', () => {
  assert.equal(H.detectDateOrder(['01/02/2011', '20/08/2011']).order, 'DMY');
  assert.equal(H.detectDateOrder(['01/02/2011', '08/20/2011']).order, 'MDY');
  assert.equal(H.detectDateOrder(['2011-08-20']).order, 'DMY');
  const ambiguous = H.detectDateOrder(['01/02/2011', '03/04/2012']);
  assert.equal(ambiguous.order, null);
  assert.deepEqual([...ambiguous.candidates], ['DMY', 'MDY']);
  assert.equal(H.detectDateOrder(['05/05/2011']).order, 'DMY');
});

test('ordre depuis le format de préférence', () => {
  assert.equal(H.dateOrderFromFormat('dd/MM/yyyy'), 'DMY');
  assert.equal(H.dateOrderFromFormat('M/d/yyyy'), 'MDY');
  assert.equal(H.dateOrderFromFormat('yyyy-MM-dd'), 'YMD');
  assert.equal(H.dateOrderFromFormat('dd MMM yy'), 'DMY');
  assert.equal(H.dateOrderFromFormat('n/a'), null);
});

test('coordonnées degrés-minutes', () => {
  assert.deepEqual({ ...H.parseDdm('N 49° 16.032 E 006° 15.586') }, { latitude: 49.2672, longitude: 6.259767 });
  assert.deepEqual({ ...H.parseDdm('S 33° 51.000 W 151° 12.000') }, { latitude: -33.85, longitude: -151.2 });
  assert.equal(H.parseDdm('N 95° 00.000 E 006° 00.000'), null);
  assert.equal(H.parseDdm('n/a'), null);
});

test('codes GC et GUID extraits des liens', () => {
  const refs = H.refsFromHrefs([
    'https://www.geocaching.com/geocache/GC345J4_trivial-mystery',
    '/geocache/gc2pr3n',
    'https://coord.info/GC345J4',
    '/seek/cache_details.aspx?wp=GC1ABCD',
    '/seek/cache_details.aspx?guid=0f3e6c2a-1b2c-4d5e-8f90-123456789abc',
    '/profile/?guid=0f3e6c2a-1b2c-4d5e-8f90-123456789abc',
    null
  ]);
  assert.deepEqual([...refs.codes], ['GC345J4', 'GC2PR3N', 'GC1ABCD']);
  assert.deepEqual([...refs.guids], ['0f3e6c2a-1b2c-4d5e-8f90-123456789abc']);
});

test('type de log depuis l\'image, variantes ramenées au canonique', () => {
  assert.equal(H.logTypeIdFromImage('3.png'), 3);
  assert.equal(H.logTypeIdFromImage('/images/logtypes/48/46.png'), 46);
  assert.equal(H.logTypeIdFromImage('1003.png'), 24);
  assert.equal(H.logTypeIdFromImage('68.png'), 18);
  assert.equal(H.logTypeIdFromImage(''), null);
});

test('entrée du carnet normalisée, sans texte', () => {
  const log = H.normalizeLogbookEntry({
    LogID: 181176759, LogType: 'Didn\'t find it', LogTypeImage: '3.png', Visited: '20/08/2011',
    UserName: 'Moi', AccountID: 1234567, LogText: 'ne doit pas sortir'
  }, 'GC2PR3N');
  assert.deepEqual({ ...log, author: { ...log.author } }, {
    log_id: 181176759, gc_code: 'GC2PR3N', type_id: 3, type_label: 'Didn\'t find it',
    date_text: '20/08/2011', author: { id: 1234567, name: 'Moi' }, favorite: null
  });
});

test('carnet réel : LogTypeID prioritaire, point favori repris, e-mail écarté', () => {
  const log = H.normalizeLogbookEntry({
    LogID: 1300000001, CacheID: 7000000, LogTypeID: 1003, LogType: 'Publish Listing', LogTypeImage: '24.png',
    Visited: '05/02/2021', UserName: 'Relecteur', AccountID: 42, Email: 'x@example.org',
    AvatarImage: 'a.jpg', LogText: 'texte', FavoritePointUsed: false
  }, 'GC8YGHB');
  assert.equal(log.type_id, 24);
  assert.equal(log.favorite, false);
  assert.ok(!JSON.stringify(log).includes('example.org'));
  const fav = H.normalizeLogbookEntry({ LogID: 1, LogTypeID: 2, LogTypeImage: '3.png', FavoritePointUsed: true }, 'GC1');
  assert.equal(fav.type_id, 2);
  assert.equal(fav.favorite, true);
});

function sampleState() {
  const state = H.newState();
  state.me = { name: 'Moi', id: 1234567 };
  state.dnf.listingComplete = true;
  state.dnf.codes.add('GC2PR3N');
  state.owned.codes.add('GC1ABCD');
  state.owned.full.add('GC1ABCD');
  state.caches.set('GC2PR3N', {
    gc_code: 'GC2PR3N', name: 'Black Op', type: 'Wherigo Cache', latitude: 49.279233, longitude: 6.227883,
    corrected: null, difficulty: 3, terrain: 3, container: 'Small', owner_name: 'Autre',
    placed_text: '05/03/2011', status: 'archived', favorite_points: 12
  });
  state.caches.set('GC1ABCD', {
    gc_code: 'GC1ABCD', name: 'Ma cache', type: 'Traditional Cache', latitude: 49.1, longitude: 6.1,
    corrected: null, difficulty: 1.5, terrain: 2, container: 'Micro', owner_name: 'Moi',
    placed_text: '01/04/2015', status: 'active', favorite_points: 3
  });
  const logs = [
    { log_id: 207457894, gc_code: 'GC2PR3N', type_id: 2, type_label: 'Found it', date_text: '08/01/2012', author: { id: 1234567, name: 'Moi' } },
    { log_id: 181176759, gc_code: 'GC2PR3N', type_id: 3, type_label: 'Didn\'t find it', date_text: '20/08/2011', author: { id: 1234567, name: 'Moi' } },
    { log_id: 500000001, gc_code: 'GC1ABCD', type_id: 2, type_label: 'Found it', date_text: '02/05/2015', author: { id: 7654321, name: 'Autre' }, favorite: true },
    { log_id: 500000002, gc_code: 'GC1ABCD', type_id: 46, type_label: 'Owner Maintenance', date_text: 'illisible', author: { id: 1234567, name: 'Moi' } }
  ];
  logs.forEach(l => state.logs.set(l.log_id, l));
  return state;
}

test('fichier final conforme au contrat mygcflow-logs v1', () => {
  // Passage par JSON, comme le fichier téléchargé : objets du bac à sable vm
  // ramenés dans le contexte du test.
  const { payload, rejected } = JSON.parse(JSON.stringify(H.buildPayload(sampleState(), 'DMY')));
  assert.equal(payload.format, 'mygcflow-logs');
  assert.equal(payload.schema_version, 1);
  assert.deepEqual(payload.account, { user_id: 1234567, username: 'Moi' });
  assert.deepEqual(payload.logs.map(l => [l.log_id, l.date]), [
    [181176759, '2011-08-20'], [207457894, '2012-01-08'], [500000001, '2015-05-02']
  ]);
  assert.deepEqual(payload.logs.map(l => l.favorite), [null, null, true]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].log_id, 500000002);
  const mine = payload.caches.find(c => c.gc_code === 'GC1ABCD');
  assert.deepEqual(mine.owner, { id: 1234567, name: 'Moi' });
  assert.equal(mine.placed_date, '2015-04-01');
  const other = payload.caches.find(c => c.gc_code === 'GC2PR3N');
  assert.deepEqual(other.owner, { id: null, name: 'Autre' });
  assert.ok(!('text' in payload.logs[0]));
  assert.deepEqual(payload.coverage, [
    { kind: 'author', author_id: 1234567, type_ids: [3], complete: true },
    { kind: 'caches', gc_codes: ['GC1ABCD'], complete: true }
  ]);
});

test('pas de couverture DNF si une cache DNF manque ou si l\'essai est limité', () => {
  const missing = sampleState();
  missing.dnf.codes.add('GC9ZZZZ');
  assert.ok(!H.buildPayload(missing, 'DMY').payload.coverage.some(c => c.kind === 'author'));
  const limited = sampleState();
  limited.limited = true;
  assert.ok(!H.buildPayload(limited, 'DMY').payload.coverage.some(c => c.kind === 'author'));
});
