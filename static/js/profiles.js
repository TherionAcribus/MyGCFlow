/**
 * Gestion des profils de configuration pour GCMap
 * Permet de sauvegarder, charger, créer, dupliquer et supprimer des profils
 */

import * as pkg from './index.js';

// Helper global: nettoie une chaîne CSS pour ne garder que les déclarations
function extractCssDeclarations(css) {
    if (!css || typeof css !== 'string') return '';
    let text = css.trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
        text = text.substring(first + 1, last);
    }
    // Nettoyage des espaces superflus en début de ligne
    text = text.replace(/^\s+/gm, '');
    return text.trim();
}

class ProfileManager {
    constructor() {
        this.currentProfile = null;
        this.profilesList = [];
        this.init();
    }

    init() {
        this.bindEvents();
        this.loadProfilesList();
        this.loadCurrentSettings();
    }

    bindEvents() {
        // Bouton nouveau profil
        document.getElementById('btn-new-profile')?.addEventListener('click', () => {
            this.showNewProfileModal();
        });

        // Bouton sauvegarder profil
        document.getElementById('btn-save-profile')?.addEventListener('click', () => {
            this.saveCurrentAsProfile();
        });

        // Modal de création/renommage
        document.getElementById('btn-confirm-profile')?.addEventListener('click', () => {
            this.confirmProfileAction();
        });

        // Modal de suppression
        document.getElementById('btn-confirm-delete')?.addEventListener('click', () => {
            this.confirmDeleteProfile();
        });

        // Fermeture des modals
        document.querySelectorAll('.modal').forEach(modal => {
            M.Modal.init(modal);
        });


        // Import profil
        const inputImport = document.getElementById('input-import-profile');
        document.getElementById('btn-import-profile')?.addEventListener('click', () => {
            inputImport && inputImport.click();
        });
        inputImport?.addEventListener('change', async (e) => {
            try {
                const file = e.target.files?.[0];
                if (!file) return;
                const text = await file.text();
                const json = JSON.parse(text);
                const resp = await fetch('/api/profiles/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(json)
                });
                const data = await resp.json();
                if (!resp.ok || !data.success) throw new Error(data.message || 'Import échoué');

                this.showToast(`Profil "${data.name}" importé`, 'green');
                await this.loadProfilesList();
            } catch (e) {
                console.error('Import error', e);
                this.showToast('Erreur import du profil', 'red');
            } finally {
                if (inputImport) inputImport.value = '';
            }
        });
    }

    // API calls
    async apiCall(endpoint, method = 'GET', data = null) {
        const config = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
            }
        };

        if (data) {
            config.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(endpoint, config);
            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.message || 'Erreur API');
            }

            return result;
        } catch (error) {
            console.error('Erreur API:', error);
            this.showToast('Erreur: ' + error.message, 'red');
            throw error;
        }
    }

    async loadProfilesList() {
        try {
            const profiles = await this.apiCall('/api/profiles');
            this.profilesList = profiles;
            this.renderProfilesList();
        } catch (error) {
            console.error('Erreur chargement profils:', error);
        }
    }

    async loadProfile(name) {
        try {
            console.log('Chargement profil depuis API:', name);
            const profile = await this.apiCall(`/api/profiles/${encodeURIComponent(name)}`);

            console.log('📥 PROFIL REÇU DU SERVEUR:', {
                profile_name: profile.name,
                uid: profile.uid,
                version: profile.version,
                map: profile.map,
                animation: profile.animation,
                points: profile.points,
                flash: profile.flash,
                raw_response: profile
            });

            this.currentProfile = profile;
            this.applyProfile(profile);
            this.loadProfilesList(); // Rafraîchir pour montrer le profil actif
            this.showToast(`Profil "${name}" chargé`, 'green');
        } catch (error) {
            console.error('❌ Erreur chargement profil:', error);
        }
    }

    async saveProfile(profileData) {
        try {
            console.log('📤 ENVOI PROFIL AU SERVEUR:', {
                endpoint: `/api/profiles/${encodeURIComponent(profileData.name)}`,
                method: 'PUT',
                data: profileData,
                timestamp: new Date().toISOString()
            });

            const result = await this.apiCall(`/api/profiles/${encodeURIComponent(profileData.name)}`, 'PUT', profileData);

            if (result.success) {
                console.log('Profil sauvegardé avec succès:', profileData.name);
                this.showToast(`Profil "${profileData.name}" sauvegardé`, 'green');
                this.loadProfilesList(); // Rafraîchir la liste
            }
        } catch (error) {
            console.error('❌ Erreur sauvegarde profil:', error);
        }
    }

    async createProfile(name, baseProfile = null) {
        try {
            const result = await this.apiCall('/api/profiles', 'POST', {
                name: name,
                base: baseProfile
            });
            if (result.success) {
                this.showToast(`Profil "${name}" créé`, 'green');
                this.loadProfilesList();
                this.currentProfile = { name: name };
            }
        } catch (error) {
            console.error('Erreur création profil:', error);
        }
    }

    async duplicateProfile(originalName, newName) {
        try {
            const result = await this.apiCall(`/api/profiles/${encodeURIComponent(originalName)}/duplicate`, 'POST', {
                new_name: newName
            });
            if (result.success) {
                this.showToast(`Profil dupliqué: "${newName}"`, 'green');
                this.loadProfilesList();
            }
        } catch (error) {
            console.error('Erreur duplication profil:', error);
        }
    }

    async deleteProfile(name) {
        try {
            const result = await this.apiCall(`/api/profiles/${encodeURIComponent(name)}`, 'DELETE');
            if (result.success) {
                this.showToast(`Profil "${name}" supprimé`, 'orange');
                this.loadProfilesList();
                if (this.currentProfile && this.currentProfile.name === name) {
                    this.currentProfile = null;
                }
            }
        } catch (error) {
            console.error('Erreur suppression profil:', error);
        }
    }

    async resetProfile(name) {
        try {
            const result = await this.apiCall(`/api/profiles/${encodeURIComponent(name)}/reset`, 'POST');
            if (result.success) {
                this.showToast(`Profil "${name}" réinitialisé`, 'blue');
                if (this.currentProfile && this.currentProfile.name === name) {
                    this.loadProfile(name);
                }
            }
        } catch (error) {
            console.error('Erreur réinitialisation profil:', error);
        }
    }

    async exportProfile(name) {
        try {
            console.log('📤 Export profil:', name);
            const resp = await fetch(`/api/profiles/${encodeURIComponent(name)}/export`);
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.message || 'Export échoué');

            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${name}.gcmap-profile.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            this.showToast(`Profil "${name}" exporté`, 'green');
        } catch (e) {
            console.error('Export error', e);
            this.showToast('Erreur export du profil', 'red');
        }
    }

    /**
     * Définir un profil comme profil par défaut depuis le menu contextuel.
     * - Charge le profil pour récupérer son UID
     * - Applique le profil immédiatement
     * - Sauvegarde l'UUID comme profil par défaut
     * - Met à jour le sélecteur et l'indicateur d'actif
     */
    async setProfileAsDefault(profileName) {
        try {
            const profile = await this.apiCall(`/api/profiles/${encodeURIComponent(profileName)}`);
            if (!profile || !profile.uid) {
                throw new Error('Profil introuvable ou UID manquant');
            }

            // Appliquer immédiatement le profil
            this.currentProfile = profile;
            this.applyProfile(profile);

            // Sauvegarder l'UUID comme profil par défaut
            const settings = await this.loadAppSettings();
            settings.default_profile_uid = profile.uid;
            const result = await this.saveAppSettings(settings);

            if (!result.success) {
                throw new Error('Échec de la sauvegarde du profil par défaut');
            }

            this.showToast(`Profil "${profile.name}" défini comme par défaut`, 'green');

            // Rafraîchir les éléments UI dépendants
            this.populateDefaultProfileSelector();
            this.updateCurrentProfileIndicator();
        } catch (error) {
            console.error('❌ Erreur définition profil par défaut:', error);
            this.showToast('Erreur lors de la définition du profil par défaut', 'red');
        }
    }

    // UI methods
    renderProfilesList() {
        const container = document.getElementById('profiles-list');
        if (!container) return;

        container.innerHTML = '';

        if (this.profilesList.length === 0) {
            container.innerHTML = '<div class="collection-item center-align">Aucun profil</div>';
            return;
        }

        this.profilesList.forEach(profileName => {
            const item = document.createElement('div');
            item.className = 'collection-item';

            const isActive = this.currentProfile && this.currentProfile.name === profileName;

            item.innerHTML = `
                <div class="row" style="margin-bottom: 0;">
                    <div class="col s8">
                        <div class="${isActive ? 'active-profile' : ''}" style="cursor: pointer; position: relative;" onclick="profileManager.loadProfile('${profileName.replace(/'/g, "\\'")}')">
                            <i class="material-icons left">palette</i>
                            <span class="profile-name">${profileName}</span>
                            ${isActive ? '<i class="material-icons right">check_circle</i><span class="active-badge">ACTIF</span>' : ''}
                        </div>
                    </div>
                    <div class="col s4 right-align">
                        <a href="#!" class="btn-flat btn-small dropdown-trigger" data-target="dropdown-${profileName.replace(/\s+/g, '-')}">
                            <i class="material-icons">more_vert</i>
                        </a>
                        <ul id="dropdown-${profileName.replace(/\s+/g, '-')}" class="dropdown-content">
                            <li><a class="dropdown-item" href="#!" onclick="profileManager.duplicateProfile('${profileName.replace(/'/g, "\\'")}', '${profileName.replace(/'/g, "\\'")}_copy')"><i class="material-icons">content_copy</i>${window.gettext ? window.gettext('Dupliquer') : 'Dupliquer'}</a></li>
                            <li><a class="dropdown-item" href="#!" onclick="profileManager.renameProfile('${profileName.replace(/'/g, "\\'")}')"><i class="material-icons">edit</i>${window.gettext ? window.gettext('Renommer') : 'Renommer'}</a></li>
                            <li><a class="dropdown-item" href="#!" onclick="profileManager.exportProfile('${profileName.replace(/'/g, "\\'")}')"><i class="material-icons">file_download</i>${window.gettext ? window.gettext('Exporter') : 'Exporter'}</a></li>
                            <li><a class="dropdown-item danger" href="#!" onclick="profileManager.resetProfile('${profileName.replace(/'/g, "\\'")}')"><i class="material-icons">refresh</i>${window.gettext ? window.gettext('Réinitialiser') : 'Réinitialiser'}</a></li>
                            <li><a class="dropdown-item danger" href="#!" onclick="profileManager.confirmDelete('${profileName.replace(/'/g, "\\'")}')"><i class="material-icons">delete</i>${window.gettext ? window.gettext('Supprimer') : 'Supprimer'}</a></li>
                            <li class="divider" tabindex="-1"></li>
                            <li><a class="dropdown-item" href="#!" onclick="profileManager.setProfileAsDefault('${profileName.replace(/'/g, "\\'")}')"><i class="material-icons">star</i>${window.gettext ? window.gettext('Définir comme par défaut') : 'Définir comme par défaut'}</a></li>
                        </ul>
                    </div>
                </div>
            `;

            container.appendChild(item);
        });

        // Initialiser les dropdowns Materialize avec largeur non contrainte
        M.Dropdown.init(document.querySelectorAll('.dropdown-trigger'), {
            constrainWidth: false,
            coverTrigger: false,
            alignment: 'right',
            container: document.body
        });

        // Mettre à jour l'indicateur du profil actif (nécessaire pour le rendu initial)
        this.updateCurrentProfileIndicator();
    }

    updateCurrentProfileIndicator() {
        const indicator = document.getElementById('current-profile-indicator');
        if (indicator) {
            if (this.currentProfile && this.currentProfile.name) {
                indicator.textContent = `(actif: ${this.currentProfile.name})`;
                indicator.style.color = '#4caf50';
                indicator.style.fontWeight = 'bold';
            } else {
                indicator.textContent = '(aucun profil actif)';
                indicator.style.color = '#666';
                indicator.style.fontWeight = 'normal';
            }
        }
    }

    // Gestion du profil par défaut
    async loadAppSettings() {
        try {
            const response = await fetch('/api/settings');
            const settings = await response.json();
            console.log('Paramètres app chargés:', settings);
            return settings;
        } catch (error) {
            console.error('❌ Erreur chargement paramètres app:', error);
            return { default_profile: 'Default' };
        }
    }

    async saveAppSettings(settings) {
        try {
            const response = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
            const result = await response.json();
            console.log('💾 Paramètres app sauvegardés:', result);
            return result;
        } catch (error) {
            console.error('❌ Erreur sauvegarde paramètres app:', error);
            return { success: false };
        }
    }

    async loadProfileByUid(uid) {
        try {
            console.log('🔄 [LOAD_PROFILE] Chargement profil par UUID:', uid);
            console.log('🔄 [LOAD_PROFILE] État avant chargement:', {
                point_mode: pkg?.options?.point?.mode,
                switch_checked: document.getElementById('switchIconeVectoriel')?.checked
            });

            const response = await fetch(`/api/profiles/uid/${encodeURIComponent(uid)}`);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(`HTTP ${response.status}: ${errorData.message || errorData.error || 'Profile not found'}`);
            }

            const profile = await response.json();

            console.log('🔄 [LOAD_PROFILE] PROFIL REÇU PAR UUID:', {
                profile_name: profile.name,
                uid: profile.uid,
                version: profile.version,
                points_mode: profile.points?.mode,
                map: profile.map,
                animation: profile.animation,
                points: profile.points,
                flash: profile.flash,
                infos: profile.infos,
                raw_response: profile
            });

            this.currentProfile = profile;
            this.applyProfile(profile);

            console.log('🔄 [LOAD_PROFILE] État après application du profil:', {
                point_mode: pkg?.options?.point?.mode,
                switch_checked: document.getElementById('switchIconeVectoriel')?.checked,
                profile_applied: profile.name
            });

            this.loadProfilesList(); // Rafraîchir pour montrer le profil actif
            this.showToast(`Profil "${profile.name}" chargé`, 'green');
        } catch (error) {
            console.error('❌ [LOAD_PROFILE] Erreur chargement profil par UUID:', error);
            this.showToast('Erreur lors du chargement du profil par défaut', 'red');
        }
    }

    async populateDefaultProfileSelector() {
        try {
            const selector = document.getElementById('selectDefaultProfile');
            if (!selector) return;

            // Charger la liste des profils
            const profiles = await this.apiCall('/api/profiles');
            const settings = await this.loadAppSettings();

            // Vider le sélecteur
            selector.innerHTML = '';

            // Ajouter l'option "Aucun" (pas de profil par défaut)
            const noneOption = document.createElement('option');
            noneOption.value = '';
            noneOption.textContent = 'Aucun profil par défaut';
            selector.appendChild(noneOption);

            // Ajouter tous les profils disponibles
            profiles.forEach(profileName => {
                const option = document.createElement('option');
                option.value = profileName;
                option.textContent = profileName;
                selector.appendChild(option);
            });

            // Sélectionner le profil par défaut actuel (par nom si disponible)
            selector.value = settings.default_profile_name || '';

            // Initialiser Materialize Select
            M.FormSelect.init(selector);

            console.log('Sélecteur profil par défaut rempli avec:', profiles);
            console.log('🎯 Profil par défaut actuel:', settings.default_profile_name || 'aucun');
        } catch (error) {
            console.error('❌ Erreur remplissage sélecteur profil par défaut:', error);
        }
    }

    async handleDefaultProfileChange() {
        const selector = document.getElementById('selectDefaultProfile');
        if (!selector) return;

        const selectedProfileName = selector.value;
        console.log('Changement profil par défaut:', selectedProfileName);

        let selectedProfileUid = null;
        let appliedProfileName = null;

        // Appliquer immédiatement le profil si un profil est sélectionné
        if (selectedProfileName && selectedProfileName !== '') {
            console.log('🎯 Application immédiate du profil:', selectedProfileName);
            try {
                await this.loadProfile(selectedProfileName);
                // Récupérer l'UUID du profil chargé
                if (this.currentProfile && this.currentProfile.uid) {
                    selectedProfileUid = this.currentProfile.uid;
                    appliedProfileName = this.currentProfile.name;
                }
            } catch (error) {
                console.error('❌ Erreur lors du chargement du profil:', error);
            }
        } else {
            console.log('🚫 Aucun profil sélectionné - pas d\'application');
        }

        // Sauvegarder le nouveau profil par défaut avec UUID
        const currentSettings = await this.loadAppSettings();
        console.log('💾 Sauvegarde profil par défaut:', {
            ancien_uuid: currentSettings.default_profile_uid,
            nouveau_uuid: selectedProfileUid,
            nom_profil: appliedProfileName,
            nom_selectionne: selectedProfileName
        });

        currentSettings.default_profile_uid = selectedProfileUid;

        const result = await this.saveAppSettings(currentSettings);
        if (result.success) {
            console.log('Profil par défaut sauvegardé avec succès, UUID:', selectedProfileUid);
            this.showToast(
                appliedProfileName ?
                    `Profil "${appliedProfileName}" appliqué et défini comme profil par défaut` :
                    'Aucun profil par défaut défini',
                appliedProfileName ? 'success' : 'info'
            );
        } else {
            console.error('❌ Échec de la sauvegarde du profil par défaut');
        }
    }

    async loadDefaultProfileAtStartup() {
        try {
            console.log('🎯 [DEFAULT_PROFILE] Vérification du profil par défaut - État actuel:', {
                point_mode: pkg?.options?.point?.mode,
                switch_checked: document.getElementById('switchIconeVectoriel')?.checked
            });

            const settings = await this.loadAppSettings();
            console.log('🎯 [DEFAULT_PROFILE] Paramètres chargés au démarrage:', {
                default_profile_uid: settings.default_profile_uid,
                default_profile_name: settings.default_profile_name,
                all_settings: settings
            });

            const defaultProfileUid = settings.default_profile_uid;

            if (defaultProfileUid) {
                console.log('🎯 [DEFAULT_PROFILE] Chargement profil par défaut au démarrage (UUID):', defaultProfileUid);
                console.log('🎯 [DEFAULT_PROFILE] Nom du profil par défaut:', settings.default_profile_name);

                console.log('🎯 [DEFAULT_PROFILE] État avant chargement du profil:', {
                    point_mode: pkg?.options?.point?.mode,
                    switch_checked: document.getElementById('switchIconeVectoriel')?.checked
                });

                try {
                    await this.loadProfileByUid(defaultProfileUid);

                    console.log('🎯 [DEFAULT_PROFILE] État après chargement du profil:', {
                        point_mode: pkg?.options?.point?.mode,
                        switch_checked: document.getElementById('switchIconeVectoriel')?.checked,
                        profile_name: this.currentProfile?.name || 'aucun'
                    });
                } catch (error) {
                    console.warn('⚠️ [DEFAULT_PROFILE] Impossible de charger le profil par défaut:', error.message);
                    console.log('🎯 [DEFAULT_PROFILE] Tentative de chargement du profil par défaut du système...');

                    // Essayer de charger un profil par défaut du système
                    try {
                        await this.loadProfile('Default');
                        console.log('✅ [DEFAULT_PROFILE] Profil "Default" chargé comme fallback');
                    } catch (fallbackError) {
                        console.error('❌ [DEFAULT_PROFILE] Échec du chargement du profil "Default":', fallbackError.message);

                        // Si même le profil Default n'existe pas, créer un profil temporaire basique
                        console.log('🎯 [DEFAULT_PROFILE] Création d\'un profil temporaire basique...');
                        try {
                            this.currentProfile = {
                                name: 'Profil Temporaire',
                                uid: 'temp-' + Date.now(),
                                version: '1.0',
                                map: {
                                    tile_provider: 'osm',
                                    default_center: [0, 0],
                                    default_zoom: 2
                                },
                                points: {
                                    mode: 'icone'
                                },
                                flash: {
                                    color_type: 'fix'
                                },
                                animation: {},
                                infos: {}
                            };
                            this.applyProfile(this.currentProfile);
                            this.showToast('Profil temporaire chargé (profil par défaut manquant)', 'orange');
                        } catch (createError) {
                            console.error('❌ [DEFAULT_PROFILE] Impossible de créer un profil temporaire:', createError.message);
                            this.showToast('Erreur lors du chargement du profil par défaut', 'red');
                        }
                    }
                }

                // Vérification finale de cohérence
                const finalSwitchState = document.getElementById('switchIconeVectoriel')?.checked;
                const finalPointMode = pkg?.options?.point?.mode;
                const isConsistent = (finalPointMode === 'vectoriel' && finalSwitchState) ||
                                   (finalPointMode === 'icone' && !finalSwitchState);

                if (isConsistent) {
                    console.log('✅ [DEFAULT_PROFILE] Mode des points cohérent:', finalPointMode);
                } else {
                    console.warn('⚠️ [DEFAULT_PROFILE] Incohérence détectée - Mode:', finalPointMode, 'Switch:', finalSwitchState);
                }

                // Le toast est déjà affiché dans loadProfileByUid
            } else {
                console.log('🎯 [DEFAULT_PROFILE] Aucun profil par défaut défini (default_profile_uid est null/undefined)');
                console.log('🎯 [DEFAULT_PROFILE] Vérifiez que le profil a bien été défini comme par défaut');
            }
        } catch (error) {
            console.error('❌ [DEFAULT_PROFILE] Erreur chargement profil par défaut au démarrage:', error);
            console.error('❌ [DEFAULT_PROFILE] Détails de l\'erreur:', error.message);
        }
    }

    loadCurrentSettings() {
        // Charger les paramètres actuels depuis l'interface
        try {
            // Paramètres de la carte - détecter le fournisseur actif
            let currentTileProvider = 'OSM'; // Valeur par défaut

            // Vérifier quel bouton de carte est actif (celui qui a la classe 'disabled' - logique de l'app)
            const mapButtons = ['OSM', 'stamenToner', 'vectorMap', 'watercolor'];

            // Log de l'état de tous les boutons
            console.log('🔍 État des boutons carte:');
            mapButtons.forEach(btnId => {
                const btn = document.getElementById(btnId);
                const isDisabled = btn && btn.classList.contains('disabled');
                console.log(`  ${btnId}: ${isDisabled ? 'ACTIF (disabled)' : 'inactif'}`);
            });

            for (const buttonId of mapButtons) {
                const button = document.getElementById(buttonId);
                if (button && button.classList.contains('disabled')) {
                    console.log('🎯 Bouton actif trouvé:', buttonId);
                    // Les vrais noms des providers correspondent aux IDs des boutons
                    const idToProvider = {
                        'OSM': 'OSM',
                        'stamenToner': 'stamenToner',
                        'vectorMap': 'vectorMap',
                        'watercolor': 'watercolor'
                    };
                    currentTileProvider = idToProvider[buttonId] || 'OSM';
                    break;
                }
            }

            // Log si aucun bouton n'a été trouvé
            if (currentTileProvider === 'OSM') {
                console.log('Aucun bouton carte trouvé disabled, utilisation valeur par défaut OSM');
            }

            // Essayer aussi de détecter via d'autres indices (classes CSS, etc.)
            if (currentTileProvider === 'OSM') {
                console.log('🔍 Recherche par visibilité des options...');

                // Vérifier si une option spécifique est visible
                const vectorOptions = document.getElementById('vectorMapOptions');
                const tonerOptions = document.getElementById('tonerMapOptions');

                console.log('  vectorMapOptions:', vectorOptions ? vectorOptions.style.display : 'non trouvé');
                console.log('  tonerMapOptions:', tonerOptions ? tonerOptions.style.display : 'non trouvé');

                // Détection par visibilité des options
                if (vectorOptions && vectorOptions.style.display !== 'none') {
                    console.log('🎯 Options vectorMap visibles, changement vers vectorMap');
                    currentTileProvider = 'vectorMap';
                } else if (tonerOptions && tonerOptions.style.display !== 'none') {
                    console.log('🎯 Options toner visibles, changement vers stamenToner');
                    currentTileProvider = 'stamenToner';
                } else {
                    console.log('Aucune option visible trouvée');
                }
            }

            const mapSettings = {
                tile_provider: currentTileProvider,
                default_center: [46.603354, 1.888334], // Centre de la France
                default_zoom: 6
            };

            // Options spécifiques par carte (souple)
            try {
                // Vector map options (si UI présente)
                const strokeColorEl = document.getElementById('fieldVectorMapStrokeColor');
                const fillColorEl = document.getElementById('fieldVectorMapFillColor');
                const backgroundColorEl = document.getElementById('fieldVectorMapBackgroundColor');
                const strokeWidthEl = document.getElementById('fieldVectorMapStrokeWidth');
                if (strokeColorEl || fillColorEl || backgroundColorEl || strokeWidthEl) {
                    mapSettings.vectorOptions = {
                        strokeColor: strokeColorEl ? strokeColorEl.value : undefined,
                        fillColor: fillColorEl ? fillColorEl.value : undefined,
                        backgroundColor: backgroundColorEl ? backgroundColorEl.value : undefined,
                        strokeWidth: strokeWidthEl ? parseFloat(strokeWidthEl.value) : undefined,
                    };
                }

                // Toner options: déterminer le variant via les boutons actifs
                const lightBtn = document.getElementById('stamenTonerLight');
                const darkBtn = document.getElementById('stamenTonerDark');
                let variant = undefined;
                if (lightBtn && lightBtn.classList.contains('disabled')) variant = 'light';
                if (darkBtn && darkBtn.classList.contains('disabled')) variant = 'dark';
                if (variant) {
                    mapSettings.tonerOptions = { variant };
                }
            } catch (e) {
                console.warn('Lecture options spécifiques carte: non bloquant', e);
            }

            console.log('Carte détectée - Provider:', currentTileProvider, 'Settings:', mapSettings);

            // Si la carte est disponible, récupérer la vue actuelle
            if (window.map && typeof window.map.getView === 'function') {
                const view = window.map.getView();
                const center = ol.proj.toLonLat(view.getCenter());
                mapSettings.default_center = [center[0], center[1]];
                mapSettings.default_zoom = view.getZoom();
            }

            // Paramètres des points
            const sizeInput = document.getElementById('sliderSizePoint');
            const colorInput = document.getElementById('pointCenterColor');
            const shapeSelect = document.getElementById('selectShape');
            const borderInput = document.getElementById('sliderSizeBorder');
            const borderColorInput = document.getElementById('pointBorderColor');
            const modeSwitch = document.getElementById('switchIconeVectoriel');

            // Récupération des types de couleur
            const fillColorType = document.querySelector('input[name="fillColorPoint"]:checked');
            const borderColorType = document.querySelector('input[name="borderColorPoint"]:checked');

            const pointSettings = {
                size: sizeInput ? parseInt(sizeInput.value) || 8 : 8,
                color: colorInput ? colorInput.value || '#ff5722' : '#ff5722',
                shape: shapeSelect ? shapeSelect.value || 'circle' : 'circle',
                halo: borderInput ? (parseInt(borderInput.value) > 0) : false,
                border_color: borderColorInput ? borderColorInput.value || '#000000' : '#000000',
                border_size: borderInput ? parseInt(borderInput.value) || 0 : 0,
                fill_color_type: fillColorType ? fillColorType.value || 'fix' : 'fix',
                border_color_type: borderColorType ? borderColorType.value || 'fix' : 'fix',
                mode: modeSwitch ? (modeSwitch.checked ? 'vectoriel' : 'icone') : 'vectoriel'
            };

            console.log('Paramètres points récupérés:', {
                size: pointSettings.size,
                color: pointSettings.color,
                shape: pointSettings.shape,
                halo: pointSettings.halo,
                border_color: pointSettings.border_color,
                border_size: pointSettings.border_size,
                fill_color_type: pointSettings.fill_color_type,
                border_color_type: pointSettings.border_color_type,
                mode: pointSettings.mode
            });

            console.log('🔍 État des éléments HTML:', {
                sizeInput_value: sizeInput ? sizeInput.value : 'null',
                colorInput_value: colorInput ? colorInput.value : 'null',
                borderInput_value: borderInput ? borderInput.value : 'null',
                borderColorInput_value: borderColorInput ? borderColorInput.value : 'null'
            });

            // Paramètres d'animation
            const timeInput = document.getElementById('inputTimePerDay');
            const animationSettings = {
                enabled: true, // Par défaut activé
                speed: timeInput ? Math.max(0.1, Math.min(5.0, 1000 / (parseInt(timeInput.value) || 1000))) : 1.0
            };

            // Paramètres flash - récupération précise depuis les éléments HTML
            const flashModeSelect = document.getElementById('selectFlashMode');
            const flashDurationInput = document.getElementById('inputTimeFlash');
            const flashSizeInput = document.getElementById('inputSizeFlash');
            const flashColorInput = document.getElementById('flashColor');
            const flashColorTypeRadio = document.querySelector('input[name="flashColor"]:checked');

            // Récupération avec vérification des valeurs
            const flashMode = flashModeSelect && flashModeSelect.value ? flashModeSelect.value : 'circle';
            const flashDuration = flashDurationInput && flashDurationInput.value ?
                parseInt(flashDurationInput.value) : 1000;
            const flashSize = flashSizeInput && flashSizeInput.value ?
                parseInt(flashSizeInput.value) : 50;
            const flashColor = flashColorInput && flashColorInput.value ?
                flashColorInput.value : '#FF00FF';
            const flashColorType = flashColorTypeRadio ? flashColorTypeRadio.value : 'fix';

            const flashSettings = {
                mode: flashMode,
                duration: flashDuration,
                size: flashSize,
                color: flashColor,
                color_type: flashColorType
            };

            console.log('🔍 Paramètres flash récupérés:', {
                element_mode: flashModeSelect ? flashModeSelect.value : 'null',
                element_duration: flashDurationInput ? flashDurationInput.value : 'null',
                element_size: flashSizeInput ? flashSizeInput.value : 'null',
                element_color: flashColorInput ? flashColorInput.value : 'null',
                element_color_type: flashColorTypeRadio ? flashColorTypeRadio.value : 'null',
                final_flash: flashSettings
            });

            // Paramètres infos - récupération depuis menu_informations.html
            const displayTitleCheckbox = document.getElementById('cbDisplayTitle');
            const titleInput = document.getElementById('inputTitle');
            const displayNumberofCachesCheckbox = document.getElementById('cbDisplayNumberofCaches');
            const displayCurrentDateCheckbox = document.getElementById('cbDisplayCurrentDate');
            const titleCssTextarea = document.getElementById('inputTitleCss');
            const infosCssTextarea = document.getElementById('inputInfosCss');

            // Nettoyage du CSS (extrait seulement les déclarations)
            function extractCssDeclarations(css) {
                if (!css || typeof css !== 'string') return '';
                let text = css.trim();
                const first = text.indexOf('{');
                const last = text.lastIndexOf('}');
                if (first !== -1 && last !== -1 && last > first) {
                    text = text.substring(first + 1, last);
                }
                // Nettoyage des espaces superflus en début de ligne
                text = text.replace(/^\s+/gm, '');
                return text.trim();
            }

            const infosSettings = {
                title: {
                    display: displayTitleCheckbox ? !!displayTitleCheckbox.checked : true,
                    text: titleInput && titleInput.value !== undefined ? titleInput.value : 'My Geocaching Map'
                },
                number_of_caches: displayNumberofCachesCheckbox ? !!displayNumberofCachesCheckbox.checked : true,
                current_date: displayCurrentDateCheckbox ? !!displayCurrentDateCheckbox.checked : true,
                title_css: extractCssDeclarations(titleCssTextarea ? titleCssTextarea.value : ''),
                infos_css: extractCssDeclarations(infosCssTextarea ? infosCssTextarea.value : ''),
            };

            console.log('📄 Paramètres infos récupérés:', {
                element_title_display: displayTitleCheckbox ? displayTitleCheckbox.checked : 'null',
                element_title_text: titleInput ? titleInput.value : 'null',
                element_title_css_length: titleCssTextarea ? (titleCssTextarea.value || '').length : 'null',
                element_infos_css_length: infosCssTextarea ? (infosCssTextarea.value || '').length : 'null',
                element_caches_display: displayNumberofCachesCheckbox ? displayNumberofCachesCheckbox.checked : 'null',
                element_date_display: displayCurrentDateCheckbox ? displayCurrentDateCheckbox.checked : 'null',
                final_infos: infosSettings
            });

            this.currentSettings = {
                map: mapSettings,
                animation: animationSettings,
                points: pointSettings,
                flash: flashSettings,
                infos: infosSettings,
            };

            console.log('PARAMÈTRES ACTUELS COMPLÈTS - Récupérés depuis l\'interface:', {
                map: mapSettings,
                animation: animationSettings,
                points: pointSettings,
                flash: flashSettings,
                infos: infosSettings,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Erreur lors du chargement des paramètres actuels:', error);
            // Valeurs par défaut en cas d'erreur
            this.currentSettings = {
                map: {
                    tile_provider: 'OpenStreetMap',
                    default_center: [48.8566, 2.3522],
                    default_zoom: 6
                },
                animation: {
                    enabled: true,
                    speed: 1.0
                },
                points: {
                    size: 8,
                    color: '#ff5722',
                    shape: 'circle',
                    halo: false,
                    border_color: '#000000',
                    border_size: 0,
                    fill_color_type: 'fix',
                    border_color_type: 'fix'
                },
                flash: {
                    mode: 'circle',
                    duration: 1000,
                    size: 50,
                    color: '#FF00FF'
                }
            };
        }
    }

    applyProfile(profile) {
        console.log('🎯 APPLICATION PROFIL - Profil complet chargé:', {
            profile_name: profile.name,
            uid: profile.uid,
            version: profile.version,
            map: profile.map,
            animation: profile.animation,
            points: profile.points,
            flash: profile.flash,
            infos: profile.infos,
            timestamp: new Date().toISOString()
        });

        // Appliquer les paramètres du profil à l'interface
        if (profile.map) {
            console.log('Application paramètres carte:', profile.map);
            // Appliquer les paramètres de carte
            if (typeof applyMapSettings === 'function') {
                applyMapSettings(profile.map);
            }
        }

        if (profile.points) {
            console.log('Application paramètres points:', profile.points);
            // Appliquer les paramètres des points
            if (typeof applyPointSettings === 'function') {
                applyPointSettings(profile.points);
            }
        }

        if (profile.animation) {
            console.log('Application paramètres animation:', profile.animation);
            // Appliquer les paramètres d'animation
            if (typeof applyAnimationSettings === 'function') {
                applyAnimationSettings(profile.animation);
            }
        }

        if (profile.flash) {
            console.log('Application paramètres flash:', profile.flash);
            // Appliquer les paramètres flash
            if (typeof applyFlashSettings === 'function') {
                applyFlashSettings(profile.flash);
            }
        }

        // Appliquer les paramètres infos (titre / infosFrame / CSS)
        if (profile.infos) {
            console.log('📄 Application paramètres infos:', profile.infos);
            try {
                // Titre (affichage + texte)
                const displayTitleCheckbox = document.getElementById('cbDisplayTitle');
                const titleInput = document.getElementById('inputTitle');
                if (displayTitleCheckbox) {
                    displayTitleCheckbox.checked = !!(profile.infos.title && profile.infos.title.display);
                    displayTitleCheckbox.dispatchEvent(new Event('change'));
                }
                if (titleInput && profile.infos.title && typeof profile.infos.title.text === 'string') {
                    titleInput.value = profile.infos.title.text;
                    titleInput.dispatchEvent(new Event('input'));
                }

                // Cases à cocher infos (nombre de caches, date)
                const cbCaches = document.getElementById('cbDisplayNumberofCaches');
                const cbDate = document.getElementById('cbDisplayCurrentDate');
                if (cbCaches) {
                    cbCaches.checked = !!profile.infos.number_of_caches;
                    cbCaches.dispatchEvent(new Event('change'));
                }
                if (cbDate) {
                    cbDate.checked = !!profile.infos.current_date;
                    cbDate.dispatchEvent(new Event('change'));
                }

                // CSS titre / infos (via fonctions existantes)
                if (typeof pkg.changeTitleCssValues === 'function' && typeof profile.infos.title_css === 'string') {
                    // Nettoyer le CSS avant application
                    const cleanedTitleCss = extractCssDeclarations(profile.infos.title_css);
                    pkg.changeTitleCssValues(cleanedTitleCss);
                    const titleCssTextarea = document.getElementById('inputTitleCss');
                    if (titleCssTextarea) titleCssTextarea.value = cleanedTitleCss;
                }
                if (typeof pkg.changeInfosCssValues === 'function' && typeof profile.infos.infos_css === 'string') {
                    // Nettoyer le CSS avant application
                    const cleanedInfosCss = extractCssDeclarations(profile.infos.infos_css);
                    pkg.changeInfosCssValues(cleanedInfosCss);
                    const infosCssTextarea = document.getElementById('inputInfosCss');
                    if (infosCssTextarea) infosCssTextarea.value = cleanedInfosCss;
                }

                try {
                    if (typeof window.gcCssAssistantSyncFromTextareas === 'function') {
                        window.gcCssAssistantSyncFromTextareas();
                    }
                } catch (e) {
                    // non bloquant
                }
            } catch (e) {
                console.warn('Application des paramètres infos: erreur non bloquante', e);
            }
        }

        console.log('Profil appliqué avec succès:', profile.name);
    }

    saveCurrentAsProfile() {
        if (!this.currentProfile) {
            this.showNewProfileModal();
            return;
        }

        // Récupérer les paramètres actuels
        this.loadCurrentSettings();

        // Normaliser map pour le serveur (dupliquer camelCase -> snake_case)
        const m = this.currentSettings.map || {};
        const mapNormalized = { ...m };
        if (m.vectorOptions) {
            mapNormalized.vector_options = {
                stroke_color: m.vectorOptions.strokeColor,
                fill_color: m.vectorOptions.fillColor,
                background_color: m.vectorOptions.backgroundColor,
                stroke_width: m.vectorOptions.strokeWidth,
            };
        }
        if (m.tonerOptions) {
            mapNormalized.toner_options = { variant: m.tonerOptions.variant };
        }

        // Créer l'objet profil complet
        const profileData = {
            name: this.currentProfile.name,
            uid: this.currentProfile.uid,
            version: this.currentProfile.version,
            map: mapNormalized,
            animation: this.currentSettings.animation,
            points: this.currentSettings.points,
            flash: this.currentSettings.flash,
            infos: this.currentSettings.infos,
        };

        console.log('💾 SAUVEGARDE PROFIL - Données complètes:', {
            profile_name: profileData.name,
            map: profileData.map,
            animation: profileData.animation,
            points: profileData.points,
            flash: profileData.flash,
            infos: profileData.infos,
            timestamp: new Date().toISOString()
        });

        this.saveProfile(profileData);
        this.updateCurrentProfileIndicator();
    }

    showNewProfileModal() {
        const modal = document.getElementById('profile-modal');
        const title = document.getElementById('profile-modal-title');
        const input = document.getElementById('profile-name-input');
        const confirmBtn = document.getElementById('btn-confirm-profile');

        title.textContent = 'Nouveau profil';
        input.value = '';
        confirmBtn.textContent = 'Créer';

        // Stocker l'action
        confirmBtn.dataset.action = 'create';

        M.Modal.getInstance(modal).open();
        setTimeout(() => input.focus(), 100);
    }

    renameProfile(profileName) {
        const modal = document.getElementById('profile-modal');
        const title = document.getElementById('profile-modal-title');
        const input = document.getElementById('profile-name-input');
        const confirmBtn = document.getElementById('btn-confirm-profile');

        title.textContent = 'Renommer le profil';
        input.value = profileName;
        confirmBtn.textContent = 'Renommer';

        // Stocker l'action et le nom original
        confirmBtn.dataset.action = 'rename';
        confirmBtn.dataset.originalName = profileName;

        M.Modal.getInstance(modal).open();
        setTimeout(() => input.select(), 100);
    }

    confirmProfileAction() {
        const input = document.getElementById('profile-name-input');
        const confirmBtn = document.getElementById('btn-confirm-profile');
        const name = input.value.trim();

        if (!name) {
            this.showToast('Veuillez saisir un nom de profil', 'orange');
            return;
        }

        if (confirmBtn.dataset.action === 'create') {
            this.createProfile(name);
        } else if (confirmBtn.dataset.action === 'rename') {
            const originalName = confirmBtn.dataset.originalName;
            if (originalName !== name) {
                // Pour renommer, on charge l'ancien profil et on le sauvegarde avec le nouveau nom (même UUID)
                this.renameProfileProperly(originalName, name);
            }
        }

        M.Modal.getInstance(document.getElementById('profile-modal')).close();
    }

    async renameProfileProperly(oldName, newName) {
        try {
            console.log('Renommage profil:', oldName, '->', newName);

            // Vérifier si c'était le profil actuellement sélectionné
            const wasCurrentProfile = this.currentProfile && this.currentProfile.name === oldName;

            // SAUVEGARDER L'ÉTAT DE SÉLECTION ACTUEL pour le restaurer après
            const originalCurrentProfile = this.currentProfile;

            // Charger les données du profil SANS l'appliquer (pour éviter de changer l'interface)
            const profileData = await this.apiCall(`/api/profiles/${encodeURIComponent(oldName)}`);

            // Préparer les données pour la sauvegarde avec le nouveau nom mais l'ancien UUID
            const updatedProfileData = {
                name: newName,
                uid: profileData.uid,  // IMPORTANT: garder le même UUID du profil chargé
                map: profileData.map,
                animation: profileData.animation,
                points: profileData.points,
                flash: profileData.flash,
                infos: profileData.infos
            };

            console.log('💾 Sauvegarde profil renommé avec UUID conservé:', updatedProfileData.uid);

            // Sauvegarder en utilisant l'ancien nom dans l'URL mais le nouveau nom dans les données
            const result = await this.apiCall(`/api/profiles/${encodeURIComponent(oldName)}`, 'PUT', updatedProfileData);

            if (result.success) {
                console.log('Profil renommé avec succès:', oldName, '->', newName);

                // Supprimer l'ancien profil seulement après confirmation de la sauvegarde
                setTimeout(async () => {
                    try {
                        // Sauvegarder temporairement currentProfile pour éviter qu'il soit remis à null
                        const tempCurrentProfile = this.currentProfile;

                        await this.deleteProfile(oldName);

                        // Restaurer currentProfile après la suppression
                        this.currentProfile = tempCurrentProfile;

                        // GESTION DE LA SÉLECTION APRÈS RENOMMAGE
                        if (wasCurrentProfile) {
                            // Si c'était le profil sélectionné, mettre à jour avec le nouveau nom
                            if (this.currentProfile) {
                                this.currentProfile.name = newName;
                            }
                        } else {
                            // Si ce n'était pas le profil sélectionné, restaurer l'état original
                            this.currentProfile = originalCurrentProfile;
                        }

                        // Rafraîchir la liste des profils APRÈS mise à jour de currentProfile
                        await this.loadProfilesList();

                        // Rafraîchir l'indicateur de profil actif UNIQUEMENT si nécessaire
                        if (wasCurrentProfile) {
                            // Mettre à jour l'indicateur après rerender
                            await new Promise(r => setTimeout(r, 50));
                            this.updateCurrentProfileIndicator();
                        }

                        // Mettre à jour le sélecteur de profil par défaut si nécessaire
                        this.populateDefaultProfileSelector();

                        this.showToast(`Profil renommé en "${newName}"`, 'success');
                    } catch (error) {
                        console.error('❌ Erreur suppression ancien profil:', error);
                    }
                }, 500);
            }

        } catch (error) {
            console.error('❌ Erreur lors du renommage du profil:', error);
            this.showToast('Erreur lors du renommage du profil', 'red');
        }
    }

    confirmDelete(profileName) {
        const modal = document.getElementById('delete-profile-modal');
        const message = document.getElementById('delete-profile-message');
        const confirmBtn = document.getElementById('btn-confirm-delete');

        message.textContent = `Êtes-vous sûr de vouloir supprimer le profil "${profileName}" ?`;
        confirmBtn.dataset.profileName = profileName;

        M.Modal.getInstance(modal).open();
    }

    confirmDeleteProfile() {
        const confirmBtn = document.getElementById('btn-confirm-delete');
        const profileName = confirmBtn.dataset.profileName;

        this.deleteProfile(profileName);
        M.Modal.getInstance(document.getElementById('delete-profile-modal')).close();
    }

    showToast(message, color = 'blue') {
        // Adapter les couleurs Materialize vers les types du système GCM
        const typeMap = {
            'green': 'success',
            'red': 'error',
            'orange': 'warning',
            'blue': 'info',
            'purple': 'info'
        };

        const gcmType = typeMap[color] || 'info';

        // Utiliser le système de toast GCM de l'application
        try {
            pkg.showToast(message, gcmType, 'Profils');
        } catch (error) {
            // Fallback vers Materialize si le système GCM échoue
            console.warn('Erreur système toast GCM, fallback Materialize:', error);
            M.toast({
                html: message,
                classes: color + ' white-text',
                displayLength: 4000
            });
        }
    }
}

// Fonctions d'application des paramètres (appelées depuis applyProfile)
function applyMapSettings(mapOptions) {
    try {
        console.log('🎯 Application carte - Provider demandé:', mapOptions.tile_provider);

        // Vérifier si la carte est initialisée
        if (!window.map) {
            console.warn('⚠️ Carte non initialisée, report de l\'application des paramètres carte');
            // Reporter l'application dans 500ms
            setTimeout(() => applyMapSettings(mapOptions), 500);
            return;
        }

        // Changer le fournisseur de carte
        const mapButton = document.querySelector(`a[id="${mapOptions.tile_provider}"]`);
        console.log('🎯 Bouton carte trouvé:', !!mapButton, 'ID:', mapOptions.tile_provider);

        if (mapButton) {
            console.log('🎯 Clic sur le bouton carte:', mapOptions.tile_provider);
            mapButton.click();

            // Attendre un peu puis appliquer les options spécifiques
            setTimeout(() => {
                applyMapSpecificOptions(mapOptions.tile_provider, mapOptions);
            }, 100);
        } else {
            console.error('❌ Bouton carte non trouvé pour provider:', mapOptions.tile_provider);
        }

        // Changer la vue (centre et zoom) - si la carte est initialisée
        if (window.map && typeof window.map.getView === 'function') {
            const view = window.map.getView();
            view.setCenter(ol.proj.fromLonLat([mapOptions.default_center[0], mapOptions.default_center[1]]));
            view.setZoom(mapOptions.default_zoom);
        }

        console.log('✅ Paramètres de carte appliqués:', mapOptions);
    } catch (error) {
        console.error('❌ Erreur lors de l\'application des paramètres de carte:', error);
    }
}

function applyMapSpecificOptions(tileProvider, mapOptions) {
    try {
        console.log('🎯 Application options spécifiques pour:', tileProvider);

        if (tileProvider === 'vectorMap') {
            // Options pour la carte vectorielle
            const vectorOptions = document.getElementById('vectorMapOptions');
            const v = (mapOptions.vectorOptions || mapOptions.vector_options || null);
            console.log('🎯 Options vectorMap - element trouvé:', !!vectorOptions, 'options:', !!v);

            if (vectorOptions && v) {
                // Couleurs
                const strokeColor = v.strokeColor || v.stroke_color;
                if (strokeColor) {
                    const strokeColorInput = document.getElementById('fieldVectorMapStrokeColor');
                    if (strokeColorInput) {
                        strokeColorInput.value = strokeColor;
                        strokeColorInput.dispatchEvent(new Event('change'));
                    }
                }

                const fillColor = v.fillColor || v.fill_color;
                if (fillColor) {
                    const fillColorInput = document.getElementById('fieldVectorMapFillColor');
                    if (fillColorInput) {
                        fillColorInput.value = fillColor;
                        fillColorInput.dispatchEvent(new Event('change'));
                    }
                }

                const backgroundColor = v.backgroundColor || v.background_color;
                if (backgroundColor) {
                    const bgColorInput = document.getElementById('fieldVectorMapBackgroundColor');
                    if (bgColorInput) {
                        bgColorInput.value = backgroundColor;
                        bgColorInput.dispatchEvent(new Event('change'));
                    }
                }

                const strokeWidth = v.strokeWidth != null ? v.strokeWidth : v.stroke_width;
                if (strokeWidth != null) {
                    const strokeWidthInput = document.getElementById('fieldVectorMapStrokeWidth');
                    if (strokeWidthInput) {
                        const numWidth = typeof strokeWidth === 'string' ? parseFloat(strokeWidth) : strokeWidth;
                        strokeWidthInput.value = numWidth;
                        strokeWidthInput.dispatchEvent(new Event('input'));
                    }
                }

                // Rafraîchir explicitement la carte vectorielle avec les nouvelles valeurs
                const finalStrokeColor = v.strokeColor || v.stroke_color;
                const finalFillColor = v.fillColor || v.fill_color;
                const finalBackgroundColor = v.backgroundColor || v.background_color;
                const finalStrokeWidth = typeof strokeWidth === 'string' ? parseFloat(strokeWidth) : strokeWidth;

                const vectorValues = {
                    strokeColor: finalStrokeColor,
                    fillColor: finalFillColor,
                    background: finalBackgroundColor,
                    strokeWidth: finalStrokeWidth
                };
                if (typeof pkg.refreshVectorMap === 'function') {
                    console.log('🎯 Rafraîchissement carte vectorielle avec:', vectorValues);
                    pkg.refreshVectorMap(vectorValues);
                } else {
                    console.warn('⚠️ Fonction refreshVectorMap non disponible');
                }
            }
        } else if (tileProvider === 'stamenToner') {
            // Options pour Stamen Toner
            const tonerOptions = document.getElementById('tonerMapOptions');
            const t = (mapOptions.tonerOptions || mapOptions.toner_options || null);
            if (tonerOptions && t) {
                const variant = t.variant;
                if (variant === 'light') {
                    const lightBtn = document.getElementById('stamenTonerLight');
                    if (lightBtn) {
                        lightBtn.click();
                    }
                } else if (variant === 'dark') {
                    const darkBtn = document.getElementById('stamenTonerDark');
                    if (darkBtn) {
                        darkBtn.click();
                    }
                }

                // Rafraîchir explicitement la carte toner avec les nouvelles valeurs
                const tonerValues = { type: variant };
                if (typeof pkg.refreshStamenTonerMap === 'function') {
                    console.log('🎯 Rafraîchissement carte Stamen Toner avec:', tonerValues);
                    pkg.refreshStamenTonerMap(tonerValues);
                } else {
                    console.warn('⚠️ Fonction refreshStamenTonerMap non disponible');
                }
            }
        }

        console.log('Options spécifiques de carte appliquées pour:', tileProvider);
    } catch (error) {
        console.error('Erreur lors de l\'application des options spécifiques de carte:', error);
    }
}

function applyPointSettings(pointOptions) {
    try {
        console.log('🎯 APPLICATION PARAMÈTRES POINTS - Données reçues:', pointOptions);

        // Appliquer le mode (icone/vectoriel)
        const modeSwitch = document.getElementById('switchIconeVectoriel');
        if (modeSwitch && pointOptions.mode) {
            modeSwitch.checked = pointOptions.mode === 'vectoriel';
            modeSwitch.dispatchEvent(new Event('change'));
            console.log('🎯 Application mode des points:', pointOptions.mode, '-> switch checked:', modeSwitch.checked);
        }

        // Appliquer la taille des points
        const sizeInput = document.getElementById('sliderSizePoint');
        if (sizeInput) {
            sizeInput.value = pointOptions.size;
            // Synchroniser avec l'input numérique si présent
            const numberInput = document.getElementById('inputSizePoint');
            if (numberInput) {
                numberInput.value = pointOptions.size;
            }
            // Déclencher l'événement change si nécessaire
            sizeInput.dispatchEvent(new Event('input'));
        }

        // Appliquer le type de couleur des points
        console.log('Application type de couleur des points:', pointOptions.fill_color_type);
        const fillColorRadio = document.querySelector(`input[name="fillColorPoint"][value="${pointOptions.fill_color_type}"]`);
        if (fillColorRadio) {
            fillColorRadio.checked = true;
            fillColorRadio.dispatchEvent(new Event('change'));
        }

        const colorInput = document.getElementById('pointCenterColor');
        if (colorInput) {
            colorInput.value = pointOptions.color;
            colorInput.dispatchEvent(new Event('change'));
        }

        // Appliquer la forme des points
        const shapeSelect = document.getElementById('selectShape');
        if (shapeSelect) {
            shapeSelect.value = pointOptions.shape;
            shapeSelect.dispatchEvent(new Event('change'));
        }

        // Appliquer le halo (bordure)
        const borderSizeInput = document.getElementById('sliderSizeBorder');
        const borderColorInput = document.getElementById('pointBorderColor');
        const borderNumberInput = document.getElementById('inputSizeBorder');

        console.log('🔍 État avant application bordure:', {
            borderSizeInput_exists: !!borderSizeInput,
            borderColorInput_exists: !!borderColorInput,
            current_border_size: borderSizeInput ? borderSizeInput.value : 'null',
            current_border_color: borderColorInput ? borderColorInput.value : 'null'
        });

        if (pointOptions.halo) {
            // Activer le type de couleur approprié pour la bordure
            console.log('Application type de couleur des bordures:', pointOptions.border_color_type);
            const borderColorRadio = document.querySelector(`input[name="borderColorPoint"][value="${pointOptions.border_color_type}"]`);
            if (borderColorRadio) {
                borderColorRadio.checked = true;
                borderColorRadio.dispatchEvent(new Event('change'));
            }

            // Appliquer la taille de bordure sauvegardée
            if (borderSizeInput) {
                borderSizeInput.value = Math.max(0, Math.min(10, pointOptions.border_size || 0));
                if (borderNumberInput) {
                    borderNumberInput.value = borderSizeInput.value;
                }
                borderSizeInput.dispatchEvent(new Event('input'));
                console.log('🔵 Application taille bordure:', pointOptions.border_size, '->', borderSizeInput.value);
            }

            // Appliquer la couleur de bordure sauvegardée
            if (borderColorInput) {
                borderColorInput.value = pointOptions.border_color || '#000000';
                borderColorInput.dispatchEvent(new Event('change'));
                console.log('🟥 Application couleur bordure:', pointOptions.border_color, '->', borderColorInput.value);
            }
        } else {
            // Désactiver la bordure
            if (borderSizeInput) {
                borderSizeInput.value = 0;
                if (borderNumberInput) {
                    borderNumberInput.value = 0;
                }
                borderSizeInput.dispatchEvent(new Event('input'));
            }
        }

        console.log('🔍 État après application bordure:', {
            new_border_size: borderSizeInput ? borderSizeInput.value : 'null',
            new_border_color: borderColorInput ? borderColorInput.value : 'null'
        });

        console.log('Paramètres des points appliqués avec succès:', pointOptions);
    } catch (error) {
        console.error('❌ Erreur lors de l\'application des paramètres des points:', error);
    }
}

function applyAnimationSettings(animationOptions) {
    try {
        // Appliquer la vitesse d'animation (convertir la vitesse en ms par jour)
        // speed 1.0 = 1000ms, speed 2.0 = 500ms, etc.
        const timePerDay = Math.max(100, Math.round(1000 / animationOptions.speed));
        const timeInput = document.getElementById('inputTimePerDay');
        if (timeInput) {
            timeInput.value = timePerDay;
            timeInput.dispatchEvent(new Event('change'));
        }

        console.log('Paramètres d\'animation appliqués:', animationOptions, 'timePerDay:', timePerDay);
    } catch (error) {
        console.error('Erreur lors de l\'application des paramètres d\'animation:', error);
    }
}

function applyFlashSettings(flashOptions) {
    try {
        // Définir color_type par défaut si non défini (compatibilité profils anciens)
        if (!flashOptions.color_type) {
            flashOptions.color_type = 'fix';
        }
        // Appliquer la forme du flash
        if (flashOptions.mode) {
            const flashModeSelect = document.getElementById('selectFlashMode');
            if (flashModeSelect) {
                flashModeSelect.value = flashOptions.mode;
                flashModeSelect.dispatchEvent(new Event('change'));
            }
        }

        // Appliquer la durée du flash
        if (flashOptions.duration) {
            const durationInput = document.getElementById('inputTimeFlash');
            if (durationInput) {
                durationInput.value = flashOptions.duration;
                durationInput.dispatchEvent(new Event('change'));
            }
        }

        // Appliquer la taille du flash
        if (flashOptions.size) {
            const sizeInput = document.getElementById('inputSizeFlash');
            if (sizeInput) {
                sizeInput.value = flashOptions.size;
                sizeInput.dispatchEvent(new Event('change'));
            }
        }

        // Appliquer la couleur du flash
        if (flashOptions.color) {
            const colorInput = document.getElementById('flashColor');
            if (colorInput) {
                colorInput.value = flashOptions.color;
                colorInput.dispatchEvent(new Event('change'));
            }
        }

        // Appliquer le type de couleur du flash
        if (flashOptions.color_type) {
            const colorTypeRadio = document.querySelector(`input[name="flashColor"][value="${flashOptions.color_type}"]`);
            if (colorTypeRadio) {
                colorTypeRadio.checked = true;
                // Déclencher l'événement pour mettre à jour l'interface
                colorTypeRadio.dispatchEvent(new Event('change'));
            }

            // Mettre à jour l'affichage du color picker selon le type
            const flashColorPickerContainer = document.querySelector('#flashColor').closest('.input-field');
            if (flashColorPickerContainer) {
                flashColorPickerContainer.style.display = (flashOptions.color_type === 'fix') ? 'block' : 'none';
            }
        }

        console.log('Paramètres flash appliqués:', flashOptions);
    } catch (error) {
        console.error('Erreur lors de l\'application des paramètres flash:', error);
    }
}

// Initialisation globale
let profileManager;
document.addEventListener('DOMContentLoaded', function() {
    profileManager = new ProfileManager();
    // Rendre disponible globalement pour les événements HTML
    window.profileManager = profileManager;

    // Mettre à jour l'indicateur initial
    setTimeout(() => {
        profileManager.updateCurrentProfileIndicator();

        // Remplir le sélecteur de profil par défaut
        profileManager.populateDefaultProfileSelector();

        // Le chargement du profil par défaut est maintenant géré dans init.js après init_ui()

        // Écouter les changements du sélecteur de profil par défaut
        const defaultProfileSelector = document.getElementById('selectDefaultProfile');
        if (defaultProfileSelector) {
            defaultProfileSelector.addEventListener('change', () => {
                console.log('🎯 Changement détecté dans sélecteur profil par défaut');
                profileManager.handleDefaultProfileChange();
            });
        }
    }, 100);
});
