// Cœur partagé — collecte des logs geocaching.com (DNF et caches posées).
//
// Inclus tel quel dans le favori « Envoyer vers MyGCFlow »
// (logs_bookmarklet.src.js) par blueprints/gc_logs.py : seule copie du
// moteur de collecte. Il s'exécute sur une page de geocaching.com, avec les
// cookies de session, et relit les mêmes pages qu'une consultation à la
// main : la liste de vos journaux filtrée sur « Didn't find it », la liste
// de vos caches, puis pour chaque cache concernée sa fiche et son carnet
// de logs — une pause entre les requêtes (LOGS_DELAY_MS). Ce qu'il lit :
//   - vos DNF : le carnet de chaque cache concernée, limité à VOS logs
//     (DNF, trouvaille éventuelle, notes) ;
//   - vos caches : TOUS les logs du carnet (les vôtres de poseur et ceux
//     des autres, avec le point favori éventuel).
// Le texte des logs, l'e-mail et l'avatar des auteurs ne sont jamais repris.
//
// Contrainte d'écriture (ce fichier finit sur une seule ligne dans le
// favori) : commentaires en lignes entières uniquement, chaque instruction
// terminée par un point-virgule, aucune chaîne sur plusieurs lignes.

var LOGS_DELAY_MS = 800;
var LOGBOOK_PAGE_SIZE = 100;
// Rythme de sauvegarde de la progression (state.persist, posé par le
// favori) : plan localStorage + fragment vers l'application.
var CHECKPOINT_EVERY = 15;
var DNF_TYPE_ID = 3;
// Types que seul le propriétaire (ou un relecteur) publie : leurs listes
// servent à retrouver vos caches si la page « vos caches » ne répond pas.
var OWNER_LOG_TYPES = [46, 47, 22, 23];
var MAX_CONSECUTIVE_FAILURES = 5;
var LOGS_FORMAT = 'mygcflow-logs';
var LOGS_SCHEMA_VERSION = 1;
var LOGS_GENERATOR = 'mygcflow-gc-logs-bookmarklet';
var LOGS_GENERATOR_VERSION = '1.0.0';

// ---------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------

// Libellés <groundspeak:type> des GPX : ceux de la base MyGCFlow.
var GC_LOGS_CACHE_TYPES = {
  2: 'Traditional Cache',
  3: 'Multi-cache',
  4: 'Virtual Cache',
  5: 'Letterbox Hybrid',
  6: 'Event Cache',
  8: 'Unknown Cache',
  9: 'Project APE Cache',
  11: 'Webcam Cache',
  12: 'Locationless (Reverse) Cache',
  13: 'Cache In Trash Out Event',
  137: 'Earthcache',
  453: 'Mega-Event Cache',
  1304: 'GPS Adventures Exhibit',
  1858: 'Wherigo Cache',
  3653: 'Community Celebration Event',
  3773: 'Geocaching HQ',
  3774: 'Geocaching HQ Celebration',
  4738: 'Geocaching HQ Block Party',
  7005: 'Giga-Event Cache'
};

var GC_LOGS_CONTAINERS = {
  micro: 'Micro',
  small: 'Small',
  regular: 'Regular',
  large: 'Large',
  other: 'Other',
  virtual: 'Virtual',
  not_chosen: 'Not chosen'
};

// Variantes d'images de types de logs (relevées dans pycaching) ramenées
// à l'identifiant canonique du contrat.
var LOG_TYPE_ALIASES = { 1: 12, 6: 5, 68: 18, 1003: 24 };

function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  var n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function logTypeIdFromImage(image) {
  var m = /(\d+)\.(?:png|gif|svg)\b/i.exec(String(image || ''));
  if (!m) return null;
  var id = Number(m[1]);
  return LOG_TYPE_ALIASES[id] || id;
}

var CODE_PATTERNS = [
  /\/geocache\/(GC[0-9A-Z]+)/i,
  /coord\.info\/(GC[0-9A-Z]+)/i,
  /[?&]wp=(GC[0-9A-Z]+)/i
];
var GUID_PATTERN = /cache_details\.aspx\?guid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Codes GC (et GUID de caches, liens anciens) d'une liste de liens.
function refsFromHrefs(hrefs) {
  var codes = new Set();
  var guids = new Set();
  for (var i = 0; i < hrefs.length; i++) {
    var href = hrefs[i];
    if (!href) continue;
    var found = false;
    for (var p = 0; p < CODE_PATTERNS.length; p++) {
      var m = CODE_PATTERNS[p].exec(href);
      if (m) {
        codes.add(m[1].toUpperCase());
        found = true;
        break;
      }
    }
    if (!found) {
      var g = GUID_PATTERN.exec(href);
      if (g) guids.add(g[1].toLowerCase());
    }
  }
  return { codes: Array.from(codes), guids: Array.from(guids) };
}

// « N 49° 16.032 E 006° 15.586 » → degrés décimaux.
function parseDdm(text) {
  var m = /([NS])\s*(\d{1,2})\s*°\s*(\d{1,2}(?:[.,]\d+)?)\s*'?\s*([EWO])\s*(\d{1,3})\s*°\s*(\d{1,2}(?:[.,]\d+)?)/i
    .exec(String(text || ''));
  if (!m) return null;
  var lat = (Number(m[2]) + Number(m[3].replace(',', '.')) / 60) * (/s/i.test(m[1]) ? -1 : 1);
  var lon = (Number(m[5]) + Number(m[6].replace(',', '.')) / 60) * (/[wo]/i.test(m[4]) ? -1 : 1);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { latitude: round6(lat), longitude: round6(lon) };
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

var MONTH_PATTERNS = [
  [/^jan/, 1], [/^(feb|fev)/, 2], [/^mar/, 3], [/^(apr|avr)/, 4],
  [/^(may|mai)/, 5], [/^(jun|juin)/, 6], [/^(jul|juil)/, 7], [/^(aug|aou)/, 8],
  [/^sep/, 9], [/^(oct|okt)/, 10], [/^nov/, 11], [/^(dec|dez)/, 12]
];

function monthFromName(word) {
  var w = String(word).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.$/, '');
  if (w.length < 3) return null;
  for (var i = 0; i < MONTH_PATTERNS.length; i++) {
    if (MONTH_PATTERNS[i][0].test(w)) return MONTH_PATTERNS[i][1];
  }
  return null;
}

function isoDate(year, month, day) {
  var maxYear = new Date().getUTCFullYear() + 1;
  if (!(year >= 2000 && year <= maxYear) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
    return null;
  }
  var d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

function fullYear(text) {
  var n = Number(text);
  return text.length <= 2 ? 2000 + n : n;
}

// Date affichée par le site → 'AAAA-MM-JJ', ou null si illisible. `order`
// ne sert qu'aux dates entièrement numériques.
function parseDateText(text, order) {
  if (!text) return null;
  var s = String(text).trim();
  var iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(s);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  var tokens = s.match(/\d+|[A-Za-zÀ-ÿ]+\.?/g) || [];
  var nums = [];
  var month = null;
  for (var t = 0; t < tokens.length; t++) {
    var token = tokens[t];
    if (/^\d+$/.test(token)) {
      nums.push(token);
      continue;
    }
    var mo = monthFromName(token);
    if (mo !== null) {
      if (month !== null) return null;
      month = mo;
    }
  }
  if (month !== null) {
    if (nums.length !== 2) return null;
    var a2 = nums[0];
    var b2 = nums[1];
    if (a2.length === 4) return isoDate(Number(a2), month, Number(b2));
    return isoDate(fullYear(b2), month, Number(a2));
  }
  if (nums.length !== 3) return null;
  var a = nums[0];
  var b = nums[1];
  var c = nums[2];
  if (a.length === 4 || order === 'YMD') return isoDate(fullYear(a), Number(b), Number(c));
  if (order === 'DMY') return isoDate(fullYear(c), Number(b), Number(a));
  if (order === 'MDY') return isoDate(fullYear(c), Number(a), Number(b));
  return null;
}

// Ordre compatible avec TOUTES les dates numériques relevées. null si
// plusieurs ordres restent possibles et donnent des dates différentes.
function detectDateOrder(samples) {
  var numeric = samples.filter(function (s) { return s && !/[A-Za-zÀ-ÿ]/.test(s); });
  if (!numeric.length) return { order: 'DMY', candidates: ['DMY', 'MDY', 'YMD'] };
  var candidates = ['DMY', 'MDY', 'YMD'].filter(function (order) {
    return numeric.every(function (s) { return parseDateText(s, order) !== null; });
  });
  if (candidates.length === 1) return { order: candidates[0], candidates: candidates };
  if (candidates.length > 1) {
    var same = numeric.every(function (s) {
      var first = parseDateText(s, candidates[0]);
      return candidates.every(function (o) { return parseDateText(s, o) === first; });
    });
    if (same) return { order: candidates[0], candidates: candidates };
  }
  return { order: null, candidates: candidates };
}

// 'dd/MM/yyyy' (préférence du compte) → 'DMY'.
function dateOrderFromFormat(format) {
  var f = String(format || '');
  var pos = { D: f.indexOf('d'), M: f.indexOf('M'), Y: f.toLowerCase().indexOf('y') };
  if (pos.D < 0 || pos.M < 0 || pos.Y < 0) return null;
  return Object.keys(pos).sort(function (a, b) { return pos[a] - pos[b]; }).join('');
}

function toBool(value) {
  if (value === true || value === false) return value;
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  return null;
}

// Seuls ces champs sont lus : le carnet renvoie aussi le texte, l'e-mail
// et l'avatar de l'auteur, qui ne sortent jamais de la page.
function normalizeLogbookEntry(entry, gcCode) {
  var rawType = toInt(entry.LogTypeID);
  return {
    log_id: toInt(entry.LogID),
    gc_code: gcCode,
    type_id: rawType !== null ? (LOG_TYPE_ALIASES[rawType] || rawType) : logTypeIdFromImage(entry.LogTypeImage),
    type_label: entry.LogType || null,
    date_text: entry.Visited || null,
    author: { id: toInt(entry.AccountID), name: entry.UserName || null },
    favorite: toBool(entry.FavoritePointUsed)
  };
}

function sameName(a, b) {
  return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// Assemble le fichier final à partir de l'état collecté.
function buildPayload(state, order) {
  var rejected = [];
  var logs = [];
  state.logs.forEach(function (raw) {
    var date = parseDateText(raw.date_text, order);
    if (raw.log_id === null || raw.type_id === null || !date) {
      rejected.push({ gc_code: raw.gc_code, log_id: raw.log_id, date_text: raw.date_text, type_id: raw.type_id });
      return;
    }
    logs.push({
      log_id: raw.log_id,
      gc_code: raw.gc_code,
      type_id: raw.type_id,
      type_label: raw.type_label,
      date: date,
      author: raw.author,
      favorite: raw.favorite === undefined ? null : raw.favorite
    });
  });
  logs.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.log_id - b.log_id; });

  var caches = [];
  state.caches.forEach(function (info) {
    var owned = state.owned.codes.has(info.gc_code);
    var cache = {
      gc_code: info.gc_code,
      name: info.name,
      type: info.type,
      latitude: info.latitude,
      longitude: info.longitude,
      difficulty: info.difficulty,
      terrain: info.terrain,
      container: info.container,
      owner: owned ? { id: state.me.id, name: state.me.name } : { id: null, name: info.owner_name },
      placed_date: parseDateText(info.placed_text, order),
      status: info.status,
      favorite_points: info.favorite_points
    };
    if (info.corrected) cache.corrected = info.corrected;
    caches.push(cache);
  });
  caches.sort(function (a, b) { return a.gc_code < b.gc_code ? -1 : 1; });

  var coverage = [];
  // `read` couvre aussi les caches lues par un passage précédent (leurs
  // logs sont dans les fragments côté application, pas dans state.caches).
  var dnfAllRead = Array.from(state.dnf.codes).every(function (code) {
    return state.caches.has(code) || state.read.has(code);
  });
  if (state.dnf.listingComplete && !state.limited && !state.dnf.failed.length && dnfAllRead &&
      state.me.id !== null) {
    // Incrémental : la couverture est bornée à la fenêtre — seuls les
    // logs datés depuis `since` peuvent être retirés à l'import.
    var dnfScope = { kind: 'author', author_id: state.me.id, type_ids: [DNF_TYPE_ID], complete: true };
    if (state.since) dnfScope.since = state.since;
    coverage.push(dnfScope);
  }
  var fullOwned = Array.from(state.owned.full).sort();
  if (fullOwned.length) {
    coverage.push({ kind: 'caches', gc_codes: fullOwned, complete: true });
  }

  return {
    payload: {
      format: LOGS_FORMAT,
      schema_version: LOGS_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      generator: { name: LOGS_GENERATOR, version: LOGS_GENERATOR_VERSION },
      account: { user_id: state.me.id, username: state.me.name },
      coverage: coverage,
      caches: caches,
      logs: logs
    },
    rejected: rejected
  };
}

function newState() {
  return {
    me: { name: null, id: null },
    caches: new Map(),
    logs: new Map(),
    dnf: { codes: new Set(), listingComplete: false, failed: [] },
    owned: { codes: new Set(), full: new Set(), failed: [] },
    limited: false,
    prefOrder: null,
    // Ordre figé par un premier fragment (les fragments déjà envoyés
    // portent des dates écrites avec) — prioritaire sur la détection.
    order: null,
    // Collecte incrémentale : date ISO (« AAAA-MM-JJ ») du dernier export
    // connu de l'application, lue avant de partir — null = tout relire.
    since: null,
    dateSamples: [],
    // Reprise de collecte : identifiant du passage (fragments serveur),
    // codes traités (y compris par un passage précédent, restaurés),
    // plan sauvegardé à reprendre, instantané de la file pour le plan,
    // et callback de sauvegarde périodique posé par le favori.
    runId: null,
    read: new Set(),
    resume: null,
    queueSnapshot: null,
    persist: null
  };
}

// ---------------------------------------------------------------------
// Lecture des pages
// ---------------------------------------------------------------------

function textOf(doc, selector) {
  var el = doc.querySelector(selector);
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

function starValue(doc, selectors) {
  for (var i = 0; i < selectors.length; i++) {
    var img = doc.querySelector(selectors[i]);
    var m = img && /^(\d(?:[.,]5)?)/.exec(img.getAttribute('alt') || '');
    if (m) return Number(m[1].replace(',', '.'));
  }
  return null;
}

function parseCachePage(doc, html, url) {
  var title = (doc.title || '').trim();
  var codeMatch = /\/geocache\/(GC[0-9A-Z]+)/i.exec(url || '') || /^(GC[0-9A-Z]+)\b/i.exec(title);
  var info = {
    gc_code: codeMatch ? codeMatch[1].toUpperCase() : null,
    name: textOf(doc, '#ctl00_ContentBody_CacheName') || null,
    type: null,
    latitude: null,
    longitude: null,
    corrected: null,
    difficulty: null,
    terrain: null,
    container: null,
    owner_name: textOf(doc, '#ctl00_ContentBody_mcd1 a') || null,
    placed_text: null,
    status: 'active',
    favorite_points: null,
    token: null
  };

  var token = /userToken\s*=\s*'([^']+)'/.exec(html);
  info.token = token ? token[1] : null;

  // Coordonnées : mapLatLng (décimal) ; si vous avez corrigé celles d'une
  // mystery, la page affiche les vôtres et garde les publiées à part.
  var map = /mapLatLng\s*=\s*(\{[\s\S]*?\})\s*;/.exec(html);
  var mapText = map ? map[1] : '';
  var ll = /"lat"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"lng"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(mapText);
  var shown = ll ? { latitude: round6(Number(ll[1])), longitude: round6(Number(ll[2])) }
    : parseDdm(textOf(doc, '#uxLatLon'));
  var userDefined = /"isUserDefined"\s*:\s*true/.test(mapText);
  var original = /"oldLatLngDisplay"\s*:\s*"([^"]+)"/.exec(mapText);
  if (userDefined && original && parseDdm(original[1])) {
    var posted = parseDdm(original[1]);
    info.latitude = posted.latitude;
    info.longitude = posted.longitude;
    info.corrected = shown;
  } else if (shown) {
    info.latitude = shown.latitude;
    info.longitude = shown.longitude;
  }

  var typeId = null;
  var use = doc.querySelector('svg.cache-icon use');
  var href = use && (use.getAttribute('xlink:href') || use.getAttribute('href'));
  var iconMatch = href && /(\d+)/.exec(href.split('#').pop());
  if (iconMatch) typeId = Number(iconMatch[1]);
  if (typeId === null || !GC_LOGS_CACHE_TYPES[typeId]) {
    var t = /"type"\s*:\s*(\d+)/.exec(mapText);
    if (t) typeId = Number(t[1]);
  }
  info.type = GC_LOGS_CACHE_TYPES[typeId] || null;

  info.difficulty = starValue(doc, ['#ctl00_ContentBody_uxLegendScale img', '.CacheStarLabels img:nth-of-type(1)']);
  info.terrain = starValue(doc, ['#ctl00_ContentBody_Localize12 img', '.CacheStarLabels img:nth-of-type(2)']);

  var sizeImg = doc.querySelector('.CacheSize img');
  var sizeMatch = sizeImg && /\/([a-z_]+)\.(?:gif|png|svg)/i.exec(sizeImg.getAttribute('src') || '');
  info.container = sizeMatch ? (GC_LOGS_CONTAINERS[sizeMatch[1].toLowerCase()] || null) : null;

  var hidden = textOf(doc, '#ctl00_ContentBody_mcd2');
  info.placed_text = hidden ? hidden.split(':').pop().trim() : null;

  if (doc.getElementById('ctl00_ContentBody_archivedMessage')) info.status = 'archived';
  else if (doc.getElementById('ctl00_ContentBody_disabledMessage')) info.status = 'disabled';
  else if (doc.getElementById('unpublishedMessage') || doc.getElementById('unpublishedReviewerNoteMessage')) {
    info.status = 'unknown';
  }

  var fav = doc.querySelector('.favorite-value');
  info.favorite_points = fav ? toInt(fav.textContent.trim()) : null;
  return info;
}

// ---------------------------------------------------------------------
// Réseau
// ---------------------------------------------------------------------

var lastRequestAt = 0;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function politeFetch(url, init) {
  for (var attempt = 0; ; attempt++) {
    var wait = lastRequestAt + LOGS_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    var res = await fetch(url, Object.assign({ credentials: 'include' }, init || {}));
    if (/\/account\/signin/i.test(res.url)) {
      throw new Error('session expirée : reconnectez-vous puis relancez');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      console.warn('[mygcflow-logs] HTTP ' + res.status + ', nouvel essai dans ' +
        Math.round(LOGS_DELAY_MS * 5 * (attempt + 1) / 1000) + ' s');
      await sleep(LOGS_DELAY_MS * 5 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status + ' sur ' + url);
    return res;
  }
}

async function fetchHtml(url, init) {
  var res = await politeFetch(url, init);
  var html = await res.text();
  return { html: html, doc: new DOMParser().parseFromString(html, 'text/html'), url: res.url };
}

// Liste paginée par postback ASP.NET (« Vos journaux », « Vos caches »).
async function collectListing(url) {
  var page = await fetchHtml(url);
  var codes = new Set();
  var guids = new Set();
  for (var n = 0; n < 1000; n++) {
    var before = codes.size + guids.size;
    var hrefs = Array.from(page.doc.querySelectorAll('table a[href]'), function (a) { return a.getAttribute('href'); });
    var refs = refsFromHrefs(hrefs);
    refs.codes.forEach(function (c) { codes.add(c); });
    refs.guids.forEach(function (g) { guids.add(g); });
    var next = page.doc.querySelector('a[href*="__doPostBack(\'ctl00$ContentBody$pgrTop$ctl08\'"]');
    if (!next || codes.size + guids.size === before) {
      return { codes: codes, guids: guids, complete: true };
    }
    var form = page.doc.querySelector('form');
    if (!form) break;
    var body = new URLSearchParams();
    form.querySelectorAll('input[type=hidden][name]').forEach(function (input) {
      body.append(input.name, input.value || '');
    });
    body.set('__EVENTTARGET', 'ctl00$ContentBody$pgrTop$ctl08');
    body.set('__EVENTARGUMENT', '');
    page = await fetchHtml(page.url, {
      method: 'POST',
      body: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  }
  return { codes: codes, guids: guids, complete: false };
}

// La ligne d'un journal « vos logs » est-elle dans la fenêtre ? La date
// est lue dans ses cellules ; date illisible = prudence, on la relit.
// Ordre inconnu : la ligne est dans la fenêtre si UN ordre possible la
// fait basculer dedans (trop relire coûte du temps, trop peu perd des
// logs — le choix est vite fait).
function rowInWindow(tr, since, order) {
  var texts = Array.from(tr.querySelectorAll('td'), function (td) {
    return td.textContent.replace(/\s+/g, ' ').trim();
  });
  var orders = order ? [order] : ['DMY', 'MDY', 'YMD'];
  var dates = [];
  for (var t = 0; t < texts.length && !dates.length; t++) {
    for (var o = 0; o < orders.length; o++) {
      var d = parseDateText(texts[t], orders[o]);
      if (d) dates.push(d);
    }
  }
  if (!dates.length) return true;
  return dates.some(function (d) { return d >= since; });
}

var POSTBACK_LINK = 'a[href*="__doPostBack(\'ctl00$ContentBody$pgrTop$ctl08\'"]';

// « Vos journaux », ligne à ligne : chaque <tr> porte le lien de la cache
// et la date de VOTRE log. since = null → toutes les lignes (comportement
// de collectListing) ; sinon, seules les lignes de la fenêtre comptent et
// la lecture s'arrête dès qu'une page entière en sort.
//   complete : true quand le périmètre visé a été lu en entier — listing
//   complet sans since, fenêtre entièrement couverte avec.
async function collectJournal(url, since, order) {
  var codes = new Set();
  var guids = new Set();
  var page = await fetchHtml(url);
  for (var n = 0; n < 1000; n++) {
    var before = codes.size + guids.size;
    var rows = page.doc.querySelectorAll('table tr');
    var anyRecent = false;
    for (var r = 0; r < rows.length; r++) {
      var hrefs = Array.from(rows[r].querySelectorAll('a[href]'), function (a) {
        return a.getAttribute('href');
      });
      var refs = refsFromHrefs(hrefs);
      if (!refs.codes.length && !refs.guids.length) continue;
      if (since && !rowInWindow(rows[r], since, order)) continue;
      anyRecent = true;
      refs.codes.forEach(function (c) { codes.add(c); });
      refs.guids.forEach(function (g) { guids.add(g); });
    }
    var next = page.doc.querySelector(POSTBACK_LINK);
    if (!next || (since && !anyRecent)) {
      return { codes: codes, guids: guids, complete: true };
    }
    if (codes.size + guids.size === before) {
      // Postback rejoué sans nouveauté : sortie prudente — la fenêtre
      // n'est pas garantie couverte.
      return { codes: codes, guids: guids, complete: !since };
    }
    var form = page.doc.querySelector('form');
    if (!form) break;
    var body = new URLSearchParams();
    form.querySelectorAll('input[type=hidden][name]').forEach(function (input) {
      body.append(input.name, input.value || '');
    });
    body.set('__EVENTTARGET', 'ctl00$ContentBody$pgrTop$ctl08');
    body.set('__EVENTARGUMENT', '');
    page = await fetchHtml(page.url, {
      method: 'POST',
      body: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  }
  return { codes: codes, guids: guids, complete: false };
}

var loggedLogbookFields = false;

async function fetchLogbook(token, ownOnly) {
  var entries = [];
  var truncated = false;
  for (var idx = 1; ; idx++) {
    var params = new URLSearchParams({
      tkn: token, idx: String(idx), num: String(LOGBOOK_PAGE_SIZE),
      sp: String(ownOnly), sf: 'false', decrypt: 'false'
    });
    var res = await politeFetch('/seek/geocache.logbook?' + params.toString());
    var json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error('carnet : réponse non JSON (session expirée ?)');
    }
    if (json.status !== 'success') throw new Error('carnet refusé : ' + (json.msg || 'raison inconnue'));
    var data = Array.isArray(json.data) ? json.data : [];
    if (data.length && !loggedLogbookFields) {
      loggedLogbookFields = true;
      console.log('[mygcflow-logs] Champs d\'un log du carnet : ' + Object.keys(data[0]).join(', '));
    }
    entries.push.apply(entries, data);
    var totalPages = json.pageInfo && toInt(json.pageInfo.totalPages);
    if (!data.length || (totalPages !== null ? idx >= totalPages : data.length < LOGBOOK_PAGE_SIZE)) break;
  }
  return { entries: entries, truncated: truncated };
}

function detectUsername() {
  var params = window.serverParameters;
  var info = params && params['user:info'];
  if (info && info.username) return info.username;
  var scripts = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < scripts.length; i++) {
    var m = /"username"\s*:\s*"([^"]+)"/.exec(scripts[i].textContent);
    if (m) return m[1];
  }
  return null;
}

async function detectPreferredOrder() {
  try {
    var page = await fetchHtml('/account/settings/preferences');
    var selects = page.doc.querySelectorAll('select');
    for (var i = 0; i < selects.length; i++) {
      var select = selects[i];
      if (!/date/i.test((select.name || '') + ' ' + (select.id || ''))) continue;
      var option = select.querySelector('option[selected]');
      var order = option && (dateOrderFromFormat(option.value) || dateOrderFromFormat(option.textContent));
      if (order) return order;
    }
  } catch (e) {
    console.warn('[mygcflow-logs] Préférences illisibles (' + e.message + ') : ordre des dates déduit des données.');
  }
  return null;
}

async function processCache(state, ref, ownOnly) {
  var page = await fetchHtml(ref.url);
  var info = parseCachePage(page.doc, page.html, page.url);
  if (!info.gc_code) throw new Error('code GC introuvable sur la page');
  if (!info.token) throw new Error('jeton du carnet introuvable sur la page');
  var book = await fetchLogbook(info.token, ownOnly);
  var others = 0;
  for (var i = 0; i < book.entries.length; i++) {
    var log = normalizeLogbookEntry(book.entries[i], info.gc_code);
    var mine = sameName(log.author.name, state.me.name);
    if (mine && state.me.id === null && log.author.id !== null) state.me.id = log.author.id;
    if (ownOnly && !mine) {
      others++;
      continue;
    }
    if (log.log_id !== null) state.logs.set(log.log_id, log);
  }
  if (ownOnly && others) {
    console.warn('[mygcflow-logs] ' + info.gc_code + ' : le carnet « mes logs » contenait ' + others +
      ' log(s) d\'autres joueurs, écartés.');
  }
  delete info.token;
  state.caches.set(info.gc_code, info);
  return { code: info.gc_code, count: book.entries.length - others, truncated: book.truncated };
}

// ---------------------------------------------------------------------
// Collecte pilotée — note(étape, a, b, c) suit l'avancement pour le
// bandeau de la page ; la console garde le détail.
// ---------------------------------------------------------------------

// Clé de file (code GC ou guid) retrouvée depuis l'URL enregistrée dans
// le plan de reprise.
function keyOfUrl(url) {
  var m = /\/geocache\/(GC[0-9A-Z]+)/i.exec(url || '');
  if (m) return m[1].toUpperCase();
  var g = /guid=([0-9a-f-]+)/i.exec(url || '');
  return g ? g[1].toLowerCase() : String(url || '');
}

// Restaure un plan sauvegardé (state.resume = objet du localStorage) :
// file, avancement, jeux de codes et échecs — les listes ne sont pas
// relues, la collecte reprend à l'indice conservé. Renvoie le couple
// [file, indice de départ] ; sans reprise, [file ordinaire, 0].
function resumeEntries(state) {
  var saved = state.resume;
  if (!saved || !sameName(saved.me && saved.me.name, state.me.name)) {
    // Autre compte connecté : le plan et son ordre des dates ne valent
    // que pour celui qui l'a produit.
    state.resume = null;
    state.order = null;
    return [null, 0];
  }
  if (state.me.id === null && saved.me && saved.me.id !== undefined) {
    state.me.id = saved.me.id;
  }
  state.since = saved.since || null;
  state.dnf.listingComplete = !!saved.dnfComplete;
  var failedD = {};
  var failedO = {};
  ((saved.failed && saved.failed.d) || []).forEach(function (k) { failedD[k] = true; });
  ((saved.failed && saved.failed.o) || []).forEach(function (k) { failedO[k] = true; });
  var entries = saved.queue.map(function (q, idx) {
    var url = q.u;
    var ownOnly = !!q.o;
    var key = keyOfUrl(url);
    var isCode = /^GC[0-9A-Z]+$/i.test(key);
    if (ownOnly) {
      if (isCode) state.dnf.codes.add(key);
      if (failedD[key]) state.dnf.failed.push({ ref: key, error: 'interrompu' });
    } else {
      if (isCode) state.owned.codes.add(key);
      if (failedO[key]) state.owned.failed.push({ ref: key, error: 'interrompu' });
      else if (idx < saved.done && isCode) state.owned.full.add(key);
    }
    return [key, { url: url, ownOnly: ownOnly }];
  });
  ((saved.read) || []).forEach(function (c) { state.read.add(c); });
  console.log('[mygcflow-logs] Reprise : ' + (entries.length - saved.done) +
    ' cache(s) restante(s) sur ' + entries.length + '.');
  return [entries, saved.done];
}

async function mygcflowCollectGcLogs(state, note) {
  state.me.name = detectUsername();
  if (!state.me.name) {
    throw new Error('pseudo introuvable sur la page');
  }
  console.log('[mygcflow-logs] Compte : ' + state.me.name);
  note('account', state.me.name, 0, 0);

  var callPersist = async function (i) {
    if (!state.persist) return;
    try {
      await state.persist(i);
    } catch (e) {
      console.warn('[mygcflow-logs] Progression non enregistrée : ' + e.message);
    }
  };

  var resumed = resumeEntries(state);
  var entries = resumed[0];
  var start = resumed[1];
  state.prefOrder = (state.resume ? state.order : null) || await detectPreferredOrder();

  if (entries === null) {
    var todo = new Map();
    var addRefs = function (refs, ownOnly) {
      refs.codes.forEach(function (code) {
        var prev = todo.get(code);
        todo.set(code, { url: '/geocache/' + code, ownOnly: prev ? prev.ownOnly && ownOnly : ownOnly });
      });
      refs.guids.forEach(function (guid) {
        if (!todo.has(guid)) todo.set(guid, { url: '/seek/cache_details.aspx?guid=' + guid, ownOnly: ownOnly });
      });
    };

    // « Vos journaux » : collecte complète sur vos DNF, ou fenêtre depuis
    // le dernier export — alors sur TOUS vos types de logs (une trouvaille
    // récente sur une vieille cache en DNF doit la faire relire aussi).
    var journalUrl = state.since
      ? '/my/logs.aspx?s=1'
      : '/my/logs.aspx?s=1&lt=' + DNF_TYPE_ID;
    var dnf = await collectJournal(journalUrl, state.since, state.prefOrder);
    state.dnf.listingComplete = dnf.complete;
    dnf.codes.forEach(function (c) { state.dnf.codes.add(c); });
    console.log('[mygcflow-logs] ' + (state.since ? 'Logs à vous depuis le ' + state.since : 'DNF') +
      ' : ' + dnf.codes.size + ' cache(s)' +
      (dnf.guids.size ? ' + ' + dnf.guids.size + ' lien(s) ancien(s)' : ''));
    note('dnf', dnf.codes.size, 0, 0);
    addRefs({ codes: Array.from(dnf.codes), guids: Array.from(dnf.guids) }, true);

    var owned = new Set();
    var listed = 0;
    try {
      var list = await collectListing('/my/owned.aspx');
      listed = list.codes.size;
      list.codes.forEach(function (c) { owned.add(c); });
    } catch (e) {
      console.warn('[mygcflow-logs] Page « vos caches » illisible (' + e.message + ').');
    }
    if (!listed) {
      console.warn('[mygcflow-logs] Aucune cache trouvée sur « vos caches » : repli sur vos logs de poseur.');
      for (var t = 0; t < OWNER_LOG_TYPES.length; t++) {
        var ownerList = await collectListing('/my/logs.aspx?s=1&lt=' + OWNER_LOG_TYPES[t]);
        ownerList.codes.forEach(function (c) { owned.add(c); });
      }
    }
    owned.forEach(function (c) { state.owned.codes.add(c); });
    console.log('[mygcflow-logs] Vos caches : ' + owned.size);
    note('owned', owned.size, 0, 0);
    addRefs({ codes: Array.from(owned), guids: [] }, false);

    entries = Array.from(todo.entries());
    var minutes = Math.ceil(entries.length * 2 * LOGS_DELAY_MS / 60000);
    console.log('[mygcflow-logs] ' + entries.length + ' cache(s) à lire — au moins ' + minutes + ' min.');
    note('plan', entries.length, minutes, 0);
  }
  state.queueSnapshot = entries.map(function (entry) {
    return { u: entry[1].url, o: entry[1].ownOnly ? 1 : 0 };
  });
  await callPersist(start);

  var consecutiveFailures = 0;
  for (var i = start; i < entries.length; i++) {
    var key = entries[i][0];
    var ref = entries[i][1];
    try {
      var done = await processCache(state, ref, ref.ownOnly);
      consecutiveFailures = 0;
      state.read.add(done.code);
      if (!ref.ownOnly && !done.truncated) state.owned.full.add(done.code);
      console.log('[mygcflow-logs] [' + (i + 1) + '/' + entries.length + '] ' + done.code + ' — ' +
        done.count + ' log(s)' + (done.truncated ? ' (tronqué)' : ''));
      note('cache', i + 1, entries.length, done.code);
    } catch (e) {
      consecutiveFailures++;
      (ref.ownOnly ? state.dnf.failed : state.owned.failed).push({ ref: key, error: e.message });
      console.warn('[mygcflow-logs] [' + (i + 1) + '/' + entries.length + '] ' + key + ' : ' + e.message);
      if (/session expirée/.test(e.message) || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[mygcflow-logs] Arrêt : trop d\'échecs consécutifs. Export de ce qui a été lu.');
        state.limited = true;
        note('stopped', i, entries.length, 0);
        break;
      }
    }
    if ((i + 1) % CHECKPOINT_EVERY === 0) await callPersist(i + 1);
  }
  await callPersist(entries.length);
  if (state.dnf.failed.length || state.owned.failed.length) {
    console.table(state.dnf.failed.concat(state.owned.failed));
  }
}

// Ordre des dates : préférence du compte si elle a été lue, sinon déduit
// des échantillons. order null = ambiguïté, l'appelant propose les
// candidats (mygcflowLogsFinish côté favori).
function mygcflowGcLogsOrder(state, forcedOrder) {
  if (forcedOrder && !/^(DMY|MDY|YMD)$/.test(forcedOrder)) {
    return { order: null, candidates: [], samples: [] };
  }
  var order = forcedOrder || state.order || state.prefOrder;
  if (order) {
    return { order: order, candidates: [], samples: [] };
  }
  var samples = Array.from(state.logs.values(), function (l) { return l.date_text; })
    .concat(Array.from(state.caches.values(), function (c) { return c.placed_text; }));
  var detected = detectDateOrder(samples);
  return {
    order: detected.order,
    candidates: detected.candidates,
    samples: samples.filter(Boolean).slice(0, 5)
  };
}

// Assemble le fichier final ; rapport détaillé en console.
function mygcflowGcLogsFinish(state, order) {
  var result = buildPayload(state, order);
  var payload = result.payload;
  var mine = payload.logs.filter(function (l) { return l.author.id !== null && l.author.id === state.me.id; }).length;
  var byType = {};
  payload.logs.forEach(function (l) {
    var key = l.type_id + ' ' + (l.type_label || '');
    byType[key] = (byType[key] || 0) + 1;
  });
  console.log('[mygcflow-logs] Ordre des dates : ' + order + ' ; compte : ' + state.me.name +
    ' (id ' + state.me.id + ')');
  console.table(byType);
  var favorites = payload.logs.filter(function (l) { return l.favorite === true; }).length;
  console.log('[mygcflow-logs] ' + payload.logs.length + ' logs (' + mine + ' à vous, ' +
    favorites + ' avec point favori), ' +
    payload.caches.length + ' caches (' + payload.caches.filter(function (c) { return c.latitude === null; }).length +
    ' sans coordonnées), ' + result.rejected.length + ' logs écartés (date ou identité illisible).');
  if (result.rejected.length) console.table(result.rejected.slice(0, 20));
  if (!payload.coverage.length) {
    console.warn('[mygcflow-logs] Export partiel : aucun périmètre déclaré complet ' +
      '(l\'import ne pourra qu\'ajouter et mettre à jour, jamais retirer).');
  }
  return result;
}
