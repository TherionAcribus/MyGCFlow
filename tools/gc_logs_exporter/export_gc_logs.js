// Exporteur de logs geocaching.com → fichier `mygcflow-logs` v1
// (contrat décrit dans docs/logs-geocaching.md du dépôt MyGCFlow).
//
// Outil personnel, indépendant de MyGCFlow : l'application ne le livre pas et
// n'en dépend pas. Il lit, avec votre propre session, les pages que vous
// consulteriez à la main. Les conditions d'utilisation de geocaching.com
// interdisent la collecte automatisée sans autorisation écrite : à utiliser
// en connaissance de cause, pour votre compte, à un rythme modéré
// (CONFIG.DELAY_MS).
//
// Ce qu'il collecte :
//   - vos DNF : la liste « Vos journaux » filtrée sur Didn't find it, puis,
//     pour chaque cache concernée, VOS logs de son carnet (DNF, trouvaille
//     éventuelle, notes) et sa fiche (coordonnées, type, D/T, état…) ;
//   - vos caches : la liste de vos caches, puis pour chacune TOUS les logs du
//     carnet (les vôtres de poseur et ceux des autres, avec le point favori
//     éventuel) et sa fiche.
// Le texte des logs, l'e-mail et l'avatar des auteurs ne sont jamais repris.
//
// Usage :
//   1. Se connecter sur https://www.geocaching.com (n'importe quelle page).
//   2. F12 → onglet Console. Chrome demande, la première fois, de taper
//      « allow pasting » avant d'accepter un collage.
//   3. Coller ce fichier en entier, Entrée. La progression s'affiche ; le
//      fichier mygcflow-logs-AAAA-MM-JJ.json se télécharge à la fin.
// Premier essai conseillé : CONFIG.LIMIT_CACHES = 3, pour vérifier que tout
// est lu correctement avant un export complet (qui peut durer longtemps :
// au moins deux requêtes par cache, espacées de DELAY_MS).
//
// Si l'ordre des dates ne peut pas être déterminé (préférence de format de
// date du compte illisible et dates toutes ambiguës), rien n'est perdu : la
// console indique d'appeler mygcflowLogsFinish('DMY') (ou 'MDY', 'YMD').

(function (root) {
  'use strict';

  const CONFIG = {
    // Pseudo du compte ; vide = détection automatique sur la page.
    USERNAME: '',
    // Ordre des dates affichées par le site (selon vos préférences) :
    // 'auto', 'DMY' (20/08/2011), 'MDY' (08/20/2011) ou 'YMD' (2011-08-20).
    DATE_ORDER: 'auto',
    COLLECT_DNF: true,
    COLLECT_OWNED: true,
    // Codes GC de vos caches que la détection n'aurait pas trouvés.
    EXTRA_OWNED_CODES: [],
    // 0 = toutes les caches ; N = s'arrêter après N caches (essai).
    LIMIT_CACHES: 0,
    // 0 = tout le carnet ; N = au plus N logs par cache (export alors partiel).
    MAX_LOGS_PER_CACHE: 0,
    // Pause minimale entre deux requêtes, en millisecondes.
    DELAY_MS: 800
  };

  const VERSION = '1.1.0';
  const FORMAT = 'mygcflow-logs';
  const SCHEMA_VERSION = 1;
  const LOGBOOK_PAGE_SIZE = 100;
  const DNF_TYPE_ID = 3;
  // Types que seul le propriétaire (ou un relecteur) publie : leurs listes
  // servent à retrouver vos caches si la page « vos caches » ne répond pas.
  const OWNER_LOG_TYPES = [46, 47, 22, 23];

  // ---------------------------------------------------------------------
  // Fonctions pures (testées par export_gc_logs.test.mjs)
  // ---------------------------------------------------------------------

  // Libellés <groundspeak:type> des GPX : ceux de la base MyGCFlow.
  const CACHE_TYPES = {
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

  const CONTAINERS = {
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
  const LOG_TYPE_ALIASES = { 1: 12, 6: 5, 68: 18, 1003: 24 };

  function toInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
  }

  function logTypeIdFromImage(image) {
    const m = /(\d+)\.(?:png|gif|svg)\b/i.exec(String(image || ''));
    if (!m) return null;
    const id = Number(m[1]);
    return LOG_TYPE_ALIASES[id] || id;
  }

  const CODE_PATTERNS = [
    /\/geocache\/(GC[0-9A-Z]+)/i,
    /coord\.info\/(GC[0-9A-Z]+)/i,
    /[?&]wp=(GC[0-9A-Z]+)/i
  ];
  const GUID_PATTERN = /cache_details\.aspx\?guid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  // Codes GC (et GUID de caches, liens anciens) d'une liste de liens.
  function refsFromHrefs(hrefs) {
    const codes = new Set();
    const guids = new Set();
    for (const href of hrefs) {
      if (!href) continue;
      let found = false;
      for (const pattern of CODE_PATTERNS) {
        const m = pattern.exec(href);
        if (m) {
          codes.add(m[1].toUpperCase());
          found = true;
          break;
        }
      }
      if (!found) {
        const g = GUID_PATTERN.exec(href);
        if (g) guids.add(g[1].toLowerCase());
      }
    }
    return { codes: Array.from(codes), guids: Array.from(guids) };
  }

  // « N 49° 16.032 E 006° 15.586 » → degrés décimaux.
  function parseDdm(text) {
    const m = /([NS])\s*(\d{1,2})\s*°\s*(\d{1,2}(?:[.,]\d+)?)\s*'?\s*([EWO])\s*(\d{1,3})\s*°\s*(\d{1,2}(?:[.,]\d+)?)/i
      .exec(String(text || ''));
    if (!m) return null;
    const lat = (Number(m[2]) + Number(m[3].replace(',', '.')) / 60) * (/s/i.test(m[1]) ? -1 : 1);
    const lon = (Number(m[5]) + Number(m[6].replace(',', '.')) / 60) * (/[wo]/i.test(m[4]) ? -1 : 1);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { latitude: round6(lat), longitude: round6(lon) };
  }

  function round6(x) {
    return Math.round(x * 1e6) / 1e6;
  }

  const MONTH_PATTERNS = [
    [/^jan/, 1], [/^(feb|fev)/, 2], [/^mar/, 3], [/^(apr|avr)/, 4],
    [/^(may|mai)/, 5], [/^(jun|juin)/, 6], [/^(jul|juil)/, 7], [/^(aug|aou)/, 8],
    [/^sep/, 9], [/^(oct|okt)/, 10], [/^nov/, 11], [/^(dec|dez)/, 12]
  ];

  function monthFromName(word) {
    const w = String(word).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.$/, '');
    if (w.length < 3) return null;
    for (const [pattern, month] of MONTH_PATTERNS) {
      if (pattern.test(w)) return month;
    }
    return null;
  }

  function isoDate(year, month, day) {
    const maxYear = new Date().getUTCFullYear() + 1;
    if (!(year >= 2000 && year <= maxYear) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
      return null;
    }
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }

  function fullYear(text) {
    const n = Number(text);
    return text.length <= 2 ? 2000 + n : n;
  }

  // Date affichée par le site → 'AAAA-MM-JJ', ou null si illisible. `order`
  // ne sert qu'aux dates entièrement numériques.
  function parseDateText(text, order) {
    if (!text) return null;
    const s = String(text).trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(s);
    if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const tokens = s.match(/\d+|[A-Za-zÀ-ÿ]+\.?/g) || [];
    const nums = [];
    let month = null;
    for (const token of tokens) {
      if (/^\d+$/.test(token)) {
        nums.push(token);
        continue;
      }
      const mo = monthFromName(token);
      if (mo !== null) {
        if (month !== null) return null;
        month = mo;
      }
    }
    if (month !== null) {
      if (nums.length !== 2) return null;
      const [a, b] = nums;
      if (a.length === 4) return isoDate(Number(a), month, Number(b));
      return isoDate(fullYear(b), month, Number(a));
    }
    if (nums.length !== 3) return null;
    const [a, b, c] = nums;
    if (a.length === 4 || order === 'YMD') return isoDate(fullYear(a), Number(b), Number(c));
    if (order === 'DMY') return isoDate(fullYear(c), Number(b), Number(a));
    if (order === 'MDY') return isoDate(fullYear(c), Number(a), Number(b));
    return null;
  }

  // Ordre compatible avec TOUTES les dates numériques relevées. null si
  // plusieurs ordres restent possibles et donnent des dates différentes.
  function detectDateOrder(samples) {
    const numeric = samples.filter(s => s && !/[A-Za-zÀ-ÿ]/.test(s));
    if (!numeric.length) return { order: 'DMY', candidates: ['DMY', 'MDY', 'YMD'] };
    const candidates = ['DMY', 'MDY', 'YMD'].filter(order =>
      numeric.every(s => parseDateText(s, order) !== null));
    if (candidates.length === 1) return { order: candidates[0], candidates };
    if (candidates.length > 1) {
      const same = numeric.every(s => {
        const first = parseDateText(s, candidates[0]);
        return candidates.every(o => parseDateText(s, o) === first);
      });
      if (same) return { order: candidates[0], candidates };
    }
    return { order: null, candidates };
  }

  // 'dd/MM/yyyy' (préférence du compte) → 'DMY'.
  function dateOrderFromFormat(format) {
    const f = String(format || '');
    const pos = { D: f.indexOf('d'), M: f.indexOf('M'), Y: f.toLowerCase().indexOf('y') };
    if (pos.D < 0 || pos.M < 0 || pos.Y < 0) return null;
    return Object.keys(pos).sort((a, b) => pos[a] - pos[b]).join('');
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
    const rawType = toInt(entry.LogTypeID);
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
    const rejected = [];
    const logs = [];
    for (const raw of state.logs.values()) {
      const date = parseDateText(raw.date_text, order);
      if (raw.log_id === null || raw.type_id === null || !date) {
        rejected.push({ gc_code: raw.gc_code, log_id: raw.log_id, date_text: raw.date_text, type_id: raw.type_id });
        continue;
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
    }
    logs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.log_id - b.log_id));

    const caches = [];
    for (const info of state.caches.values()) {
      const owned = state.owned.codes.has(info.gc_code);
      const cache = {
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
    }
    caches.sort((a, b) => (a.gc_code < b.gc_code ? -1 : 1));

    const coverage = [];
    const dnfAllRead = Array.from(state.dnf.codes).every(code => state.caches.has(code));
    if (state.dnf.listingComplete && !state.limited && !state.dnf.failed.length && dnfAllRead &&
        state.me.id !== null) {
      coverage.push({ kind: 'author', author_id: state.me.id, type_ids: [DNF_TYPE_ID], complete: true });
    }
    const fullOwned = Array.from(state.owned.full).sort();
    if (fullOwned.length) {
      coverage.push({ kind: 'caches', gc_codes: fullOwned, complete: true });
    }

    return {
      payload: {
        format: FORMAT,
        schema_version: SCHEMA_VERSION,
        exported_at: new Date().toISOString(),
        generator: { name: 'mygcflow-gc-logs-exporter', version: VERSION },
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
      dateSamples: []
    };
  }

  // ---------------------------------------------------------------------
  // Lecture des pages (navigateur)
  // ---------------------------------------------------------------------

  function textOf(doc, selector) {
    const el = doc.querySelector(selector);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function starValue(doc, selectors) {
    for (const selector of selectors) {
      const img = doc.querySelector(selector);
      const m = img && /^(\d(?:[.,]5)?)/.exec(img.getAttribute('alt') || '');
      if (m) return Number(m[1].replace(',', '.'));
    }
    return null;
  }

  function parseCachePage(doc, html, url) {
    const title = (doc.title || '').trim();
    const codeMatch = /\/geocache\/(GC[0-9A-Z]+)/i.exec(url || '') || /^(GC[0-9A-Z]+)\b/i.exec(title);
    const info = {
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

    const token = /userToken\s*=\s*'([^']+)'/.exec(html);
    info.token = token ? token[1] : null;

    // Coordonnées : mapLatLng (décimal) ; si vous avez corrigé celles d'une
    // mystery, la page affiche les vôtres et garde les publiées à part.
    const map = /mapLatLng\s*=\s*(\{[\s\S]*?\})\s*;/.exec(html);
    const mapText = map ? map[1] : '';
    const ll = /"lat"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"lng"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(mapText);
    const shown = ll ? { latitude: round6(Number(ll[1])), longitude: round6(Number(ll[2])) }
      : parseDdm(textOf(doc, '#uxLatLon'));
    const userDefined = /"isUserDefined"\s*:\s*true/.test(mapText);
    const original = /"oldLatLngDisplay"\s*:\s*"([^"]+)"/.exec(mapText);
    if (userDefined && original && parseDdm(original[1])) {
      const posted = parseDdm(original[1]);
      info.latitude = posted.latitude;
      info.longitude = posted.longitude;
      info.corrected = shown;
    } else if (shown) {
      info.latitude = shown.latitude;
      info.longitude = shown.longitude;
    }

    let typeId = null;
    const use = doc.querySelector('svg.cache-icon use');
    const href = use && (use.getAttribute('xlink:href') || use.getAttribute('href'));
    const iconMatch = href && /(\d+)/.exec(href.split('#').pop());
    if (iconMatch) typeId = Number(iconMatch[1]);
    if (typeId === null || !CACHE_TYPES[typeId]) {
      const t = /"type"\s*:\s*(\d+)/.exec(mapText);
      if (t) typeId = Number(t[1]);
    }
    info.type = CACHE_TYPES[typeId] || null;

    info.difficulty = starValue(doc, ['#ctl00_ContentBody_uxLegendScale img', '.CacheStarLabels img:nth-of-type(1)']);
    info.terrain = starValue(doc, ['#ctl00_ContentBody_Localize12 img', '.CacheStarLabels img:nth-of-type(2)']);

    const sizeImg = doc.querySelector('.CacheSize img');
    const sizeMatch = sizeImg && /\/([a-z_]+)\.(?:gif|png|svg)/i.exec(sizeImg.getAttribute('src') || '');
    info.container = sizeMatch ? (CONTAINERS[sizeMatch[1].toLowerCase()] || null) : null;

    const hidden = textOf(doc, '#ctl00_ContentBody_mcd2');
    info.placed_text = hidden ? hidden.split(':').pop().trim() : null;

    if (doc.getElementById('ctl00_ContentBody_archivedMessage')) info.status = 'archived';
    else if (doc.getElementById('ctl00_ContentBody_disabledMessage')) info.status = 'disabled';
    else if (doc.getElementById('unpublishedMessage') || doc.getElementById('unpublishedReviewerNoteMessage')) {
      info.status = 'unknown';
    }

    const fav = doc.querySelector('.favorite-value');
    info.favorite_points = fav ? toInt(fav.textContent.trim()) : null;
    return info;
  }

  // ---------------------------------------------------------------------
  // Réseau (navigateur)
  // ---------------------------------------------------------------------

  let lastRequestAt = 0;

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function politeFetch(url, init) {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + CONFIG.DELAY_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      const res = await fetch(url, Object.assign({ credentials: 'include' }, init || {}));
      if (/\/account\/signin/i.test(res.url)) {
        throw new Error('session expirée : reconnectez-vous puis relancez');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        console.warn('[mygcflow-logs] HTTP ' + res.status + ', nouvel essai dans ' +
          Math.round(CONFIG.DELAY_MS * 5 * (attempt + 1) / 1000) + ' s');
        await sleep(CONFIG.DELAY_MS * 5 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status + ' sur ' + url);
      return res;
    }
  }

  async function fetchHtml(url, init) {
    const res = await politeFetch(url, init);
    const html = await res.text();
    return { html: html, doc: new DOMParser().parseFromString(html, 'text/html'), url: res.url };
  }

  // Liste paginée par postback ASP.NET (« Vos journaux », « Vos caches »).
  async function collectListing(url) {
    let page = await fetchHtml(url);
    const codes = new Set();
    const guids = new Set();
    for (let n = 0; n < 1000; n++) {
      const before = codes.size + guids.size;
      const hrefs = Array.from(page.doc.querySelectorAll('table a[href]'), a => a.getAttribute('href'));
      const refs = refsFromHrefs(hrefs);
      refs.codes.forEach(c => codes.add(c));
      refs.guids.forEach(g => guids.add(g));
      const next = page.doc.querySelector('a[href*="__doPostBack(\'ctl00$ContentBody$pgrTop$ctl08\'"]');
      if (!next || codes.size + guids.size === before) {
        return { codes: codes, guids: guids, complete: true };
      }
      const form = page.doc.querySelector('form');
      if (!form) break;
      const body = new URLSearchParams();
      form.querySelectorAll('input[type=hidden][name]').forEach(input => body.append(input.name, input.value || ''));
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

  let loggedLogbookFields = false;

  async function fetchLogbook(token, ownOnly) {
    const entries = [];
    let truncated = false;
    for (let idx = 1; ; idx++) {
      const params = new URLSearchParams({
        tkn: token, idx: String(idx), num: String(LOGBOOK_PAGE_SIZE),
        sp: String(ownOnly), sf: 'false', decrypt: 'false'
      });
      const res = await politeFetch('/seek/geocache.logbook?' + params.toString());
      let json;
      try {
        json = await res.json();
      } catch (e) {
        throw new Error('carnet : réponse non JSON (session expirée ?)');
      }
      if (json.status !== 'success') throw new Error('carnet refusé : ' + (json.msg || 'raison inconnue'));
      const data = Array.isArray(json.data) ? json.data : [];
      if (data.length && !loggedLogbookFields) {
        loggedLogbookFields = true;
        console.log('[mygcflow-logs] Champs d\'un log du carnet : ' + Object.keys(data[0]).join(', '));
      }
      entries.push.apply(entries, data);
      const totalPages = json.pageInfo && toInt(json.pageInfo.totalPages);
      if (!data.length || (totalPages !== null ? idx >= totalPages : data.length < LOGBOOK_PAGE_SIZE)) break;
      if (CONFIG.MAX_LOGS_PER_CACHE && entries.length >= CONFIG.MAX_LOGS_PER_CACHE) {
        truncated = true;
        break;
      }
    }
    return { entries: entries, truncated: truncated };
  }

  function detectUsername() {
    if (CONFIG.USERNAME) return CONFIG.USERNAME;
    const params = root.serverParameters;
    const info = params && params['user:info'];
    if (info && info.username) return info.username;
    for (const script of document.querySelectorAll('script:not([src])')) {
      const m = /"username"\s*:\s*"([^"]+)"/.exec(script.textContent);
      if (m) return m[1];
    }
    return null;
  }

  async function detectPreferredOrder() {
    try {
      const page = await fetchHtml('/account/settings/preferences');
      for (const select of page.doc.querySelectorAll('select')) {
        if (!/date/i.test((select.name || '') + ' ' + (select.id || ''))) continue;
        const option = select.querySelector('option[selected]');
        const order = option && (dateOrderFromFormat(option.value) || dateOrderFromFormat(option.textContent));
        if (order) return order;
      }
    } catch (e) {
      console.warn('[mygcflow-logs] Préférences illisibles (' + e.message + ') : ordre des dates déduit des données.');
    }
    return null;
  }

  async function processCache(state, ref, ownOnly) {
    const page = await fetchHtml(ref.url);
    const info = parseCachePage(page.doc, page.html, page.url);
    if (!info.gc_code) throw new Error('code GC introuvable sur la page');
    if (!info.token) throw new Error('jeton du carnet introuvable sur la page');
    const book = await fetchLogbook(info.token, ownOnly);
    let others = 0;
    for (const entry of book.entries) {
      const log = normalizeLogbookEntry(entry, info.gc_code);
      const mine = sameName(log.author.name, state.me.name);
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

  function downloadJson(name, value) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  }

  function finish(state, forcedOrder) {
    if (forcedOrder && !/^(DMY|MDY|YMD)$/.test(forcedOrder)) {
      console.error('[mygcflow-logs] Ordre attendu : \'DMY\', \'MDY\' ou \'YMD\'.');
      return null;
    }
    let order = forcedOrder || (CONFIG.DATE_ORDER !== 'auto' ? CONFIG.DATE_ORDER : state.prefOrder);
    if (!order) {
      const samples = Array.from(state.logs.values(), l => l.date_text)
        .concat(Array.from(state.caches.values(), c => c.placed_text));
      const detected = detectDateOrder(samples);
      order = detected.order;
      if (!order) {
        console.error('[mygcflow-logs] Ordre des dates indéterminé (possibles : ' +
          (detected.candidates.join(', ') || 'aucun') + '). Exemples : ' +
          samples.filter(Boolean).slice(0, 5).join(' | ') +
          '. Appelez mygcflowLogsFinish(\'DMY\') ou mygcflowLogsFinish(\'MDY\') — rien n\'est à recollecter.');
        return null;
      }
    }
    const result = buildPayload(state, order);
    const payload = result.payload;
    const mine = payload.logs.filter(l => l.author.id !== null && l.author.id === state.me.id).length;
    const byType = {};
    payload.logs.forEach(l => {
      const key = l.type_id + ' ' + (l.type_label || '');
      byType[key] = (byType[key] || 0) + 1;
    });
    console.log('[mygcflow-logs] Ordre des dates : ' + order + ' ; compte : ' + state.me.name +
      ' (id ' + state.me.id + ')');
    console.table(byType);
    const favorites = payload.logs.filter(l => l.favorite === true).length;
    console.log('[mygcflow-logs] ' + payload.logs.length + ' logs (' + mine + ' à vous, ' +
      favorites + ' avec point favori), ' +
      payload.caches.length + ' caches (' + payload.caches.filter(c => c.latitude === null).length +
      ' sans coordonnées), ' + result.rejected.length + ' logs écartés (date ou identité illisible).');
    if (result.rejected.length) console.table(result.rejected.slice(0, 20));
    if (!payload.coverage.length) {
      console.warn('[mygcflow-logs] Export partiel : aucun périmètre déclaré complet ' +
        '(l\'import ne pourra qu\'ajouter et mettre à jour, jamais retirer).');
    }
    root.mygcflowLogsExport = payload;
    downloadJson('mygcflow-logs-' + new Date().toISOString().slice(0, 10) + '.json', payload);
    console.log('%c[mygcflow-logs] Fichier téléchargé.', 'color: green; font-weight: bold');
    return payload;
  }

  async function main() {
    if (!/(^|\.)geocaching\.com$/i.test(location.hostname)) {
      throw new Error('à lancer depuis une page de www.geocaching.com');
    }
    const state = newState();
    root.mygcflowLogsState = state;
    root.mygcflowLogsFinish = order => finish(state, order);

    state.me.name = detectUsername();
    if (!state.me.name) {
      throw new Error('pseudo introuvable : renseignez CONFIG.USERNAME en tête du script');
    }
    console.log('[mygcflow-logs] Compte : ' + state.me.name);
    if (CONFIG.DATE_ORDER === 'auto') state.prefOrder = await detectPreferredOrder();

    // Listes : vos DNF, vos caches.
    const todo = new Map();
    const addRefs = (refs, ownOnly) => {
      refs.codes.forEach(code => {
        const prev = todo.get(code);
        todo.set(code, { url: '/geocache/' + code, ownOnly: prev ? prev.ownOnly && ownOnly : ownOnly });
      });
      refs.guids.forEach(guid => {
        if (!todo.has(guid)) todo.set(guid, { url: '/seek/cache_details.aspx?guid=' + guid, ownOnly: ownOnly });
      });
    };

    if (CONFIG.COLLECT_DNF) {
      const dnf = await collectListing('/my/logs.aspx?s=1&lt=' + DNF_TYPE_ID);
      state.dnf.listingComplete = dnf.complete;
      dnf.codes.forEach(c => state.dnf.codes.add(c));
      console.log('[mygcflow-logs] DNF : ' + dnf.codes.size + ' cache(s)' +
        (dnf.guids.size ? ' + ' + dnf.guids.size + ' lien(s) ancien(s)' : ''));
      addRefs({ codes: Array.from(dnf.codes), guids: Array.from(dnf.guids) }, true);
    }

    if (CONFIG.COLLECT_OWNED) {
      const owned = new Set(CONFIG.EXTRA_OWNED_CODES.map(c => String(c).trim().toUpperCase()).filter(Boolean));
      let listed = 0;
      try {
        const list = await collectListing('/my/owned.aspx');
        listed = list.codes.size;
        list.codes.forEach(c => owned.add(c));
      } catch (e) {
        console.warn('[mygcflow-logs] Page « vos caches » illisible (' + e.message + ').');
      }
      if (!listed) {
        console.warn('[mygcflow-logs] Aucune cache trouvée sur « vos caches » : repli sur vos logs de poseur.');
        for (const type of OWNER_LOG_TYPES) {
          const list = await collectListing('/my/logs.aspx?s=1&lt=' + type);
          list.codes.forEach(c => owned.add(c));
        }
      }
      owned.forEach(c => state.owned.codes.add(c));
      console.log('[mygcflow-logs] Vos caches : ' + owned.size);
      addRefs({ codes: Array.from(owned), guids: [] }, false);
    }

    let entries = Array.from(todo.entries());
    if (CONFIG.LIMIT_CACHES && entries.length > CONFIG.LIMIT_CACHES) {
      entries = entries.slice(0, CONFIG.LIMIT_CACHES);
      state.limited = true;
      console.warn('[mygcflow-logs] Essai limité à ' + CONFIG.LIMIT_CACHES + ' cache(s) : export partiel.');
    }
    const minutes = Math.ceil(entries.length * 2 * CONFIG.DELAY_MS / 60000);
    console.log('[mygcflow-logs] ' + entries.length + ' cache(s) à lire — au moins ' + minutes + ' min.');

    let consecutiveFailures = 0;
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i][0];
      const ref = entries[i][1];
      try {
        const done = await processCache(state, ref, ref.ownOnly);
        consecutiveFailures = 0;
        if (!ref.ownOnly && !done.truncated) state.owned.full.add(done.code);
        console.log('[mygcflow-logs] [' + (i + 1) + '/' + entries.length + '] ' + done.code + ' — ' +
          done.count + ' log(s)' + (done.truncated ? ' (tronqué)' : ''));
      } catch (e) {
        consecutiveFailures++;
        (ref.ownOnly ? state.dnf.failed : state.owned.failed).push({ ref: key, error: e.message });
        console.warn('[mygcflow-logs] [' + (i + 1) + '/' + entries.length + '] ' + key + ' : ' + e.message);
        if (/session expirée/.test(e.message) || consecutiveFailures >= 5) {
          console.error('[mygcflow-logs] Arrêt : trop d\'échecs consécutifs. Export de ce qui a été lu.');
          state.limited = true;
          break;
        }
      }
    }
    if (state.dnf.failed.length || state.owned.failed.length) {
      console.table(state.dnf.failed.concat(state.owned.failed));
    }
    finish(state);
  }

  const helpers = {
    CONFIG, CACHE_TYPES, CONTAINERS, toInt, logTypeIdFromImage, refsFromHrefs, parseDdm,
    monthFromName, parseDateText, detectDateOrder, dateOrderFromFormat, normalizeLogbookEntry,
    buildPayload, newState, parseCachePage
  };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = helpers;
  } else if (root.__MYGCFLOW_LOGS_TEST__) {
    root.mygcflowLogsHelpers = helpers;
  } else {
    main().catch(err => console.error('[mygcflow-logs] Échec : ' + err.message));
  }
})(typeof window !== 'undefined' ? window : globalThis);
