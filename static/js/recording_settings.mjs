export const RECORDING_LIMITS = Object.freeze({
    fps: Object.freeze({ min: 1, max: 60, fallback: 30, step: 1 }),
    bitrateMbps: Object.freeze({ min: 1, max: 30, fallback: 6, step: 1 }),
    slowdownFactor: Object.freeze({ min: 1, max: 20, fallback: 1, step: 1 }),
    scaleFactor: Object.freeze({ min: 1, max: 3, fallback: 1, step: 0.25 }),
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

function normalizeNumber(value, limits) {
    const number = finiteNumber(value, limits.fallback);
    const clamped = Math.max(limits.min, Math.min(limits.max, number));
    if (!limits.step) return clamped;
    const stepped = limits.min + Math.round((clamped - limits.min) / limits.step) * limits.step;
    return Number(stepped.toFixed(10));
}

export function normalizeRecordingFps(value) {
    return normalizeInteger(value, RECORDING_LIMITS.fps);
}

export function normalizeRecordingBitrateMbps(value) {
    return normalizeInteger(value, RECORDING_LIMITS.bitrateMbps);
}

export function normalizeRecordingSlowdownFactor(value) {
    return normalizeInteger(value, RECORDING_LIMITS.slowdownFactor);
}

export function normalizeRecordingScaleFactor(value) {
    return normalizeNumber(value, RECORDING_LIMITS.scaleFactor);
}

export function isValidRecordingNumber(value, limits) {
    const number = Number(value);
    if (value === '' || !Number.isFinite(number) || number < limits.min || number > limits.max) {
        return false;
    }
    if (!limits.step) return true;
    const steps = (number - limits.min) / limits.step;
    return Math.abs(steps - Math.round(steps)) < 1e-9;
}

export function isValidRecordingInteger(value, limits) {
    const number = Number(value);
    return Number.isInteger(number) && isValidRecordingNumber(value, limits);
}

export function recordingQualityProfileFor(fps, bitrateMbps) {
    const normalizedFps = normalizeRecordingFps(fps);
    const normalizedBitrate = normalizeRecordingBitrateMbps(bitrateMbps);
    const match = Object.entries(RECORDING_QUALITY_PROFILES).find(([, profile]) => (
        profile.fps === normalizedFps && profile.bitrateMbps === normalizedBitrate
    ));
    return match ? match[0] : 'custom';
}
