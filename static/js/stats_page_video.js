// Page Statistiques : vidéo animée d'un graphique ou du tableau entier,
// avec musique.

import { showConfirmation, showError, showToast, t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import { axisLabels, buildChartOption, numberModel } from './chart_echarts.mjs';
import {
    chartAnimates, ellipsize, fitFontSize, lockOption, niceCeil, revealIndex, revealProgress, revealResult, valueMax,
    VIDEO_HOLD, VIDEO_HOLD_MIN_MS,
    VIDEO_DURATIONS, VIDEO_FPS, VIDEO_SIZES,
} from './chart_video.mjs';
import fixWebmDuration from './fix-webm-duration.js';
import { presentSlides } from './present_model.mjs';
import {
    countUp, dashboardVideoDuration, DEFAULT_SLIDE_SECONDS, musicFields, SLIDE_SECONDS, slideSeconds,
    videoMoment,
} from './dashboard_video.mjs';
import { fileSafe } from './stats_page_card_actions.js';
import { chartContext } from './stats_page_cards.js';
import { activeDashboard, chartTitle } from './stats_page_dashboard.js';
import { fetchJson } from './stats_page_data.js';
import { slidePeriod } from './stats_page_present.js';
import { $, echartsLocale, readTokens, state } from './stats_page_state.js';

// ---------------------------------------------------------------------------
// Vidéo animée : le graphique dessiné image par image hors écran, enregistré
// (MediaRecorder), puis converti en MP4 par le serveur (même traitement que
// les vidéos de la carte). Repli : le WebM brut, téléchargeable.
// ---------------------------------------------------------------------------

// La création a deux temps, lus sur une seule barre : la prise en temps
// réel couvre 0 → 70 %, puis la conversion MP4 serveur 70 → 100 % — même
// découpage que la barre de la carte (l'encodage y prend 0 → 70 %).
const RECORD_SHARE = 70;

const videoModal = () => getBsModal($('statsVideoModal'));

// setup → preview → recording → done ; « Annuler » devient « Fermer » à
// la fin. L'aperçu affiche le même bloc que la prise (canevas, barre,
// statut) — rien n'est enregistré : « Annuler » est remplacé par
// « Arrêter l'aperçu », la fermeture reste libre (confirmVideoClose
// n'intercepte que 'recording').
function setVideoPhase(phase) {
    if (state.video) state.video.phase = phase;
    $('statsVideoSetup').hidden = phase !== 'setup';
    $('statsVideoRecording').hidden = phase !== 'recording' && phase !== 'preview';
    $('statsVideoDone').hidden = phase !== 'done';
    $('btnStatsVideoStart').hidden = phase !== 'setup';
    $('btnStatsVideoPreview').hidden = phase !== 'setup';
    $('btnStatsVideoStopPreview').hidden = phase !== 'preview';
    $('btnStatsVideoEdit').hidden = phase !== 'done';
    $('btnStatsVideoReveal').hidden = phase !== 'done' || !state.video?.file;
    $('btnStatsVideoDownload').hidden = phase !== 'done';
    $('btnStatsVideoCancel').hidden = phase === 'preview';
    $('btnStatsVideoCancel').textContent = phase === 'done' ? t('Fermer') : t('Annuler');
    if (phase === 'done') {
        // Le MP4 est déjà écrit dans le dossier des vidéos : « Afficher
        // dans le dossier » est le geste utile, la copie dans
        // Téléchargements est secondaire. En repli WebM (conversion
        // échouée, « Afficher dans le dossier » masqué) rien n'est sur
        // disque : la copie redevient l'action principale — le seul
        // moyen de récupérer la vidéo.
        const hasFile = Boolean(state.video?.file);
        $('btnStatsVideoReveal').classList.toggle('btn-primary', hasFile);
        $('btnStatsVideoReveal').classList.toggle('btn-secondary', !hasFile);
        $('btnStatsVideoDownload').classList.toggle('btn-primary', !hasFile);
        $('btnStatsVideoDownload').classList.toggle('btn-secondary', hasFile);
    }
    // Le bouton qui avait le focus disparaît avec son étape : replacer le
    // focus sur l'action de la nouvelle (sinon il retombe sur <body>).
    const focusTarget = {
        setup: 'btnStatsVideoStart', preview: 'btnStatsVideoStopPreview',
        recording: 'btnStatsVideoCancel',
        done: state.video?.file ? 'btnStatsVideoReveal' : 'btnStatsVideoDownload',
    }[phase];
    $(focusTarget)?.focus();
}

// `text` null : le libellé ne change pas, seule la barre avance — ne pas
// réécrire le nœud à chaque image (chaque mutation est annoncée à
// l'aria-live).
function setVideoStatus(text, percent = null) {
    if (text !== null) $('statsVideoStatus').textContent = text;
    if (percent !== null) {
        const bar = $('statsVideoProgress');
        bar.style.width = Math.round(percent) + '%';
        bar.parentElement.setAttribute('aria-valuenow', String(Math.round(percent)));
    }
}

// Annulation côté serveur : ffmpeg est tué et le MP4 partiel supprimé.
// keepalive : l'appel survit à la fermeture de la page.
function cancelVideoTask(video) {
    const id = video?.taskId;
    if (!id) return;
    video.taskId = null;
    fetch('/tasks/' + encodeURIComponent(id) + '/cancel', { method: 'POST', keepalive: true }).catch(() => {});
}

export function releaseVideo() {
    const video = state.video;
    if (!video) return;
    video.cancelled = true;
    // En phase 'done' la tâche est déjà finie (taskId est encore posé) : on
    // n'annule que la conversion en cours.
    if (video.phase === 'recording') cancelVideoTask(video);
    const player = $('statsVideoPlayer');
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (video.objectUrl) URL.revokeObjectURL(video.objectUrl);
    $('statsVideoStage').replaceChildren();
    state.video = null;
}

// Réglages de la fenêtre (format, durées des deux modes, musique de
// bibliothèque) : préférence d'interface locale au navigateur, non
// synchronisée serveur — comme PNG_SCALE_KEY pour l'export PNG.
const VIDEO_PREFS_KEY = 'statsVideoPrefs';

function loadVideoPrefs() {
    try {
        return JSON.parse(localStorage.getItem(VIDEO_PREFS_KEY)) || {};
    } catch (_) {
        return {};
    }
}

// Mémorise les choix courants des selects ; la durée est par mode (les
// deux axes sont indépendants) : seule celle du mode courant est écrite.
export function persistVideoPrefs() {
    const prefs = loadVideoPrefs();
    prefs.size = $('statsVideoSize').value;
    const mode = state.video?.mode;
    if (mode === 'chart') prefs.duration = $('statsVideoDuration').value;
    else if (mode === 'dashboard') prefs.slideDuration = $('statsVideoDuration').value;
    // 'pick' / 'upload' : un fichier de l'ordinateur n'est pas restaurable
    // — la valeur précédemment mémorisée est conservée.
    const music = $('statsVideoMusic').value;
    if (music === '' || music.startsWith('lib:')) prefs.music = music;
    try { localStorage.setItem(VIDEO_PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* quota */ }
}

// Fenêtre de la vidéo, pour un graphique (`mode: 'chart'`) ou tout le
// tableau (`mode: 'dashboard'`, dashboard_video.mjs) : durée totale ou
// durée par graphique, musique.
function setupVideoModal(video) {
    releaseVideo();
    state.video = { phase: 'setup', cancelled: false, file: null, objectUrl: null, music: null, ...video };
    const prefs = loadVideoPrefs();
    const dashboardMode = video.mode === 'dashboard';
    $('statsVideoTitle').textContent = dashboardMode ? t('Vidéo du tableau de bord') : t('Vidéo animée');
    $('statsVideoIntroChart').hidden = dashboardMode;
    $('statsVideoIntroDashboard').hidden = !dashboardMode;
    $('statsVideoDurationLabel').textContent = dashboardMode ? t('Durée de chaque graphique') : t('Durée');
    const select = $('statsVideoDuration');
    select.replaceChildren();
    if (dashboardMode) {
        for (const seconds of SLIDE_SECONDS) select.add(new Option(t('${n} secondes', { n: seconds }), String(seconds)));
        select.value = String(slideSeconds(prefs.slideDuration));
    } else {
        for (const seconds of VIDEO_DURATIONS) select.add(new Option(t('${n} secondes', { n: seconds }), String(seconds)));
        const duration = Number(prefs.duration);
        select.value = VIDEO_DURATIONS.includes(duration) ? String(duration) : '10';
    }
    if (VIDEO_SIZES[prefs.size]) $('statsVideoSize').value = prefs.size;
    // Écrans de la vidéo « tableau entier » (choix propres à cet export,
    // non persistés : le tableau change d'une vidéo à l'autre) : tous les
    // graphiques inclus, dans l'ordre du tableau.
    $('statsVideoSlides').hidden = !dashboardMode;
    if (dashboardMode) {
        state.video.excluded = new Set();
        renderVideoSlides();
    }
    syncVideoTotal();
    fillMusicChoices(prefs.music);
    setVideoPhase('setup');
    videoModal().show();
}

export function openVideo(spec) {
    const entry = state.results.get(spec.id);
    if (!entry?.result || !chartAnimates(spec, entry.result)) {
        showToast(t('Ce graphique ne peut pas être animé.'), 'info');
        return;
    }
    setupVideoModal({ mode: 'chart', spec });
}

export function openDashboardVideo() {
    const dashboard = activeDashboard();
    const slides = presentSlides(dashboard.items, state.results);
    if (!slides.length) {
        showToast(t('Aucun graphique à mettre en vidéo.'), 'info');
        return;
    }
    setupVideoModal({ mode: 'dashboard', slides, dashboardId: dashboard.id });
}

// Graphiques retenus pour la vidéo « tableau entier » : l'ordre de
// `video.slides`, moins ceux décochés dans la liste (`video.excluded`,
// Set d'ids).
function includedSlides(video) {
    return (video?.slides || []).filter((id) => !video.excluded?.has(id));
}

// Liste « Écrans » de la fenêtre : une ligne par graphique — case pour
// l'exclure, flèches pour le réordonner. La liste est reconstruite après
// chaque déplacement ; les cases relisent `video.excluded`.
function renderVideoSlides() {
    const video = state.video;
    const list = $('statsVideoSlidesList');
    list.replaceChildren();
    if (video?.mode !== 'dashboard') return;
    const move = (index, step) => {
        const target = index + step;
        if (target < 0 || target >= video.slides.length) return;
        [video.slides[index], video.slides[target]] = [video.slides[target], video.slides[index]];
        renderVideoSlides();
        // La ligne déplacée garde le focus (sa nouvelle place, même flèche).
        list.children[target]?.querySelector(`[data-move="${step < 0 ? 'up' : 'down'}"]`)?.focus();
    };
    const moveButton = (index, step) => {
        const text = step < 0 ? t('Monter') : t('Descendre');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-sm btn-link';
        button.dataset.move = step < 0 ? 'up' : 'down';
        button.title = text;
        button.setAttribute('aria-label', text);
        button.disabled = step < 0 ? index === 0 : index === video.slides.length - 1;
        const icon = document.createElement('i');
        icon.className = `ti ${step < 0 ? 'ti-arrow-up' : 'ti-arrow-down'}`;
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        button.addEventListener('click', () => move(index, step));
        return button;
    };
    video.slides.forEach((id, index) => {
        const entry = state.results.get(id);
        const row = document.createElement('div');
        row.className = 'stats-video-slide';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'form-check-input';
        check.id = `statsVideoSlide-${index}`;
        check.checked = !video.excluded.has(id);
        check.addEventListener('change', () => {
            if (check.checked) video.excluded.delete(id);
            else video.excluded.add(id);
            syncVideoTotal();
        });
        const label = document.createElement('label');
        label.className = 'form-check-label';
        label.htmlFor = check.id;
        label.textContent = entry?.spec ? chartTitle(entry.spec) : id;
        row.append(check, label, moveButton(index, -1), moveButton(index, 1));
        list.append(row);
    });
}

// Durée totale annoncée (tableau entier : ouverture + un écran par
// graphique coché + fermeture). Sans graphique coché, pas de total et
// « Créer » / « Aperçu » sont grisés.
export function syncVideoTotal() {
    const video = state.video;
    const total = $('statsVideoTotal');
    if (video?.mode !== 'dashboard') {
        total.textContent = '';
        $('btnStatsVideoStart').disabled = false;
        $('btnStatsVideoPreview').disabled = false;
        return;
    }
    const n = includedSlides(video).length;
    const empty = !n;
    $('btnStatsVideoStart').disabled = empty;
    $('btnStatsVideoPreview').disabled = empty;
    if (empty) {
        total.textContent = t('Cochez au moins un graphique.');
        return;
    }
    const ms = dashboardVideoDuration(n, $('statsVideoDuration').value);
    const s = Math.round(ms / 1000);
    total.textContent = n > 1
        ? t("${n} graphiques, ${s} secondes en tout : la vidéo s'enregistre en temps réel.", { n, s })
        : t("${n} graphique, ${s} secondes en tout : la vidéo s'enregistre en temps réel.", { n, s });
}

// Musiques : aucune, les récentes de la carte (bibliothèque audio/), ou un
// fichier de l'ordinateur, envoyé avec la vidéo. `restore` : la valeur
// mémorisée ('' ou 'lib:<fichier>'), reposée si l'entrée est encore là.
async function fillMusicChoices(restore = '') {
    const select = $('statsVideoMusic');
    select.replaceChildren(new Option(t('Sans musique'), ''));
    let recording = null;
    try {
        recording = (await fetchJson('/api/settings'))?.recording || null;
    } catch (e) {
        console.warn('[stats] Musiques récentes non lues :', e?.message || e);
    }
    const seen = new Set();
    const library = [];
    for (const entry of recording?.audio_recent || []) {
        if (entry?.file && !seen.has(entry.file)) {
            seen.add(entry.file);
            library.push(entry);
        }
    }
    if (recording?.audio_file && !seen.has(recording.audio_file)) library.unshift({ file: recording.audio_file, name: recording.audio_file });
    if (library.length) {
        const group = document.createElement('optgroup');
        group.label = t('Musiques récentes');
        for (const entry of library) {
            const option = new Option(entry.name || entry.file, 'lib:' + entry.file);
            option.dataset.start = String(Number(entry.start) || 0);
            group.append(option);
        }
        select.append(group);
    }
    select.append(new Option(t('Un fichier de mon ordinateur…'), 'pick'));
    select.value = '';
    // Une entrée mémorisée a pu disparaître de la bibliothèque : elle n'est
    // reposée que si elle existe encore ('lib:<fichier>' peut porter des
    // caractères spéciaux → comparaison des valeurs, pas de sélecteur).
    if (restore && [...select.options].some((option) => option.value === restore)) {
        select.value = restore;
        onMusicChange();
    }
}

export function onMusicChange() {
    const select = $('statsVideoMusic');
    const video = state.video;
    if (!video) return;
    if (select.value === 'pick') {
        $('statsVideoMusicFile').value = '';
        $('statsVideoMusicFile').click();
        // Revenir au choix précédent tant que rien n'est choisi.
        select.value = video.music?.kind === 'upload' ? 'upload' : (video.music?.kind === 'library' ? 'lib:' + video.music.file : '');
        return;
    }
    if (!select.value) video.music = null;
    else if (select.value.startsWith('lib:')) {
        video.music = { kind: 'library', file: select.value.slice(4), start: Number(select.selectedOptions[0]?.dataset.start) || 0 };
    }
    persistVideoPrefs();
}

export function onMusicFile() {
    const file = $('statsVideoMusicFile').files?.[0];
    const video = state.video;
    if (!file || !video) return;
    video.music = { kind: 'upload', blob: file, name: file.name };
    const select = $('statsVideoMusic');
    select.querySelector('option[value="upload"]')?.remove();
    const option = new Option(file.name, 'upload');
    select.insertBefore(option, select.querySelector('option[value="pick"]'));
    select.value = 'upload';
}

function videoMimeType() {
    const recorder = window.MediaRecorder;
    if (!recorder?.isTypeSupported) return null;
    return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => recorder.isTypeSupported(type)) || null;
}

// Une image : titre, repère de l'axe atteint (« Mars »), graphique partiel.
// `reveal: false` : le graphique entier, sans révélation (anneau, grille…).
function videoPainter(spec, result, { width, height }, { reveal = true } = {}) {
    const tokens = state.tokens || readTokens();
    // Les polices d'ECharts (12 px) sont pensées pour l'écran : le graphique
    // est mis en page comme sur une fenêtre de 540 px de haut puis dessiné en
    // pleine définition (devicePixelRatio) — textes lisibles dans la vidéo.
    const { scale, pad, titleSize, top } = videoFrame({ width, height });
    const chartW = width - pad * 2;
    const chartH = height - top - pad;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + Math.round(chartW / scale) + 'px;height:' + Math.round(chartH / scale) + 'px';
    document.body.append(box);
    const chart = window.echarts.init(box, null, {
        renderer: 'canvas', devicePixelRatio: scale, locale: echartsLocale(),
        width: Math.round(chartW / scale), height: Math.round(chartH / scale),
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const stacked = spec.view.stack && result.series.length > 1;
    const max = spec.view.log ? undefined : niceCeil(valueMax(result, { stacked }));
    const kind = spec.view.chart === 'bar' ? 'bar' : 'line';
    // Sans « aujourd'hui » : pas de projection prolongeant une courbe à
    // moitié révélée.
    const ctx = { ...chartContext(), tokens, width: chartW / scale, height: chartH / scale, today: null };
    const heads = reveal ? axisLabels(result, ctx, { long: true }) : [];
    const title = chartTitle(spec);
    const font = videoFont();
    let drawn = false;
    const paint = (progress) => {
        if (reveal) {
            chart.setOption(lockOption(buildChartOption(revealResult(result, progress, { chart: kind }), spec, ctx), max), true);
        } else if (!drawn) {
            // Entier dès la première image (le fondu de l'écran l'amène).
            chart.setOption({ ...buildChartOption(result, spec, ctx), animation: false }, true);
            drawn = true;
        }
        g.fillStyle = tokens.surface;
        g.fillRect(0, 0, width, height);
        g.textBaseline = 'alphabetic';
        g.textAlign = 'left';
        g.fillStyle = tokens.text;
        g.font = '600 ' + titleSize + 'px ' + font;
        // measureText lit la police courante : poser g.font avant de mesurer.
        // Pas de maxWidth à fillText : il compresserait les glyphes.
        const measure = (s) => g.measureText(s).width;
        g.fillText(ellipsize(title, width - pad * 2 - titleSize * 6, measure), pad, pad + titleSize * 0.9);
        g.textAlign = 'right';
        g.fillStyle = tokens.textMuted;
        g.font = '700 ' + Math.round(titleSize * 1.15) + 'px ' + font;
        // Repère de l'axe atteint (« septembre ») : borné à l'espace laissé
        // au titre, pour ne pas déborder dessus.
        if (reveal) {
            const head = heads[revealIndex(result, progress)] ?? '';
            g.fillText(ellipsize(head, titleSize * 6, measure), width - pad, pad + titleSize * 0.9);
        }
        const source = box.querySelector('canvas');
        if (source) g.drawImage(source, pad, top, chartW, chartH);
    };
    const dispose = () => {
        chart.dispose();
        box.remove();
    };
    return { canvas, paint, dispose };
}

// Mise en page commune des écrans de la vidéo : marges et taille du titre,
// proportionnelles à la définition.
function videoFrame({ width, height }) {
    const scale = Math.min(width, height) / 540;
    const pad = Math.round(28 * scale);
    const titleSize = Math.round(24 * scale);
    return { scale, pad, titleSize, top: pad * 2 + titleSize };
}

function videoFont() {
    return getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
}

// Écran d'ouverture : nom du tableau, période, nombre de graphiques.
function introPainter(dashboard, count, { width, height }) {
    const tokens = state.tokens || readTokens();
    const { scale } = videoFrame({ width, height });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const font = videoFont();
    const name = dashboard.name || t('Mon tableau de bord');
    const period = state.labels.periodChoiceLabel(dashboard.period);
    const charts = count > 1 ? t('${n} graphiques', { n: count }) : t('${n} graphique', { n: count });
    const paint = (progress) => {
        g.fillStyle = tokens.surface;
        g.fillRect(0, 0, width, height);
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        // Le titre monte légèrement en apparaissant.
        const rise = (1 - Math.min(1, progress)) * 18 * scale;
        const measure = (s) => g.measureText(s).width;
        g.fillStyle = tokens.text;
        // Le nom du tableau (un nom propre) est réduit plutôt que tronqué ;
        // « … » en dernier recours si le plancher ne suffit pas.
        const nameMax = width * 0.9;
        const nameBase = Math.round(48 * scale);
        g.font = '700 ' + nameBase + 'px ' + font;
        const nameSize = fitFontSize(name, nameBase, nameMax, measure);
        if (nameSize !== nameBase) g.font = '700 ' + Math.round(nameSize) + 'px ' + font;
        g.fillText(ellipsize(name, nameMax, measure), width / 2, height * 0.44 + rise);
        g.fillStyle = tokens.textMuted;
        g.font = '500 ' + Math.round(24 * scale) + 'px ' + font;
        g.fillText(ellipsize(period, nameMax, measure), width / 2, height * 0.44 + 52 * scale + rise);
        g.font = '400 ' + Math.round(18 * scale) + 'px ' + font;
        g.fillText(ellipsize(charts, nameMax, measure), width / 2, height * 0.44 + 88 * scale + rise);
    };
    return { canvas, paint, dispose: () => {} };
}

// Chiffre clé : il compte de 0 à sa valeur, puis sa période, son record ou
// son objectif.
function numberPainter(spec, result, { width, height }) {
    const tokens = state.tokens || readTokens();
    const { scale, pad, titleSize } = videoFrame({ width, height });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const font = videoFont();
    const title = chartTitle(spec);
    const [block] = numberModel(result, spec, chartContext());
    const dashboard = activeDashboard();
    const caption = block?.label || slidePeriod(spec, dashboard);
    const lines = [block?.record, block?.outlook?.progress, ...(block?.outlook?.lines || [])].filter(Boolean).slice(0, 3);
    const paint = (progress) => {
        g.fillStyle = tokens.surface;
        g.fillRect(0, 0, width, height);
        g.textBaseline = 'alphabetic';
        g.textAlign = 'left';
        g.fillStyle = tokens.text;
        g.font = '600 ' + titleSize + 'px ' + font;
        const measure = (s) => g.measureText(s).width;
        g.fillText(ellipsize(title, width - pad * 2, measure), pad, pad + titleSize * 0.9);
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        const value = block ? countUp(block.value, progress) : null;
        const label = state.labels.formatValue(value, spec.measure, { normalize: result.normalize });
        // Le chiffre est réduit (plancher bas) plutôt que tronqué : un nombre
        // coupé par « … » n'a pas de sens — au plancher, il peut déborder un peu.
        const valueMaxWidth = width - pad * 2;
        const valueBase = Math.round(150 * scale);
        g.font = '700 ' + valueBase + 'px ' + font;
        const valueSize = fitFontSize(label, valueBase, valueMaxWidth, measure, 0.4);
        if (valueSize !== valueBase) g.font = '700 ' + Math.round(valueSize) + 'px ' + font;
        g.fillText(label, width / 2, height * 0.46);
        g.fillStyle = tokens.textMuted;
        g.font = '500 ' + Math.round(24 * scale) + 'px ' + font;
        g.fillText(ellipsize(caption, valueMaxWidth, measure), width / 2, height * 0.46 + 100 * scale);
        // Jours du record, objectif : quand le compte est fini.
        g.globalAlpha = Math.min(1, Math.max(0, (progress - 0.8) / 0.2));
        g.font = '400 ' + Math.round(20 * scale) + 'px ' + font;
        lines.forEach((line, i) => g.fillText(ellipsize(line, valueMaxWidth, measure), width / 2, height * 0.46 + (140 + i * 30) * scale));
        g.globalAlpha = 1;
    };
    return { canvas, paint, dispose: () => {} };
}

// Écran d'un graphique : chiffre clé, graphique révélé au fil de l'axe, ou
// graphique entier (anneau, grille, carte de chaleur…).
function slidePainter(spec, result, size) {
    if (spec.view.chart === 'number') return numberPainter(spec, result, size);
    return videoPainter(spec, result, size, { reveal: chartAnimates(spec, result) });
}

// Machinerie commune de la vidéo « tableau entier » (enregistrement et
// aperçu) : un canevas sur lequel l'écran courant — ouverture, puis chaque
// graphique — est peint avec son fondu d'entrée. `paint(elapsed)` renvoie
// le moment affiché (videoMoment) ; `dispose` relâche l'écran courant
// (les précédents l'ont été au changement). `seconds` = durée par
// graphique lue dans le formulaire, pour le calcul de la durée totale.
function makeDashboardPainter(slides, size) {
    const dashboard = activeDashboard();
    const seconds = slideSeconds($('statsVideoDuration').value);
    const tokens = state.tokens || readTokens();
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const g = canvas.getContext('2d');
    let current = { key: null, painter: null };
    const painterFor = (moment) => {
        // 'outro' : la vidéo se referme sur sa carte de titre (bookend) —
        // le même peintre que l'ouverture, une clé à part pour que l'écran
        // soit repeint avec son propre fondu.
        const key = moment.kind === 'intro' ? 'intro'
            : moment.kind === 'outro' ? 'outro'
            : 'slide:' + moment.index;
        if (current.key !== key) {
            current.painter?.dispose();
            const entry = slides[moment.index];
            current = {
                key,
                painter: moment.kind === 'intro' || moment.kind === 'outro'
                    ? introPainter(dashboard, slides.length, size)
                    : slidePainter(entry.spec, entry.result, size),
            };
        }
        return current.painter;
    };
    const paint = (elapsed) => {
        const moment = videoMoment(elapsed, slides.length, seconds);
        const painter = painterFor(moment);
        painter.paint(moment.progress);
        g.fillStyle = tokens.surface;
        g.fillRect(0, 0, size.width, size.height);
        g.globalAlpha = moment.fade;
        g.drawImage(painter.canvas, 0, 0);
        g.globalAlpha = 1;
        return moment;
    };
    const dispose = () => current.painter?.dispose();
    return { canvas, paint, dispose, seconds };
}

// « ouverture », « fin » ou « graphique n / count » : la position de la
// vidéo tableau, affichée dans le statut (enregistrement comme aperçu).
function dashboardMomentWhere(moment, count) {
    if (moment.kind === 'intro') return t('ouverture');
    if (moment.kind === 'outro') return t('fin');
    return t('graphique ${n} / ${count}', { n: moment.index + 1, count });
}

async function recordDashboardVideo(video) {
    const slides = includedSlides(video).map((id) => state.results.get(id)).filter((entry) => entry?.result);
    if (!slides.length) return;
    const mimeType = videoMimeType();
    if (!mimeType || !HTMLCanvasElement.prototype.captureStream) {
        showError(t("Ce navigateur ne sait pas enregistrer de vidéo."));
        return;
    }
    const size = VIDEO_SIZES[$('statsVideoSize').value] || VIDEO_SIZES.hd;
    const machine = makeDashboardPainter(slides, size);
    const duration = dashboardVideoDuration(slides.length, machine.seconds);
    setVideoPhase('recording');
    const canvas = machine.canvas;
    $('statsVideoStage').replaceChildren(canvas);
    const paint = machine.paint;
    paint(0);
    const stream = canvas.captureStream(VIDEO_FPS);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(1000);
    const start = performance.now();
    const vis = watchRecordingVisibility(video, recorder);
    let lastText = '';
    await new Promise((resolve) => {
        const tick = () => {
            if (video.cancelled) return resolve();
            // Onglet masqué : le minuteur ~1 Hz ne fait que patienter — pas
            // de paint, pas de maj de statut (prise gelée).
            if (document.hidden) return nextFrame(tick);
            const elapsed = Math.min(performance.now() - start - vis.hiddenMs(), duration);
            const moment = paint(elapsed);
            const where = dashboardMomentWhere(moment, slides.length);
            const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
            // Le texte (position + compte à rebours, à la seconde) n'est
            // réécrit que quand il change ; la barre avance à chaque image.
            const text = t('Enregistrement… (${where}, reste ~${s} s)', { where, s: remaining });
            setVideoStatus(text === lastText ? null : text, (elapsed / duration) * RECORD_SHARE);
            lastText = text;
            if (elapsed >= duration) return resolve();
            return nextFrame(tick);
        };
        nextFrame(tick);
    });
    const recorded = performance.now() - start - vis.hiddenMs();
    // Solde un éventuel masquage en cours avant d'arrêter : stop() sur un
    // recorder en pause produit quand même ses chunks.
    vis.detach();
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    machine.dispose();
    if (video.cancelled) return;
    let blob = new Blob(chunks, { type: 'video/webm' });
    try {
        blob = (await fixWebmDuration(blob, recorded, { logger: false })) || blob;
    } catch (_) { /* durée non réécrite : ffmpeg la recalcule */ }
    await convertVideo(video, blob, fileSafe(activeDashboard().name || t('Mon tableau de bord')));
}

// Avance du temps de la vidéo : requestAnimationFrame quand la page est
// visible, minuteur sinon (un onglet masqué n'a plus d'images).
const nextFrame = (fn) => (document.hidden ? setTimeout(fn, 1000 / VIDEO_FPS) : requestAnimationFrame(fn));

// Onglet masqué : rAF ne tourne plus et les minuteurs sont bridés à ~1 i/s —
// la prise temps réel sortirait saccadée. On gèle le MediaRecorder et
// l'horloge tant que l'onglet est masqué, reprise au retour.
function watchRecordingVisibility(video, recorder) {
    let hiddenSince = 0;
    let hiddenMs = 0;
    const onChange = () => {
        if (document.hidden && !hiddenSince) {
            hiddenSince = performance.now();
            video.hiddenDuringRecording = true;
            try { recorder.pause(); } catch (_) { video.pauseFailed = true; }
        } else if (!document.hidden && hiddenSince) {
            hiddenMs += performance.now() - hiddenSince;
            hiddenSince = 0;
            try { recorder.resume(); } catch (_) {}
        }
    };
    document.addEventListener('visibilitychange', onChange);
    return {
        hiddenMs: () => hiddenMs + (hiddenSince ? performance.now() - hiddenSince : 0),
        // À appeler à la fin de la prise : solde un masquage en cours et
        // retire l'écouteur.
        detach: () => { onChange(); document.removeEventListener('visibilitychange', onChange); },
    };
}

export async function recordVideo() {
    const video = state.video;
    if (video?.mode === 'dashboard') return recordDashboardVideo(video);
    const entry = video && state.results.get(video.spec.id);
    if (!entry?.result) return;
    const mimeType = videoMimeType();
    if (!mimeType || !HTMLCanvasElement.prototype.captureStream) {
        showError(t("Ce navigateur ne sait pas enregistrer de vidéo."));
        return;
    }
    const size = VIDEO_SIZES[$('statsVideoSize').value] || VIDEO_SIZES.hd;
    const duration = (Number($('statsVideoDuration').value) || 10) * 1000;
    const { spec, result } = entry;
    setVideoPhase('recording');
    setVideoStatus(t('Enregistrement…'), 0);
    const painter = videoPainter(spec, result, size);
    $('statsVideoStage').replaceChildren(painter.canvas);
    painter.paint(0);
    const stream = painter.canvas.captureStream(VIDEO_FPS);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(1000);
    const start = performance.now();
    const vis = watchRecordingVisibility(video, recorder);
    let lastText = '';
    await new Promise((resolve) => {
        const tick = () => {
            if (video.cancelled) return resolve();
            // Onglet masqué : le minuteur ~1 Hz ne fait que patienter — pas
            // de paint, pas de maj de statut (prise gelée).
            if (document.hidden) return nextFrame(tick);
            const elapsed = performance.now() - start - vis.hiddenMs();
            painter.paint(revealProgress(elapsed, duration, VIDEO_HOLD, VIDEO_HOLD_MIN_MS));
            const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
            // Même garde qu'en mode tableau : le compte à rebours n'est
            // réécrit qu'au changement de seconde.
            const text = t('Enregistrement… (reste ~${s} s)', { s: remaining });
            setVideoStatus(text === lastText ? null : text, Math.min(RECORD_SHARE, (elapsed / duration) * RECORD_SHARE));
            lastText = text;
            if (elapsed >= duration) return resolve();
            return nextFrame(tick);
        };
        nextFrame(tick);
    });
    const recorded = performance.now() - start - vis.hiddenMs();
    // Solde un éventuel masquage en cours avant d'arrêter : stop() sur un
    // recorder en pause produit quand même ses chunks.
    vis.detach();
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    painter.dispose();
    if (video.cancelled) return;

    let blob = new Blob(chunks, { type: 'video/webm' });
    try {
        blob = (await fixWebmDuration(blob, recorded, { logger: false })) || blob;
    } catch (_) { /* durée non réécrite : ffmpeg la recalcule */ }
    await convertVideo(video, blob, fileSafe(chartTitle(spec)));
}

// ---------------------------------------------------------------------------
// Aperçu : la même animation jouée dans la fenêtre, sans MediaRecorder ni
// conversion — l'utilisateur voit la vidéo avant de lancer la prise. Rien
// n'est persisté, la musique n'est pas jouée (elle est mixée serveur).
// ---------------------------------------------------------------------------

// Boucle commune des aperçus : `paint(elapsed)` dessine une image et
// renvoie ce qui sert au statut (`statusFor`), jusqu'à la fin naturelle
// (toast + retour aux réglages), « Arrêter l'aperçu » (previewStop : retour
// aux réglages sans toast) ou la fermeture de la fenêtre (cancelled :
// releaseVideo a déjà tout relâché — dispose seul reste à faire).
// Onglet masqué : pas de recorder à geler — on saute le paint et l'horloge
// continue ; au retour l'aperçu a « avancé » (acceptable pour un aperçu).
function runVideoPreview(video, duration, paint, statusFor, dispose) {
    const start = performance.now();
    const tick = () => {
        if (video.cancelled || video.previewStop) {
            const stopped = Boolean(video.previewStop) && !video.cancelled;
            video.previewStop = false;
            dispose();
            if (stopped) setVideoPhase('setup');
            return;
        }
        if (document.hidden) return nextFrame(tick);
        const elapsed = performance.now() - start;
        setVideoStatus(statusFor(paint(elapsed)), Math.min(100, (elapsed / duration) * 100));
        if (elapsed >= duration) {
            dispose();
            setVideoPhase('setup');
            showToast(t("Aperçu terminé — rien n'a été enregistré."), 'info');
            return;
        }
        nextFrame(tick);
    };
    nextFrame(tick);
}

// Aperçu du mode tableau : mêmes écrans et fondus que l'enregistrement.
function previewDashboardVideo(video) {
    const slides = includedSlides(video).map((id) => state.results.get(id)).filter((entry) => entry?.result);
    if (!slides.length) return;
    const size = VIDEO_SIZES[$('statsVideoSize').value] || VIDEO_SIZES.hd;
    const machine = makeDashboardPainter(slides, size);
    const duration = dashboardVideoDuration(slides.length, machine.seconds);
    video.previewStop = false;
    setVideoPhase('preview');
    setVideoStatus(t('Aperçu… (${where})', { where: t('ouverture') }), 0);
    $('statsVideoStage').replaceChildren(machine.canvas);
    machine.paint(0);
    runVideoPreview(video, duration, machine.paint,
        (moment) => t('Aperçu… (${where})', { where: dashboardMomentWhere(moment, slides.length) }),
        machine.dispose);
}

// « Aperçu » de l'étape de préparation : joue la vidéo dans la fenêtre.
export function previewVideo() {
    const video = state.video;
    if (video?.mode === 'dashboard') return previewDashboardVideo(video);
    const entry = video && state.results.get(video.spec.id);
    if (!entry?.result) return;
    const size = VIDEO_SIZES[$('statsVideoSize').value] || VIDEO_SIZES.hd;
    const duration = (Number($('statsVideoDuration').value) || 10) * 1000;
    const { spec, result } = entry;
    const painter = videoPainter(spec, result, size);
    video.previewStop = false;
    setVideoPhase('preview');
    setVideoStatus(t('Aperçu…'), 0);
    $('statsVideoStage').replaceChildren(painter.canvas);
    painter.paint(0);
    runVideoPreview(video, duration,
        (elapsed) => { painter.paint(revealProgress(elapsed, duration, VIDEO_HOLD, VIDEO_HOLD_MIN_MS)); },
        () => t('Aperçu…'),
        painter.dispose);
}

// « Arrêter l'aperçu » : la boucle le voit à la prochaine image et ramène
// aux réglages (sans toast — l'arrêt est demandé).
export function stopVideoPreview() {
    if (state.video) state.video.previewStop = true;
}

async function pollTask(id, onProgress, isCancelled) {
    const started = Date.now();
    for (;;) {
        // Tâche morte côté client (fenêtre fermée) : ne pas la sonder 10 min.
        if (isCancelled?.()) return {};
        if (Date.now() - started > 10 * 60 * 1000) throw new Error('timeout');
        const response = await fetch('/tasks/' + encodeURIComponent(id) + '?include_result=true');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const status = await response.json();
        if (typeof status.progress === 'number') onProgress(status.progress);
        if (status.state === 'finished') return status.result || {};
        if (status.state === 'failed') throw new Error(status.error || status.message || 'failed');
        await new Promise((resolve) => setTimeout(resolve, 700));
    }
}

// Conversion MP4 par le serveur ; à défaut, le WebM enregistré. La barre
// continue là où la prise s'est arrêtée (RECORD_SHARE → 100 %) : même
// processus, deuxième étape.
async function convertVideo(video, blob, name) {
    setVideoStatus(t('Conversion en MP4…'), RECORD_SHARE);
    let result = null;
    let failure = null;
    try {
        const form = new FormData();
        form.append('video', blob, 'statistiques.webm');
        form.append('fileName', name);
        form.append('fps', String(VIDEO_FPS));
        form.append('slowdown', '1');
        // Musique : un morceau de la bibliothèque (nom), ou le fichier choisi.
        for (const [key, value] of Object.entries(musicFields(video.music) || {})) form.append(key, value);
        if (video.music?.kind === 'upload') form.append('audio', video.music.blob, video.music.name);
        const response = await fetch('/process_recorded_video', { method: 'POST', body: form });
        const data = await response.json();
        if (!data?.task_id) throw new Error(data?.message || 'no task');
        video.taskId = data.task_id;
        // La fenêtre a pu être fermée pendant l'envoi du POST.
        if (video.cancelled) { cancelVideoTask(video); return; }
        result = await pollTask(data.task_id, (p) => { if (!video.cancelled) setVideoStatus(null, RECORD_SHARE + p * (100 - RECORD_SHARE) / 100); }, () => video.cancelled);
    } catch (e) {
        failure = e;
        console.warn('[stats] Conversion vidéo impossible :', e?.message || e);
    }
    if (video.cancelled) return;
    const player = $('statsVideoPlayer');
    const download = $('btnStatsVideoDownload');
    // Onglet masqué pendant la prise sans pause() possible (vieux
    // navigateur) : la vidéo peut être saccadée — dit dans les deux cas.
    const hiddenNote = video.pauseFailed
        ? ' ' + t("L'onglet a été masqué pendant l'enregistrement : la vidéo peut être saccadée.")
        : '';
    if (result?.file) {
        video.file = result.file;
        video.folder = result.folder || null;
        const url = '/download_video/' + encodeURIComponent(result.file);
        player.src = url + '?inline=1';
        download.href = url;
        download.removeAttribute('download');
        $('statsVideoDoneNote').textContent = (result.folder
            ? t('Vidéo enregistrée : ${file}, dans ${folder}.', { file: result.file, folder: result.folder })
            : result.file) + hiddenNote;
    } else {
        video.objectUrl = URL.createObjectURL(blob);
        player.src = video.objectUrl;
        download.href = video.objectUrl;
        download.download = name + '.webm';
        // Le rejet de `pollTask` peut porter plusieurs lignes ffmpeg : la
        // première suffit, bornée pour rester lisible dans la note.
        const detail = (failure?.message || '').split('\n')[0].trim().slice(0, 200);
        let note = detail
            ? t('La conversion en MP4 a échoué (${detail}) : la vidéo est proposée au format WebM.', { detail })
            : t('La conversion en MP4 a échoué : la vidéo est proposée au format WebM.');
        // La musique est mixée pendant la conversion : le repli est muet.
        if (video.music) note += ' ' + t("La musique choisie n'y est pas incluse : elle est mixée pendant la conversion.");
        note += hiddenNote;
        $('statsVideoDoneNote').textContent = note;
    }
    $('statsVideoStage').replaceChildren();
    setVideoPhase('done');
}

// Retour aux réglages depuis l'étape finale : la vidéo produite reste
// dans le dossier des vidéos ; l'aperçu et le blob de repli sont relâchés.
export function editVideo() {
    const video = state.video;
    if (!video || video.phase !== 'done') return;
    const player = $('statsVideoPlayer');
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (video.objectUrl) { URL.revokeObjectURL(video.objectUrl); video.objectUrl = null; }
    video.file = null;
    video.folder = null;
    // La tâche de la vidéo faite est terminée : sans cette remise à zéro,
    // une annulation du prochain enregistrement l'interrogerait (404).
    video.taskId = null;
    video.hiddenDuringRecording = false;
    video.pauseFailed = false;
    $('statsVideoDoneNote').textContent = '';
    setVideoPhase('setup');
}

export async function revealVideo() {
    const file = state.video?.file;
    if (!file) return;
    try {
        const response = await fetch('/reveal_video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file }),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
    } catch (e) {
        showError(t("Impossible d'ouvrir le dossier des vidéos."));
    }
}

export function closeVideo() {
    videoModal().hide();
}

// Fermer la fenêtre en pleine création demande confirmation : la prise
// serait perdue. `hide.bs.modal` est annulable — tout chemin de sortie
// (Échap, croix, « Annuler ») passe par là.
export function confirmVideoClose(event) {
    const video = state.video;
    if (video?.phase !== 'recording' || video.closeApproved) return;
    event.preventDefault();
    showConfirmation(
        t("La vidéo est en cours de création : fermer la fenêtre l'interrompt et elle sera perdue."),
        t('Arrêter la vidéo ?'),
        // `state.video === video` : la fenêtre a pu être remplacée entre-temps ;
        // `closeApproved` empêche ce hide() confirmé d'être re-intercepté.
        () => { if (state.video === video) { video.closeApproved = true; videoModal().hide(); } },
        null,
        { confirmText: t('Arrêter'), danger: true },
    );
}

