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

// Débit conseillé pour une sortie donnée.
//
// Le débit ne suivait pas la résolution : 6 Mbit/s convient en 1080p, mais la
// même valeur en 1440p ou 2160p redonne une image en blocs — le détail gagné au
// rendu serait reperdu à l'encodage.
//
// 0,1 bit par pixel et par image est exactement ce que valent les 6 Mbit/s du
// profil « Standard » en 1920x1080 à 30 images/s : la référence actuelle est
// donc conservée, et seule une sortie plus grande fait monter le débit.
export const RECOMMENDED_BITS_PER_PIXEL = 0.1;

export function recommendedBitrateMbps({ width, height, fps } = {}) {
    const pixels = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
    const frames = normalizeRecordingFps(fps);
    const mbps = RECOMMENDED_BITS_PER_PIXEL * pixels * frames / 1_000_000;
    return normalizeRecordingBitrateMbps(Math.round(mbps));
}

// True quand la résolution demande plus que le débit maximal réglable : le
// plafond devient alors le facteur limitant, et cela mérite d'être dit.
export function bitrateIsCappedFor({ width, height, fps } = {}) {
    const pixels = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
    const raw = RECOMMENDED_BITS_PER_PIXEL * pixels * normalizeRecordingFps(fps) / 1_000_000;
    return Math.round(raw) > RECORDING_LIMITS.bitrateMbps.max;
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
