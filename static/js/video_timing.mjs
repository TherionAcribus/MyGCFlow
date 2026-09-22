import { IMPULSE_MAX_STAGGER_MS } from './flash_impulse.mjs';

const DEFAULT_FPS = 30;
const DEFAULT_END_HOLD_MS = 3000;

// Les navigateurs (Chromium, Firefox, WebKit) plafonnent le taux de lecture d'un
// <video> à 16x. Au-delà, la valeur est ignorée silencieusement : aucune erreur,
// mais la vidéo est lue — donc ré-encodée — au mauvais rythme.
export const MAX_BROWSER_PLAYBACK_RATE = 16;

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

export function inclusiveDayCount(startDate, endDate) {
    if (!(startDate instanceof Date) || !(endDate instanceof Date)) return 1;
    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    const delta = Math.floor((end - start) / 86400000) + 1;
    return Math.max(1, Number.isFinite(delta) ? delta : 1);
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
