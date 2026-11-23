// Barre de chronologie du parcours : timeline_bar.js compte en jours du
// moteur, donc ici en quanta, sur des dates fictives — ce module lui donne
// la série, les repères et les textes en vraies dates et heures. `axisStart`
// est la date fictive du premier quantum de la piste, `offset` un quantum de
// la piste. La plage est le parcours entier.
//
// L'état du parcours ouvert (timeline, lecture, révision) arrive par
// `getState()` : la barre se branche une fois chez le moteur et lit toujours
// les valeurs courantes, sans import de parcours_data.js.
import { t } from './notifications.js';
import {
    formatDay,
    formatKm,
    stopLabel,
    stopsCountText,
    travelModeLabel,
} from './parcours_labels.mjs';
import {
    HOURS_NONE,
    HOURS_SLOTS,
    barSeries,
    barTicks,
    formatClock,
    legIndexAt,
    legTravelMode,
    stateAt,
} from './parcours_timeline.mjs';
import { dayIndexOf } from './evolution_timeline.mjs';
import { isCountedStop } from './parcours_reconstruct.mjs';
import { photoSlots } from './parcours_photo_layout.mjs';

// Libellés des « créneaux » de la journée (réglage « heures : créneaux »).
export function slotLabels() {
    return { morning: t('matin'), noon: t('midi'), afternoon: t('après-midi'), evening: t('soir') };
}

// `getState()` → { timeline, playback, timelineRevision } du parcours ouvert.
export function createParcoursTimelineBar({ quantumBase, getState }) {
    const current = () => getState() || {};
    const timeline = () => current().timeline;
    const hours = () => (current().playback || {}).hours;

    function barFirstQ(axisStart) {
        return dayIndexOf(quantumBase, axisStart);
    }

    function barStateAt(axisStart, offset) {
        const tl = timeline();
        return tl ? stateAt(tl, barFirstQ(axisStart) + offset) : null;
    }

    // « Jour 2 · dim. 13 juil. » (la date seule pour une journée unique).
    function barDayText(state) {
        if (!state?.date) return '';
        const date = formatDay(state.date, { weekday: 'short', day: 'numeric', month: 'short' });
        if ((timeline()?.days?.length || 0) < 2) return date;
        return t('Jour ${n}', { n: state.dayNumber }) + ' · ' + date;
    }

    function barClockText(state) {
        return state ? formatClock(state.minutes, state.estimated, hours(), slotLabels()) : '';
    }

    // Où en est le géocacheur au quantum `q` : avant le départ, à une étape,
    // en route, la nuit, ou à la fin.
    function barSituation(q, state) {
        const tl = timeline();
        const legIndex = legIndexAt(tl, q);
        if (legIndex >= 0) {
            const leg = tl.legs[legIndex];
            if (leg.night) return t('Nuit');
            const mode = travelModeLabel(legTravelMode(tl, legIndex));
            const name = stopLabel(tl.stops[leg.to]);
            return t('Trajet ${mode} vers ${name}', { mode, name }) + ' · ' + formatKm(leg.km);
        }
        if (state.reached < 0) return t('Avant la première étape');
        const stop = tl.stops[state.reached];
        if (state.reached === tl.stops.length - 1 && q >= stop.departQ) return t('Fin du parcours');
        if (!isCountedStop(stop)) return stopLabel(stop);
        return t('Étape ${n} : ${name}', { n: state.stopsReached, name: stopLabel(stop) });
    }

    // Bornes : courtes, la piste a besoin de la place (panneau latéral). La
    // date seule sur plusieurs journées — l'heure est dans l'étiquette du
    // curseur et la bulle —, l'heure seule sur une journée (même date aux
    // deux bouts).
    function barEdgeText(axisStart, offset) {
        const state = barStateAt(axisStart, offset);
        if (!state?.date) return '';
        if ((timeline()?.days?.length || 0) < 2) {
            return barClockText(state) || formatDay(state.date, { weekday: 'short', day: 'numeric', month: 'short' });
        }
        return formatDay(state.date, { weekday: 'short', day: 'numeric', month: 'short' });
    }

    // Étiquette au curseur (et valeur du slider) : courte, sa largeur est
    // fixe (ui_improvements.css) — le numéro du jour et la distance sont
    // dans la bulle. Deux lignes (« date · heure », puis les étapes, suivies
    // de l'instant de la vidéo) : `white-space: pre-line` les sépare, une
    // barre étroite (nowrap) les remet sur une ligne.
    function barPositionText(axisStart, offset) {
        const state = barStateAt(axisStart, offset);
        if (!state?.date) return '';
        const date = formatDay(state.date, { weekday: 'short', day: 'numeric', month: 'short' });
        return [date, barClockText(state)].filter(Boolean).join(' · ') + '\n' + stopsCountText(state.stopsReached);
    }

    function barTipLines(axisStart, offset) {
        const tl = timeline();
        const q = barFirstQ(axisStart) + offset;
        const state = tl ? stateAt(tl, q) : null;
        if (!state) return [];
        const total = stopsCountText(state.stopsReached) + ' · ' + formatKm(state.km);
        return [
            { text: [barDayText(state), barClockText(state)].filter(Boolean).join(' · '), strong: true },
            { text: barSituation(q, state) },
            { text: t('Total : ${text}', { text: total }) },
        ];
    }

    // Nuits en bandes ; journées (plusieurs) ou heures pleines (une seule,
    // quand des heures sont affichées) en traits et étiquettes.
    function barTickMarks(axisStart, span) {
        const out = { bands: [], lines: [], labels: [] };
        const tl = timeline();
        if (!tl) return out;
        const ticks = barTicks(tl, barFirstQ(axisStart), span);
        out.bands = ticks.bands;
        for (const { offset, day } of ticks.days) {
            if (offset > 0) out.lines.push(offset);
            out.labels.push({ offset, text: t('Jour ${n}', { n: tl.days[day].dayNumber }) });
        }
        if (hours() === HOURS_NONE || hours() === HOURS_SLOTS) return out;
        for (const { offset, hour } of ticks.hours) {
            out.lines.push(offset);
            out.labels.push({ offset, text: `${String(hour).padStart(2, '0')}:00` });
        }
        return out;
    }

    // Repères : DNF et photos de chaque étape (au début de la première).
    function barMarks(axisStart, span) {
        const tl = timeline();
        if (!tl) return [];
        const firstQ = barFirstQ(axisStart);
        const marks = [];
        const push = (q, kind, label) => {
            const offset = Math.ceil(q - 1e-6) - firstQ;
            if (offset >= 0 && offset < span) marks.push({ offset, kind, label });
        };
        for (const stop of tl.stops) {
            if (stop.kind === 'dnf') push(stop.q, 'dnf', t('DNF : ${code}', { code: stop.code || stopLabel(stop) }));
        }
        const photosByStop = new Map();
        for (const slot of photoSlots(tl)) {
            // Photo en chemin : son propre repère, à son arrêt.
            const key = slot.route ? `route:${slot.order}` : slot.stop;
            const entry = photosByStop.get(key);
            if (entry) entry.count++;
            else photosByStop.set(key, { fromQ: slot.fromQ, count: 1, route: !!slot.route, stop: slot.stop });
        }
        for (const { fromQ, count, route, stop } of photosByStop.values()) {
            const photos = count === 1 ? t('1 photo') : t('${n} photos', { n: count });
            push(fromQ, 'photo', photos + ' · ' + (route ? t('en chemin') : stopLabel(tl.stops[stop])));
        }
        return marks;
    }

    // Pg.Préc/Pg.Suiv : arrivée à la première étape de la journée suivante
    // (direction 1) ou de la journée en cours / précédente (-1).
    function barDayOffset(rangeStart, offset, direction) {
        const tl = timeline();
        if (!tl) return null;
        const firstQ = barFirstQ(rangeStart);
        const starts = tl.days
            .map((day) => Math.ceil((tl.stops[day.first]?.q ?? 0) - 1e-6) - firstQ)
            .filter((start) => start >= 0);
        if (direction > 0) return starts.find((start) => start > offset) ?? null;
        return starts.filter((start) => start < offset).pop() ?? null;
    }

    return Object.freeze({
        rangeEditable: false,
        // Un cran de molette : 5 quanta (½ s à la vitesse naturelle).
        wheelStep: 5,
        revision: () => `${current().timelineRevision || 0}|${hours()}`,
        series: (axisStart, span) => barSeries(timeline(), barFirstQ(axisStart), span),
        ticks: barTickMarks,
        marks: barMarks,
        edgeText: barEdgeText,
        positionText: barPositionText,
        tipLines: barTipLines,
        dayOffset: barDayOffset,
    });
}
