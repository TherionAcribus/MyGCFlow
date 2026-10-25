// Favori « Envoyer vers MyGCFlow » (logs geocaching.com) — source lisible.
//
// blueprints/gc_logs.py en fait le lien `javascript:` : il y inclut
// logs_collect_core.js, remplace __ORIGIN__ / __TOKEN__ (origine locale
// réelle et jeton d'installation) et les messages __T_*__ (traduits côté
// serveur : le favori s'affiche sur geocaching.com, hors de portée des
// catalogues de l'application), puis met le tout sur une ligne.
//
// À cliquer depuis une page de geocaching.com, connecté. La collecte
// relit vos journaux et vos caches comme une consultation à la main :
// elle peut durer plusieurs minutes — le bandeau en haut à droite suit
// l'avancement. L'export est ensuite envoyé à l'application, où un aperçu
// reste à valider avant l'import.
//
// Contrainte d'écriture, vérifiée par les tests : commentaires en lignes
// entières uniquement, chaque instruction terminée par un point-virgule,
// aucune chaîne sur plusieurs lignes.
(async () => {
  var ORIGIN = __ORIGIN__;
  var TOKEN = __TOKEN__;
  var MESSAGES = {
    start: __T_START__,
    account: __T_ACCOUNT__,
    dnf: __T_DNF__,
    owned: __T_OWNED__,
    plan: __T_PLAN__,
    cache: __T_CACHE__,
    stopped: __T_STOPPED__,
    sending: __T_SENDING__,
    sent: __T_SENT__,
    order: __T_ORDER__,
    error: __T_ERROR__,
    prefix: __T_PREFIX__,
    wrongsite: __T_WRONGSITE__,
    since: __T_SINCE__,
    pendingask: __T_PENDINGASK__,
    pendingstop: __T_PENDINGSTOP__,
    badtoken: __T_BADTOKEN__,
    resumeask: __T_RESUMEASK__,
    resume: __T_RESUME__
  };

  // @include logs_collect_core.js

  // Bandeau d'état posé sur la page (textContent : jamais de HTML injecté).
  var say = (function () {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;'
      + 'background:#082747;color:#fff;padding:10px 14px;border-radius:8px;'
      + 'font:13px system-ui;box-shadow:0 2px 12px #0007;max-width:340px';
    document.body.appendChild(box);
    return function (text) { box.textContent = text; };
  })();
  var fill = function (template, a, b, c) {
    return String(template).replace('${a}', a).replace('${b}', b).replace('${c}', c);
  };
  var note = function (key, a, b, c) {
    say(fill(MESSAGES[key] || key, a, b, c));
  };

  try {
    if (!/(^|\.)geocaching\.com$/i.test(location.hostname)) {
      throw new Error(MESSAGES.wrongsite);
    }
    say(MESSAGES.start);

    // État de l'application avant de partir : un export en attente se
    // signale (inutile de relire tant qu'il n'est pas validé), et `since`
    // borne la collecte aux nouveautés — l'export incrémental ne voit pas
    // les suppressions de logs plus anciens, d'où le bouton « collecte
    // complète » de la carte. Si l'app ne répond pas, collecte complète :
    // l'envoi montrera l'erreur si elle persiste.
    var info = null;
    try {
      var sr = await fetch(ORIGIN + '/api/logs/receive/state', {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'X-MyGCFlow-Token': TOKEN }
      });
      if (sr.status === 403) {
        say(MESSAGES.error + ' : ' + MESSAGES.badtoken);
        return;
      }
      if (sr.ok) info = await sr.json();
    } catch (e) {
      info = null;
    }
    if (info && info.pending && !confirm(MESSAGES.pendingask)) {
      say(MESSAGES.pendingstop);
      return;
    }
    var since = (info && info.since) || null;
    if (since) note('since', since, 0, 0);
    var state = newState();
    state.since = since;

    // --- Reprise de collecte -----------------------------------------
    // Le PLAN (file de caches à lire + avancement, ~25 Ko) tient dans
    // localStorage, sur l'origine geocaching.com. Les LOGS, eux, partent
    // en fragments vers l'application à chaque point de sauvegarde —
    // l'onglet peut se fermer, rien de collecté n'est perdu. Les
    // fragments expirent au bout de 7 jours côté application : un plan
    // plus vieux est écarté (la couverture serait mensongère).
    var PLAN_KEY = 'mygcflowLogsRun';
    var PLAN_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
    var dropPlan = function () {
      try { localStorage.removeItem(PLAN_KEY); } catch (e) {}
    };
    var newRunId = function () {
      return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    };
    var savePlan = function (done) {
      try {
        localStorage.setItem(PLAN_KEY, JSON.stringify({
          v: 1,
          runId: state.runId,
          created: state.planCreated || Date.now(),
          since: state.since,
          order: state.order || state.prefOrder || null,
          me: { name: state.me.name, id: state.me.id },
          dnfComplete: !!state.dnf.listingComplete,
          queue: state.queueSnapshot || [],
          done: done,
          read: Array.from(state.read),
          failed: {
            d: state.dnf.failed.map(function (f) { return f.ref; }),
            o: state.owned.failed.map(function (f) { return f.ref; })
          }
        }));
        if (!state.planCreated) state.planCreated = Date.now();
      } catch (e) {
        // Quota ou stockage indisponible : pas de plan périmé conservé,
        // la reprise est simplement désactivée pour ce passage.
        dropPlan();
        state.persist = null;
        console.warn('[mygcflow-logs] Plan de reprise impossible : ' + e.message);
      }
    };
    // Fragment = l'export courant SANS couverture (elle n'a de sens que
    // fusionnée ; le document final la recompute). Rien d'envoyé tant
    // que l'ordre des dates est inconnu ou qu'il n'y a rien de nouveau.
    var lastFragCount = -1;
    var fragment = async function () {
      if (!state.logs.size && !state.caches.size) return;
      if (state.logs.size + state.caches.size === lastFragCount) return;
      // Un fragment écrit des dates : l'ordre choisi devient définitif —
      // ne pas le figer sur un échantillon vide (détection renverrait un
      // ordre par défaut sans avoir vu la moindre date).
      var picked = mygcflowGcLogsOrder(state, null);
      if (!picked.order) return;
      state.order = picked.order;
      var built = buildPayload(state, picked.order);
      var doc = built.payload;
      doc.coverage = [];
      var r = await fetch(ORIGIN + '/api/logs/receive/fragment', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'X-MyGCFlow-Token': TOKEN,
          'X-MyGCFlow-Run-Id': state.runId
        },
        body: JSON.stringify(doc)
      });
      if (r.ok || r.status === 202) {
        lastFragCount = state.logs.size + state.caches.size;
      } else {
        console.warn('[mygcflow-logs] Fragment refusé (' + r.status + ') — la reprise couvrira moins.');
      }
    };
    state.persist = async function (done) {
      savePlan(done);
      try {
        await fragment();
      } catch (e) {
        console.warn('[mygcflow-logs] Fragment non envoyé : ' + e.message);
      }
    };

    // Un plan valide ? « done === queue.length » = collecte bouclée mais
    // envoi raté : la reprise renvoie l'export sans rien relire.
    var saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
    } catch (e) {
      saved = null;
    }
    var resumable = saved && saved.v === 1 && saved.runId &&
      Array.isArray(saved.queue) && saved.queue.length > 0 &&
      typeof saved.done === 'number' && saved.done >= 0 && saved.done <= saved.queue.length &&
      (!saved.created || Date.now() - saved.created <= PLAN_MAX_AGE_MS);
    if (resumable && confirm(fill(MESSAGES.resumeask, saved.done, saved.queue.length, 0))) {
      state.resume = saved;
      state.runId = saved.runId;
      state.order = saved.order || null;
      note('resume', saved.done, saved.queue.length, 0);
    } else {
      dropPlan();
      state.runId = newRunId();
    }

    var send = async function (order) {
      var built = mygcflowGcLogsFinish(state, order);
      say(MESSAGES.sending);
      var headers = { 'Content-Type': 'application/json', 'X-MyGCFlow-Token': TOKEN };
      var url = ORIGIN + '/api/logs/receive';
      if (state.runId) {
        url += '/fragment';
        headers['X-MyGCFlow-Run-Id'] = state.runId;
        headers['X-MyGCFlow-Final'] = '1';
      }
      var response = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: headers,
        body: JSON.stringify(built.payload)
      });
      if (response.ok || response.status === 202) {
        dropPlan();
        var detail = '';
        try {
          var body = await response.json();
          detail = body.message || '';
        } catch (e) {
          detail = '';
        }
        say(fill(MESSAGES.sent, built.payload.logs.length, built.payload.caches.length, 0)
          + (detail ? ' — ' + detail : ''));
      } else {
        var text = '';
        try {
          text = await response.text();
        } catch (e) {
          text = '';
        }
        say(MESSAGES.error + ' ' + response.status + ' — ' + text.slice(0, 160));
      }
    };

    // Ordre des dates indéterminé : la collecte est faite, seule l'écriture
    // attend un ordre. La console permet de le donner sans rien relire :
    // mygcflowLogsFinish('DMY') (ou 'MDY', 'YMD').
    window.mygcflowLogsFinish = async function (order) {
      var picked = mygcflowGcLogsOrder(state, order);
      if (!picked.order) {
        console.error('[mygcflow-logs] Ordre attendu : \'DMY\', \'MDY\' ou \'YMD\'.');
        return;
      }
      await send(picked.order);
    };

    await mygcflowCollectGcLogs(state, note);

    var picked = mygcflowGcLogsOrder(state, null);
    if (!picked.order) {
      console.error('[mygcflow-logs] Exemples de dates : ' + picked.samples.join(' | '));
      say(fill(MESSAGES.order, picked.candidates.join(', ') || '?', 0, 0));
      return;
    }
    await send(picked.order);
  } catch (e) {
    say(MESSAGES.prefix + ' ' + (e && e.message ? e.message : e));
  }
})();
