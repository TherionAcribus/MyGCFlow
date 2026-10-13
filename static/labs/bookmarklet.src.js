// Favori « Envoyer vers MyGCFlow » — source lisible.
//
// blueprints/labs.py en fait le lien `javascript:` : il y inclut
// lab_logs_core.js, remplace __ORIGIN__ / __TOKEN__ (origine locale réelle et
// jeton d'installation) et les messages __T_*__ (traduits côté serveur : le
// favori s'affiche sur labs.geocaching.com, hors de portée des catalogues de
// l'application), puis met le tout sur une ligne.
//
// Contrainte d'écriture, vérifiée par les tests : commentaires en lignes
// entières uniquement, chaque instruction terminée par un point-virgule,
// aucune chaîne sur plusieurs lignes.
(async () => {
  var ORIGIN = __ORIGIN__;
  var TOKEN = __TOKEN__;
  var API_URL = '/Logs/GetLogsByAdventureGrouping/';
  var STORAGE_KEY = 'mygcflow:playerId';
  var HOOK_TIMEOUT_MS = 90000;
  var MAX_CANDIDATES = 80;
  var PROBES_AT_ONCE = 5;
  var MESSAGES = {
    start: __T_START__,
    prompt: __T_PROMPT__,
    cancelled: __T_CANCELLED__,
    guidbad: __T_GUIDBAD__,
    progress: __T_PROGRESS__,
    sending: __T_SENDING__,
    sent: __T_SENT__,
    error: __T_ERROR__,
    prefix: __T_PREFIX__,
    scroll: __T_SCROLL__
  };

  // @include lab_logs_core.js

  // Bandeau d'état posé sur la page (textContent : jamais de HTML injecté).
  var say = (function () {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;'
      + 'background:#082747;color:#fff;padding:10px 14px;border-radius:8px;'
      + 'font:13px system-ui;box-shadow:0 2px 12px #0007;max-width:340px';
    document.body.appendChild(box);
    return function (text) { box.textContent = text; };
  })();
  var fill = function (template, adventures, stages) {
    return template.replace('${adv}', adventures).replace('${disc}', stages);
  };

  // Sans effet tant qu'aucune interception n'est posée — en particulier quand
  // l'identifiant mémorisé suffit et que la détection ci-dessous est sautée.
  var unhook = function () {};

  try {
    say(MESSAGES.start);

    var ask = function (id) {
      return fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: id, skip: 0, take: 1 })
      });
    };
    var accepts = async function (id) {
      try {
        return (await ask(id)).ok;
      } catch (e) {
        return false;
      }
    };
    // Sonde stricte : le bon identifiant renvoie au moins une ligne
    // d'historique ; un GUID étranger (Adventure, etc.) répond 200 avec une
    // liste vide.
    var probe = async function (id) {
      try {
        var response = await ask(id);
        if (!response.ok) {
          return false;
        }
        var data = await response.json();
        return (data.items || []).length > 0;
      } catch (e) {
        return false;
      }
    };

    // `found` distingue « trouvé » de « pas trouvé » : `pick === null` est un
    // identifiant VALIDE (le serveur déduit alors le joueur de la session, ce
    // qu'une réponse 200 avec des lignes confirme).
    var pick = null;
    var found = false;

    var remembered = localStorage.getItem(STORAGE_KEY) || null;
    if (remembered && await probe(remembered)) {
      pick = remembered;
      found = true;
    }
    if (remembered && !found) {
      localStorage.removeItem(STORAGE_KEY);
    }

    if (!found) {
      var candidates = [null];
      var haystack = document.documentElement.innerHTML;
      var match;
      // Le site peut garder l'identifiant dans un cookie lisible (non
      // HttpOnly) ou dans le storage — sources gratuites à balayer.
      try {
        haystack += ';' + document.cookie + ';' + JSON.stringify(localStorage)
          + ';' + JSON.stringify(sessionStorage);
      } catch (e) {
        // Storage inaccessible : la page seule suffira ou non.
      }
      var patterns = [
        /profile[^"']*guid=([0-9a-f-]{36})/ig,
        /"(?:publicGuid|playerGuid|playerId|player_id)"\s*:\s*"([0-9a-f-]{36})"/ig
      ];
      for (var p = 0; p < patterns.length; p++) {
        while ((match = patterns[p].exec(haystack))) {
          if (candidates.indexOf(match[1]) < 0) {
            candidates.push(match[1]);
          }
        }
      }
      // Dernier recours automatique : tous les GUID présents dans la page —
      // la page /logs connaît l'identifiant du joueur connecté.
      var anyGuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
      while ((match = anyGuid.exec(haystack)) && candidates.length < MAX_CANDIDATES) {
        var guid = match[0].toLowerCase();
        if (candidates.indexOf(guid) < 0) {
          candidates.push(guid);
        }
      }

      // L'identifiant n'apparaît pas toujours dans le HTML : la page peut
      // l'obtenir par un appel interne. Filet armé dès maintenant :
      // intercepter la prochaine requête que la page émet elle-même quand
      // l'utilisateur fait défiler son historique. Nos propres sondes sont
      // exclues, leurs identifiants étant dans `candidates`.
      var hooked = new Promise(function (done) {
        var pageFetch = window.fetch;
        var xhrOpen = XMLHttpRequest.prototype.open;
        var xhrSend = XMLHttpRequest.prototype.send;
        unhook = function () {
          window.fetch = pageFetch;
          XMLHttpRequest.prototype.open = xhrOpen;
          XMLHttpRequest.prototype.send = xhrSend;
        };
        var settle = function (value) {
          unhook();
          done(value);
        };
        var inspect = function (target, body) {
          try {
            var url = String((target && target.url) || target);
            if (url.indexOf('GetLogsByAdventureGrouping') >= 0 && body) {
              var sent = JSON.parse(body);
              if (sent && sent.id && candidates.indexOf(sent.id) < 0) {
                settle(sent.id);
              }
            }
          } catch (e) {
            return;
          }
        };
        window.fetch = function (target, options) {
          var pending = pageFetch.apply(this, arguments);
          inspect(target, options && options.body);
          return pending;
        };
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__mygcflowUrl = url;
          return xhrOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          inspect(this.__mygcflowUrl, body);
          return xhrSend.apply(this, arguments);
        };
        setTimeout(function () { settle(null); }, HOOK_TIMEOUT_MS);
      });
      var hookSettled = false;
      hooked.then(function (value) {
        hookSettled = true;
        if (value !== null) {
          pick = value;
          found = true;
        }
      });

      for (var start = 0; start < candidates.length && !found && !hookSettled; start += PROBES_AT_ONCE) {
        var hits = await Promise.all(candidates.slice(start, start + PROBES_AT_ONCE).map(probe));
        for (var h = 0; h < hits.length && !found; h++) {
          if (hits[h]) {
            pick = candidates[start + h];
            found = true;
          }
        }
      }

      if (found) {
        unhook();
      } else if (!hookSettled) {
        say(MESSAGES.scroll);
        var intercepted = await hooked;
        if (intercepted !== null) {
          pick = intercepted;
          found = true;
        }
      }
    }

    if (!found) {
      var typed = prompt(MESSAGES.prompt);
      if (!typed) {
        say(MESSAGES.cancelled);
        return;
      }
      typed = typed.trim();
      if (!(await accepts(typed))) {
        say(MESSAGES.guidbad);
        return;
      }
      pick = typed;
      found = true;
    }
    if (pick !== null) {
      localStorage.setItem(STORAGE_KEY, pick);
    }

    var result = await mygcflowCollectLabLogs(pick, function (adventures, stages) {
      say(fill(MESSAGES.progress, adventures, stages));
    });

    say(MESSAGES.sending);
    var response = await fetch(ORIGIN + '/api/labs/receive', {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-MyGCFlow-Token': TOKEN },
      body: JSON.stringify(mygcflowLabFindsPayload(result.discoveries))
    });
    if (response.status === 202) {
      say(fill(MESSAGES.sent, result.adventureIds.length, result.discoveries.length));
    } else {
      var detail = '';
      try {
        detail = await response.text();
      } catch (e) {
        detail = '';
      }
      say(MESSAGES.error + ' ' + response.status + ' — ' + detail.slice(0, 160));
    }
  } catch (e) {
    unhook();
    say(MESSAGES.prefix + ' ' + (e && e.message ? e.message : e));
  }
})();
