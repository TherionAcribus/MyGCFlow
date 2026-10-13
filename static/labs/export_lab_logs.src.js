// Exporteur MyGCFlow — historique Adventure Lab depuis labs.geocaching.com/logs
//
// Usage : ouvrir https://labs.geocaching.com/logs connecté, F12 → Console,
// coller ce script tel quel. Il produit 2 téléchargements :
//   - mygcflow-lab-finds-<date>.json  (historique complet, contrat v1)
//   - lab-adventure-uuids.txt         (UUID d'Adventures à coller dans Lab2Gpx)
//
// PLAYER_ID : valeur du champ `id` du payload POST de la page (DevTools →
// Network → GetLogsByAdventureGrouping → Payload). C'est le GUID public du
// joueur — le même que Lab2Gpx demande dans « Calling user's public GUID ».
(async () => {
  var PLAYER_ID = 'COLLER_LE_GUID_JOUEUR_ICI';

  // @include lab_logs_core.js

  var result = await mygcflowCollectLabLogs(PLAYER_ID, function (adventures, stages) {
    console.log('cumul : ' + adventures + ' Adventures, ' + stages + ' étapes');
  });

  var download = function (name, text, type) {
    var link = document.createElement('a');
    link.href = self.URL.createObjectURL(new Blob([text], { type: type }));
    link.download = name;
    link.click();
    setTimeout(function () { self.URL.revokeObjectURL(link.href); }, 5000);
  };

  var stamp = new Date().toISOString().slice(0, 10);
  download('mygcflow-lab-finds-' + stamp + '.json',
    JSON.stringify(mygcflowLabFindsPayload(result.discoveries), null, 2), 'application/json');
  download('lab-adventure-uuids.txt', result.adventureIds.join(','), 'text/plain');

  console.log('✔ ' + result.adventureIds.length + ' Adventures, '
    + result.discoveries.length + ' étapes exportées.');
})();
