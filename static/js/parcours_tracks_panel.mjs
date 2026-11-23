// Panneau « Traces GPS » de la page Parcours (lot 5) : liste des traces
// importées, réglage du décalage UTC, envoi et suppression. L'état du
// parcours ouvert (entrées, reconstruction, fuseau) arrive par `getState()`
// — le module reste sans import de parcours_data.js ; les opérations qui
// touchent le parcours entier (envoi mutualisé, rechargement, verrou) sont
// injectées en dépendances.
import { showToast, t } from './notifications.js';
import { formatUtcOffset, offsetSourceLabel, trackRange } from './parcours_labels.mjs';
import { parcoursStops } from './parcours_model.mjs';
import { OFFSET_COMPUTER } from './parcours_tracks.mjs';

const el = (id) => document.getElementById(id);

// Décalages proposés pour l'heure locale des traces : de −12 h à +14 h, au
// quart d'heure (fuseaux à 30 et 45 minutes compris).
const UTC_OFFSET_CHOICES = Array.from({ length: (26 * 60) / 15 + 1 }, (_, i) => -12 * 60 + i * 15);

// « Fuseau de cet ordinateur » : suspect quand le parcours se passe loin du
// centre habituel des trouvailles — l'ordinateur peut avoir gardé le fuseau
// de la maison. Longitude : ≈ un fuseau par 10° d'écart.
const UTC_SUSPECT_LON_DEG = 10;

// deps : { getState, button, fetchJson, adjustmentsLocked, runUpload,
//          reloadAdjustments, receiveAdjustments }
// getState() → { inputs, ordered, utcOffset, homeCenter, trackMatches, selectedId }
export function createTracksPanel(deps) {
    const s = () => deps.getState() || {};

    function computerOffsetSuspect() {
        const { inputs, ordered, utcOffset, homeCenter } = s();
        if (utcOffset?.source !== OFFSET_COMPUTER || !(inputs?.tracks || []).length) return false;
        if (!homeCenter || !ordered) return false;
        return parcoursStops(ordered).some((stop) => {
            const d = Math.abs(stop.lon - homeCenter.lon);
            return Math.min(d, 360 - d) > UTC_SUSPECT_LON_DEG;
        });
    }

    function render() {
        const { inputs, utcOffset, trackMatches } = s();
        const card = el('parcoursTracksCard');
        if (!card) return;
        card.hidden = !inputs;
        if (!inputs) return;
        const tracks = inputs.tracks || [];
        const count = tracks.length === 1 ? t('1 trace') : t('${n} traces', { n: tracks.length });
        const matched = trackMatches.size === 1
            ? t('1 étape calée sur une trace')
            : t('${n} étapes calées sur une trace', { n: trackMatches.size });
        const summaryText = tracks.length ? `${count}, ${matched}` : t('Aucune trace pour ce parcours.');
        const summary = el('parcoursTrackSummary');
        if (summary) summary.textContent = summaryText;
        // Résumé lisible section repliée (en-tête de la section).
        const hint = el('parcoursTracksHint');
        if (hint) hint.textContent = summaryText;
        const offset = el('parcoursUtcOffset');
        if (offset) {
            if (!offset.options.length) {
                const auto = document.createElement('option');
                auto.value = '';
                offset.append(auto);
                for (const minutes of UTC_OFFSET_CHOICES) {
                    const opt = document.createElement('option');
                    opt.value = String(minutes);
                    opt.textContent = formatUtcOffset(minutes);
                    offset.append(opt);
                }
            }
            const manual = inputs.parcours?.utc_offset_minutes;
            offset.options[0].textContent = Number.isFinite(manual)
                ? t('Automatique')
                : t('Automatique : ${offset} (${source})', { offset: formatUtcOffset(utcOffset.minutes), source: offsetSourceLabel(utcOffset.source) });
            offset.value = Number.isFinite(manual) ? String(manual) : '';
        }
        const warn = el('parcoursUtcOffsetWarn');
        if (warn) {
            warn.hidden = !computerOffsetSuspect();
            const warnText = el('parcoursUtcOffsetWarnText');
            if (!warn.hidden && warnText) {
                warnText.textContent = t('Heures des traces calées sur le fuseau de cet ordinateur (${offset}) — vérifiez-le pour un parcours loin de chez vous.', { offset: formatUtcOffset(utcOffset.minutes) });
            }
        }
        const list = el('parcoursTracks');
        if (list) {
            list.replaceChildren(...tracks.map((track) => {
                const item = document.createElement('div');
                item.className = 'd-flex align-items-center gap-2 py-1 parcours-track';
                item.dataset.trackId = String(track.id);
                const text = document.createElement('div');
                text.className = 'flex-grow-1 min-w-0';
                const name = document.createElement('div');
                name.className = 'text-truncate';
                name.textContent = track.name || t('Trace');
                const detail = document.createElement('div');
                detail.className = 'small text-muted';
                const matched = [...trackMatches.values()].filter((m) => m.trackId === track.id).length;
                detail.textContent = [
                    trackRange(track, utcOffset.minutes),
                    t('${n} points', { n: track.pointCount }),
                    matched === 1 ? t('1 étape calée') : t('${n} étapes calées', { n: matched }),
                ].filter(Boolean).join(' · ');
                text.append(name, detail);
                const remove = deps.button('btn btn-sm btn-ghost-danger parcours-track-delete', 'ti-trash', t('Supprimer la trace'));
                remove.addEventListener('click', () => deleteTrack(track.id));
                item.append(text, remove);
                return item;
            }));
        }
    }

    async function upload(files) {
        const { selectedId } = s();
        if (!selectedId || deps.adjustmentsLocked() || files.length === 0) return;
        // Fichiers glissés n'importe où : la section repliée montre l'envoi.
        const card = el('parcoursTracksCard');
        if (card) card.open = true;
        // Même garde que les photos : la destination est le parcours ouvert
        // au début de l'envoi (partagée dans runUpload).
        await deps.runUpload('track', files);
    }

    async function deleteTrack(id) {
        const { selectedId } = s();
        if (!selectedId || deps.adjustmentsLocked()) return;
        const pid = selectedId;
        try {
            await deps.fetchJson(`/api/parcours/${pid}/tracks/${id}`, { method: 'DELETE' });
            await deps.reloadAdjustments(pid, { tracks: true });
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    async function setUtcOffset(value) {
        const { selectedId, inputs } = s();
        if (!selectedId || deps.adjustmentsLocked()) return;
        const pid = selectedId;
        try {
            const body = await deps.fetchJson(`/api/parcours/${pid}`, {
                method: 'PATCH', body: JSON.stringify({ utc_offset_minutes: value }),
            });
            if (pid !== s().selectedId) return;
            inputs.parcours = body.parcours;
            deps.receiveAdjustments({}, pid);
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    function bind() {
        el('btnParcoursTracksStop')?.addEventListener('click', () => deps.cancelUploads('track'));
        const input = el('parcoursTrackInput');
        el('btnParcoursAddTracks')?.addEventListener('click', () => input?.click());
        input?.addEventListener('change', () => {
            const files = [...(input.files || [])];
            input.value = '';
            upload(files);
        });
        const offset = el('parcoursUtcOffset');
        offset?.addEventListener('change', () => setUtcOffset(offset.value === '' ? null : Number(offset.value)));
    }

    return { bind, render, upload, offsetSuspect: computerOffsetSuspect };
}
