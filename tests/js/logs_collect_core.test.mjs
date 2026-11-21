// Cœur du favori « Mes logs » (static/logs/logs_collect_core.js) : un script
// classique, pas un module — chargé ici dans un contexte vm, ses fonctions
// de premier niveau en deviennent les propriétés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../static/logs/logs_collect_core.js', import.meta.url), 'utf8');
const core = vm.createContext({ console });
vm.runInContext(source, core);

// Document minimal : parseCachePage ne lit que des sélecteurs absents ici.
const emptyDoc = {
  title: 'GC1TEST 1-Une mystery',
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
};

// Forme relevée sur une fiche réelle le 2026-11-21 (coordonnées et nom fictifs).
const CURRENT_PAGE = `<script type="text/javascript">
//<![CDATA[
MapTilesEnvironment = 'production';window.userDefinedCoords = {"status":"success","data":{"isUserDefined":true,"newLatLng":[45.12345,3.54321],"oldLatLng":[45.1,3.5],"oldLatLngDisplay":"N 45° 06.000' E 003° 30.000'"}};
mapLatLng = {"lat":45.12345,"lng":3.54321,"type":8,"name":"Une mystery"};
</script>
<script>
function updateUserDefinedCoordsAfterSuccessfulCheck(lat, lng) {
  var currentUserDefinedCoords = window.userDefinedCoords || {};
  window.userDefinedCoords = currentUserDefinedCoords;
}
</script>`;

test('fiche actuelle : publiées et corrigées lues dans window.userDefinedCoords', () => {
  const info = core.parseCachePage(emptyDoc, CURRENT_PAGE, 'https://www.geocaching.com/geocache/GC1TEST');
  assert.equal(info.latitude, 45.1);
  assert.equal(info.longitude, 3.5);
  assert.deepEqual({ ...info.corrected }, { latitude: 45.12345, longitude: 3.54321 });
});

test('publiées en texte seulement : repli sur oldLatLngDisplay', () => {
  const html = CURRENT_PAGE.replace('"oldLatLng":[45.1,3.5],', '');
  const user = core.userDefinedCoords(html);
  assert.deepEqual({ ...user.posted }, { latitude: 45.1, longitude: 3.5 });
});

test('cache sans correction : position de mapLatLng, pas de corrigées', () => {
  const html = `<script>mapLatLng = {"lat":45.1,"lng":3.5,"type":2,"name":"Une traditionnelle"};</script>
<script>function f() { var currentUserDefinedCoords = window.userDefinedCoords || {}; window.userDefinedCoords = currentUserDefinedCoords; }</script>`;
  assert.equal(core.userDefinedCoords(html), null);
  const info = core.parseCachePage(emptyDoc, html, 'https://www.geocaching.com/geocache/GC1TEST');
  assert.equal(info.latitude, 45.1);
  assert.equal(info.longitude, 3.5);
  assert.equal(info.corrected, null);
});

test('parkings : tableau des waypoints, puis liste de la petite carte', () => {
  const table = `<table id="ctl00_ContentBody_Waypoints"><tbody>
<tr class="BorderBottom"><td><img src="/images/wpttypes/sm/pkg.jpg" alt="Parking Area" /></td><td>PK</td>
<td><a href="/seek/wpt.aspx?WID=x">Parking du Col &amp; de l&#39;Arc (Parking Area)</a></td>
<td>N 45° 06.000 E 003° 30.000&nbsp;</td></tr>
<tr><td>Note:</td><td colspan="3">Gratuit</td></tr>
<tr><td><img src="/images/wpttypes/sm/stage.jpg" /></td><td>S1</td><td><a>Étape</a></td><td>N 45° 07.000 E 003° 31.000</td></tr>
<tr><td><img src="/images/wpttypes/sm/pkg.jpg" /></td><td>P2</td><td><a>Caché</a></td><td>??? ???</td></tr>
</tbody></table>`;
  assert.deepEqual(JSON.parse(JSON.stringify(core.parkingWaypoints(table))), [
    { kind: 'parking', name: "Parking du Col & de l'Arc", latitude: 45.1, longitude: 3.5 },
  ]);
  const cmap = 'var cmapAdditionalWaypoints = [{"lat":45.2,"lng":3.6,"type":217,"name":"P"},{"lat":45.3,"lng":3.7,"type":219,"name":"S"}];';
  assert.deepEqual(JSON.parse(JSON.stringify(core.parkingWaypoints(cmap))), [
    { kind: 'parking', name: 'P', latitude: 45.2, longitude: 3.6 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(core.parkingWaypoints('<p>rien</p>'))), []);
});

test('isUserDefined faux ou JSON illisible : rien de corrigé', () => {
  assert.equal(core.userDefinedCoords('window.userDefinedCoords = {"status":"success","data":{"isUserDefined":false}};'), null);
  assert.equal(core.userDefinedCoords('window.userDefinedCoords = {"status":;'), null);
});

// Collecte d'une demande de la page Parcours, réseau simulé : seules les
// caches demandées sont lues (ni journal ni « Vos caches »), le carnet est
// filtré sur vos logs, et l'export ne déclare aucune couverture.
test('demande de parcours : seulement ses caches, sans couverture', async () => {
  const fetched = [];
  const page = (code) => `<script>var userToken = 'tk${code}';
mapLatLng = {"lat":45.1,"lng":3.5,"type":2,"name":"x"};</script>`;
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {}, table() {} },
    setTimeout, URLSearchParams,
    window: { serverParameters: { 'user:info': { username: 'Moi' } } },
    document: { querySelectorAll: () => [] },
    DOMParser: class { parseFromString() { return { ...emptyDoc, title: '' }; } },
    fetch: async (url) => {
      fetched.push(url);
      const base = 'https://www.geocaching.com';
      if (url.startsWith('/seek/geocache.logbook')) {
        const code = new URLSearchParams(url.split('?')[1]).get('tkn').slice(2);
        return {
          ok: true, status: 200, url: base + url,
          json: async () => ({
            status: 'success', pageInfo: { totalPages: 1 },
            data: [{ LogID: code === 'GC1' ? 101 : 102, LogTypeID: 2, LogType: 'Found it',
              Visited: '2025-07-12', AccountID: 7, UserName: 'Moi', FavoritePointUsed: code === 'GC1' }],
          }),
        };
      }
      return { ok: true, status: 200, url: base + url, text: async () => page(url.split('/').pop()) };
    },
  });
  vm.runInContext(source, ctx);
  vm.runInContext('LOGS_DELAY_MS = 0;', ctx);
  const state = ctx.newState();
  state.request = { id: 'a'.repeat(32), label: 'Vacances', codes: ['GC1', 'GC2', 'pas-un-code'] };
  await ctx.mygcflowCollectGcLogs(state, () => {});

  assert.deepEqual(fetched.filter((u) => !u.startsWith('/seek/geocache.logbook')),
    ['/account/settings/preferences', '/geocache/GC1', '/geocache/GC2']);
  assert.ok(fetched.filter((u) => u.startsWith('/seek/geocache.logbook')).every((u) => u.includes('sp=true')));
  // Copie JSON : les objets créés dans le contexte vm ont d'autres prototypes.
  const payload = JSON.parse(JSON.stringify(ctx.buildPayload(state, 'YMD').payload));
  assert.deepEqual(payload.coverage, []);
  assert.deepEqual(payload.logs.map((l) => [l.gc_code, l.favorite]), [['GC1', true], ['GC2', false]]);
});

test('ancienne fiche : mapLatLng fusionné côté serveur', () => {
  const html = `<script>mapLatLng = {"lat":45.12345,"lng":3.54321,"isUserDefined":true,"oldLatLngDisplay":"N 45° 06.000' E 003° 30.000'"};</script>`;
  const info = core.parseCachePage(emptyDoc, html, 'https://www.geocaching.com/geocache/GC1TEST');
  assert.equal(info.latitude, 45.1);
  assert.equal(info.longitude, 3.5);
  assert.deepEqual({ ...info.corrected }, { latitude: 45.12345, longitude: 3.54321 });
});
