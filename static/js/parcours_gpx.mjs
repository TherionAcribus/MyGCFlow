// Export GPX d'un parcours : une route (<rte>) par journée, les étapes
// dans l'ordre de l'itinéraire reconstruit (les exclues n'y figurent pas).
// <time> = heure d'arrivée prévue, convertie en UTC grâce au décalage du
// parcours. Les étapes sans position sont ignorées — un point de route
// sans coordonnées n'a pas de sens pour un GPS.

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

// Journée « YYYY-MM-DD » + minutes depuis minuit local → ISO 8601 UTC.
function arrivalIsoUtc(date, arrivalMin, offsetMin) {
    if (!Number.isFinite(arrivalMin)) return null;
    const utcMs = Date.parse(`${date}T00:00:00Z`) + (arrivalMin - offsetMin) * 60000;
    if (!Number.isFinite(utcMs)) return null;
    return new Date(utcMs).toISOString();
}

// stop → <rtept> : code de cache quand il y en a un, sinon le nom du lieu.
function rtePoint(stop, date, offsetMin) {
    const label = stop.code || stop.name || stop.key || '';
    const time = arrivalIsoUtc(date, stop.arrivalMin, offsetMin);
    const lines = [`    <rtept lat="${stop.lat}" lon="${stop.lon}">`,
        `      <name>${esc(label)}</name>`];
    if (time) lines.push(`      <time>${time}</time>`);
    if (stop.name && stop.name !== label) lines.push(`      <desc>${esc(stop.name)}</desc>`);
    lines.push('    </rtept>');
    return lines.join('\n');
}

export function buildParcoursGpx({ name, days, utcOffsetMinutes = 0 }) {
    const offset = Number.isFinite(utcOffsetMinutes) ? utcOffsetMinutes : 0;
    const parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="MyGCFlow" xmlns="http://www.topografix.com/GPX/1/1">',
        `  <metadata><name>${esc(name)}</name></metadata>`,
    ];
    for (const day of days || []) {
        const stops = (day?.stops || [])
            .filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
        if (!stops.length || !day?.date) continue;
        parts.push(`  <rte><name>${esc(name)} · ${day.date}</name>`);
        for (const stop of stops) parts.push(rtePoint(stop, day.date, offset));
        parts.push('  </rte>');
    }
    parts.push('</gpx>');
    return `${parts.join('\n')}\n`;
}
