// Exécute le favori « Envoyer vers MyGCFlow » généré par l'application dans
// une fausse page labs.geocaching.com/logs, et imprime ce qu'il a fait.
//
//   node bookmarklet_harness.cjs <fichier du lien javascript:> <scénario JSON>
//
// Scénario : { remembered, playerId, pages, html, refuseTakeAbove, prompt,
//             expireHook }.
// - playerId : seul identifiant auquel le faux site renvoie de l'historique
//   (null = joueur déduit de la session) ;
// - pages : pages d'Adventures servies à la suite (tableaux d'items).
const fs = require('node:fs');
const vm = require('node:vm');

const href = fs.readFileSync(process.argv[2], 'utf-8').trim();
const scenario = JSON.parse(process.argv[3] || '{}');
if (!href.startsWith('javascript:')) {
  throw new Error('lien javascript: attendu');
}

const said = [];
const requests = [];
const store = {};
if (scenario.remembered) {
  store['mygcflow:playerId'] = scenario.remembered;
}
let received = null;

const playerId = scenario.playerId === undefined ? null : scenario.playerId;
const pages = scenario.pages || [];

async function fakeFetch(url, options) {
  const target = String(url);
  if (target.includes('/api/labs/receive')) {
    received = { url: target, headers: options.headers, body: JSON.parse(options.body),
                 credentials: options.credentials };
    return { status: 202, ok: true, text: async () => '' };
  }
  const sent = JSON.parse(options.body);
  requests.push(sent);
  if (scenario.refuseTakeAbove && sent.take > scenario.refuseTakeAbove) {
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  }
  if (sent.id !== playerId) {
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  }
  // Pagination par Adventure, comme le site : skip/take comptent des items.
  const all = pages.flat();
  return { ok: true, status: 200,
           json: async () => ({ items: all.slice(sent.skip, sent.skip + sent.take) }) };
}

function XMLHttpRequest() {}
XMLHttpRequest.prototype.open = function () {};
XMLHttpRequest.prototype.send = function () {};

const sandbox = {
  console,
  JSON, Promise, Set, Math, Date, String, Array, Error,
  // Les pauses entre pages (300 ms) sont écourtées ; l'échéance de
  // l'interception (90 s) ne doit ni retenir le processus ni se déclencher.
  // `expireHook` la fait au contraire échoir tout de suite.
  setTimeout: (fn, ms) => (ms > 5000 && !scenario.expireHook ? 0 : setTimeout(fn, 0)),
  localStorage: {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
  },
  sessionStorage: {},
  document: {
    createElement: () => ({ style: {}, set textContent(text) { said.push(text); } }),
    body: { appendChild() {} },
    documentElement: { innerHTML: scenario.html || '' },
    cookie: '',
  },
  XMLHttpRequest,
  prompt: () => (scenario.prompt === undefined ? null : scenario.prompt),
  fetch: fakeFetch,
};
sandbox.window = sandbox;
sandbox.self = sandbox;

(async () => {
  // Le favori est une expression `(async () => {...})();` : son résultat est
  // la promesse de fin d'exécution.
  const body = href.slice('javascript:'.length).replace(/;\s*$/, '');
  await vm.runInNewContext(body, sandbox);
  process.stdout.write(JSON.stringify({
    said, received, requests, remembered: store['mygcflow:playerId'] || null,
    fetchRestored: sandbox.fetch === fakeFetch,
  }));
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(1);
});
