import * as pkg from './index.js';
import { buildImageTimingPlan } from './video_timing.mjs';

// Fonction pour convertir Hex en composantes RGB
export function hexToRgb(hex) {
    if (hex.startsWith('#')) hex = hex.slice(1); // Enlève le '#' si présent
    if (hex.length === 3) { // Support pour le format hex court
        hex = Array.from(hex).map(x => x + x).join('');
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return {r, g, b};
}

// permet de générer un certificat cfrf
export function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            // Vérifie si le cookie commence par le nom demandé suivi de "="
            if (cookie.startsWith(name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}


// Calcule un total de frames global puis répartit les fractions entre les jours.
// L'ancien calcul arrondissait chaque jour séparément et accumulait la dérive.
export function updateInfosForPictures(){
    const plan = buildImageTimingPlan({
        dayCount: pkg.options.date.deltaDays,
        timePerDayMs: pkg.options.animation.timePerDay,
        fps: pkg.options.record.fps,
        extraEndSeconds: pkg.options.animation.extraEndSeconds,
        tailFreezeMs: pkg.options.record?.mediaRecorder?.tailFreezeMs,
        flashMode: pkg.options.flash.mode,
        flashDurationMs: pkg.options.flash.duration,
    });

    pkg.options.record.framesPerDay = plan.framesPerDayAverage;
    pkg.options.record.baseFrameCount = plan.baseFrameCount;
    pkg.options.record.nbOfImages = plan.totalFrameCount;
    pkg.options.record.numberOfDigits = Math.max(1, String(plan.totalFrameCount).length);
    pkg.options.record.framesPerSec = plan.fps;
    pkg.options.record.flashFrames = Math.max(1, Math.round(
        Math.max(0, Number(pkg.options.flash.duration) || 0) * plan.fps / 1000
    ));
    pkg.options.record.extraFrames = plan.tailFrameCount;
    pkg.options.record.automaticEndHoldMs = plan.endHoldMs;
}


// Parse une date "YYYY-MM-DD" (ou Date) en Date calendaire locale à minuit.
// `new Date("2026-03-28")` parserait en UTC minuit — getDate() rendrait alors
// le jour précédent dans les fuseaux à l'ouest de Greenwich.
export function parseLocalDate(value){
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value !== 'string' || !value) return null;
    const d = new Date(`${value.slice(0, 10)}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
}

// --- Format d'affichage des dates -----------------------------------------
// Préférence `options.options.dateFormat` (miroir de `date_format` dans
// settings.json) : « auto » suit la langue de l'interface (fr → jj/mm/aaaa,
// en → mm/jj/aaaa), « eu » et « us » la forcent.

export function getDateFormatPref(){
    const pref = pkg.options?.options?.dateFormat;
    if (pref === 'eu' || pref === 'us') return pref;
    // « auto » : la langue de la page servie (TRANSLATIONS.current_lang) est
    // connue avant même que les préférences ne soient chargées ; la langue des
    // options sert de repli.
    const lang = (typeof window !== 'undefined' && window.TRANSLATIONS?.current_lang)
        || pkg.options?.options?.language;
    return lang === 'en' ? 'us' : 'eu';
}

// Format attendu par les datepickers Tempus Dominus (tokens : dd jour,
// MM mois, yyyy année).
export function tdDatePickerFormat(){
    return getDateFormatPref() === 'us' ? 'MM/dd/yyyy' : 'dd/MM/yyyy';
}

// Date ISO « yyyy-mm-dd » — le seul format échangé avec le serveur.
export function formatDateIso(date){
    if (!(date instanceof Date) || isNaN(date.getTime())) return '';
    const dd = String(date.getDate()).padStart(2,'0');
    const mm = String(date.getMonth()+1).padStart(2,'0');
    return `${date.getFullYear()}-${mm}-${dd}`;
}

// Date courte dans le format choisi : jj/mm/aaaa (« eu ») ou mm/jj/aaaa (« us »).
export function formatDateDisplay(date){
    if (!(date instanceof Date) || isNaN(date.getTime())) return '';
    const first = String(date.getDate()).padStart(2,'0');
    const second = String(date.getMonth()+1).padStart(2,'0');
    const parts = getDateFormatPref() === 'us' ? [second, first] : [first, second];
    return `${parts[0]}/${parts[1]}/${date.getFullYear()}`;
}

// Utilitaires date pour UI Animation
export function parseDateInput(value){
    // Gère jj/mm/aaaa, mm/jj/aaaa et yyyy-mm-dd. Pour les formats à slashes
    // (ambiguïté jour/mois), la préférence de format décide de l'ordre ; si ce
    // premier essai est invalide (mois > 12) on tente l'ordre inverse.
    if (!value || typeof value !== 'string') return null;

    const trimmedValue = value.trim();
    let d, mo, y;

    let m = trimmedValue.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) {
        const a = parseInt(m[1],10), b = parseInt(m[2],10);
        y = parseInt(m[3],10);
        // Format choisi d'abord : « us » lit mois/jour, « eu » jour/mois.
        if (getDateFormatPref() === 'us') {
            mo = a - 1; d = b;
            if (mo < 0 || mo > 11) { mo = b - 1; d = a; }
        } else {
            d = a; mo = b - 1;
            if (mo < 0 || mo > 11) { mo = a - 1; d = b; }
        }
    } else {
        // Essai format yyyy-mm-dd (datepicker / ISO)
        m = trimmedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) {
            y = parseInt(m[1],10);
            mo = parseInt(m[2],10)-1;
            d = parseInt(m[3],10);
        } else {
            return null; // Aucun format reconnu
        }
    }

    const dt = new Date(y, mo, d);
    return isNaN(dt.getTime()) ? null : dt;
}

export function formatDateInput(date){
    return formatDateDisplay(date);
}


// Retourne un temps en fraction de minutes en minutes et secondes
export function convertToMinutesAndSeconds(timeInFraction) {
    // Séparer les minutes et la partie fractionnaire
    const minutes = Math.floor(timeInFraction);
    const fractionalPart = timeInFraction - minutes;

    // Convertir la partie fractionnaire en secondes
    const seconds = Math.round(fractionalPart * 60);

    return {minutes, seconds};
}


