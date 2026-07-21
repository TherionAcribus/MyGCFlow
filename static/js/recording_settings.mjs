export const RECORDING_LIMITS = Object.freeze({
    fps: Object.freeze({ min: 1, max: 60, fallback: 30 }),
    bitrateMbps: Object.freeze({ min: 1, max: 30, fallback: 6 }),
});

export const RECORDING_QUALITY_PROFILES = Object.freeze({
    compact: Object.freeze({ fps: 24, bitrateMbps: 4 }),
    standard: Object.freeze({ fps: 30, bitrateMbps: 6 }),
    fluid: Object.freeze({ fps: 60, bitrateMbps: 12 }),
});

function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeInteger(value, limits) {
    const rounded = Math.round(finiteNumber(value, limits.fallback));
    return Math.max(limits.min, Math.min(limits.max, rounded));
}

export function normalizeRecordingFps(value) {
    return normalizeInteger(value, RECORDING_LIMITS.fps);
}

export function normalizeRecordingBitrateMbps(value) {
    return normalizeInteger(value, RECORDING_LIMITS.bitrateMbps);
}

export function isValidRecordingInteger(value, limits) {
    const number = Number(value);
    return value !== ''
        && Number.isFinite(number)
        && Number.isInteger(number)
        && number >= limits.min
        && number <= limits.max;
}

export function recordingQualityProfileFor(fps, bitrateMbps) {
    const normalizedFps = normalizeRecordingFps(fps);
    const normalizedBitrate = normalizeRecordingBitrateMbps(bitrateMbps);
    const match = Object.entries(RECORDING_QUALITY_PROFILES).find(([, profile]) => (
        profile.fps === normalizedFps && profile.bitrateMbps === normalizedBitrate
    ));
    return match ? match[0] : 'custom';
}

export function estimateRecordingSizeBytes({ bitrateMbps, durationMs }) {
    const safeBitrate = normalizeRecordingBitrateMbps(bitrateMbps);
    const safeDurationMs = Math.max(0, finiteNumber(durationMs, 0));
    return safeBitrate * 1_000_000 * (safeDurationMs / 1000) / 8;
}

export function formatEstimatedFileSize(bytes) {
    const safeBytes = Math.max(0, finiteNumber(bytes, 0));
    const megabytes = safeBytes / 1_000_000;
    if (megabytes >= 1000) {
        return `${(megabytes / 1000).toFixed(1)} Go`;
    }
    if (megabytes >= 100) {
        return `${Math.round(megabytes)} Mo`;
    }
    return `${megabytes.toFixed(1)} Mo`;
}
