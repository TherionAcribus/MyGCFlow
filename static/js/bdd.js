import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showSuccess, showError, showInfo, t } from './notifications.js';
import { clearMap } from './mapgl.js';
import { showBsModal, hideBsModal } from './ui_bootstrap.js';

export let json_data = null;
export const metadata = {};
export const pointsByDate = new Map();
export let totalCaches = 0;

let readLoadingToast = null;
let noCacheToast = null;

// Jeu de données complet (toutes les caches) conservé en mémoire pour permettre
// un filtrage 100% côté client, sans aller-retour serveur. Alimenté à chaque
// chargement complet (readBdd / loadAndDisplayPoints) et remis à null au vidage.
let baseGeojson = null;

// Gestionnaire pour le chargement automatique lors de la sélection de fichier
const fileInput = document.getElementById('file-input');
if (fileInput) {
    fileInput.addEventListener('change', function(e) {
        if (e.target.files && e.target.files[0]) {
            // Lancer automatiquement le chargement quand un fichier est sélectionné
            uploadBddRequest(e);
        }
    });
}

const clearDatabaseBtn = document.getElementById('clearDatabaseBtn');
if (clearDatabaseBtn) {
    clearDatabaseBtn.addEventListener('click', clearDatabase);
}

// Gestionnaire pour le chargement depuis la modale de première utilisation.
// Même logique que l'input principal, mais sur l'élément #file-input-modal
// présent dans templates/modal_first_use.html.
const fileInputModal = document.getElementById('file-input-modal');
if (fileInputModal) {
    fileInputModal.addEventListener('change', function(e) {
        if (e.target.files && e.target.files[0]) {
            uploadBddRequestFromModal(e);
        }
    });
}

// --- Verrouillage des contrôles pendant un import --------------------------
// Un import vide puis remplit la table Geocache en une transaction côté
// serveur (voir bdd.py:uploadBdd). Lancer un second import ou un vidage de
// base pendant qu'un premier tourne entrelacerait ces opérations. On désactive
// donc les points d'entrée (inputs fichier, bouton de suppression) pendant
// toute la durée d'un import ; le drag & drop, qui ne passe pas par ces
// éléments (listeners globaux sur window), est bloqué via le flag ci-dessous.
let importInProgress = false;

function setImportControlsDisabled(disabled) {
    if (fileInput) fileInput.disabled = disabled;
    if (fileInputModal) fileInputModal.disabled = disabled;
    if (clearDatabaseBtn) clearDatabaseBtn.disabled = disabled;
}

function beginImport() {
    importInProgress = true;
    setImportControlsDisabled(true);
}

function endImport() {
    importInProgress = false;
    setImportControlsDisabled(false);
}

// --- Drag & drop de fichiers GPX -----------------------------------------
// Un overlay plein écran apparaît dès qu'un fichier est glissé au-dessus de la
// fenêtre (n'importe où, y compris sur la carte). Le drop route vers le même
// pipeline d'upload que les inputs fichier.

function isGpxFile(file) {
    return !!file && /\.gpx$/i.test(file.name || '');
}

// Pocket Query telle que téléchargée sur geocaching.com : le serveur en
// extrait le GPX (bdd.py:extract_gpx_from_zip).
function isZipFile(file) {
    return !!file && /\.zip$/i.test(file.name || '');
}

// Un vrai GPX "My Finds" ne dépasse jamais quelques dizaines de Mo ; au-delà,
// il s'agit presque certainement du mauvais fichier. On bloque tôt plutôt que
// de laisser l'utilisateur attendre un upload voué à l'échec.
const GPX_MAX_SIZE_BYTES = 200 * 1024 * 1024; // 200 Mo
// Nombre d'octets lus en tête de fichier pour sniffer <name>/<desc>/<author>
// avant le premier <wpt>, sans upload réseau (cf. GPX_HEADER_SNIFF_BYTES ci-dessous
// et bdd.py:_read_gpx_header pour la même logique, côté serveur, en streaming).
const GPX_HEADER_SNIFF_BYTES = 64 * 1024;

// Extrait le texte du premier tag <tagName>...</tagName> rencontré (sans
// espace de nom). Suffisant ici : les tags d'en-tête GPX (<name>, <desc>,
// <author>) ne sont jamais préfixés dans les exports Groundspeak.
function extractFirstTagText(text, tagName) {
    const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
}

// Sniffe l'en-tête GPX (avant le 1er <wpt>) pour vérifier localement qu'il
// s'agit d'un fichier "My Finds" Groundspeak — sans envoyer le fichier au
// serveur. Reproduit la logique de bdd.py:validate_gpx_header (source unique
// de vérité côté serveur) ; le rejet définitif reste toujours fait côté
// serveur, cette étape n'est qu'une pré-validation pour économiser la bande
// passante sur les cas évidents.
async function sniffGpxHeader(file) {
    let head;
    try {
        head = await file.slice(0, GPX_HEADER_SNIFF_BYTES).text();
    } catch (e) {
        // Lecture locale impossible : ne pas bloquer, le serveur validera.
        return { checked: false };
    }

    const wptIndex = head.search(/<wpt[\s>]/i);
    const headerText = wptIndex === -1 ? head : head.slice(0, wptIndex);

    const nameText = extractFirstTagText(headerText, 'name');
    const descText = extractFirstTagText(headerText, 'desc');
    const authorText = extractFirstTagText(headerText, 'author');

    // Aucun tag d'en-tête trouvé ET aucun <wpt> atteint dans la portion lue :
    // fichier atypique (en-tête anormalement long) — on ne peut pas conclure,
    // on laisse passer et le serveur validera pleinement.
    if (nameText === null && descText === null && authorText === null && wptIndex === -1) {
        return { checked: false };
    }

    const isGroundspeak = (descText && descText.includes('Groundspeak'))
        || (authorText && authorText.includes('Groundspeak'));
    if (!isGroundspeak) {
        return { checked: true, ok: false, message: t("Le fichier GPX n'est pas un fichier produit par Groundspeak.") };
    }

    if (!nameText || !nameText.includes('My Finds Pocket Query')) {
        return { checked: true, ok: false, message: t("Le fichier GPX est une Pocket Query et non un fichier My Finds.") };
    }

    return { checked: true, ok: true };
}

// Validation cliente avant tout envoi réseau : extension, taille, puis
// contenu de l'en-tête (lu localement, sans upload).
async function validateGpxFile(file) {
    const isZip = isZipFile(file);
    if (!isGpxFile(file) && !isZip) {
        return { ok: false, message: t('Veuillez sélectionner un fichier .gpx ou .zip') };
    }
    if (file.size === 0) {
        return { ok: false, message: t('Le fichier sélectionné est vide') };
    }
    if (file.size > GPX_MAX_SIZE_BYTES) {
        return { ok: false, message: t('Le fichier est trop volumineux (200 Mo max)') };
    }

    // Contenu compressé : pas de sniff d'en-tête possible, le serveur valide.
    if (isZip) {
        return { ok: true };
    }

    const header = await sniffGpxHeader(file);
    if (header.checked && !header.ok) {
        return { ok: false, message: header.message };
    }
    return { ok: true };
}

// Point d'entrée unique pour tout fichier GPX à charger (sélection via input
// ou glisser-déposer) : valide, puis route vers le bon flux selon que la
// modale de bienvenue est ouverte.
async function handleGpxFile(file) {
    if (importInProgress) {
        // Les inputs/bouton sont désactivés pendant un import, mais le drag &
        // drop passe par des listeners globaux sur window : cette garde le
        // couvre aussi (double clic très rapide, drop pendant la validation
        // asynchrone du fichier précédent, etc.).
        showError(t('Un import est déjà en cours, veuillez patienter.'), t('Import en cours'));
        return;
    }
    const result = await validateGpxFile(file);
    if (!result.ok) {
        showError(result.message, t('Fichier invalide'));
        return;
    }
    const modalEl = document.getElementById('modal_first_use');
    const modalOpen = !!(modalEl && modalEl.classList.contains('show'));
    if (modalOpen) {
        performUploadFromModal(file);
    } else {
        uploadBdd(file);
    }
}

// Vrai si le drag transporte des fichiers (et non du texte/HTML).
function dragHasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    // dt.types peut être un DOMStringList ou un array selon le navigateur.
    return Array.prototype.indexOf.call(dt.types || [], 'Files') !== -1;
}

function setupGpxDragAndDrop() {
    if (!document.body) return;

    let overlay = document.getElementById('gpxDropOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'gpxDropOverlay';
        overlay.className = 'gpx-drop-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML =
            '<div class="gpx-drop-overlay__inner">' +
            '<i class="ti ti-file-upload"></i>' +
            '<div class="gpx-drop-overlay__text">' +
            t('Déposez votre fichier .gpx pour le charger') +
            '</div></div>';
        document.body.appendChild(overlay);
    }

    // Compteur de profondeur : dragenter/dragleave se déclenchent aussi au
    // passage d'un élément enfant à l'autre ; on ne masque l'overlay que
    // lorsqu'on a réellement quitté la fenêtre.
    let dragDepth = 0;
    const show = () => overlay.classList.add('is-visible');
    const hide = () => { dragDepth = 0; overlay.classList.remove('is-visible'); };

    window.addEventListener('dragenter', (e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        show();
    });
    window.addEventListener('dragover', (e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault(); // indispensable pour autoriser le drop
        try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    });
    window.addEventListener('dragleave', (e) => {
        if (!dragHasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) hide();
    });
    window.addEventListener('drop', (e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        hide();
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleGpxFile(file);
    });
    // Sécurité : si le drag est abandonné hors fenêtre, masquer l'overlay.
    window.addEventListener('dragend', hide);
}

setupGpxDragAndDrop();

// Lit l'état de la BDD (/db_status) et le reflète dans l'UI (texte d'infos +
// visibilité du bouton de vidage). Avec { offerFirstUse: true } (uniquement au
// démarrage), affiche en plus la modale de première utilisation quand aucune
// donnée n'est présente (base absente ou vide) pour inviter à charger un GPX.
// Ce flag n'est PAS activé sur les appels post-import (la base n'est alors pas
// vide de toute façon) ni ailleurs, pour éviter que la modale ne resurgisse.
export function readBddValues({ offerFirstUse = false } = {}){
    try {
        fetch(`${CONFIG.BASE_URL}/db_status`)
        .then(response => response.json())
        .then(data => {
            const infos = document.getElementById('infosBDD');
            const infosModal = document.getElementById('infosBDDModal');

            // "A des données" = base présente ET non vide. Les deux autres cas
            // (vide, ou inexistante) sont traités de façon identique côté UI.
            const hasData = !!(data && data.exists && data.isEmpty === false);

            let text = '';
            if (hasData) {
                const total = data.totalPoints ?? 0;
                const start = data.startDate ?? '';
                const end = data.endDate ?? '';
                const load = data.loadDate ?? '';
                text = `${total} caches | ${start} → ${end}${load ? ' | ' + load : ''}`;
            } else {
                text = t('Aucune base de données chargée');
            }

            if (infos) infos.textContent = text;
            if (infosModal) infosModal.textContent = text;

            const btn = document.getElementById('clearDatabaseBtn');
            if (btn) btn.style.display = hasData ? '' : 'none';

            // Première utilisation : pas de données → inviter à charger un GPX.
            if (offerFirstUse && !hasData) {
                try { showBsModal('modal_first_use'); } catch (e) {
                    console.warn('Affichage modale première utilisation impossible:', e);
                }
            }
        })
        .catch(err => {
            console.error('Erreur lecture infos BDD:', err);
        });
    } catch (e) {
        console.error('readBddValues error:', e);
    }
}

function setMetadata(meta) {
    try {
        for (const k of Object.keys(metadata)) {
            delete metadata[k];
        }
        if (meta && typeof meta === 'object') {
            Object.assign(metadata, meta);
        }
        if (metadata.startDate) {
            metadata.startDate = new Date(metadata.startDate);
        }
        if (metadata.endDate) {
            metadata.endDate = new Date(metadata.endDate);
        }
        if (metadata.publishedStartDate) {
            metadata.publishedStartDate = new Date(metadata.publishedStartDate);
        }
        if (metadata.publishedEndDate) {
            metadata.publishedEndDate = new Date(metadata.publishedEndDate);
        }
    } catch (e) {
        console.warn('setMetadata error:', e);
    }
}

function clearLocalData() {
    json_data = null;
    baseGeojson = null;
    for (const k of Object.keys(metadata)) delete metadata[k];
    pointsByDate.clear();
    totalCaches = 0;
}

function updateUIAfterClear() {
    const infos = document.getElementById('infosBDD');
    const infosModal = document.getElementById('infosBDDModal');
    const btn = document.getElementById('clearDatabaseBtn');
    const counter = document.getElementById('filtersCounter');

    if (infos) infos.textContent = t('Aucune base de données chargée');
    if (infosModal) infosModal.textContent = t('Aucune base de données chargée');
    if (btn) btn.style.display = 'none';
    if (counter) counter.textContent = t('Sélection: 0 / 0');
}

function buildPointsByDateIndex(features = []) {
    try {
        pointsByDate.clear();
        if (!Array.isArray(features)) return;

        for (const f of features) {
            const dateStr = f?.properties?.date_find;
            if (!dateStr) continue;
            const d = new Date(`${dateStr}T00:00:00`);
            if (Number.isNaN(d.getTime())) continue;
            const key = d.toDateString();
            const arr = pointsByDate.get(key) || [];
            arr.push(f);
            pointsByDate.set(key, arr);
        }
    } catch (e) {
        console.warn('buildPointsByDateIndex error:', e);
    }
}

function dateStrToDate() {
    // Historique: conversion des dates côté frontend.
    // Désormais l'index pointsByDate fait l'essentiel (via buildPointsByDateIndex).
}

// --- Filtrage côté client -------------------------------------------------
// Reproduit fidèlement la sémantique du filtrage serveur
// (geojson_cache.py : _matches_filters / build_metadata_from_features) afin
// d'éviter tout aller-retour réseau lorsqu'un filtre change. Les dates (find /
// published) et les bornes des date pickers sont au format ISO 'YYYY-MM-DD',
// donc comparables lexicographiquement.

function toFloatSet(values) {
    const s = new Set();
    for (const v of values || []) {
        const n = Number(v);
        if (Number.isFinite(n)) s.add(n);
    }
    return s;
}

function toStrSet(values) {
    const s = new Set();
    for (const v of values || []) s.add(String(v));
    return s;
}

function normIsoDate(value) {
    if (typeof value !== 'string' || value.length < 10) return null;
    const iso = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

// Vrai si le <select multiple> possède au moins une option réelle (hors
// placeholder disabled à valeur vide). Sert à distinguer "l'utilisateur a
// désélectionné toutes les options (Aucun)" de "la dimension n'a aucune option".
function selectHasRealOptions(selectId) {
    const el = document.getElementById(selectId);
    if (!el) return false;
    return Array.from(el.options).some(o => !o.disabled && o.value !== '');
}

function filterFeaturesClientSide(features, sel) {
    const types = new Set(sel.type || []);
    // Aucun type sélectionné => aucun résultat (comportement identique au serveur).
    if (types.size === 0) return [];

    const terrains = toFloatSet(sel.terrain);
    const difficulties = toFloatSet(sel.difficulty);
    const containers = toStrSet(sel.container);
    const countries = toStrSet(sel.countries);
    const states = toStrSet(sel.states);

    // "Aucun" (aucune option sélectionnée) => aucun résultat, comme pour le type.
    // terrain / difficulté / taille ont toujours des options fixes : un ensemble
    // vide y signifie donc sans ambiguïté "Aucun" et non "pas de filtre".
    if (terrains.size === 0 || difficulties.size === 0 || containers.size === 0) return [];

    // Pays / régions sont peuplés dynamiquement. Un ensemble vide veut dire "Aucun"
    // seulement si le <select> possède réellement des options ; sinon (aucune donnée
    // géographique disponible) la dimension est inactive et ne doit pas filtrer.
    if (selectHasRealOptions('selectCountry') && countries.size === 0) return [];
    if (selectHasRealOptions('selectState') && states.size === 0) return [];

    const dStart = normIsoDate(sel.dates?.startDate);
    const dEnd = normIsoDate(sel.dates?.endDate);
    const dateActive = !!(dStart && dEnd);

    const pStart = normIsoDate(sel.published_dates?.startDate);
    const pEnd = normIsoDate(sel.published_dates?.endDate);
    const pubActive = !!(pStart && pEnd);

    const matchFloat = (val, set) => {
        if (set.size === 0) return true;
        const n = Number(val);
        return Number.isFinite(n) && set.has(n);
    };
    const matchStr = (val, set) => set.size === 0 || set.has(String(val));

    const out = [];
    for (const f of features) {
        const p = (f && f.properties) || {};
        if (!types.has(p.cache_type)) continue;
        if (!matchFloat(p.terrain, terrains)) continue;
        if (!matchFloat(p.difficulty, difficulties)) continue;
        if (!matchStr(p.container, containers)) continue;
        if (!matchStr(p.country, countries)) continue;
        if (!matchStr(p.state, states)) continue;
        if (dateActive) {
            const df = normIsoDate(p.date_find);
            if (!df || df < dStart || df > dEnd) continue;
        }
        if (pubActive) {
            const pd = normIsoDate(p.published_date);
            if (!pd || pd < pStart || pd > pEnd) continue;
        }
        out.push(f);
    }
    return out;
}

function buildMetadataClientSide(features) {
    if (!features || features.length === 0) {
        return {
            startDate: null, endDate: null, deltaDays: null,
            numberOfCaches: 0, publishedStartDate: null, publishedEndDate: null,
        };
    }
    let minFind = null, maxFind = null, minPub = null, maxPub = null;
    for (const f of features) {
        const p = (f && f.properties) || {};
        const df = p.date_find;
        if (df) {
            if (minFind === null || df < minFind) minFind = df;
            if (maxFind === null || df > maxFind) maxFind = df;
        }
        const pd = p.published_date;
        if (pd) {
            if (minPub === null || pd < minPub) minPub = pd;
            if (maxPub === null || pd > maxPub) maxPub = pd;
        }
    }
    let deltaDays = null;
    if (minFind && maxFind) {
        const a = new Date(`${minFind}T00:00:00`);
        const b = new Date(`${maxFind}T00:00:00`);
        if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
            deltaDays = Math.round((b - a) / 86400000);
        }
    }
    return {
        startDate: minFind, endDate: maxFind, deltaDays,
        numberOfCaches: features.length,
        publishedStartDate: minPub, publishedEndDate: maxPub,
    };
}

function updateOptionsValues(meta) {
    try {
        if (!meta || typeof meta !== 'object') return;
        if (typeof meta.deltaDays === 'number') {
            pkg.options.date.deltaDays = meta.deltaDays;
        }
        if (meta.startDate) {
            pkg.options.date.startDate = new Date(meta.startDate);
        }
        if (meta.endDate) {
            pkg.options.date.endDate = new Date(meta.endDate);
        }
        if (!(pkg.options.animation.dateStart instanceof Date) && meta.startDate) {
            pkg.options.animation.dateStart = new Date(meta.startDate);
        }
        if (!(pkg.options.animation.dateEnd instanceof Date) && meta.endDate) {
            pkg.options.animation.dateEnd = new Date(meta.endDate);
        }
    } catch (e) {
        console.warn('updateOptionsValues error:', e);
    }
}

// stallTimeoutMs est un timeout d'INACTIVITÉ (aucune réponse serveur reçue
// depuis stallTimeoutMs), pas un plafond de durée totale : il est repoussé à
// chaque réponse valide, quel que soit l'état/la progression rapportés. Un
// gros import peut légitimement rester plusieurs minutes à progress=99
// ("Enregistrement en base de données...", cf. bdd.py) sans que le
// pourcentage bouge — un timeout basé sur la durée totale afficherait alors
// une erreur côté client alors que l'import continue et réussit côté serveur.
// maxConsecutiveErrors tolère quelques ratés réseau transitoires (Wi-Fi qui
// clignote, etc.) sans abandonner tout le suivi de la tâche.
function pollGeojsonTask(taskId, { onSuccess, onError, onProgress, intervalMs = 400, stallTimeoutMs = 120000, maxConsecutiveErrors = 10 } = {}) {
    let lastActivityAt = Date.now();
    let consecutiveErrors = 0;

    const tick = () => {
        if (!taskId) {
            if (typeof onError === 'function') onError(new Error('Missing taskId'));
            return;
        }

        if (Date.now() - lastActivityAt > stallTimeoutMs) {
            if (typeof onError === 'function') onError(new Error('Task polling timeout'));
            return;
        }

        fetch(`${CONFIG.BASE_URL}/tasks/${encodeURIComponent(taskId)}?include_result=true`, { method: 'GET' })
        .then(r => r.json())
        .then(status => {
            // Réponse valide reçue : le serveur est joignable et suit toujours
            // la tâche — on repousse le timeout d'inactivité et on remet à
            // zéro le compteur d'erreurs réseau transitoires.
            lastActivityAt = Date.now();
            consecutiveErrors = 0;

            const state = status?.state;

            if (state === 'finished') {
                if (typeof onProgress === 'function') onProgress(100);
                if (status && status.result) {
                    if (typeof onSuccess === 'function') onSuccess(status.result);
                } else {
                    if (typeof onError === 'function') onError(new Error('Task finished without result'));
                }
                return;
            }

            if (state === 'failed') {
                const msg = status?.error || status?.message || 'Task failed';
                if (typeof onError === 'function') onError(new Error(msg));
                return;
            }

            if (typeof onProgress === 'function' && typeof status?.progress === 'number') {
                onProgress(status.progress);
            }

            setTimeout(tick, intervalMs);
        })
        .catch(err => {
            consecutiveErrors++;
            if (consecutiveErrors >= maxConsecutiveErrors) {
                if (typeof onError === 'function') onError(err);
                return;
            }
            // Raté réseau isolé (pas une absence de réponse prolongée) : on
            // retente au prochain intervalle plutôt que d'abandonner tout de
            // suite. lastActivityAt n'est volontairement pas repoussé ici :
            // stallTimeoutMs reste le filet de sécurité en cas de panne réelle.
            setTimeout(tick, intervalMs);
        });
    };

    tick();
}

function checkLoadingProgress(toast, taskId, onSuccess, onError, { intervalMs = 400, stallTimeoutMs = 120000 } = {}) {
    pollGeojsonTask(taskId, {
        intervalMs,
        stallTimeoutMs,
        onProgress: (p) => {
            try { if (toast) pkg.updateToastProgress(toast, p); } catch(_) {}
        },
        onSuccess: () => {
            if (typeof onSuccess === 'function') onSuccess();
        },
        onError: (err) => {
            try { if (toast) pkg.hideToast(toast); } catch(_) {}
            if (typeof onError === 'function') onError(err?.message || String(err));
        }
    });
}

// Envoie le fichier GPX via XMLHttpRequest plutôt que fetch : fetch ne rapporte
// aucune progression d'envoi, la toast resterait donc figée pendant tout le
// transfert d'un gros fichier sur une connexion lente. xhr.upload.progress
// permet d'afficher l'avancement réel ("Envoi du fichier : 43 %").
// Une fois le fichier reçu par le serveur, la promesse se résout et l'appelant
// bascule sur checkLoadingProgress, qui pilote la barre pour la phase suivante
// (parsing + import côté serveur — une échelle 0-100 distincte de l'upload).
function uploadGpxWithProgress(file, toast) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('file', file);

        xhr.upload.addEventListener('progress', (e) => {
            if (!e.lengthComputable) return;
            const pct = Math.round((e.loaded / e.total) * 100);
            try {
                pkg.updateToastProgress(toast, pct);
                pkg.updateToastMessage(toast, t('Envoi du fichier : ${pct}%', { pct }));
            } catch (_) {}
        });

        xhr.addEventListener('load', () => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                reject(new Error(t('Réponse invalide du serveur')));
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300 || !data.success || !data.task_id) {
                reject(new Error(data.message || t("Impossible de lancer l'import GPX")));
                return;
            }
            // Transfert terminé : bascule visuellement vers la phase de
            // traitement serveur, dont la progression est pilotée séparément
            // par checkLoadingProgress (appelé par l'appelant avec data.task_id).
            try {
                pkg.updateToastMessage(toast, t('Traitement du fichier en cours...'));
                pkg.setIndeterminateProgress(toast);
            } catch (_) {}
            resolve(data);
        });

        xhr.addEventListener('error', () => reject(new Error(t("Erreur réseau lors de l'envoi du fichier"))));
        xhr.addEventListener('abort', () => reject(new Error(t('Envoi du fichier annulé'))));

        xhr.open('POST', `${CONFIG.BASE_URL}/upload`);
        xhr.send(formData);
    });
}

function uploadBddRequest(e){
    e.preventDefault();

    var fileInput = document.getElementById('file-input');
    var selectedFile = fileInput.files[0];

    if (!selectedFile) {
        showError(t("Veuillez sélectionner un fichier .gpx"), t("Aucun fichier"));
        return;
    }

    // Réinitialiser la valeur dès maintenant pour qu'une re-sélection du
    // même fichier (typiquement après un échec) déclenche à nouveau l'événement
    // change. Le fichier est capturé ci-dessus et passé explicitement à handleGpxFile.
    fileInput.value = '';

    // handleGpxFile valide localement (extension/taille/en-tête) avant tout envoi
    // réseau, puis appelle /upload. La validation complète reste faite côté
    // serveur (uploadBdd) : un fichier invalide qui passerait le sniff client
    // serait quand même rejeté par la tâche de fond.
    handleGpxFile(selectedFile);
}

function uploadBdd (file){
    // Verrouiller les contrôles (inputs, bouton de suppression) pour toute la
    // durée de l'import : évite qu'un second import ou un vidage de base ne
    // s'entrelace avec celui-ci.
    beginImport();

    // Afficher un toast de chargement avec progress bar : uploadGpxWithProgress
    // pilote la barre pendant l'envoi réseau, puis checkLoadingProgress prend
    // le relais pour la phase de traitement serveur.
    const uploadToast = pkg.showLoadingToast(t("Préparation de l'envoi..."), t("Chargement"));

    uploadGpxWithProgress(file, uploadToast)
    .then(data => {
        checkLoadingProgress(uploadToast, data.task_id, () => {
            endImport();
            console.log('[uploadBdd] Import terminé, lancement loadAndDisplayPoints');
            pkg.hideToast(uploadToast);
            pkg.showToast(t("Fichier chargé avec succès !"), "success", t("Terminé"));

            // mets à jour les infos de la BDD
            readBddValues();

            // Charger et afficher les points sur la carte
            loadAndDisplayPoints();
        }, (message) => {
            endImport();
            console.error('[uploadBdd] Erreur import:', message);
            pkg.hideToast(uploadToast);
            pkg.showToast(message || t("Erreur lors du chargement du fichier"), "error", t("Erreur"));
        });
    })
    .catch(error => {
        endImport();
        console.error('Error:', error);
        pkg.hideToast(uploadToast);
        pkg.showToast(error?.message || t("Erreur lors du chargement du fichier"), "error", t("Erreur"));
    });
}

export function readBdd(){
    try { readLoadingToast = pkg.showLoadingToast(t("Chargement de l'application..."), t('Chargement')); } catch(e) {}
    fetch(`${CONFIG.BASE_URL}/get_geojson_points`, { method: 'POST' })
    .then(response => response.json())
    .then(data => {
        if (!data.task_id) {
            throw new Error(data.message || 'Impossible de lancer le chargement de la BDD');
        }
        pollGeojsonTask(data.task_id, {
            onProgress: (p) => {
                try { if (readLoadingToast) pkg.updateToastProgress(readLoadingToast, p); } catch(_) {}
            },
            onSuccess: (result) => {
                if (result.error || !result.geojson) {
                    console.error('Erreur tâche GeoJSON (readBdd):', result.error || 'geojson manquant');
                    try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
                    return;
                }
                console.log('[readBdd] onSuccess - features:', result.geojson?.features?.length, 'metadata:', result.metadata);
                json_data = result.geojson;
                // Conserver le jeu complet pour le filtrage client-side ultérieur.
                baseGeojson = result.geojson;
                setMetadata(result.metadata || {});

                // Mémoriser le total de caches initial
                totalCaches = metadata.numberOfCaches || (result.geojson?.features?.length || 0);

                // Pré-calcul de l'index des points par date pour optimiser l'animation
                buildPointsByDateIndex(result.geojson?.features || []);

                // conversion en objet date
                dateStrToDate();
                // MAJ des frames Infos
                pkg.updateInfosFrameAfterReadBdd(metadata);
                // MAJ du menu d'animation
                pkg.updateAnimationMenuAfterReadBdd(metadata);
                // mise à jour des Date Pickers de l'ui (filtre BDD)
                pkg.setPickerDates(metadata);
                // mise à jour des options en fonction de la BDD (dates début et fin)
                updateOptionsValues(metadata);
                console.log('[readBdd] Appel addVector avec', result.geojson?.features?.length, 'features');
                pkg.addVector(result.geojson);

                // Mettre à jour le compteur : sélection = total au chargement initial
                updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);

                const btn = document.getElementById('clearDatabaseBtn');
                if (btn) btn.style.display = totalCaches > 0 ? '' : 'none';

                try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
            },
            onError: (err) => {
                console.error('Erreur lors du chargement de la BDD:', err);
                try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
                showError(t('Erreur lors du chargement des données'), t('Erreur'));
            }
        });
    })
    .catch(error => {
        console.error('Error:', error);
        try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
        showError(t('Erreur lors du chargement des données'), t('Erreur'));
    });
}

export function changeSelect(selectedValues, optionValues) {
    // Filtrage 100% côté client : le jeu de données complet est déjà en mémoire
    // (baseGeojson). Plus aucun aller-retour serveur — donc plus de tâche, de
    // polling, de toast d'attente ni de mécanisme d'époque anti-race-condition :
    // le traitement est synchrone, il ne peut plus y avoir de résultat obsolète.
    if (!baseGeojson || !Array.isArray(baseGeojson.features)) {
        // Données pas encore chargées : rien à filtrer pour l'instant.
        return;
    }

    const sel = selectedValues || {};
    const filteredFeatures = filterFeaturesClientSide(baseGeojson.features, sel);
    const geojson = { type: 'FeatureCollection', features: filteredFeatures };
    const meta = buildMetadataClientSide(filteredFeatures);

    json_data = geojson;
    setMetadata(meta);

    // Reconstruit l'index des points par date avec les données filtrées
    buildPointsByDateIndex(filteredFeatures);

    // conversion en objet date
    dateStrToDate();
    // remets à jour les options/infos dépendant de la BDD (deltaDays, dates)
    updateOptionsValues(metadata);
    // MAJ des frames Infos
    pkg.updateInfosFrameAfterReadBdd(metadata);
    // Mettre à jour les features affichées sur la carte
    clearMap();
    pkg.addVector(geojson);

    // Mettre à jour le compteur : sélection courante / total initial
    updateFiltersCounter(metadata.numberOfCaches || filteredFeatures.length, totalCaches);
}

function updateFiltersCounter(selected, total){
    try {
        const el = document.getElementById('filtersCounter');
        if (el) {
            el.textContent = `Sélection: ${selected} / ${total}`;
        }

        const badge = document.getElementById('dataTabBadge');
        if (badge) {
            if (total > 0 && selected < total) {
                badge.textContent = `${selected}/${total}`;
                badge.style.display = '';
            } else {
                badge.style.display = 'none';
            }
        }

        // Gérer la toast d'alerte "aucune cache visible"
        if (selected === 0 && total > 0) {
            // Afficher la toast si elle n'existe pas encore
            if (!noCacheToast) {
                noCacheToast = pkg.showToast(t('Aucune cache ne correspond aux critères sélectionnés par les filtres.'), 'warning', t('Aucune cache visible'), 0);
            }

        } else {
            // Fermer la toast si elle existe et qu'il y a des caches affichées
            if (noCacheToast) {
                try {
                    pkg.hideToast(noCacheToast);
                } catch(e) {
                    console.warn('Erreur lors de la fermeture de la toast "aucune cache visible"', e);
                }
                noCacheToast = null;
            }
        }
    } catch(e) { console.warn('updateFiltersCounter error', e); }
}

async function clearDatabase() {
    // Le bouton est désactivé pendant un import (setImportControlsDisabled),
    // mais un clic en file d'attente juste avant la désactivation reste
    // possible : cette garde couvre ce cas limite.
    if (importInProgress) {
        showError(t('Un import est en cours, veuillez patienter avant de vider la base.'), t('Import en cours'));
        return;
    }

    // Action destructive et irréversible : demander confirmation avant toute
    // requête vers /clear_database. On s'appuie sur showConfirmation (toast
    // bloquant avec boutons Confirmer/Annuler) déjà utilisé ailleurs (mapgl.js).
    const confirmed = await new Promise(resolve => {
        if (pkg && pkg.showConfirmation) {
            pkg.showConfirmation(
                t("Êtes-vous sûr de vouloir vider la base de données ? Cette action est irréversible et supprimera toutes vos trouvailles."),
                t("Confirmation de suppression"),
                () => resolve(true),
                () => resolve(false)
            );
        } else {
            // Fallback : pas de système de confirmation disponible, on n'efface pas
            // silencieusement — on alerte l'utilisateur.
            showError(t("Confirmation non disponible, action annulée."), t("Suppression"));
            resolve(false);
        }
    });

    if (!confirmed) return;

    let clearingToast = null;
    
    try {
        // Afficher un toast de chargement
        clearingToast = pkg.showLoadingToast(t("Vidage de la base de données..."), t("Suppression"));

        // Appel à l'endpoint pour vider la base de données
        const response = await fetch(`${CONFIG.BASE_URL}/clear_database`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Vider les données locales
            clearLocalData();
            
            // Vider la carte
            clearMap();
            
            // Mettre à jour l'interface
            updateUIAfterClear();
            
            // Masquer le toast de chargement et afficher le succès
            if (clearingToast) {
                pkg.hideToast(clearingToast);
            }
            showSuccess(t("Base de données vidée avec succès"), t("Suppression réussie"));
            
        } else {
            throw new Error(result.message || 'Erreur inconnue');
        }
        
    } catch (error) {
        console.error('Erreur vidage BDD:', error);
        if (clearingToast) {
            pkg.hideToast(clearingToast);
        }
        showError(t("Erreur lors du vidage de la base de données: ") + error.message, t("Erreur"));
    }
}

function uploadBddRequestFromModal(e) {
    e.preventDefault();

    var fileInput = document.getElementById('file-input-modal');
    var selectedFile = fileInput.files[0];

    if (!selectedFile) {
        showError(t("Veuillez sélectionner un fichier .gpx"), t("Aucun fichier"));
        return;
    }

    // Réinitialiser la valeur pour qu'une re-sélection du même fichier
    // (typiquement après un échec) déclenche à nouveau l'événement change.
    // Le fichier est capturé ci-dessus et passé explicitement à handleGpxFile.
    fileInput.value = '';

    // handleGpxFile valide localement puis route vers performUploadFromModal
    // (la modale est ouverte, donc c'est bien ce flux qui sera choisi).
    handleGpxFile(selectedFile);
}

function performUploadFromModal(file){
    // Verrouiller les contrôles pour toute la durée de l'import (cf. uploadBdd).
    beginImport();

    // Afficher un toast de chargement avec progress bar : uploadGpxWithProgress
    // pilote la barre pendant l'envoi réseau, puis checkLoadingProgress prend
    // le relais pour la phase de traitement serveur.
    const uploadToast = pkg.showLoadingToast(t("Préparation de l'envoi..."), t("Chargement"));

    uploadGpxWithProgress(file, uploadToast)
    .then(data => {
        checkLoadingProgress(uploadToast, data.task_id, () => {
            endImport();
            pkg.hideToast(uploadToast);
            showSuccess(t("Fichier chargé avec succès !"), t("Chargement terminé"));

            // Fermer la modale de première utilisation (Bootstrap 5)
            const modalElement = document.getElementById('modal_first_use');
            if (modalElement) {
                hideBsModal(modalElement);
            }

            // Mettre à jour les infos de la BDD
            readBddValues();

            // Charger et afficher les points sur la carte
            loadAndDisplayPoints();

            // Optionnel : rediriger vers l'onglet de données
            switchToDataTab();
        }, (message) => {
            endImport();
            pkg.hideToast(uploadToast);
            showError(message || t("Erreur lors du chargement du fichier"), t("Erreur"));
        });
    })
    .catch(error => {
        endImport();
        console.error('Erreur:', error);
        pkg.hideToast(uploadToast);
        showError(error?.message || t("Erreur lors du chargement du fichier"), t("Erreur"));
    });
}

function loadAndDisplayPoints() {
    // Afficher un toast pour l'affichage initial des points
    const pointsToast = pkg.showPointsToast(t('Chargement et affichage des points...'), t('Affichage des points'));

    fetch(`${CONFIG.BASE_URL}/get_geojson_points`, { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (!data.task_id) {
                throw new Error(data.message || 'Impossible de lancer la génération du GeoJSON');
            }
            pollGeojsonTask(data.task_id, {
                onProgress: (p) => {
                    try { if (pointsToast) pkg.updateToastProgress(pointsToast, p); } catch(_) {}
                },
                onSuccess: (result) => {
                    console.log('[loadAndDisplayPoints] onSuccess - features:', result?.geojson?.features?.length, '| error:', result?.error);
                    if (result.error || !result.geojson) {
                        console.error('Erreur tâche GeoJSON (loadAndDisplayPoints):', result.error || 'geojson manquant');
                        pkg.hidePointsToast();
                        showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
                        return;
                    }
                    const geojson = result.geojson;
                    const meta = result.metadata || {};

                    json_data = geojson;
                    // Conserver le jeu complet pour le filtrage client-side ultérieur.
                    baseGeojson = geojson;
                    setMetadata(meta);

                    // Mémoriser le total de caches initial
                    totalCaches = metadata.numberOfCaches || (geojson?.features?.length || 0);

                    // Pré-calcul de l'index des points par date pour optimiser l'animation
                    buildPointsByDateIndex(geojson?.features || []);

                    // conversion en objet date
                    dateStrToDate();
                    // MAJ des frames Infos
                    pkg.updateInfosFrameAfterReadBdd(metadata);
                    // MAJ du menu d'animation
                    pkg.updateAnimationMenuAfterReadBdd(metadata);
                    // mise à jour des Date Pickers de l'ui (filtre BDD)
                    pkg.setPickerDates(metadata);
                    // mise à jour des options en fonction de la BDD (dates début et fin)
                    updateOptionsValues(metadata);

                    // Ajouter les points à la carte
                    pkg.addVector(geojson);

                    // Mettre à jour le compteur : sélection = total au chargement initial
                    updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);

                    const btn = document.getElementById('clearDatabaseBtn');
                    if (btn) btn.style.display = '';

                    // Masquer le toast d'affichage initial
                    pkg.hidePointsToast();
                },
                onError: (err) => {
                    console.error('[LOAD_POINTS] Erreur lors du suivi de la génération GeoJSON:', err);
                    pkg.hidePointsToast();
                    showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
                }
            });
        })
        .catch(error => {
            console.error('[LOAD_POINTS] Erreur lors du lancement de la génération des points:', error);
            pkg.hidePointsToast();
            showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
        });
}

// Fonction pour basculer vers l'onglet de données
function switchToDataTab() {
    try {
        // Cliquer sur l'onglet "Données" pour l'activer
        const dataTab = document.querySelector('a[href="#data"]');
        if (dataTab) {
            dataTab.click();
        }
    } catch (e) {
        console.warn('Impossible de basculer vers l\'onglet de données:', e);
    }
}
