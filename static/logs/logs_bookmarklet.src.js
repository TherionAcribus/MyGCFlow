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
    wrongsite: __T_WRONGSITE__
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
    var state = newState();

    var send = async function (order) {
      var built = mygcflowGcLogsFinish(state, order);
      say(MESSAGES.sending);
      var response = await fetch(ORIGIN + '/api/logs/receive', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'X-MyGCFlow-Token': TOKEN },
        body: JSON.stringify(built.payload)
      });
      if (response.ok || response.status === 202) {
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
