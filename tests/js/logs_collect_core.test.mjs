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

test('isUserDefined faux ou JSON illisible : rien de corrigé', () => {
  assert.equal(core.userDefinedCoords('window.userDefinedCoords = {"status":"success","data":{"isUserDefined":false}};'), null);
  assert.equal(core.userDefinedCoords('window.userDefinedCoords = {"status":;'), null);
});

test('ancienne fiche : mapLatLng fusionné côté serveur', () => {
  const html = `<script>mapLatLng = {"lat":45.12345,"lng":3.54321,"isUserDefined":true,"oldLatLngDisplay":"N 45° 06.000' E 003° 30.000'"};</script>`;
  const info = core.parseCachePage(emptyDoc, html, 'https://www.geocaching.com/geocache/GC1TEST');
  assert.equal(info.latitude, 45.1);
  assert.equal(info.longitude, 3.5);
  assert.deepEqual({ ...info.corrected }, { latitude: 45.12345, longitude: 3.54321 });
});
