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

// Volume de la musique : part du volume du fichier d'origine (1 = tel quel),
// de 0 à AUDIO_VOLUME_MAX. Au-delà de 1, un morceau calme est relevé.
export const AUDIO_VOLUME_MAX = 4;

// Volume lu ou saisi, borné. Le 0 est un vrai réglage, pas une valeur
// absente : un `Number(v) || 1` le transformait en 100 %. Seule une valeur
// manquante ou illisible retombe sur le volume d'origine.
export function normalizeAudioVolume(value) {
    if (value === null || value === undefined || value === '') return 1;
    const number = Number(value);
    if (!Number.isFinite(number)) return 1;
    return Math.max(0, Math.min(AUDIO_VOLUME_MAX, number));
}

// Curseur du volume, de 0 à VOLUME_SLIDER_STEPS : 100 % au milieu. La moitié
// gauche va de 0 à 100 %, la droite de 100 % à AUDIO_VOLUME_MAX — sinon les
// réglages courants (0 à 100 %) n'occuperaient qu'un quart de sa largeur.
export const VOLUME_SLIDER_STEPS = 1000;

// Volume à une position du curseur, arrondi au pour cent affiché.
export function volumeFromSlider(position) {
    const p = Math.max(0, Math.min(1, (Number(position) || 0) / VOLUME_SLIDER_STEPS));
    const volume = p <= 0.5 ? p * 2 : 1 + (p - 0.5) * 2 * (AUDIO_VOLUME_MAX - 1);
    return Math.round(volume * 100) / 100;
}

// Position du curseur pour un volume.
export function sliderFromVolume(volume) {
    const v = normalizeAudioVolume(volume);
    const p = v <= 1 ? v / 2 : 0.5 + (v - 1) / (2 * (AUDIO_VOLUME_MAX - 1));
    return Math.round(p * VOLUME_SLIDER_STEPS);
}

// Volume du niveau sonore standard pour le gain calculé d'un morceau (cf.
// normalizationGain, music_analysis.mjs), arrondi au pour cent. `limited` :
// il en faudrait davantage que ce que permet le curseur (morceau très faible).
export function standardLevelVolume(gain) {
    if (!(gain > 0)) return { volume: 1, limited: false };
    return {
        volume: Math.round(Math.min(gain, AUDIO_VOLUME_MAX) * 100) / 100,
        limited: gain > AUDIO_VOLUME_MAX + 0.005,
    };
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

// Format réellement utilisable par le MediaRecorder de ce navigateur.
//
// Le format demandé n'est pas encodable partout : Firefox n'encode pas le VP9
// (le format par défaut) mais sait faire du VP8. Abandonner la capture rapide
// pour autant serait disproportionné — on retombe sur le WebM le plus proche.
// Les replis restent en WebM : c'est le conteneur attendu par le traitement
// serveur. Renvoie null quand rien n'est encodable.
export const DEFAULT_RECORDER_MIME = 'video/webm;codecs=vp9';

const RECORDER_MIME_FALLBACKS = Object.freeze([
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
]);

export function resolveRecorderMimeType(preferred, isSupported) {
    const candidates = [preferred || DEFAULT_RECORDER_MIME, ...RECORDER_MIME_FALLBACKS];
    for (const mime of candidates) {
        try { if (isSupported(mime)) return mime; } catch (_) {}
    }
    return null;
}

// Variante branchée sur le navigateur courant. Un MediaRecorder sans
// isTypeSupported ne permet pas de tester : le format demandé est tenté tel quel.
export function browserRecorderMimeType(preferred) {
    if (typeof MediaRecorder === 'undefined') return null;
    if (typeof MediaRecorder.isTypeSupported !== 'function') return preferred || DEFAULT_RECORDER_MIME;
    return resolveRecorderMimeType(preferred, (mime) => MediaRecorder.isTypeSupported(mime));
}

// Nom court d'un format, pour les messages (les codecs ne se traduisent pas).
export function recorderMimeLabel(mime) {
    const value = String(mime || '').toLowerCase();
    if (value.includes('vp9')) return 'VP9';
    if (value.includes('vp8')) return 'VP8';
    if (value.includes('mp4')) return 'H.264 (MP4)';
    return 'WebM';
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
