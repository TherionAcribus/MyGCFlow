// Page Statistiques : vidéo animée d'un graphique ou du tableau entier,
// avec musique.

import { showError, showToast, t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import { axisLabels, buildChartOption, numberModel } from './chart_echarts.mjs';
import {
    chartAnimates, lockOption, niceCeil, revealIndex, revealProgress, revealResult, valueMax, VIDEO_DURATIONS,
    VIDEO_FPS, VIDEO_SIZES,
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

const videoModal = () => getBsModal($('statsVideoModal'));

// setup → recording → done ; « Annuler » devient « Fermer » à la fin.
function setVideoPhase(phase) {
    if (state.video) state.video.phase = phase;
    $('statsVideoSetup').hidden = phase !== 'setup';
    $('statsVideoRecording').hidden = phase !== 'recording';
    $('statsVideoDone').hidden = phase !== 'done';
    $('btnStatsVideoStart').hidden = phase !== 'setup';
    $('btnStatsVideoReveal').hidden = phase !== 'done' || !state.video?.file;
    $('btnStatsVideoDownload').hidden = phase !== 'done';
    $('btnStatsVideoCancel').textContent = phase === 'done' ? t('Fermer') : t('Annuler');
}

function setVideoStatus(text, percent = null) {
    $('statsVideoStatus').textContent = text;
    if (percent !== null) {
        const bar = $('statsVideoProgress');
        bar.style.width = Math.round(percent) + '%';
        bar.parentElement.setAttribute('aria-valuenow', String(Math.round(percent)));
    }
}

export function releaseVideo() {
    const video = state.video;
    if (!video) return;
    video.cancelled = true;
    const player = $('statsVideoPlayer');
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (video.objectUrl) URL.revokeObjectURL(video.objectUrl);
    $('statsVideoStage').replaceChildren();
    state.video = null;
}

// Fenêtre de la vidéo, pour un graphique (`mode: 'chart'`) ou tout le
// tableau (`mode: 'dashboard'`, dashboard_video.mjs) : durée totale ou
// durée par graphique, musique.
function setupVideoModal(video) {
    releaseVideo();
    state.video = { phase: 'setup', cancelled: false, file: null, objectUrl: null, music: null, ...video };
    const dashboardMode = video.mode === 'dashboard';
    $('statsVideoTitle').textContent = dashboardMode ? t('Vidéo du tableau de bord') : t('Vidéo animée');
    $('statsVideoIntroChart').hidden = dashboardMode;
    $('statsVideoIntroDashboard').hidden = !dashboardMode;
    $('statsVideoDurationLabel').textContent = dashboardMode ? t('Durée de chaque graphique') : t('Durée');
    const select = $('statsVideoDuration');
    select.replaceChildren();
    if (dashboardMode) {
        for (const seconds of SLIDE_SECONDS) select.add(new Option(t('${n} secondes', { n: seconds }), String(seconds)));
        select.value = String(DEFAULT_SLIDE_SECONDS);
    } else {
        for (const seconds of VIDEO_DURATIONS) select.add(new Option(t('${n} secondes', { n: seconds }), String(seconds)));
        select.value = '10';
    }
    syncVideoTotal();
    fillMusicChoices();
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

// Durée totale annoncée (tableau entier : ouverture + un écran par graphique).
export function syncVideoTotal() {
    const video = state.video;
    const total = $('statsVideoTotal');
    if (video?.mode !== 'dashboard') {
        total.textContent = '';
        return;
    }
    const ms = dashboardVideoDuration(video.slides.length, $('statsVideoDuration').value);
    total.textContent = t("${n} graphiques, ${s} secondes en tout : la vidéo s'enregistre en temps réel.", {
        n: video.slides.length, s: Math.round(ms / 1000),
    });
}

// Musiques : aucune, les récentes de la carte (bibliothèque audio/), ou un
// fichier de l'ordinateur, envoyé avec la vidéo.
async function fillMusicChoices() {
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
        g.fillText(title, pad, pad + titleSize * 0.9, width - pad * 2 - titleSize * 6);
        g.textAlign = 'right';
        g.fillStyle = tokens.textMuted;
        g.font = '700 ' + Math.round(titleSize * 1.15) + 'px ' + font;
        if (reveal) g.fillText(heads[revealIndex(result, progress)] ?? '', width - pad, pad + titleSize * 0.9);
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
    const charts = t('${n} graphiques', { n: count });
    const paint = (progress) => {
        g.fillStyle = tokens.surface;
        g.fillRect(0, 0, width, height);
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        // Le titre monte légèrement en apparaissant.
        const rise = (1 - Math.min(1, progress)) * 18 * scale;
        g.fillStyle = tokens.text;
        g.font = '700 ' + Math.round(48 * scale) + 'px ' + font;
        g.fillText(name, width / 2, height * 0.44 + rise, width * 0.9);
        g.fillStyle = tokens.textMuted;
        g.font = '500 ' + Math.round(24 * scale) + 'px ' + font;
        g.fillText(period, width / 2, height * 0.44 + 52 * scale + rise, width * 0.9);
        g.font = '400 ' + Math.round(18 * scale) + 'px ' + font;
        g.fillText(charts, width / 2, height * 0.44 + 88 * scale + rise, width * 0.9);
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
        g.fillText(title, pad, pad + titleSize * 0.9, width - pad * 2);
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        const value = block ? countUp(block.value, progress) : null;
        g.font = '700 ' + Math.round(150 * scale) + 'px ' + font;
        g.fillText(state.labels.formatValue(value, spec.measure, { normalize: result.normalize }), width / 2, height * 0.46, width - pad * 2);
        g.fillStyle = tokens.textMuted;
        g.font = '500 ' + Math.round(24 * scale) + 'px ' + font;
        g.fillText(caption, width / 2, height * 0.46 + 100 * scale, width - pad * 2);
        // Jours du record, objectif : quand le compte est fini.
        g.globalAlpha = Math.min(1, Math.max(0, (progress - 0.8) / 0.2));
        g.font = '400 ' + Math.round(20 * scale) + 'px ' + font;
        lines.forEach((line, i) => g.fillText(line, width / 2, height * 0.46 + (140 + i * 30) * scale, width - pad * 2));
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

async function recordDashboardVideo(video) {
    const dashboard = activeDashboard();
    const slides = video.slides.map((id) => state.results.get(id)).filter((entry) => entry?.result);
    if (!slides.length) return;
    const mimeType = videoMimeType();
    if (!mimeType || !HTMLCanvasElement.prototype.captureStream) {
        showError(t("Ce navigateur ne sait pas enregistrer de vidéo."));
        return;
    }
    const size = VIDEO_SIZES[$('statsVideoSize').value] || VIDEO_SIZES.hd;
    const seconds = slideSeconds($('statsVideoDuration').value);
    const duration = dashboardVideoDuration(slides.length, seconds);
    const tokens = state.tokens || readTokens();
    setVideoPhase('recording');
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const g = canvas.getContext('2d');
    $('statsVideoStage').replaceChildren(canvas);
    let current = { key: null, painter: null };
    const painterFor = (moment) => {
        const key = moment.kind === 'intro' ? 'intro' : 'slide:' + moment.index;
        if (current.key !== key) {
            current.painter?.dispose();
            const entry = slides[moment.index];
            current = {
                key,
                painter: moment.kind === 'intro'
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
    paint(0);
    const stream = canvas.captureStream(VIDEO_FPS);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(1000);
    const start = performance.now();
    await new Promise((resolve) => {
        const tick = () => {
            if (video.cancelled) return resolve();
            const elapsed = Math.min(performance.now() - start, duration);
            const moment = paint(elapsed);
            const where = moment.kind === 'intro'
                ? t('ouverture')
                : t('graphique ${n} / ${count}', { n: moment.index + 1, count: slides.length });
            setVideoStatus(t('Enregistrement… (${where})', { where }), (elapsed / duration) * 100);
            if (elapsed >= duration) return resolve();
            return nextFrame(tick);
        };
        nextFrame(tick);
    });
    const recorded = performance.now() - start;
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    current.painter?.dispose();
    if (video.cancelled) return;
    let blob = new Blob(chunks, { type: 'video/webm' });
    try {
        blob = (await fixWebmDuration(blob, recorded, { logger: false })) || blob;
    } catch (_) { /* durée non réécrite : ffmpeg la recalcule */ }
    await convertVideo(video, blob, fileSafe(dashboard.name || t('Mon tableau de bord')));
}

// Avance du temps de la vidéo : requestAnimationFrame quand la page est
// visible, minuteur sinon (un onglet masqué n'a plus d'images).
const nextFrame = (fn) => (document.hidden ? setTimeout(fn, 1000 / VIDEO_FPS) : requestAnimationFrame(fn));

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
    await new Promise((resolve) => {
        const tick = () => {
            if (video.cancelled) return resolve();
            const elapsed = performance.now() - start;
            painter.paint(revealProgress(elapsed, duration));
            setVideoStatus(t('Enregistrement…'), Math.min(100, (elapsed / duration) * 100));
            if (elapsed >= duration) return resolve();
            return nextFrame(tick);
        };
        nextFrame(tick);
    });
    const recorded = performance.now() - start;
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

async function pollTask(id, onProgress) {
    const started = Date.now();
    for (;;) {
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

// Conversion MP4 par le serveur ; à défaut, le WebM enregistré.
async function convertVideo(video, blob, name) {
    setVideoStatus(t('Conversion en MP4…'), 0);
    let result = null;
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
        result = await pollTask(data.task_id, (p) => { if (!video.cancelled) setVideoStatus(t('Conversion en MP4…'), p); });
    } catch (e) {
        console.warn('[stats] Conversion vidéo impossible :', e?.message || e);
    }
    if (video.cancelled) return;
    const player = $('statsVideoPlayer');
    const download = $('btnStatsVideoDownload');
    if (result?.file) {
        video.file = result.file;
        video.folder = result.folder || null;
        const url = '/download_video/' + encodeURIComponent(result.file);
        player.src = url + '?inline=1';
        download.href = url;
        download.removeAttribute('download');
        $('statsVideoDoneNote').textContent = result.folder
            ? t('Vidéo enregistrée : ${file}, dans ${folder}.', { file: result.file, folder: result.folder })
            : result.file;
    } else {
        video.objectUrl = URL.createObjectURL(blob);
        player.src = video.objectUrl;
        download.href = video.objectUrl;
        download.download = name + '.webm';
        $('statsVideoDoneNote').textContent = t('La conversion en MP4 a échoué : la vidéo est proposée au format WebM.');
    }
    $('statsVideoStage').replaceChildren();
    setVideoPhase('done');
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

