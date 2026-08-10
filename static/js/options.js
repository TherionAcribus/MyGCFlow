import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showSuccess, showError, showWarning } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';

// Flag de debug local (cf. DEBUG_MAPGL dans mapgl.js).
// Passer à true pour tracer la vérification de version et l'ouverture de la modale.
const DEBUG_OPTIONS = false;
const dbgOptions = (...args) => { if (DEBUG_OPTIONS) console.log(...args); };

// Traductions pour la modale et les toasts de mise à jour
const updateModalTranslations = {
    fr: {
        modalTitle: "🚀 Mise à jour disponible !",
        currentVersion: "Version actuelle",
        latestVersion: "Dernière version",
        newFeatures: "Nouveautés et améliorations",
        downloadUpdate: "Télécharger la mise à jour",
        later: "Plus tard",
        updateFound: "trouvée",
        upToDate: "Version actuelle",
        updateTitle: "Mise à jour disponible",
        verificationError: "Erreur de vérification"
    },
    en: {
        modalTitle: "🚀 Update available!",
        currentVersion: "Current version",
        latestVersion: "Latest version",
        newFeatures: "New features and improvements",
        downloadUpdate: "Download update",
        later: "Later",
        updateFound: "found",
        upToDate: "Current version",
        updateTitle: "Update available",
        verificationError: "Verification error"
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

export function checkVersion(mode="manual"){
    // Récupérer la langue actuelle détectée par l'app
    const currentLang = getCurrentLanguage();

    fetch(`${CONFIG.BASE_URL}/check_version`)
    .then(response => {
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json();
    })
    .then(data => {
        dbgOptions("[checkVersion] langue:", currentLang, "| données API:", data);
        displayCheckVersion(data, mode);
    })
    .catch(error => {
        console.error('Erreur lors de la vérification de version:', error);
        // En cas d'erreur, afficher un message d'erreur seulement en mode manuel
        if (mode === "manual") {
            showError(`Erreur lors de la vérification de version: ${error.message}`, "Erreur de vérification");
        }
    });
}

// le mode permet de savoir si checkversion depuis initialisation ou demande user
// car on n'affiche la reponse si négative que si demande user
async function displayCheckVersion(data, mode){
    dbgOptions("[displayCheckVersion] mode:", mode, "| update_available:", data.update_available, "| error:", data.error, "| data:", data);

    const currentLang = await getCurrentLanguage();
    const translations = updateModalTranslations[currentLang] || updateModalTranslations.fr;

    if (data.error == true) {
        dbgOptions("[displayCheckVersion] cas ERREUR");
        // Erreur - toujours afficher en mode manuel, jamais en mode init
        if (mode === "manual") {
            showError("Une erreur est survenue lors de la vérification des mises à jour", translations.verificationError);
        }
    } else if (data.update_available) {
        dbgOptions("[displayCheckVersion] cas MISE À JOUR DISPONIBLE - ouverture modale");
        // Mise à jour disponible - toujours afficher
        const version = data.latest_version.version;
        const date = data.latest_version.date || "Date inconnue";
        const message = currentLang === 'fr'
            ? `Nouvelle version ${version} du ${date} ${translations.updateFound}`
            : `New version ${version} from ${date} ${translations.updateFound}`;

        showWarning(message, translations.updateTitle);
        // Ouvrir la modale détaillée immédiatement après le toast
        openUpdateDetailsModal(data);
    } else {
        dbgOptions("[displayCheckVersion] cas AUCUNE MISE À JOUR");
        // Aucune mise à jour - seulement en mode manuel
        if (mode === "manual") {
            showSuccess("Votre application est à jour", translations.upToDate);
        }
    }
}

function normalizeLanguage(lang) {
    if (!lang) return null;
    const lower = `${lang}`.toLowerCase();
    if (lower.startsWith('fr')) return 'fr';
    if (lower.startsWith('en')) return 'en';
    return null;
}

function getLanguageFromCookie() {
    const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('gcmap_lang='));
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

// Ouvre la modale (Bootstrap 5) présentant les détails de la mise à jour
async function openUpdateDetailsModal(data) {
    dbgOptions("[openUpdateDetailsModal] data:", data);

    const currentVersion = data.current_version || "?";
    const currentLang = await getCurrentLanguage();
    const translations = updateModalTranslations[currentLang] || updateModalTranslations.fr;

    // Créer l'ID unique pour la modal
    const modalId = 'update-details-modal-' + Date.now();

    // Créer le contenu HTML de la modal Bootstrap 5
    const modalHTML = `
        <div id="${modalId}" class="modal bs-modal" tabindex="-1">
            <div class="modal-dialog modal-lg modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title text-center w-100">${translations.modalTitle}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="update-modal-content">
                            <div class="update-header">
                            </div>

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
                                            <div class="version-number">${data.latest_version.version}</div>
                                            ${data.latest_version.date ? `<div class="version-date">${data.latest_version.date}</div>` : ''}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="update-changelog">
                                <h5>${translations.newFeatures}</h5>
                                <div class="changelog-content">
    `;

    let fullModalHTML = modalHTML;

    // Ajouter chaque version avec ses changements
    if (data.versions && data.versions.length > 0) {
        data.versions.forEach(version => {
            // Échapper les caractères spéciaux pour éviter les erreurs HTML
            const safeVersion = String(version.version || '').replace(/[<>]/g, '');
            const safeDate = String(version.release_date || '').replace(/[<>]/g, '');
            const safeChangelog = Array.isArray(version.changelog) ? version.changelog : [];

            fullModalHTML += `
                            <div class="version-changelog">
                                <h6>Version ${safeVersion}</h6>
                                ${safeDate ? `<div class="release-date">${safeDate}</div>` : ''}
                                ${safeChangelog.length > 0 ? `
                                    <ul class="changelog-list">
                                        ${safeChangelog.map(change => `<li>${String(change).replace(/[<>]/g, '')}</li>`).join('')}
                                    </ul>
                                ` : ''}
                            </div>
            `;
        });
    }

    fullModalHTML += `
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <div class="update-actions text-center">
                            ${data.latest_version.download_url ? `
                                <a href="${data.latest_version.download_url}" target="_blank" class="btn btn-success">
                                    <i class="ti ti-download me-1"></i>
                                    ${translations.downloadUpdate}
                                </a>
                            ` : ''}
                            <button class="btn btn-secondary modal-close" data-bs-dismiss="modal">
                                <i class="ti ti-x me-1"></i>
                                ${translations.later}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <style>
            .update-modal-content {
                padding: 20px;
                max-width: 600px;
                margin: 0 auto;
            }

            .update-header {
                margin-bottom: 30px;
            }

            .update-header h4 {
                color: #1976d2;
                margin-bottom: 10px;
            }

            .update-versions {
                margin-bottom: 30px;
            }

            .version-card {
                padding: 20px;
                border-radius: 8px;
                margin: 10px 0;
            }

            .current-version {
                background-color: #f5f5f5;
                border: 2px solid #bdbdbd;
            }

            .latest-version {
                background-color: #e3f2fd;
                border: 2px solid #2196f3;
            }

            .version-card h6 {
                margin: 0 0 10px 0;
                font-size: 0.9em;
                color: #666;
                text-transform: uppercase;
                font-weight: 500;
            }

            .version-number {
                font-size: 1.5em;
                font-weight: bold;
                color: #333;
            }

            .current-version .version-number {
                color: #666;
            }

            .latest-version .version-number {
                color: #1976d2;
            }

            .version-date {
                font-size: 0.8em;
                color: #666;
                margin-top: 5px;
            }

            .update-changelog {
                margin-bottom: 30px;
            }

            .update-changelog h5 {
                color: #333;
                border-bottom: 2px solid #2196f3;
                padding-bottom: 10px;
                margin-bottom: 20px;
            }

            .version-changelog {
                margin-bottom: 20px;
                padding: 15px;
                background-color: #fafafa;
                border-radius: 6px;
                border-left: 4px solid #2196f3;
            }

            .version-changelog h6 {
                margin: 0 0 10px 0;
                color: #1976d2;
                font-size: 1.1em;
            }

            .release-date {
                font-size: 0.85em;
                color: #666;
                margin-bottom: 10px;
                font-style: italic;
            }

            .changelog-list {
                margin: 0;
                padding-left: 20px;
            }

            .changelog-list li {
                margin-bottom: 5px;
                line-height: 1.4;
            }

            .update-actions {
                margin-top: 30px;
            }

            .update-actions .btn {
                margin: 0 10px 10px 0;
                min-width: 160px;
            }

            .update-actions .btn-secondary {
                color: #666;
            }

            .update-actions .btn-secondary:hover {
                background-color: #f5f5f5 !important;
            }

            /* Style pour la modal Bootstrap 5 */
            #${modalId} .modal-content {
                padding-bottom: 0;
            }

            #${modalId} .modal-footer {
                padding-top: 0;
                border-top: none;
            }
        </style>
    `;

    dbgOptions("[openUpdateDetailsModal] création de la modal Bootstrap 5, ID:", modalId);

    // Ajouter la modal au DOM
    document.body.insertAdjacentHTML('beforeend', fullModalHTML);

    // Initialiser et ouvrir la modal Bootstrap 5.
    // getBsModal() résout l'API Bootstrap via window.tabler (Tabler 1.4.0
    // n'expose pas window.bootstrap) — un appel direct à `new bootstrap.Modal`
    // lèverait une ReferenceError.
    const modalElement = document.getElementById(modalId);
    const bsModal = getBsModal(modalElement);
    if (!bsModal) {
        console.error("Impossible d'ouvrir la modal de mise à jour : API Bootstrap indisponible");
        return;
    }
    // Nettoyer la modal du DOM après fermeture
    modalElement.addEventListener('hidden.bs.modal', function() {
        modalElement.remove();
    });

    // Ouvrir la modal
    bsModal.show();
    dbgOptions("[openUpdateDetailsModal] modal ouverte");
}
