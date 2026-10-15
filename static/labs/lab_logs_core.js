// Cœur partagé — parcours paginé de l'historique Adventure Lab.
//
// Inclus tel quel dans le favori « Envoyer vers MyGCFlow »
// (bookmarklet.src.js) et dans le script d'export manuel
// (export_lab_logs.src.js) par blueprints/labs.py : c'est la seule copie de
// la boucle de pagination. Il s'exécute sur labs.geocaching.com/logs, avec
// les cookies de session de la page.
//
// Contrainte d'écriture (ce fichier finit sur une seule ligne dans le
// favori) : commentaires en lignes entières uniquement, chaque instruction
// terminée par un point-virgule, aucune chaîne sur plusieurs lignes.

async function mygcflowCollectLabLogs(playerId, onPage) {
  var API_URL = '/Logs/GetLogsByAdventureGrouping/';
  var DELAY_MS = 300;
  // 50 : le plus grand lot que le site accepte (100 et 200 → HTTP 500).
  var take = 50;
  var skip = 0;
  var guard = 0;
  var discoveries = [];
  var adventureIds = new Set();
  var seenLogs = new Set();

  while (true) {
    var response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id: playerId, skip: skip, take: take })
    });
    if (!response.ok) {
      // Le site refuse parfois les grandes pages : repli progressif jusqu'à 10.
      if (take > 10) {
        take = Math.max(10, Math.floor(take / 2));
        continue;
      }
      throw new Error('HTTP ' + response.status);
    }
    var data = await response.json();
    var items = data.items || [];
    var before = adventureIds.size;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      adventureIds.add(item.adventureId);
      var logs = item.playerLogs || [];
      for (var j = 0; j < logs.length; j++) {
        var log = logs[j];
        if (seenLogs.has(log.id)) {
          continue;
        }
        seenLogs.add(log.id);
        // Date civile dans l'offset de la source — celle que la page affiche
        // (« Complétées: JJ/MM/AAAA »), pas la date UTC.
        var day = /^\d{4}-\d{2}-\d{2}/.exec(log.dateLogged || '');
        discoveries.push({
          adventure_id: item.adventureId || null,
          stage_id: log.stageId || null,
          adventure_title: item.adventureTitle || null,
          stage_title: log.stageTitle || null,
          found_date: day ? day[0] : null,
          found_at: log.dateLogged || null,
          date_precision: 'instant',
          date_basis: 'source_offset',
          latitude: null,
          longitude: null,
          coordinate_scope: null,
          adventure_url: null,
          stage_image_url: log.stageKeyImageUrl || null,
          adventure_image_url: item.adventureKeyImageUrl || null,
          log_id: log.id == null ? null : log.id,
          is_archived: !!log.isArchived,
          adventure_is_archived: !!item.isArchived
        });
      }
    }

    if (onPage) {
      onPage(adventureIds.size, discoveries.length);
    }
    skip += items.length;
    // Arrêt : page vide, ou plus aucune nouvelle Adventure (borne de sécurité).
    if (items.length === 0 || adventureIds.size === before || ++guard > 500) {
      break;
    }
    await new Promise(function (resolve) { setTimeout(resolve, DELAY_MS); });
  }

  return { discoveries: discoveries, adventureIds: Array.from(adventureIds) };
}

// Enveloppe « mygcflow-lab-finds » v1 attendue par l'import.
function mygcflowLabFindsPayload(discoveries) {
  return {
    format: 'mygcflow-lab-finds',
    schema_version: 1,
    exported_at: new Date().toISOString(),
    account: { username: null },
    source: 'labs.geocaching.com/logs',
    coverage: 'complete',
    discoveries: discoveries
  };
}
