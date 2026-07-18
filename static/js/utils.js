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


// Utilitaires date pour UI Animation
export function parseDateInput(value){
    // Gère dd/mm/yyyy (format français) et yyyy-mm-dd (format datepicker)
    if (!value || typeof value !== 'string') return null;

    const trimmedValue = value.trim();

    // Essai format dd/mm/yyyy (français)
    let m = trimmedValue.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    let d, mo, y;

    if (m) {
        d = parseInt(m[1],10);
        mo = parseInt(m[2],10)-1;
        y = parseInt(m[3],10);
    } else {
        // Essai format yyyy-mm-dd (datepicker)
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
    if (!(date instanceof Date)) return '';
    const dd = String(date.getDate()).padStart(2,'0');
    const mm = String(date.getMonth()+1).padStart(2,'0');
    const yy = date.getFullYear();
    return `${dd}/${mm}/${yy}`;
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


