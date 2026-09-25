import { IMPULSE_MAX_STAGGER_MS } from './flash_impulse.mjs';

const DEFAULT_FPS = 30;
const DEFAULT_END_HOLD_MS = 3000;

// Les navigateurs (Chromium, Firefox, WebKit) plafonnent le taux de lecture d'un
// <video> à 16x. Au-delà, la valeur est ignorée silencieusement : aucune erreur,
// mais la vidéo est lue — donc ré-encodée — au mauvais rythme.
export const MAX_BROWSER_PLAYBACK_RATE = 16;

// Bornes des entrées temporelles de l'UI. Elles sont volontairement larges :
// la durée minimale réalisable dépend du nombre de jours et du fps, et elle est
// calculée par buildTimingPlan plutôt que figée ici.
export const TIMING_LIMITS = Object.freeze({
    daysPerSecond: { min: 0.01, max: 1000, fallback: 20 },
    extraEndSeconds: { min: 0, max: 3600, fallback: 0 },
    totalDurationSeconds: { min: 1, max: 6 * 3600, fallback: 60 },
});
// La durée totale se décompose (animation + pause auto + temps additionnel),
// donc sa borne haute doit couvrir l'animation seule plus ces deux pauses.
const TOTAL_DURATION_MAX_MS =
    TIMING_LIMITS.totalDurationSeconds.max * 1000
    + 60 * 1000
    + TIMING_LIMITS.extraEndSeconds.max * 1000;

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function normalizeVideoFps(value, fallback = DEFAULT_FPS) {
    return Math.max(1, Math.min(60, Math.round(finiteNumber(value, fallback))));
}

export function serverNormalizationFactor(slowdown, normalizeEnabled) {
    const safeSlowdown = Math.max(1, finiteNumber(slowdown, 1));
    return normalizeEnabled && safeSlowdown > 1 ? safeSlowdown : 1;
}

// Borne le facteur d'accélération demandé au maximum réellement applicable par
// un <video>, et signale à l'appelant que la demande n'a pas pu être honorée.
export function clampPlaybackRate(factor, max = MAX_BROWSER_PLAYBACK_RATE) {
    const safeMax = Math.max(1, finiteNumber(max, MAX_BROWSER_PLAYBACK_RATE));
    const requested = Math.max(1, finiteNumber(factor, 1));
    const rate = Math.min(requested, safeMax);
    return { requested, rate, clamped: rate < requested };
}

// Nombre de jours calendaires entre deux dates, bornes comprises.
// Les dates sont normalisées en UTC avant soustraction : en heure locale le
// jour du changement d'heure dure 23 h ou 25 h (France) et une division des
// timestamps locaux par 86 400 000 donnerait un résultat faux.
export function inclusiveDayCount(startDate, endDate) {
    const start = _toUTCMidnight(startDate);
    const end = _toUTCMidnight(endDate);
    if (start === null || end === null || end < start) return 1;
    return Math.round((end - start) / 86400000) + 1;
}

// Variante stricte : null quand les dates sont invalides ou que la fin
// précède le début — la validation peut alors expliquer l'erreur au lieu
// d'animer un seul jour sans avertissement.
export function strictDayCount(startDate, endDate) {
    const start = _toUTCMidnight(startDate);
    const end = _toUTCMidnight(endDate);
    if (start === null || end === null || end < start) return null;
    return Math.round((end - start) / 86400000) + 1;
}

function _toUTCMidnight(value) {
    if (!(value instanceof Date)) return null;
    const time = value.getTime();
    if (!Number.isFinite(time)) return null;
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
}

export function automaticEndHoldMs({
    tailFreezeMs = DEFAULT_END_HOLD_MS,
    flashMode = 'none',
    flashDurationMs = 0,
} = {}) {
    const configuredHold = Math.max(0, finiteNumber(tailFreezeMs, DEFAULT_END_HOLD_MS));
    // Le flash impulsion peut démarrer jusqu'à IMPULSE_MAX_STAGGER_MS après le
    // dernier jour : la pause finale doit aussi couvrir ce décalage.
    const flashHold = flashMode && flashMode !== 'none'
        ? Math.max(0, finiteNumber(flashDurationMs, 0))
            + (flashMode === 'impulse' ? IMPULSE_MAX_STAGGER_MS : 0)
        : 0;
    return Math.max(configuredHold, flashHold);
}

// ---------- Validation des entrées ----------

// Validation stricte d'une saisie numérique positive : refuse les chaînes
// vides, non numériques, nulles, négatives, NaN et infinies. value n'est
// défini que si ok — jamais de correction silencieuse.
export function parsePositiveNumber(raw, { allowZero = false } = {}) {
    if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
    if (typeof raw === 'string' && raw.trim() === '') return { ok: false, reason: 'empty' };
    const v = Number(raw);
    if (!Number.isFinite(v)) return { ok: false, reason: 'not-a-number' };
    if (allowZero ? v < 0 : v <= 0) return { ok: false, reason: 'non-positive' };
    return { ok: true, value: v };
}

// Même règle avec bornes : une valeur hors [min, max] est invalide, elle n'est
// pas ramenée dans la plage — l'erreur doit être expliquée à l'utilisateur.
export function parseBoundedNumber(raw, limits, { allowZero = false } = {}) {
    const p = parsePositiveNumber(raw, { allowZero });
    if (!p.ok) return p;
    if (limits && (p.value < limits.min || p.value > limits.max)) {
        return { ok: false, reason: 'out-of-range', value: p.value, limits };
    }
    return p;
}

// Saisie "mm:ss" (ou "h:mm:ss", ou des secondes décimales "83.5") -> ms.
export function parseDurationText(raw) {
    if (typeof raw !== 'string') return { ok: false, reason: 'not-a-number' };
    const s = raw.trim();
    if (!s) return { ok: false, reason: 'empty' };
    const parts = s.split(':');
    if (parts.length > 3) return { ok: false, reason: 'format' };
    let seconds = 0;
    for (const part of parts) {
        const p = parsePositiveNumber(part, { allowZero: true });
        if (!p.ok) return { ok: false, reason: 'not-a-number' };
        seconds = seconds * 60 + p.value;
    }
    // Dans "mm:ss", les segments de droite restent < 60.
    for (let i = 1; i < parts.length; i++) {
        if (Number(parts[i]) >= 60) return { ok: false, reason: 'format' };
    }
    if (!(seconds > 0)) return { ok: false, reason: 'non-positive' };
    return { ok: true, value: Math.round(seconds * 1000) };
}

// ---------- Formatage ----------

// 295 000 ms -> "4:55" ; 3 720 000 ms -> "1:02:00".
export function formatMmSs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0:00';
    const totalSec = Math.floor(ms / 1000);
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    const ss = String(s).padStart(2, '0');
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
}

// 295 000 ms -> "4 min 55 s" ; 40 000 ms -> "40 s".
export function formatDurationHuman(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0 s';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const parts = [];
    if (h > 0) parts.push(`${h} h`);
    if (m > 0) parts.push(`${m} min`);
    if (s > 0 || parts.length === 0) parts.push(`${s} s`);
    return parts.join(' ');
}

// ---------- Plan de timing unifié ----------

// `rhythm` décrit la source unique du tempo de l'animation principale :
//   { mode: 'rate',     daysPerSecond }      ex. 20 jours/s
//   { mode: 'duration', totalDurationMs }    durée finale demandée (hors pauses ? cf. ci-dessous)
//   { mode: 'music',    musicDurationMs }    calé sur la durée du fichier audio
//
// Pour 'duration' et 'music', la durée demandée désigne la durée TOTALE de la
// vidéo (animation + pause auto + temps additionnel) : c'est le contrat que
// "calé sur la musique" impose au fichier muxé.
//
// Retourne un plan : compte de jours, décomposition des durées, frames,
// minimum réalisable, `errors` (entrées invalides — ne pas lancer) et
// `warnings` (limites appliquées, ex. pincement au minimum ou musique plus
// courte que le minimum).
export function buildTimingPlan({
    startDate,
    endDate,
    dayCount: dayCountOverride,
    rhythm,
    fps = DEFAULT_FPS,
    flashMode = 'none',
    flashDurationMs = 0,
    tailFreezeMs = DEFAULT_END_HOLD_MS,
    extraEndSeconds = 0,
} = {}) {
    const errors = [];
    const warnings = [];

    const safeFps = normalizeVideoFps(fps);
    let days;
    if (dayCountOverride !== undefined) {
        days = Math.floor(finiteNumber(dayCountOverride, 0));
    } else {
        // Chemin strict : fin < début ou date invalide doit être signalée,
        // pas ramenée à 1 jour par inclusiveDayCount.
        const strict = strictDayCount(startDate, endDate);
        days = strict === null ? 0 : strict;
    }
    if (!Number.isFinite(days) || days <= 0) errors.push('range');

    const endHoldMs = automaticEndHoldMs({ tailFreezeMs, flashMode, flashDurationMs });
    const extraParsed = parseBoundedNumber(extraEndSeconds, TIMING_LIMITS.extraEndSeconds, { allowZero: true });
    if (!extraParsed.ok) errors.push('extraEnd');
    const extraEndMs = extraParsed.ok ? Math.round(extraParsed.value * 1000) : 0;

    const minAnimationMs = days > 0 ? Math.ceil(days / safeFps * 1000) : 0;
    const minTotalMs = minAnimationMs + endHoldMs + extraEndMs;

    let timePerDayMs = NaN;
    let animationMs = 0;
    let requestedTotalMs = NaN;
    let clampedToMinimum = false;

    const mode = rhythm && rhythm.mode;
    if (mode === 'rate') {
        const p = parseBoundedNumber(rhythm.daysPerSecond, TIMING_LIMITS.daysPerSecond);
        if (!p.ok) {
            errors.push('daysPerSecond');
        } else {
            timePerDayMs = 1000 / p.value;
            animationMs = days > 0 ? days * timePerDayMs : 0;
        }
    } else if (mode === 'duration' || mode === 'music') {
        const requested = mode === 'music' ? rhythm.musicDurationMs : rhythm.totalDurationMs;
        const p = parseBoundedNumber(requested, { min: 1, max: TOTAL_DURATION_MAX_MS });
        if (!p.ok) {
            errors.push(mode === 'music' ? 'musicDuration' : 'totalDuration');
        } else if (days > 0) {
            requestedTotalMs = p.value;
            const animRequested = Math.max(0, p.value - endHoldMs - extraEndMs);
            if (animRequested < minAnimationMs) {
                // Trop court pour une frame par jour : le minimum est appliqué
                // et signalé au lieu d'être corrigé silencieusement.
                clampedToMinimum = true;
                animationMs = minAnimationMs;
                warnings.push({
                    type: 'minimum-total',
                    minimumMs: minTotalMs,
                    appliedMs: minTotalMs,
                    requestedMs: p.value,
                    reason: 'one-frame-per-day',
                });
                if (mode === 'music') {
                    warnings.push({
                        type: 'music-shorter-than-minimum',
                        musicMs: p.value,
                        appliedMs: minTotalMs,
                    });
                }
            } else {
                animationMs = animRequested;
            }
            timePerDayMs = days > 0 ? animationMs / days : NaN;
        }
    } else {
        errors.push('rhythm');
    }

    const totalDurationMs = animationMs + endHoldMs + extraEndMs;
    const frames = (days > 0 && Number.isFinite(timePerDayMs))
        ? buildImageTimingPlan({
            dayCount: days,
            timePerDayMs,
            fps: safeFps,
            extraEndSeconds: extraEndMs / 1000,
            tailFreezeMs,
            flashMode,
            flashDurationMs,
        })
        : { baseFrameCount: 0, tailFrameCount: 0, totalFrameCount: 0, framesPerDayAverage: 0 };

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        clampedToMinimum,
        dayCount: Math.max(0, days),
        fps: safeFps,
        timePerDayMs,
        daysPerSecond: Number.isFinite(timePerDayMs) && timePerDayMs > 0 ? 1000 / timePerDayMs : NaN,
        animationMs,
        endHoldMs,
        extraEndMs,
        totalDurationMs,
        requestedTotalDurationMs: requestedTotalMs,
        minimumAnimationMs: minAnimationMs,
        minimumTotalDurationMs: minTotalMs,
        baseFrameCount: frames.baseFrameCount,
        tailFrameCount: frames.tailFrameCount,
        totalFrameCount: frames.totalFrameCount,
        framesPerDayAverage: frames.framesPerDayAverage,
        // Durée de la musique retenue pour l'UI : la comparaison avec la vidéo
        // (plus courte / plus longue → coupée en fin de vidéo) est affichée par
        // ui.js, qui seul connaît le fichier sélectionné.
        musicDurationMs: mode === 'music' ? requestedTotalMs : NaN,
    };
}

// ---------- Estimation de charge ----------

// Estimation du nombre maximal de flashs simultanément actifs : une journée
// produisant `maxPointsPerDay` points reste "visible" pendant flashDurationMs ;
// à timePerDayMs par jour, jusqu'à 1 + flash/tpd journées se superposent.
export function estimateMaxSimultaneousFlashes({ maxPointsPerDay = 0, flashDurationMs = 0, timePerDayMs = 1 } = {}) {
    const pts = Math.max(0, Math.floor(finiteNumber(maxPointsPerDay, 0)));
    const flash = Math.max(0, finiteNumber(flashDurationMs, 0));
    const tpd = Math.max(1e-6, finiteNumber(timePerDayMs, 1));
    if (pts <= 0 || flash <= 0) return 0;
    return Math.ceil(pts * (1 + flash / tpd));
}

// Seuils de l'avertissement de charge : au-delà, l'UI suggère de raccourcir le
// flash, de ralentir l'animation ou de passer en mode Images.
export const LOAD_WARNING_FLASH_THRESHOLD = 500;
export const LOAD_WARNING_FRAME_THRESHOLD = 20000;
// Coût moyen supposé d'une capture en mode Images (ms par frame), pour donner
// un ordre de grandeur du temps de capture avant de lancer.
export const IMAGE_CAPTURE_MS_PER_FRAME = 40;

export function buildLoadEstimate({ plan, maxPointsPerDay = 0, flashDurationMs = 0 } = {}) {
    if (!plan || !plan.valid) return null;
    const flashes = estimateMaxSimultaneousFlashes({
        maxPointsPerDay,
        flashDurationMs,
        timePerDayMs: plan.timePerDayMs,
    });
    const warnings = [];
    if (flashes > LOAD_WARNING_FLASH_THRESHOLD) warnings.push('flashes');
    if (plan.totalFrameCount > LOAD_WARNING_FRAME_THRESHOLD) warnings.push('frames');
    return {
        maxSimultaneousFlashes: flashes,
        totalFrames: plan.totalFrameCount,
        videoDurationMs: plan.totalDurationMs,
        imageCaptureEstimateMs: plan.totalFrameCount * IMAGE_CAPTURE_MS_PER_FRAME,
        warnings,
    };
}

// Plan de timing du mode Images (capture frame par frame, donc vitesse libre).
//
// Garanties :
//  - au moins une image par jour animé (sinon ce jour serait invisible en vidéo) ;
//  - la pause de fin se prolonge assez pour que le dernier flash termine son
//    animation (fixe : durée D ; duration/impulse : cf. automaticEndHoldMs) ;
//  - la durée totale correspond exactement à totalFrameCount frames au fps
//    demandé (la durée réelle est quantifiée par la grille fps).
export function buildImageTimingPlan({
    dayCount,
    timePerDayMs,
    fps,
    extraEndSeconds = 0,
    tailFreezeMs = DEFAULT_END_HOLD_MS,
    flashMode = 'none',
    flashDurationMs = 0,
} = {}) {
    const safeDays = Math.max(1, Math.round(finiteNumber(dayCount, 1)));
    const safeFps = normalizeVideoFps(fps);
    const safeTimePerDayMs = Math.max(0, finiteNumber(timePerDayMs, 0));
    const extraEndMs = Math.max(0, finiteNumber(extraEndSeconds, 0)) * 1000;
    const endHoldMs = automaticEndHoldMs({ tailFreezeMs, flashMode, flashDurationMs });

    // Une date doit apparaître dans au moins une frame. Au-delà de ce minimum,
    // les fractions de frame sont réparties entre les jours au lieu d'arrondir
    // chaque jour séparément (ce qui créait une dérive cumulée importante).
    const requestedBaseFrames = Math.round(safeDays * safeTimePerDayMs * safeFps / 1000);
    const baseFrameCount = Math.max(safeDays, requestedBaseFrames);
    const tailFrameCount = Math.max(0, Math.round((endHoldMs + extraEndMs) * safeFps / 1000));
    const totalFrameCount = baseFrameCount + tailFrameCount;

    return {
        fps: safeFps,
        dayCount: safeDays,
        baseFrameCount,
        tailFrameCount,
        totalFrameCount,
        framesPerDayAverage: baseFrameCount / safeDays,
        endHoldMs,
        extraEndMs,
        minimumDurationMs: (safeDays / safeFps * 1000) + endHoldMs + extraEndMs,
        actualDurationMs: totalFrameCount / safeFps * 1000,
    };
}

export function framesForDay(dayIndex, dayCount, baseFrameCount) {
    const safeDays = Math.max(1, Math.round(finiteNumber(dayCount, 1)));
    const safeFrames = Math.max(safeDays, Math.round(finiteNumber(baseFrameCount, safeDays)));
    const index = Math.max(0, Math.min(safeDays - 1, Math.round(finiteNumber(dayIndex, 0))));
    const before = Math.round(index * safeFrames / safeDays);
    const after = Math.round((index + 1) * safeFrames / safeDays);
    return Math.max(1, after - before);
}
