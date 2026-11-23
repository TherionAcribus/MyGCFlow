// Chapitres de la vidéo d'un parcours : un chapitre par journée.
//
// Un chapitre commence avec la nuit qui précède sa journée (le carton
// « n jours plus tard » et le trajet de nuit en font partie, comme dans la
// chronologie) ; le premier commence à 0 s et couvre aussi le carton
// d'ouverture. Les instants sont RELEVÉS pendant la capture plutôt que
// recalculés depuis les quanta : pré-roll, pauses et images de caméra y sont
// ainsi comptés tels qu'ils sont dans la vidéo, dans les deux pipelines.
//
// Module pur (testé sous Node) : ni DOM ni index.js.

// Début de chaque journée en quanta : { q, dayNumber, date }.
export function chapterMarks(timeline) {
    const days = timeline?.days || [];
    return days.map((day, index) => ({
        q: index === 0 ? 0 : day.startQ,
        dayNumber: day.dayNumber,
        date: day.date,
    }));
}

// Journal d'une capture. `begin` le remet à zéro au départ de la lecture ;
// `note(lastQ, atMs)` est appelé à chaque pas du moteur avec le dernier
// quantum affiché et l'instant vidéo correspondant (null hors capture : un
// aperçu ne note rien).
export function createChapterLog() {
    let marks = [];
    let next = 0;
    const entries = [];
    return {
        begin(timeline, startQ = 0) {
            marks = chapterMarks(timeline);
            entries.length = 0;
            // Départ en cours de parcours : le chapitre qui contient startQ
            // ouvre la vidéo.
            next = 0;
            while (next + 1 < marks.length && marks[next + 1].q <= startQ) next++;
        },
        note(lastQ, atMs) {
            if (atMs === null || atMs === undefined || !Number.isFinite(atMs)) return;
            while (next < marks.length && (entries.length === 0 || marks[next].q <= lastQ)) {
                const mark = marks[next++];
                entries.push({ ...mark, ms: entries.length === 0 ? 0 : Math.max(0, atMs) });
            }
        },
        entries: () => entries.map((entry) => ({ ...entry })),
    };
}

// Chapitres envoyés au serveur : { start (s), day, date }. `speed` divise
// les instants relevés (MediaRecorder accéléré au post-traitement). Moins de
// deux chapitres : rien à chapitrer.
export function chaptersForUpload(entries, speed = 1, formatDate = (iso) => iso) {
    const factor = Number(speed) > 0 ? Number(speed) : 1;
    const out = [];
    for (const entry of entries || []) {
        const start = Math.round(entry.ms / factor) / 1000;
        const chapter = { start, day: entry.dayNumber, date: formatDate(entry.date) || '' };
        // Deux journées sur la même image : la première n'a aucune durée.
        if (out.length && start <= out[out.length - 1].start) {
            out[out.length - 1] = { ...chapter, start: out[out.length - 1].start };
        } else {
            out.push(chapter);
        }
    }
    return out.length >= 2 ? out : [];
}
