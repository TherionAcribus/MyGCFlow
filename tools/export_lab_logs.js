// Exporteur MyGCFlow — historique Adventure Lab depuis labs.geocaching.com/logs
//
// Usage : ouvrir https://labs.geocaching.com/logs connecté, F12 → Console,
// coller ce script tel quel. Produire 2 téléchargements :
//   - mygcflow-lab-finds-<date>.json  (historique complet, contrat v1 du plan)
//   - lab-adventure-uuids.txt       (UUID d'Adventures à coller dans Lab2Gpx)
//
// PLAYER_ID : valeur du champ `id` du payload POST de la page (DevTools →
// Network → GetLogsByAdventureGrouping → Payload). C'est le GUID public du
// joueur — le même que Lab2Gpx demande dans « Calling user's public GUID ».
(async () => {
  const PLAYER_ID = "b19d6e80-a3cd-49f5-8bad-35351a14681c";
  let take = 100;                   // repli automatique vers take=10 (500 si trop grand)
  const DELAY_MS = 300;             // débit modéré
  const API_URL = "/Logs/GetLogsByAdventureGrouping/";

  const discoveries = [];
  const adventureIds = new Set();
  const seenLogs = new Set();
  let skip = 0, guard = 0;

  while (true) {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: PLAYER_ID, skip, take })
    });
    if (!r.ok) {
      if (take > 10) { take = Math.max(10, Math.floor(take / 2)); console.warn(`HTTP ${r.status}, repli take=${take}`); continue; }
      throw new Error("HTTP " + r.status + " : " + (await r.text()).slice(0, 300));
    }
    const d = await r.json();
    const items = d.items || [];
    const before = adventureIds.size;

    for (const it of items) {
      adventureIds.add(it.adventureId);
      for (const l of (it.playerLogs || [])) {
        if (seenLogs.has(l.id)) continue;
        seenLogs.add(l.id);
        const day = /^\d{4}-\d{2}-\d{2}/.exec(l.dateLogged || "");
        discoveries.push({
          adventure_id: it.adventureId || null,
          stage_id: l.stageId || null,
          adventure_title: it.adventureTitle || null,
          stage_title: l.stageTitle || null,
          // Date civile dans l'offset de la source — la même que la page
          // affiche (« Complétées: JJ/MM/AAAA »), pas la date UTC.
          found_date: day ? day[0] : null,
          found_at: l.dateLogged || null,
          date_precision: "instant",
          date_basis: "source_offset",
          latitude: null,
          longitude: null,
          coordinate_scope: null,
          adventure_url: null,
          log_id: l.id ?? null,
          is_archived: !!l.isArchived,
          adventure_is_archived: !!it.isArchived
        });
      }
    }

    console.log(`skip=${skip} → ${items.length} Adventures | cumul: ${adventureIds.size} Adventures, ${discoveries.length} étapes (totalCount=${d.totalCount})`);
    skip += items.length;
    // Arrêt : page vide, ou plus aucune nouvelle Adventure (borne de sécurité).
    if (items.length === 0 || adventureIds.size === before || ++guard > 500) break;
    await new Promise(res => setTimeout(res, DELAY_MS));
  }

  const payload = {
    format: "mygcflow-lab-finds",
    schema_version: 1,
    exported_at: new Date().toISOString(),
    account: { username: null },
    source: "labs.geocaching.com/logs",
    coverage: "complete",
    discoveries
  };

  const dl = (name, text, type = "application/json") => {
    const a = document.createElement("a");
    a.href = self.URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => self.URL.revokeObjectURL(a.href), 5000);
  };

  const stamp = new Date().toISOString().slice(0, 10);
  dl(`mygcflow-lab-finds-${stamp}.json`, JSON.stringify(payload, null, 2));
  dl("lab-adventure-uuids.txt", [...adventureIds].join(","), "text/plain");

  console.log(`✔ ${adventureIds.size} Adventures, ${discoveries.length} étapes exportées.`);
})();
