/**
 * Gestion des profils de configuration pour GCMap
 * Permet de sauvegarder, charger, créer, dupliquer et supprimer des profils
 */

import * as pkg from './index.js';

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
            console.log('🔄 Chargement profil depuis API:', name);
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
            this.updateCurrentProfileIndicator();
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
                console.log('✅ Profil sauvegardé avec succès:', profileData.name);
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
                            <li><a href="#!" onclick="profileManager.duplicateProfile('${profileName.replace(/'/g, "\\'")}', '${profileName.replace(/'/g, "\\'")}_copy')"><i class="material-icons">content_copy</i>Dupliquer</a></li>
                            <li><a href="#!" onclick="profileManager.renameProfile('${profileName.replace(/'/g, "\\'")}')"><i class="material-icons">edit</i>Renommer</a></li>
                            <li><a href="#!" onclick="profileManager.resetProfile('${profileName.replace(/'/g, "\\'")}')"><i class="material-icons">refresh</i>Réinitialiser</a></li>
                            <li><a href="#!" onclick="profileManager.confirmDelete('${profileName.replace(/'/g, "\\'")}')"><i class="material-icons">delete</i>Supprimer</a></li>
                        </ul>
                    </div>
                </div>
            `;

            container.appendChild(item);
        });

        // Initialiser les dropdowns Materialize
        M.Dropdown.init(document.querySelectorAll('.dropdown-trigger'));

        // Mettre à jour l'indicateur du profil actif
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
            console.log('🔧 Paramètres app chargés:', settings);
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

            // Sélectionner le profil par défaut actuel
            selector.value = settings.default_profile || '';

            // Initialiser Materialize Select
            M.FormSelect.init(selector);

            console.log('📋 Sélecteur profil par défaut rempli avec:', profiles);
        } catch (error) {
            console.error('❌ Erreur remplissage sélecteur profil par défaut:', error);
        }
    }

    async handleDefaultProfileChange() {
        const selector = document.getElementById('selectDefaultProfile');
        if (!selector) return;

        const selectedProfile = selector.value;
        console.log('🔄 Changement profil par défaut:', selectedProfile);

        // Appliquer immédiatement le profil si un profil est sélectionné
        if (selectedProfile && selectedProfile !== '') {
            console.log('🎯 Application immédiate du profil:', selectedProfile);
            await this.loadProfile(selectedProfile);
        } else {
            console.log('🚫 Aucun profil sélectionné - pas d\'application');
        }

        // Sauvegarder le nouveau profil par défaut
        const currentSettings = await this.loadAppSettings();
        currentSettings.default_profile = selectedProfile;

        const result = await this.saveAppSettings(currentSettings);
        if (result.success) {
            this.showToast(
                selectedProfile ?
                    `Profil "${selectedProfile}" appliqué et défini comme profil par défaut` :
                    'Aucun profil par défaut défini',
                selectedProfile ? 'success' : 'info'
            );
        }
    }

    async loadDefaultProfileAtStartup() {
        try {
            const settings = await this.loadAppSettings();
            const defaultProfile = settings.default_profile;

            if (defaultProfile && defaultProfile !== '' && defaultProfile !== 'Default') {
                console.log('🚀 Chargement profil par défaut au démarrage:', defaultProfile);
                await this.loadProfile(defaultProfile);
                this.showToast(`Profil par défaut "${defaultProfile}" chargé`, 'info');
            }
        } catch (error) {
            console.error('❌ Erreur chargement profil par défaut au démarrage:', error);
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
                console.log('⚠️ Aucun bouton carte trouvé disabled, utilisation valeur par défaut OSM');
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
                    console.log('⚠️ Aucune option visible trouvée');
                }
            }

            const mapSettings = {
                tile_provider: currentTileProvider,
                default_center: [46.603354, 1.888334], // Centre de la France
                default_zoom: 6
            };

            console.log('🗺️ Carte détectée - Provider:', currentTileProvider, 'Settings:', mapSettings);

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
                border_color_type: borderColorType ? borderColorType.value || 'fix' : 'fix'
            };

            console.log('📍 Paramètres points récupérés:', {
                size: pointSettings.size,
                color: pointSettings.color,
                shape: pointSettings.shape,
                halo: pointSettings.halo,
                border_color: pointSettings.border_color,
                border_size: pointSettings.border_size,
                fill_color_type: pointSettings.fill_color_type,
                border_color_type: pointSettings.border_color_type
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

            // Récupération avec vérification des valeurs
            const flashMode = flashModeSelect && flashModeSelect.value ? flashModeSelect.value : 'circle';
            const flashDuration = flashDurationInput && flashDurationInput.value ?
                parseInt(flashDurationInput.value) : 1000;
            const flashSize = flashSizeInput && flashSizeInput.value ?
                parseInt(flashSizeInput.value) : 50;
            const flashColor = flashColorInput && flashColorInput.value ?
                flashColorInput.value : '#FF00FF';

            const flashSettings = {
                mode: flashMode,
                duration: flashDuration,
                size: flashSize,
                color: flashColor
            };

            console.log('🔍 Paramètres flash récupérés:', {
                element_mode: flashModeSelect ? flashModeSelect.value : 'null',
                element_duration: flashDurationInput ? flashDurationInput.value : 'null',
                element_size: flashSizeInput ? flashSizeInput.value : 'null',
                element_color: flashColorInput ? flashColorInput.value : 'null',
                final_flash: flashSettings
            });

            this.currentSettings = {
                map: mapSettings,
                animation: animationSettings,
                points: pointSettings,
                flash: flashSettings
            };

            console.log('📊 PARAMÈTRES ACTUELS COMPLÈTS - Récupérés depuis l\'interface:', {
                map: mapSettings,
                animation: animationSettings,
                points: pointSettings,
                flash: flashSettings,
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
            timestamp: new Date().toISOString()
        });

        // Appliquer les paramètres du profil à l'interface
        if (profile.map) {
            console.log('🗺️ Application paramètres carte:', profile.map);
            // Appliquer les paramètres de carte
            if (typeof applyMapSettings === 'function') {
                applyMapSettings(profile.map);
            }
        }

        if (profile.points) {
            console.log('📍 Application paramètres points:', profile.points);
            // Appliquer les paramètres des points
            if (typeof applyPointSettings === 'function') {
                applyPointSettings(profile.points);
            }
        }

        if (profile.animation) {
            console.log('🎬 Application paramètres animation:', profile.animation);
            // Appliquer les paramètres d'animation
            if (typeof applyAnimationSettings === 'function') {
                applyAnimationSettings(profile.animation);
            }
        }

        if (profile.flash) {
            console.log('✨ Application paramètres flash:', profile.flash);
            // Appliquer les paramètres flash
            if (typeof applyFlashSettings === 'function') {
                applyFlashSettings(profile.flash);
            }
        }

        console.log('✅ Profil appliqué avec succès:', profile.name);
    }

    saveCurrentAsProfile() {
        if (!this.currentProfile) {
            this.showNewProfileModal();
            return;
        }

        // Récupérer les paramètres actuels
        this.loadCurrentSettings();

        // Créer l'objet profil complet
        const profileData = {
            name: this.currentProfile.name,
            map: this.currentSettings.map,
            animation: this.currentSettings.animation,
            points: this.currentSettings.points,
            flash: this.currentSettings.flash
        };

        console.log('💾 SAUVEGARDE PROFIL - Données complètes:', {
            profile_name: profileData.name,
            map: profileData.map,
            animation: profileData.animation,
            points: profileData.points,
            flash: profileData.flash,
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
                // Pour renommer, on crée un nouveau profil et on supprime l'ancien
                this.duplicateProfile(originalName, name);
                setTimeout(() => this.deleteProfile(originalName), 500);
            }
        }

        M.Modal.getInstance(document.getElementById('profile-modal')).close();
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
        console.log('🗺️ Application carte - Provider demandé:', mapOptions.tile_provider);

        // Changer le fournisseur de carte
        const mapButton = document.querySelector(`a[id="${mapOptions.tile_provider}"]`);
        console.log('🗺️ Bouton carte trouvé:', !!mapButton, 'ID:', mapOptions.tile_provider);

        if (mapButton) {
            console.log('🗺️ Clic sur le bouton carte:', mapOptions.tile_provider);
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

        console.log('Paramètres de carte appliqués:', mapOptions);
    } catch (error) {
        console.error('Erreur lors de l\'application des paramètres de carte:', error);
    }
}

function applyMapSpecificOptions(tileProvider, mapOptions) {
    try {
        if (tileProvider === 'vectorMap') {
            // Options pour la carte vectorielle
            const vectorOptions = document.getElementById('vectorMapOptions');
            if (vectorOptions && mapOptions.vectorOptions) {
                // Couleurs
                if (mapOptions.vectorOptions.strokeColor) {
                    const strokeColorInput = document.getElementById('fieldVectorMapStrokeColor');
                    if (strokeColorInput) {
                        strokeColorInput.value = mapOptions.vectorOptions.strokeColor;
                        strokeColorInput.dispatchEvent(new Event('change'));
                    }
                }

                if (mapOptions.vectorOptions.fillColor) {
                    const fillColorInput = document.getElementById('fieldVectorMapFillColor');
                    if (fillColorInput) {
                        fillColorInput.value = mapOptions.vectorOptions.fillColor;
                        fillColorInput.dispatchEvent(new Event('change'));
                    }
                }

                if (mapOptions.vectorOptions.backgroundColor) {
                    const bgColorInput = document.getElementById('fieldVectorMapBackgroundColor');
                    if (bgColorInput) {
                        bgColorInput.value = mapOptions.vectorOptions.backgroundColor;
                        bgColorInput.dispatchEvent(new Event('change'));
                    }
                }

                if (mapOptions.vectorOptions.strokeWidth) {
                    const strokeWidthInput = document.getElementById('fieldVectorMapStrokeWidth');
                    if (strokeWidthInput) {
                        strokeWidthInput.value = mapOptions.vectorOptions.strokeWidth;
                        strokeWidthInput.dispatchEvent(new Event('input'));
                    }
                }
            }
        } else if (tileProvider === 'stamenToner') {
            // Options pour Stamen Toner
            const tonerOptions = document.getElementById('tonerMapOptions');
            if (tonerOptions && mapOptions.tonerOptions) {
                if (mapOptions.tonerOptions.variant === 'light') {
                    const lightBtn = document.getElementById('stamenTonerLight');
                    if (lightBtn) {
                        lightBtn.click();
                    }
                } else if (mapOptions.tonerOptions.variant === 'dark') {
                    const darkBtn = document.getElementById('stamenTonerDark');
                    if (darkBtn) {
                        darkBtn.click();
                    }
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
        console.log('🎨 Application type de couleur des points:', pointOptions.fill_color_type);
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
            console.log('🎨 Application type de couleur des bordures:', pointOptions.border_color_type);
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

        console.log('✅ Paramètres des points appliqués avec succès:', pointOptions);
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

        // Charger le profil par défaut au démarrage
        profileManager.loadDefaultProfileAtStartup();

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
