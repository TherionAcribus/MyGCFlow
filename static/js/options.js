import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showLoadingToast, showSuccess, showError, showInfo, showWarning } from './notifications.js';

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
    if (pkg.options.options.checkVersion == true) {
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

    fetch(`${CONFIG.BASE_URL}/check_version?lang=${currentLang}`)
    .then(response => {
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json();
    })
    .then(data => {
        console.log("=== DEBUG checkVersion - réponse API ===");
        console.log("Langue utilisée pour la requête:", currentLang);
        console.log("Données brutes de l'API:", data);
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

// Fonction de test pour forcer l'affichage de la modale
export function testModal() {
    const testData = {
        "error": false,
        "update_available": true,
        "latest_version": {
            "version": "2.0",
            "date": "2024-04-10",
            "download_url": "https://example.com/download"
        },
        "versions": [
            {
                "version": "2.0",
                "release_date": "2024-04-10",
                "changelog": ["Refonte majeure", "Optimisations"]
            }
        ]
    };
    console.log("=== TEST MODAL ===");
    displayCheckVersion(testData, "manual");
}

// Fonction de test pour vérifier les traductions
export async function testTranslations() {
    const currentLang = await getCurrentLanguage();
    console.log("=== TEST TRADUCTIONS ===");
    console.log("Langue actuelle:", currentLang);
    console.log("Traductions utilisées:", updateModalTranslations[currentLang] || updateModalTranslations.fr);

    // Test de la modale avec les traductions
    testModal();
}

// Fonction de test pour vérifier les données du serveur
export async function testServerData() {
    console.log("=== TEST DONNÉES SERVEUR ===");
    try {
        // Test avec la langue détectée automatiquement
        console.log("--- Test langue détectée automatiquement ---");
        const responseDefault = await fetch(`${CONFIG.BASE_URL}/check_version`);
        const dataDefault = await responseDefault.json();
        console.log("Données détectées:", dataDefault);
        console.log("Changelog première version:", dataDefault.versions?.[0]?.changelog?.slice(0, 2));

        // Test en forçant français via paramètre URL
        console.log("--- Test paramètre URL français (?lang=fr) ---");
        const responseFr = await fetch(`${CONFIG.BASE_URL}/check_version?lang=fr`);
        const dataFr = await responseFr.json();
        console.log("Données avec ?lang=fr:", dataFr);
        console.log("Changelog première version FR:", dataFr.versions?.[0]?.changelog?.slice(0, 2));

        // Test en forçant anglais via paramètre URL
        console.log("--- Test paramètre URL anglais (?lang=en) ---");
        const responseEn = await fetch(`${CONFIG.BASE_URL}/check_version?lang=en`);
        const dataEn = await responseEn.json();
        console.log("Données avec ?lang=en:", dataEn);
        console.log("Changelog première version EN:", dataEn.versions?.[0]?.changelog?.slice(0, 2));

        // Vérifier la langue actuelle détectée
        console.log("--- Vérification langue détectée ---");
        const localeResponse = await fetch(`${CONFIG.BASE_URL}/api/locale`);
        const localeData = await localeResponse.json();
        console.log("Langue détectée:", localeData);

    } catch (error) {
        console.error("Erreur lors du test des données serveur:", error);
    }
}


// le mode permet de savoir si checkversion depuis initialisation ou demande user
// car on n'affiche la reponse si négative que si demande user
async function displayCheckVersion(data, mode){
    console.log("=== DEBUG displayCheckVersion ===");
    console.log("Data reçue:", data);
    console.log("Mode:", mode);
    console.log("update_available:", data.update_available);
    console.log("error:", data.error);

    const currentLang = await getCurrentLanguage();
    const translations = updateModalTranslations[currentLang] || updateModalTranslations.fr;

    if (data.error == true) {
        console.log("Cas ERREUR");
        // Erreur - toujours afficher en mode manuel, jamais en mode init
        if (mode === "manual") {
            showError("Une erreur est survenue lors de la vérification des mises à jour", translations.verificationError);
        }
    } else if (data.update_available) {
        console.log("Cas MISE À JOUR DISPONIBLE - ouverture modale");
        // Mise à jour disponible - toujours afficher
        const version = data.latest_version.version;
        const date = data.latest_version.date || "Date inconnue";
        const message = currentLang === 'fr'
            ? `Nouvelle version ${version} du ${date} ${translations.updateFound}`
            : `New version ${version} from ${date} ${translations.updateFound}`;

        showWarning(message, translations.updateTitle);
        // Ouvrir la modale détaillée immédiatement après le toast
        console.log("Appel de openUpdateDetailsModal");
        openUpdateDetailsModal(data);
    } else {
        console.log("Cas AUCUNE MISE À JOUR");
        // Aucune mise à jour - seulement en mode manuel
        if (mode === "manual") {
            showSuccess("Votre application est à jour", translations.upToDate);
        }
    }
}

// Fonction pour récupérer la langue actuelle depuis l'URL
function getCurrentLanguage() {
    // Extraire la langue depuis les paramètres URL
    const urlParams = new URLSearchParams(window.location.search);
    const langParam = urlParams.get('lang');

    if (langParam && (langParam === 'fr' || langParam === 'en')) {
        return langParam;
    }

    // Fallback : langue du navigateur
    const browserLang = navigator.language || navigator.userLanguage;
    if (browserLang && browserLang.startsWith('en')) {
        return 'en';
    }

    // Défaut français
    return 'fr';
}

// Fonction pour ouvrir une vraie modale Materialize avec les détails de mise à jour
async function openUpdateDetailsModal(data) {
    console.log("=== DEBUG openUpdateDetailsModal ===");
    console.log("Data reçue dans modale:", data);

    const currentVersion = "1.0"; // Version actuelle de l'application
    const currentLang = await getCurrentLanguage();
    const translations = updateModalTranslations[currentLang] || updateModalTranslations.fr;

    // Créer l'ID unique pour la modal
    const modalId = 'update-details-modal-' + Date.now();

    // Créer le contenu HTML de la modal Materialize
    const modalHTML = `
        <div id="${modalId}" class="modal">
            <div class="modal-content">
                <div class="update-modal-content">
                    <div class="update-header">
                        <h4 class="center-align">${translations.modalTitle}</h4>
                    </div>

                    <div class="update-versions">
                        <div class="row">
                            <div class="col s6 center-align">
                                <div class="version-card current-version">
                                    <h6>${translations.currentVersion}</h6>
                                    <div class="version-number">${currentVersion}</div>
                                </div>
                            </div>
                            <div class="col s6 center-align">
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
                <div class="update-actions center-align">
                    ${data.latest_version.download_url ? `
                        <a href="${data.latest_version.download_url}" target="_blank" class="waves-effect waves-light btn green">
                            <i class="material-icons left">download</i>
                            ${translations.downloadUpdate}
                        </a>
                    ` : ''}
                    <button class="waves-effect waves-light btn-flat modal-close">
                        <i class="material-icons left">close</i>
                        ${translations.later}
                    </button>
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

            .update-actions .btn-flat {
                color: #666;
            }

            .update-actions .btn-flat:hover {
                background-color: #f5f5f5 !important;
            }

            /* Style pour la modal Materialize */
            #${modalId} .modal-content {
                padding-bottom: 0;
            }

            #${modalId} .modal-footer {
                padding-top: 0;
                border-top: none;
            }
        </style>
    `;

    console.log("Création de la modal Materialize avec ID:", modalId);

    // Ajouter la modal au DOM
    document.body.insertAdjacentHTML('beforeend', fullModalHTML);

    // Initialiser et ouvrir la modal Materialize
    const modalElement = document.getElementById(modalId);
    const modalInstance = M.Modal.init(modalElement, {
        dismissible: true,
        opacity: 0.5,
        inDuration: 300,
        outDuration: 200,
        onCloseEnd: function() {
            // Nettoyer la modal du DOM après fermeture
            modalElement.remove();
        }
    });

    // Ouvrir la modal
    modalInstance.open();
    console.log("Modal Materialize ouverte avec succès");
}