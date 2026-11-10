// Rapport de rattachement de l'onglet Zones (templates/menu_zones.html) : les
// noms de Geocaching.com (pays, région, département) que les données de zones
// ne reconnaissent pas. Calcul : zone_report.py, GET /api/zones/report — mes
// trouvailles sur « Mes Géocaches », le jeu ouvert sur « Évolution ».
// Doc : docs/carte-zones.md › Rapport de rattachement.
//
// Rechargé à chaque ouverture de l'onglet (quelques millisecondes côté
// serveur) et quand un autre jeu Évolution s'ouvre. Les noms des zones
// viennent des contours (zone_geo.js), chargés à la demande.

import * as pkg from './index.js';
import { t } from './notifications.js';
import { addGeoListener, zoneFeatures, zoneName } from './zone_geo.js';

const el = (id) => document.getElementById(id);
let report = null;           // dernière réponse du serveur
let status = 'idle';         // idle | loading | ready | error
let requestSeq = 0;
let bound = false;

const page = () => pkg.zoneLayerPage?.() ?? null;
const lang = () => String(document.documentElement.lang || 'fr');
const fmt = (n) => new Intl.NumberFormat(lang()).format(n);

function reportUrl() {
    if (page() === 'evolution') {
        const id = pkg.evolutionDatasetId?.();
        return id ? '/api/zones/report?source=evolution&dataset=' + id : null;
    }
    return '/api/zones/report?source=finds';
}

export async function loadZoneReport() {
    if (!el('zonesReport')) return;
    const url = reportUrl();
    const seq = ++requestSeq;
    if (!url) {
        report = null;
        status = 'ready';
        renderZoneReport();
        return;
    }
    status = 'loading';
    renderZoneReport();
    try {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const body = await response.json();
        if (seq !== requestSeq) return;
        report = body;
        status = 'ready';
    } catch (e) {
        if (seq !== requestSeq) return;
        console.warn('[zones] Rapport de rattachement indisponible :', e?.message || e);
        report = null;
        status = 'error';
    }
    renderZoneReport();
}

// ---------------------------------------------------------------------------
// Libellés

function levelLabel(level) {
    if (level === 'country') return t('Pays');
    if (level === 'region') return t('Région');
    return t('Département, comté…');
}

// Nom d'une zone, si ses contours sont chargés (le chargement est lancé au
// passage ; l'écouteur de zone_geo.js redessine à l'arrivée).
function nameOf(level, id) {
    if (!id) return null;
    const country = String(id).split('-')[0];
    zoneFeatures(level, level === 'country' ? [] : [country]);
    return zoneName(id);
}

function zoneLabel(level, id) {
    if (!id) return t('hors carte');
    const name = nameOf(level, id);
    return name ? `${name} (${id})` : id;
}

function noun(n) {
    return page() === 'evolution' ? t('${n} caches', { n: fmt(n) }) : t('${n} trouvailles', { n: fmt(n) });
}

function itemText(item) {
    const where = item.zones.map(([id, n]) => `${zoneLabel(item.level, id)} : ${fmt(n)}`).join(', ');
    const country = item.level === 'country'
        ? ''
        : ' — ' + (nameOf('country', item.country) || item.country || item.country_name || '?');
    return {
        head: `${levelLabel(item.level)} « ${item.name} »${country}`,
        count: noun(item.count),
        where: t('placées par leur position : ${where}', { where }),
    };
}

function outsideText(outside) {
    const parts = [];
    if (outside?.country) parts.push(t('sans pays : ${n}', { n: fmt(outside.country) }));
    if (outside?.region) parts.push(t('sans région : ${n}', { n: fmt(outside.region) }));
    if (outside?.subregion) parts.push(t('sans département ni comté : ${n}', { n: fmt(outside.subregion) }));
    return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Rendu

export function renderZoneReport() {
    const summary = el('zonesReportSummary');
    if (!summary) return;
    const details = el('zonesReportDetails');
    const list = el('zonesReportList');
    const outside = el('zonesReportOutside');
    const copy = el('btnZonesReportCopy');
    const ready = status === 'ready' && report;
    copy.disabled = !ready || !report.total;
    details.hidden = true;
    outside.hidden = true;
    summary.className = 'mb-0';
    if (status === 'loading' && !report) {
        summary.textContent = t('Vérification des noms…');
        return;
    }
    if (status === 'error') {
        summary.textContent = t('Rapport indisponible.');
        return;
    }
    if (!ready) {
        summary.textContent = page() === 'evolution'
            ? t('Ouvrez un jeu pour vérifier ses noms.')
            : t('Importez vos trouvailles pour vérifier leurs noms.');
        return;
    }
    if (!report.available) {
        summary.textContent = t('Données de zones absentes : rien à vérifier.');
        return;
    }
    if (!report.total) {
        summary.textContent = page() === 'evolution'
            ? t('Ce jeu ne contient aucune cache.')
            : t('Importez vos trouvailles pour vérifier leurs noms.');
        return;
    }
    const items = report.unrecognized || [];
    if (!items.length) {
        summary.textContent = page() === 'evolution'
            ? t('Tous les pays et régions des ${n} caches du jeu sont reconnus par leur nom.', { n: fmt(report.total) })
            : t('Tous les pays et régions de vos ${n} trouvailles sont reconnus par leur nom.', { n: fmt(report.total) });
        summary.className = 'mb-0 text-success';
    } else {
        const rows = items.reduce((sum, item) => sum + item.count, 0);
        summary.textContent = t('Noms non reconnus : ${k} (${rows}). Ces caches sont placées par leur position.', {
            k: fmt(items.length), rows: noun(rows),
        });
        summary.className = 'mb-0 text-warning-emphasis';
        details.hidden = false;
        list.replaceChildren(...items.map((item) => {
            const text = itemText(item);
            const li = document.createElement('li');
            const head = document.createElement('strong');
            head.textContent = text.head;
            const count = document.createElement('span');
            count.className = 'text-muted';
            count.textContent = ' — ' + text.count;
            const where = document.createElement('div');
            where.className = 'form-hint text-muted';
            where.textContent = text.where;
            li.dataset.level = item.level;
            li.append(head, count, where);
            return li;
        }));
    }
    const off = outsideText(report.outside);
    if (off) {
        outside.hidden = false;
        outside.textContent = t('Hors carte — ${parts}. Position absente, ou contraire à la région de Geocaching.com (souvent des mystères).', { parts: off });
    }
}

// Texte copié : à coller tel quel dans une demande GitHub.
export function zoneReportText() {
    if (!report) return '';
    const lines = [];
    lines.push(t('MyGCFlow ${version} — rapport de rattachement aux zones', { version: report.app_version || '?' }));
    lines.push(report.source === 'evolution'
        ? t('Source : jeu Évolution « ${name} » (${n} caches)', { name: report.dataset?.name || '?', n: fmt(report.total) })
        : t('Source : mes trouvailles (${n})', { n: fmt(report.total) }));
    lines.push(t('Données de zones : ${signature}', { signature: report.signature || '—' }));
    lines.push('');
    const items = report.unrecognized || [];
    if (!items.length) {
        lines.push(t('Aucun nom non reconnu.'));
    } else {
        lines.push(t('Noms non reconnus :'));
        const offMap = t('hors carte');
        for (const item of items) {
            const where = item.zones.map(([id, n]) => `${id || offMap} (${n})`).join(', ');
            const country = item.level === 'country' ? '' : ` [${item.country || '?'}${item.country_name ? ' / ' + item.country_name : ''}]`;
            lines.push(`- ${item.level} « ${item.name} »${country} : ${item.count} → ${where}`);
        }
    }
    const off = report.outside || {};
    lines.push('');
    lines.push(t('Hors carte : pays ${a} · région ${b} · sous-région ${c}', {
        a: off.country || 0, b: off.region || 0, c: off.subregion || 0,
    }));
    return lines.join('\n');
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        // Repli (contexte non sécurisé, permission refusée).
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
        area.remove();
        return ok;
    }
}

async function onCopy(event) {
    const button = event.currentTarget;
    const label = button.querySelector('span');
    const ok = await copyText(zoneReportText());
    const original = t('Copier le rapport');
    label.textContent = ok ? t('Rapport copié') : t('Copie impossible');
    setTimeout(() => { label.textContent = original; }, 2000);
}

// Relevé E2E.
export function getZoneReportSnapshot() {
    return {
        status,
        report,
        summary: el('zonesReportSummary')?.textContent ?? null,
        items: [...(el('zonesReportList')?.children || [])].map((li) => li.textContent),
        text: zoneReportText(),
    };
}

function initZoneReport() {
    if (bound || !page() || !el('zonesReport')) return;
    bound = true;
    el('btnZonesReportCopy')?.addEventListener('click', onCopy);
    document.querySelector('a[href="#zones"]')?.addEventListener('shown.bs.tab', loadZoneReport);
    // Un autre jeu ouvert (page Évolution) : rapport à refaire s'il est visible.
    window.addEventListener('mygcflow:evolution-loaded', () => {
        if (el('zones')?.classList.contains('active')) loadZoneReport();
        else report = null;
    });
    addGeoListener(() => { if (report) renderZoneReport(); });
    if (el('zones')?.classList.contains('active')) loadZoneReport();
    else renderZoneReport();
}

// S'initialise lui-même (cf. AGENTS.md, ordre d'évaluation).
if (window.mygcflowReady) {
    initZoneReport();
} else {
    window.addEventListener('mygcflow:ready', initZoneReport, { once: true });
}
