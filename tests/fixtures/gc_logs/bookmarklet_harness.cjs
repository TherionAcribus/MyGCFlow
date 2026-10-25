// Exécute le favori « Envoyer vers MyGCFlow » (logs) généré par
// l'application sur un faux geocaching.com, et imprime ce qu'il a fait.
//
//   node bookmarklet_harness.cjs <fichier du lien javascript:> <scénario JSON>
//
// Scénario : {
//   username,            // pseudo posé dans window.serverParameters
//   prefOrder,           // 'DMY'|'MDY'|'YMD'|null — <select> des préférences
//   dnfPages,            // pages de « Vos journaux » (DNF) : [{codes, guids, next}]
//   ownedPages,          // pages de « Vos caches » (absent = repli logs poseur)
//   caches,              // {code|guid : {name, token, placed, lat, lng,
//                        //             owner, favs, archived, failStatus}}
//   books,               // {jeton : [[entrée,…],…]} — carnet par page idx
//   finish,              // ordre passé à window.mygcflowLogsFinish après la
//                        // collecte (dates ambiguës)
//   state,               // réponse de /api/logs/receive/state
//                        // ({since, pending, status}) ;
//   confirmPending       // réponse à « collecter quand même ? » (défaut oui)
// }
// `rows` des pages de journal : [{code|guid, date}] — la date pilote
// l'arrêt de la collecte incrémentale.
// Sortie : { said, received, requests, attempts, failedFetches }.
const fs = require('node:fs');
const vm = require('node:vm');

const href = fs.readFileSync(process.argv[2], 'utf-8').trim();
const scenario = JSON.parse(process.argv[3] || '{}');
if (!href.startsWith('javascript:')) {
  throw new Error('lien javascript: attendu');
}

// ---------------------------------------------------------------
// Mini-DOM : juste assez pour les sélecteurs du moteur de collecte
// (tags, #id, .classe, [attr], [attr=v], [attr*=v], :not(), :nth-of-type(),
// combinateur descendant). Aucun HTML réel n'est exigé : le faux site
// sert des pages taillées pour ces sélecteurs.
// ---------------------------------------------------------------

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'path', 'source', 'track', 'use', 'wbr',
]);

function parseHtml(html) {
  const roots = [];
  const all = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const tok = m[0];
    if (tok.startsWith('<!--')) continue;
    if (tok[0] !== '<') {
      if (stack.length) stack[stack.length - 1]._text += tok;
      continue;
    }
    if (tok.startsWith('</')) {
      const tag = tok.slice(2, -1).trim().toLowerCase();
      while (stack.length && stack[stack.length - 1].tag !== tag) stack.pop();
      stack.pop();
      continue;
    }
    const mt = /^<([a-zA-Z0-9:-]+)([\s\S]*?)(\/?)>$/.exec(tok);
    if (!mt) continue;
    const attrs = {};
    const are = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s>]+))?/g;
    let am;
    while ((am = are.exec(mt[2]))) {
      attrs[am[1].toLowerCase()] = am[2] !== undefined ? am[2] : (am[3] !== undefined ? am[3] : am[0].split('=').pop() || '');
    }
    const el = {
      tag: mt[1].toLowerCase(),
      attrs,
      _text: '',
      children: [],
      parent: stack.length ? stack[stack.length - 1] : null,
    };
    if (el.parent) el.parent.children.push(el); else roots.push(el);
    all.push(el);
    if (!mt[3] && !VOID_TAGS.has(el.tag)) stack.push(el);
  }
  function textOf(el) {
    return el._text + el.children.map(textOf).join('');
  }
  all.forEach((el) => {
    Object.defineProperty(el, 'textContent', { get() { return textOf(el); } });
    el.getAttribute = (name) => (name.toLowerCase() in el.attrs ? el.attrs[name.toLowerCase()] : null);
    ['name', 'value', 'id', 'href', 'src'].forEach((prop) => {
      Object.defineProperty(el, prop, { get() { return el.attrs[prop] || ''; } });
    });
    el.querySelector = (sel) => queryIn(el.children, sel)[0] || null;
    el.querySelectorAll = (sel) => queryIn(el.children, sel);
  });
  function descendants(list, out) {
    for (const el of list) { out.push(el); descendants(el.children, out); }
    return out;
  }
  function matchCompound(el, c) {
    let i = 0;
    const tm = /^[a-zA-Z*][\w-]*/.exec(c);
    if (tm) {
      if (tm[0] !== '*' && el.tag !== tm[0].toLowerCase()) return false;
      i = tm[0].length;
    }
    while (i < c.length) {
      const rest = c.slice(i);
      let mm;
      if ((mm = /^#([\w-]+)/.exec(rest))) {
        if (el.attrs.id !== mm[1]) return false;
      } else if ((mm = /^\.([\w-]+)/.exec(rest))) {
        if (!(' ' + (el.attrs.class || '') + ' ').includes(' ' + mm[1] + ' ')) return false;
      } else if ((mm = /^\[([\w:-]+)(?:([*^$|~]?)=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/.exec(rest))) {
        const actual = el.attrs[mm[1].toLowerCase()];
        if (actual === undefined) return false;
        if (mm[2] !== undefined && mm[2] !== '') {
          const val = mm[3] !== undefined ? mm[3] : (mm[4] !== undefined ? mm[4] : mm[5]);
          if (mm[2] === '*' ? !String(actual).includes(val) : String(actual) !== val) return false;
        }
      } else if ((mm = /^:(not|nth-of-type)(?:\(([^)]*)\))?/.exec(rest))) {
        if (mm[1] === 'not') {
          if (matchCompound(el, mm[2])) return false;
        } else {
          const n = Number(mm[2]);
          const sibs = el.parent ? el.parent.children.filter((s) => s.tag === el.tag) : [el];
          if (sibs.indexOf(el) !== n - 1) return false;
        }
      } else {
        return false;
      }
      i += mm[0].length;
    }
    return true;
  }
  function matchSelector(el, sel) {
    const parts = sel.trim().split(/\s+/);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let ancestor = el.parent;
    for (let i = parts.length - 2; i >= 0; i--) {
      let found = null;
      for (let a = ancestor; a; a = a.parent) {
        if (matchCompound(a, parts[i])) { found = a; break; }
      }
      if (!found) return false;
      ancestor = found.parent;
    }
    return true;
  }
  function queryIn(scope, sel) {
    return descendants(scope, []).filter((el) => matchSelector(el, sel));
  }
  return {
    roots,
    all,
    queryIn,
    title: (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html)) || [null, ''])[1],
  };
}

function makeDoc(html) {
  const parsed = parseHtml(html);
  return {
    title: parsed.title,
    querySelector: (sel) => parsed.queryIn(parsed.roots, sel)[0] || null,
    querySelectorAll: (sel) => parsed.queryIn(parsed.roots, sel),
    getElementById: (id) => parsed.all.find((el) => el.attrs.id === id) || null,
  };
}

// ---------------------------------------------------------------
// Pages du faux site
// ---------------------------------------------------------------

function listingHtml(page) {
  // Chaque entrée est une ligne de journal (<tr> date + lien), comme « Vos
  // journaux » — la collecte incrémentale lit la fenêtre dessus. `rows`
  // accepte {code|guid, date} ; `codes`/`guids` restent un raccourci sans
  // date (ligne toujours « récente » pour la fenêtre).
  const rows = (page.rows || []).map((r) => {
    const link = r.code
      ? `<a href="/geocache/${r.code}">${r.code}</a>`
      : `<a href="/seek/cache_details.aspx?guid=${r.guid}">${r.guid}</a>`;
    return `<tr><td>${r.date || ''}</td><td>${link}</td></tr>`;
  });
  (page.codes || []).forEach((c) => rows.push(`<tr><td></td><td><a href="/geocache/${c}">${c}</a></td></tr>`));
  (page.guids || []).forEach((g) => rows.push(`<tr><td></td><td><a href="/seek/cache_details.aspx?guid=${g}">${g}</a></td></tr>`));
  const next = page.next
    ? '<a href="javascript:__doPostBack(\'ctl00$ContentBody$pgrTop$ctl08\',\'\')">2</a>'
    : '';
  return '<form>' +
    '<input type="hidden" name="__VIEWSTATE" value="v">' +
    '<input type="hidden" name="__EVENTTARGET" value="">' +
    `<table>${rows.join('')}${next}</table></form>`;
}

function cachePageHtml(code, info) {
  const title = `<title>${info.title || `${code} - ${info.name || 'cache'}`}</title>`;
  return `${title}<html><body>` +
    `<script>var userToken = '${info.token}'; var mapLatLng = {"lat":${info.lat},"lng":${info.lng},"type":${info.typeId || 2}};</script>` +
    `<span id="ctl00_ContentBody_CacheName">${info.name || code}</span>` +
    `<div id="ctl00_ContentBody_mcd1"><a href="/profile">${info.owner || 'Poseur'}</a></div>` +
    `<div id="ctl00_ContentBody_mcd2">Hidden : ${info.placed || '01/02/2010'}</div>` +
    `<svg class="cache-icon"><use xlink:href="#${info.typeId || 2}"/></svg>` +
    `<span id="ctl00_ContentBody_uxLegendScale"><img alt="${info.difficulty || 2}"/></span>` +
    `<span id="ctl00_ContentBody_Localize12"><img alt="${info.terrain || 1.5}"/></span>` +
    `<div class="CacheSize"><img src="/icons/${info.container || 'micro'}.svg"/></div>` +
    `<span id="uxLatLon"></span>` +
    (info.favs !== undefined && info.favs !== null ? `<span class="favorite-value">${info.favs}</span>` : '') +
    (info.archived ? '<div id="ctl00_ContentBody_archivedMessage"></div>' : '') +
    '</body></html>';
}

function preferencesHtml(order) {
  const formats = { DMY: 'dd/MM/yyyy', MDY: 'MM/dd/yyyy', YMD: 'yyyy-MM-dd' };
  const sel = order
    ? `<select name="dateFormat"><option value="${formats[order]}" selected>${formats[order]}</option></select>`
    : '<select name="other"><option value="x">x</option></select>';
  return `<form>${sel}</form>`;
}

// ---------------------------------------------------------------
// Faux réseau
// ---------------------------------------------------------------

const received = { payload: null };
const requests = [];       // urls demandées (hors /receive)
const attempts = {};       // url -> nombre de requêtes
const said = [];
const listingCursors = {}; // url -> prochaine page à servir

function res(url, status, body) {
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

function serveListing(url, pages) {
  const idx = listingCursors[url] || 0;
  if (idx >= pages.length) {
    // Un postback de trop : rejouer la dernière page, sans lien « suivant »
    // (codes déjà vus ou page vide → fin de liste côté collecteur).
    const last = pages[pages.length - 1] || {};
    return res(url, 200, listingHtml({ ...last, next: false }));
  }
  listingCursors[url] = idx + 1;
  return res(url, 200, listingHtml(pages[idx]));
}

async function fakeFetch(url, options) {
  const target = String(url);
  if (target.includes('/api/logs/receive/state')) {
    const state = scenario.state || {};
    return res(target, state.status || 200, {
      success: !(state.status >= 400),
      message: state.message,
      since: state.since === undefined ? null : state.since,
      pending: state.pending || null,
    });
  }
  if (target.includes('/api/logs/receive')) {
    received.payload = {
      url: target,
      headers: options.headers,
      credentials: options.credentials,
      body: JSON.parse(options.body),
    };
    return res(target, 202, { success: true, message: 'Export reçu' });
  }
  requests.push(target);
  attempts[target] = (attempts[target] || 0) + 1;

  if (/\/my\/logs\.aspx/.test(target)) {
    const lt = /[?&]lt=(\d+)/.exec(target);
    // lt=3 = journal filtré DNF (collecte complète) ; sans lt = journal
    // complet (collecte incrémentale) — même scénario `dnfPages`.
    const pages = (!lt || lt[1] === '3')
      ? (scenario.dnfPages || [])
      : ((scenario.ownerLogPages || {})[lt[1]] || []);
    return serveListing(target, pages);
  }
  if (/\/my\/owned\.aspx/.test(target)) {
    if (!scenario.ownedPages) return res(target, 500, 'ko');
    return serveListing(target, scenario.ownedPages);
  }
  if (/\/account\/settings\/preferences/.test(target)) {
    return res(target, 200, preferencesHtml(scenario.prefOrder || null));
  }
  if (/\/seek\/geocache\.logbook/.test(target)) {
    const tkn = /[?&]tkn=([^&]+)/.exec(target)[1];
    const idx = Number(/[?&]idx=(\d+)/.exec(target)[1]);
    const pages = (scenario.books || {})[tkn] || [];
    return res(target, 200, {
      status: 'success',
      data: pages[idx - 1] || [],
      pageInfo: { totalPages: Math.max(pages.length, idx) },
    });
  }
  const gm = /\/geocache\/(GC[0-9A-Z]+)/i.exec(target);
  const um = /cache_details\.aspx\?guid=([0-9a-f-]+)/i.exec(target);
  if (gm || um) {
    const key = gm ? gm[1].toUpperCase() : um[1].toLowerCase();
    const info = (scenario.caches || {})[key];
    if (!info) return res(target, 404, 'introuvable');
    const fails = info.failStatus && attempts[target] <= (info.failTimes || 99);
    if (fails) return res(target, info.failStatus, 'ko');
    return res(target, 200, cachePageHtml(key, info));
  }
  return res(target, 404, 'inattendu : ' + target);
}

// ---------------------------------------------------------------
// Page hôte
// ---------------------------------------------------------------

const host = parseHtml(scenario.html || '');
// La console du moteur reste lisible, sur stderr : stdout ne porte que le
// résultat JSON.
const out = (...args) => process.stderr.write(args.join(' ') + '\n');
const sandbox = {
  console: { log: out, warn: out, error: out, info: out,
             table: (rows) => out(JSON.stringify(rows)) },
  JSON, Promise, Set, Map, Math, Date, String, Number, Array, Object,
  Error, RegExp, URLSearchParams, Intl,
  // Pauses écourtées : le rythme poli (800 ms) n'a pas à être attendu.
  setTimeout: (fn) => setTimeout(fn, 0),
  clearTimeout,
  location: { hostname: scenario.hostname || 'www.geocaching.com' },
  DOMParser: class {
    parseFromString(html) { return makeDoc(html); }
  },
  document: {
    createElement: () => ({ style: {}, set textContent(text) { said.push(text); } }),
    body: { appendChild() {} },
    querySelector: (sel) => host.queryIn(host.roots, sel)[0] || null,
    querySelectorAll: (sel) => host.queryIn(host.roots, sel),
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  confirm: () => scenario.confirmPending !== false,
  fetch: fakeFetch,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.serverParameters = { 'user:info': { username: scenario.username || 'Testeur' } };

(async () => {
  // Le favori est une expression `(async () => {...})();` : son résultat est
  // la promesse de fin d'exécution.
  const body = href.slice('javascript:'.length).replace(/;\s*$/, '');
  await vm.runInNewContext(body, sandbox);
  // Dates ambiguës : la console de la page expose mygcflowLogsFinish pour
  // finir sans relire — le scénario peut l'appeler.
  if (scenario.finish && typeof sandbox.mygcflowLogsFinish === 'function') {
    await sandbox.mygcflowLogsFinish(scenario.finish);
  }
  process.stdout.write(JSON.stringify({
    said,
    received: received.payload,
    requests,
    attempts,
  }));
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(1);
});
