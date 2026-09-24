import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showSuccess, showError, showWarning } from './notifications.js';
import { saveSettingsPatch } from './settings_api.mjs';
import { getBsModal } from './ui_bootstrap.js';

// Flag de debug local (cf. DEBUG_MAPGL dans mapgl.js).
// Passer à true pour tracer la vérification de version et l'ouverture de la modale.
const DEBUG_OPTIONS = false;
const dbgOptions = (...args) => { if (DEBUG_OPTIONS) console.log(...args); };

// Traductions de la modale et des toasts de mise à jour.
//
// Ces chaînes sont arrivées ici parce qu'elles naissent côté client : les
// modèles Jinja passent par flask-babel, mais `t()` (notifications.js) n'a pas
// encore de catalogue JS et renvoie son argument tel quel. Tant que ce
// catalogue n'existe pas, ce dictionnaire est le seul endroit où la modale
// existe en deux langues.
const updateModalTranslations = {
    fr: {
        modalTitle: "🚀 Mise à jour disponible !",
        currentVersion: "Version actuelle",
        latestVersion: "Dernière version",
        newFeatures: "Nouveautés et améliorations",
        downloadUpdate: "Télécharger la mise à jour",
        skipVersion: "Ignorer cette version",
        later: "Plus tard",
        updateFound: "trouvée",
        upToDate: "Version actuelle",
        upToDateMessage: "Votre application est à jour",
        updateTitle: "Mise à jour disponible",
        verificationError: "Erreur de vérification",
        verificationFailed: "Impossible de vérifier les mises à jour. Vérifiez votre connexion.",
        skipped: "Vous ne serez plus averti pour cette version."
    },
    en: {
        modalTitle: "🚀 Update available!",
        currentVersion: "Current version",
        latestVersion: "Latest version",
        newFeatures: "New features and improvements",
        downloadUpdate: "Download update",
        skipVersion: "Skip this version",
        later: "Later",
        updateFound: "found",
        upToDate: "Current version",
        upToDateMessage: "Your application is up to date",
        updateTitle: "Update available",
        verificationError: "Verification error",
        verificationFailed: "Could not check for updates. Check your connection.",
        skipped: "You will no longer be notified about this version."
    }
};

export function checkVersionInit(){
    const enabled = pkg.options.options.checkVersion;
    if (enabled === true || enabled === 'true') {
        checkVersion("init");
    }
}

export function openHomePage(){
    const currentLang = getCurrentLanguage();
    const homeUrls = {
        'en': 'http://blfa1842.odns.fr/app/GCMap/gc_map_home_en.html',
        'fr': 'http://blfa1842.odns.fr/app/GCMap/gc_map_home_fr.html'
    };

    const url = homeUrls[currentLang] || homeUrls['fr'];
    window.open(url, '_blank');
}

// `mode` distingue la vérification automatique du démarrage ("init") de celle
// demandée par l'utilisateur. Le serveur en tire deux différences : la première
// est espacée dans le temps et respecte la version ignorée, la seconde vérifie
// toujours. Côté client, seule la seconde signale « vous êtes à jour » ou une
// erreur : au démarrage, un échec réseau ne doit pas se voir.
export function checkVersion(mode="manual"){
    fetch(`${CONFIG.BASE_URL}/check_version?mode=${encodeURIComponent(mode)}`)
    .then(response => {
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json();
    })
    .then(data => {
        dbgOptions("[checkVersion] mode:", mode, "| données API:", data);
        displayCheckVersion(data, mode);
    })
    .catch(error => {
        console.error('Erreur lors de la vérification de version:', error);
        if (mode === "manual") {
            const translations = getTranslations();
            showError(translations.verificationFailed, translations.verificationError);
        }
    });
}

function displayCheckVersion(data, mode){
    dbgOptions("[displayCheckVersion] mode:", mode, "| data:", data);

    const translations = getTranslations();
    const manual = mode !== "init";

    if (data.error === true) {
        // Erreur réseau ou serveur : visible seulement si l'utilisateur a demandé
        // la vérification. Au démarrage, elle reste dans les journaux serveur.
        if (manual) {
            showError(translations.verificationFailed, translations.verificationError);
        }
        return;
    }

    if (data.checked === false) {
        // Vérification reportée (moins de 24 h depuis la précédente). Ce cas ne
        // se produit qu'au démarrage : rien à afficher.
        dbgOptions("[displayCheckVersion] vérification reportée");
        return;
    }

    if (!data.update_available) {
        if (manual) {
            showSuccess(translations.upToDateMessage, translations.upToDate);
        }
        return;
    }

    if (data.skipped && !manual) {
        // L'utilisateur a demandé à ne plus être averti pour cette version-là.
        dbgOptions("[displayCheckVersion] version ignorée par l'utilisateur");
        return;
    }

    const currentLang = getCurrentLanguage();
    const version = data.latest_version.version;
    const date = data.latest_version.date || "";
    const message = currentLang === 'fr'
        ? `Nouvelle version ${version} ${date ? `du ${date} ` : ''}${translations.updateFound}`
        : `New version ${version} ${date ? `from ${date} ` : ''}${translations.updateFound}`;

    showWarning(message, translations.updateTitle);
    openUpdateDetailsModal(data);
}

function getTranslations() {
    return updateModalTranslations[getCurrentLanguage()] || updateModalTranslations.fr;
}

function normalizeLanguage(lang) {
    if (!lang) return null;
    const lower = `${lang}`.toLowerCase();
    if (lower.startsWith('fr')) return 'fr';
    if (lower.startsWith('en')) return 'en';
    return null;
}

function getLanguageFromCookie() {
    const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('mygcflow_lang='));
    if (!cookie) return null;
    return cookie.split('=')[1];
}

// Fonction pour récupérer la langue actuelle en utilisant les préférences persistées
function getCurrentLanguage() {
    const urlParams = new URLSearchParams(window.location.search);
    const langParam = urlParams.get('lang');

    const sources = [
        langParam,
        localStorage.getItem('selectedLanguage'),
        getLanguageFromCookie(),
        window.TRANSLATIONS && window.TRANSLATIONS.current_lang
    ];

    for (const source of sources) {
        const normalized = normalizeLanguage(source);
        if (normalized) {
            return normalized;
        }
    }

    const browserLang = normalizeLanguage(navigator.language || navigator.userLanguage);
    return browserLang || 'fr';
}

// Liste des nouveautés d'une version. Les champs viennent déjà échappés du
// serveur (options.py : `_text`), l'insertion en HTML est donc sûre.
function changelogSection(version) {
    const changelog = Array.isArray(version.changelog) ? version.changelog : [];
    return `
        <div class="version-changelog">
            <h6>Version ${version.version || ''}</h6>
            ${version.release_date ? `<div class="release-date">${version.release_date}</div>` : ''}
            ${changelog.length > 0 ? `
                <ul class="changelog-list">
                    ${changelog.map(change => `<li>${change}</li>`).join('')}
                </ul>
            ` : ''}
        </div>
    `;
}

// Ouvre la modale (Bootstrap 5) présentant les détails de la mise à jour
function openUpdateDetailsModal(data) {
    dbgOptions("[openUpdateDetailsModal] data:", data);

    const currentVersion = data.current_version || "?";
    const translations = getTranslations();
    const latest = data.latest_version;
    const versions = Array.isArray(data.versions) ? data.versions : [];
    const modalId = 'update-details-modal-' + Date.now();

    const modalHTML = `
        <div id="${modalId}" class="modal bs-modal update-modal" tabindex="-1">
            <div class="modal-dialog modal-lg modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title text-center w-100">${translations.modalTitle}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="update-modal-content">
                            <div class="update-versions">
                                <div class="row">
                                    <div class="col-6 text-center">
                                        <div class="version-card current-version">
                                            <h6>${translations.currentVersion}</h6>
                                            <div class="version-number">${currentVersion}</div>
                                        </div>
                                    </div>
                                    <div class="col-6 text-center">
                                        <div class="version-card latest-version">
                                            <h6>${translations.latestVersion}</h6>
                                            <div class="version-number">${latest.version}</div>
                                            ${latest.date ? `<div class="version-date">${latest.date}</div>` : ''}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="update-changelog">
                                <h5>${translations.newFeatures}</h5>
                                <div class="changelog-content">
                                    ${versions.map(changelogSection).join('')}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <div class="update-actions text-center">
                            ${latest.download_url ? `
                                <a href="${latest.download_url}" target="_blank" rel="noopener noreferrer" class="btn btn-success">
                                    <i class="ti ti-download me-1"></i>
                                    ${translations.downloadUpdate}
                                </a>
                            ` : ''}
                            <button type="button" class="btn btn-outline-secondary update-skip" data-bs-dismiss="modal">
                                <i class="ti ti-bell-off me-1"></i>
                                ${translations.skipVersion}
                            </button>
                            <button type="button" class="btn btn-secondary modal-close" data-bs-dismiss="modal">
                                <i class="ti ti-x me-1"></i>
                                ${translations.later}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // Initialiser et ouvrir la modal Bootstrap 5.
    // getBsModal() résout l'API Bootstrap via window.tabler (Tabler 1.4.0
    // n'expose pas window.bootstrap) — un appel direct à `new bootstrap.Modal`
    // lèverait une ReferenceError.
    const modalElement = document.getElementById(modalId);
    const bsModal = getBsModal(modalElement);
    if (!bsModal) {
        console.error("Impossible d'ouvrir la modal de mise à jour : API Bootstrap indisponible");
        modalElement.remove();
        return;
    }

    // « Ignorer cette version » : enregistre le numéro côté serveur, seule la
    // vérification automatique le consultera. Le bouton « Vérifier » la
    // proposera toujours, et une version ultérieure passera outre.
    modalElement.querySelector('.update-skip').addEventListener('click', () => {
        saveSettingsPatch({ skipped_update_version: latest.version });
        showSuccess(translations.skipped, translations.updateTitle);
    });

    modalElement.addEventListener('hidden.bs.modal', () => modalElement.remove());

    bsModal.show();
    dbgOptions("[openUpdateDetailsModal] modal ouverte");
}
