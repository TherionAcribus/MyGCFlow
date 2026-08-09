/**
 * Gestion des profils de configuration pour GCMap
 * Permet de sauvegarder, charger, créer, dupliquer et supprimer des profils
 */

import * as pkg from './index.js';
import { refreshTomSelect, initTomSelect, getTomSelect, showBsModal, hideBsModal, getBsModal } from './ui_bootstrap.js';

// Flag de debug pour ce fichier. Mettre à true pour réactiver les logs en
// console (désactivés par défaut : sérialiser des objets/chaînes à chaque
// appel a un coût, sensible sur les chemins fréquents).
const DEBUG_PROFILES = false;
const dbgProfiles = (...args) => { if (DEBUG_PROFILES) console.log(...args); };

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
        this.hasUnsavedChanges = false;
        this._lastSavedSnapshot = null;
        // Nom du profil par défaut connu (null = pas encore lu du serveur,
        // '' = aucun profil par défaut). Voir _getDefaultProfileName().
        this._defaultProfileName = null;
        this.init();
    }

    init() {
        this.bindEvents();
        this.loadProfilesList();
        this.loadCurrentSettings();
        this._lastSavedSnapshot = this._dirtySnapshot(this.currentSettings);
        this._bindDirtyTracking();
    }

    // Sérialise les réglages pour la comparaison "modifications non enregistrées",
    // en excluant le centre/zoom courants de la carte : ce sont des valeurs qui
    // suivent en permanence la vue (déplacement, zoom molette...) et non des
    // réglages de style. Sans cette exclusion, se contenter de déplacer la carte
    // puis de toucher un champ de style sans rapport fait apparaître le profil
    // comme "modifié" alors que rien de pertinent n'a changé. `saveCurrentAsProfile`
    // capture néanmoins bien la vue courante : seule la détection "dirty" l'ignore.
    _dirtySnapshot(settings) {
        const clone = JSON.parse(JSON.stringify(settings || {}));
        if (clone.map) {
            delete clone.map.default_center;
            delete clone.map.default_zoom;
        }
        return JSON.stringify(clone);
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

        // Modal de réinitialisation
        document.getElementById('btn-confirm-reset')?.addEventListener('click', () => {
            this.confirmResetProfile();
        });

        // Initialiser les modals Bootstrap 5
        document.querySelectorAll('.modal.bs-modal').forEach(modal => {
            getBsModal(modal);
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

                this.showToast(pkg.t('Profil "${name}" importé', { name: data.name }), 'green');
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
            this.showToast(pkg.t('Erreur: ${message}', { message: error.message }), 'red');
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

    // Retourne true si le profil a bien été chargé, false s'il a été annulé
    // (modifications non sauvegardées refusées par l'utilisateur) ou en erreur.
    // Les appelants qui répercutent ce chargement sur un autre état persistant
    // (ex: profil par défaut) doivent vérifier cette valeur avant de continuer.
    async loadProfile(name) {
        if (!this._confirmDiscardChangesIfNeeded()) return false;
        try {
            dbgProfiles('Chargement profil depuis API:', name);
            const profile = await this.apiCall(`/api/profiles/${encodeURIComponent(name)}`);

            dbgProfiles('📥 PROFIL REÇU DU SERVEUR:', {
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
            await this.applyProfile(profile);
            this._markSaved();
            // La liste des profils est inchangée : déplacer le marquage "ACTIF"
            // suffit, inutile de refetcher /api/profiles et de reconstruire le DOM.
            this._updateActiveProfileHighlight();
            this.showToast(pkg.t('Profil "${name}" chargé', { name }), 'green');
            return true;
        } catch (error) {
            console.error('❌ Erreur chargement profil:', error);
            return false;
        }
    }

    async saveProfile(profileData) {
        try {
            dbgProfiles('📤 ENVOI PROFIL AU SERVEUR:', {
                endpoint: `/api/profiles/${encodeURIComponent(profileData.name)}`,
                method: 'PUT',
                data: profileData,
                timestamp: new Date().toISOString()
            });

            const result = await this.apiCall(`/api/profiles/${encodeURIComponent(profileData.name)}`, 'PUT', profileData);

            if (result.success) {
                dbgProfiles('Profil sauvegardé avec succès:', profileData.name);
                this.showToast(pkg.t('Profil "${name}" sauvegardé', { name: profileData.name }), 'green');
                this.loadProfilesList(); // Rafraîchir la liste
            }
            return result;
        } catch (error) {
            console.error('❌ Erreur sauvegarde profil:', error);
            return { success: false };
        }
    }

    async createProfile(name, baseProfile = null) {
        try {
            const result = await this.apiCall('/api/profiles', 'POST', {
                name: name,
                base: baseProfile
            });
            if (result.success) {
                this.showToast(pkg.t('Profil "${name}" créé', { name }), 'green');
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
                // Le serveur peut avoir choisi un nom différent en cas de collision (ex: "X (1)")
                this.showToast(pkg.t('Profil dupliqué: "${name}"', { name: result.name }), 'green');
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
                this.showToast(pkg.t('Profil "${name}" supprimé', { name }), 'orange');
                // Le profil par défaut mémorisé n'existe plus : le serveur ne
                // saura plus résoudre son UID en nom.
                if (this._defaultProfileName === name) {
                    this._defaultProfileName = '';
                }
                // Rafraîchir la liste des profils avant de choisir un fallback
                await this.loadProfilesList();

                // Si on vient de supprimer le profil actif, on bascule sur un profil valide
                if (this.currentProfile && this.currentProfile.name === name) {
                    this.currentProfile = null;
                    // Le profil vient d'être supprimé: les éventuelles modifications non
                    // sauvegardées le concernant n'ont plus de sens, et ne doivent pas
                    // redemander une confirmation lors du basculement vers un profil de secours.
                    this.hasUnsavedChanges = false;

                    // 1) Tenter le profil par défaut (UUID)
                    try {
                        const settings = await this.loadAppSettings();
                        const defaultUid = settings?.default_profile_uid;
                        if (defaultUid) {
                            await this.loadProfileByUid(defaultUid);
                            return;
                        }
                    } catch (e) {
                        console.warn('Fallback profil par défaut impossible:', e);
                    }

                    // 2) Sinon charger le premier profil restant (s'il en existe)
                    if (Array.isArray(this.profilesList) && this.profilesList.length > 0) {
                        const firstProfile = this.profilesList[0];
                        if (firstProfile) {
                            await this.loadProfile(firstProfile);
                            return;
                        }
                    }

                    // 3) Plus aucun profil : rester sans profil actif
                    this.updateCurrentProfileIndicator();
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
                this.showToast(pkg.t('Profil "${name}" réinitialisé', { name }), 'blue');
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
            dbgProfiles('📤 Export profil:', name);
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
            this.showToast(pkg.t('Profil "${name}" exporté', { name }), 'green');
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
     *
     * Deux requêtes au total : ni les réglages ni la liste des profils n'ont
     * besoin d'être relus (cf. saveAppSettings pour le PUT partiel et
     * _syncDefaultProfileSelectorValue pour le sélecteur).
     */
    async setProfileAsDefault(profileName) {
        if (!this._confirmDiscardChangesIfNeeded()) return;
        try {
            const profile = await this.apiCall(`/api/profiles/${encodeURIComponent(profileName)}`);
            if (!profile || !profile.uid) {
                throw new Error('Profil introuvable ou UID manquant');
            }

            // Appliquer immédiatement le profil
            this.currentProfile = profile;
            await this.applyProfile(profile);
            this._markSaved();

            // Sauvegarder l'UUID comme profil par défaut
            const result = await this.saveAppSettings({ default_profile_uid: profile.uid });

            if (!result.success) {
                throw new Error('Échec de la sauvegarde du profil par défaut');
            }

            this._defaultProfileName = profile.name;

            this.showToast(`Profil "${profile.name}" défini comme par défaut`, 'green');

            // Rafraîchir les éléments UI dépendants : la liste des profils n'a
            // pas changé, seules la valeur du sélecteur et la position du badge
            // "ACTIF" doivent suivre.
            this._syncDefaultProfileSelectorValue();
            this._updateActiveProfileHighlight();
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
            container.innerHTML = '<div class="list-group-item text-center">Aucun profil</div>';
            return;
        }

        const gt = (key) => (window.gettext ? window.gettext(key) : key);

        // Construit un <li><a class="dropdown-item"> avec icône + libellé texte
        // (jamais de HTML injecté depuis des données utilisateur) et son handler.
        const buildMenuItem = (iconClass, label, onClick, danger = false) => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.className = 'dropdown-item' + (danger ? ' text-danger' : '');
            a.href = '#!';
            const icon = document.createElement('i');
            icon.className = `ti ${iconClass} me-1`;
            a.appendChild(icon);
            a.appendChild(document.createTextNode(label));
            a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
            li.appendChild(a);
            return li;
        };

        this.profilesList.forEach(profileName => {
            const item = document.createElement('div');
            item.className = 'list-group-item';
            // Permet de retrouver l'élément d'un profil donné sans reconstruire
            // la liste (cf. _updateActiveProfileHighlight).
            item.dataset.profileName = profileName;

            const row = document.createElement('div');
            row.className = 'row';
            row.style.marginBottom = '0';

            // Colonne nom (cliquable pour charger le profil)
            const colName = document.createElement('div');
            colName.className = 'col-8';
            const nameWrap = document.createElement('div');
            nameWrap.className = 'profile-name-wrap';
            nameWrap.style.cursor = 'pointer';
            nameWrap.style.position = 'relative';
            nameWrap.addEventListener('click', () => this.loadProfile(profileName));

            const swatchIcon = document.createElement('i');
            swatchIcon.className = 'ti ti-color-swatch me-1';
            nameWrap.appendChild(swatchIcon);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'profile-name';
            nameSpan.textContent = profileName;
            nameWrap.appendChild(nameSpan);

            this._setProfileItemActive(nameWrap, this.currentProfile?.name === profileName);
            colName.appendChild(nameWrap);

            // Colonne actions (menu déroulant)
            const colActions = document.createElement('div');
            colActions.className = 'col-4 text-end';
            const dropdown = document.createElement('div');
            dropdown.className = 'dropdown';

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn btn-link btn-sm dropdown-toggle';
            toggleBtn.type = 'button';
            toggleBtn.setAttribute('data-bs-toggle', 'dropdown');
            toggleBtn.setAttribute('aria-expanded', 'false');
            const dotsIcon = document.createElement('i');
            dotsIcon.className = 'ti ti-dots-vertical';
            toggleBtn.appendChild(dotsIcon);

            const menu = document.createElement('ul');
            menu.className = 'dropdown-menu dropdown-menu-end';
            menu.appendChild(buildMenuItem('ti-copy', gt('Dupliquer'), () => this.duplicateProfile(profileName, `${profileName}_copy`)));
            menu.appendChild(buildMenuItem('ti-edit', gt('Renommer'), () => this.renameProfile(profileName)));
            menu.appendChild(buildMenuItem('ti-download', gt('Exporter'), () => this.exportProfile(profileName)));
            menu.appendChild(buildMenuItem('ti-refresh', gt('Réinitialiser'), () => this.confirmReset(profileName), true));
            menu.appendChild(buildMenuItem('ti-trash', gt('Supprimer'), () => this.confirmDelete(profileName), true));
            const divider = document.createElement('li');
            divider.innerHTML = '<hr class="dropdown-divider">';
            menu.appendChild(divider);
            menu.appendChild(buildMenuItem('ti-star', gt('Définir comme par défaut'), () => this.setProfileAsDefault(profileName)));

            dropdown.appendChild(toggleBtn);
            dropdown.appendChild(menu);
            colActions.appendChild(dropdown);

            row.appendChild(colName);
            row.appendChild(colActions);
            item.appendChild(row);

            container.appendChild(item);
        });

        // Les dropdowns Bootstrap 5 sont auto-initialisés via data-bs-toggle="dropdown"
        // (plus besoin d'initialisation manuelle comme avec Materialize)

        // Mettre à jour l'indicateur du profil actif (nécessaire pour le rendu initial)
        this.updateCurrentProfileIndicator();
    }

    // Pose ou retire les marqueurs "profil actif" (classe CSS, icône, badge) sur
    // un élément de liste déjà construit. Utilisé au rendu initial et lors d'un
    // simple déplacement du badge, pour que les deux chemins produisent
    // exactement le même DOM.
    _setProfileItemActive(nameWrap, isActive) {
        nameWrap.classList.toggle('active-profile', !!isActive);
        // Les marqueurs ne sont stylés que sous .active-profile : on les retire
        // plutôt que de les masquer, pour ne pas laisser un "ACTIF" brut visible.
        nameWrap.querySelector('.profile-active-check')?.remove();
        nameWrap.querySelector('.active-badge')?.remove();
        if (!isActive) return;

        const checkIcon = document.createElement('i');
        checkIcon.className = 'ti ti-circle-check ms-1 profile-active-check';
        nameWrap.appendChild(checkIcon);
        const badge = document.createElement('span');
        badge.className = 'active-badge';
        badge.textContent = 'ACTIF';
        nameWrap.appendChild(badge);
    }

    // Déplace le marquage "ACTIF" sur la liste déjà rendue. Alternative à
    // loadProfilesList() quand seul le profil courant change : pas de requête
    // /api/profiles ni de reconstruction du DOM (donc pas de perte des
    // dropdowns Bootstrap ouverts ni de scroll réinitialisé).
    _updateActiveProfileHighlight() {
        const container = document.getElementById('profiles-list');
        if (container) {
            const activeName = this.currentProfile?.name ?? null;
            container.querySelectorAll('[data-profile-name]').forEach(item => {
                const nameWrap = item.querySelector('.profile-name-wrap');
                if (nameWrap) {
                    this._setProfileItemActive(nameWrap, item.dataset.profileName === activeName);
                }
            });
        }
        this.updateCurrentProfileIndicator();
    }

    updateCurrentProfileIndicator() {
        const indicator = document.getElementById('current-profile-indicator');
        if (indicator) {
            if (this.currentProfile && this.currentProfile.name) {
                const suffix = this.hasUnsavedChanges ? ' •' : '';
                indicator.textContent = this.currentProfile.name + suffix;
                indicator.classList.add('active');
                indicator.classList.toggle('unsaved', !!this.hasUnsavedChanges);
                indicator.title = this.hasUnsavedChanges
                    ? (window.gettext ? window.gettext('Modifications non enregistrées') : 'Modifications non enregistrées')
                    : '';
            } else {
                indicator.textContent = '';
                indicator.classList.remove('active');
                indicator.classList.remove('unsaved');
                indicator.title = '';
            }
        }
    }

    // Snapshot des réglages actuels comme référence "sauvegardée" (après chargement/sauvegarde d'un profil)
    _markSaved() {
        this.loadCurrentSettings();
        this._lastSavedSnapshot = this._dirtySnapshot(this.currentSettings);
        this.hasUnsavedChanges = false;
        this.updateCurrentProfileIndicator();
    }

    // Écoute les changements des contrôles de style pour détecter les modifications non sauvegardées
    _bindDirtyTracking() {
        const container = document.getElementById('style');
        if (!container) {
            // #style est le conteneur de l'onglet Style (menu_style.html), censé
            // toujours être présent. On échoue de façon visible plutôt que de se
            // rabattre silencieusement sur tout le document (qui déclencherait le
            // suivi "dirty" sur des changements sans rapport avec le profil).
            console.warn('ProfileManager: conteneur #style introuvable, suivi des modifications désactivé');
            return;
        }
        let debounceTimer = null;
        const recompute = () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!this.currentProfile) return;
                this.loadCurrentSettings();
                const dirty = this._dirtySnapshot(this.currentSettings) !== this._lastSavedSnapshot;
                if (dirty !== this.hasUnsavedChanges) {
                    this.hasUnsavedChanges = dirty;
                    this.updateCurrentProfileIndicator();
                }
            }, 300);
        };
        container.addEventListener('input', recompute, true);
        container.addEventListener('change', recompute, true);
    }

    // Avertit avant d'abandonner des modifications non sauvegardées (chargement d'un autre profil, etc.)
    _confirmDiscardChangesIfNeeded() {
        if (!this.hasUnsavedChanges) return true;
        const message = window.gettext
            ? window.gettext('Vous avez des modifications non enregistrées. Les abandonner ?')
            : 'Vous avez des modifications non enregistrées. Les abandonner ?';
        return window.confirm(message);
    }

    // Gestion du profil par défaut
    async loadAppSettings() {
        try {
            const response = await fetch('/api/settings');
            const settings = await response.json();
            dbgProfiles('Paramètres app chargés:', settings);
            return settings;
        } catch (error) {
            console.error('❌ Erreur chargement paramètres app:', error);
            return { default_profile_uid: null, default_profile_name: null };
        }
    }

    // Nom du profil par défaut, lu une seule fois du serveur puis mémorisé.
    // Seul ce module modifie `default_profile_uid` (ui.js réécrit la valeur
    // qu'il vient de lire), l'état en mémoire reste donc fidèle et évite un
    // GET /api/settings à chaque action sur le profil par défaut.
    async _getDefaultProfileName() {
        if (this._defaultProfileName === null) {
            const settings = await this.loadAppSettings();
            this._defaultProfileName = settings.default_profile_name || '';
        }
        return this._defaultProfileName;
    }

    // Positionne la valeur du sélecteur "profil par défaut" sans reconstruire
    // ses options : la liste des profils n'a pas changé, et un rebuild impose
    // de détruire puis recréer l'instance Tom Select.
    _syncDefaultProfileSelectorValue() {
        const selector = document.getElementById('selectDefaultProfile');
        if (!selector) return;
        const value = this._defaultProfileName || '';
        if (selector.value === value) return;
        selector.value = value;
        try { refreshTomSelect(selector); } catch (_) {}
    }

    // `settings` peut être un patch partiel : PUT /api/settings ne modifie que
    // les clés effectivement présentes dans le corps de la requête.
    async saveAppSettings(settings) {
        try {
            const response = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
            const result = await response.json();
            dbgProfiles('💾 Paramètres app sauvegardés:', result);
            return result;
        } catch (error) {
            console.error('❌ Erreur sauvegarde paramètres app:', error);
            return { success: false };
        }
    }

    // Voir loadProfile() pour la convention de retour (true = chargé, false = annulé/erreur).
    async loadProfileByUid(uid) {
        if (!this._confirmDiscardChangesIfNeeded()) return false;
        try {
            dbgProfiles('🔄 [LOAD_PROFILE] Chargement profil par UUID:', uid);
            dbgProfiles('🔄 [LOAD_PROFILE] État avant chargement:', {
                point_mode: pkg?.options?.point?.mode,
                switch_checked: document.getElementById('switchIconeVectoriel')?.checked
            });

            const response = await fetch(`/api/profiles/uid/${encodeURIComponent(uid)}`);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(`HTTP ${response.status}: ${errorData.message || errorData.error || 'Profile not found'}`);
            }

            const profile = await response.json();

            dbgProfiles('🔄 [LOAD_PROFILE] PROFIL REÇU PAR UUID:', {
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
            await this.applyProfile(profile);
            this._markSaved();

            dbgProfiles('🔄 [LOAD_PROFILE] État après application du profil:', {
                point_mode: pkg?.options?.point?.mode,
                switch_checked: document.getElementById('switchIconeVectoriel')?.checked,
                profile_applied: profile.name
            });

            // Cf. loadProfile() : seul le marquage "ACTIF" change ici.
            this._updateActiveProfileHighlight();
            this.showToast(pkg.t('Profil "${name}" chargé', { name: profile.name }), 'green');
            return true;
        } catch (error) {
            console.error('❌ [LOAD_PROFILE] Erreur chargement profil par UUID:', error);
            this.showToast('Erreur lors du chargement du profil par défaut', 'red');
            return false;
        }
    }

    async populateDefaultProfileSelector() {
        try {
            const selector = document.getElementById('selectDefaultProfile');
            if (!selector) return;

            // Liste des profils déjà en mémoire (loadProfilesList) : on ne
            // refetche que si elle n'a pas encore été chargée.
            const profiles = Array.isArray(this.profilesList) && this.profilesList.length
                ? this.profilesList
                : await this.apiCall('/api/profiles');
            const defaultProfileName = await this._getDefaultProfileName();

            // Détruire l'instance Tom Select AVANT de modifier le DOM,
            // pour éviter les références orphelines qui causent un crash async.
            try { const ts = getTomSelect(selector); if (ts) ts.destroy(); } catch(_) {}

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
            selector.value = defaultProfileName;

            try { initTomSelect(selector, {}); } catch(_) {}

            dbgProfiles('Sélecteur profil par défaut rempli avec:', profiles);
            dbgProfiles('🎯 Profil par défaut actuel:', defaultProfileName || 'aucun');
        } catch (error) {
            console.error('❌ Erreur remplissage sélecteur profil par défaut:', error);
        }
    }

    async handleDefaultProfileChange() {
        const selector = document.getElementById('selectDefaultProfile');
        if (!selector) return;

        const selectedProfileName = selector.value;
        dbgProfiles('Changement profil par défaut:', selectedProfileName);

        // Nécessaire pour pouvoir restaurer le sélecteur si le chargement est
        // annulé par l'utilisateur (modifications non enregistrées) ou échoue :
        // sans ça, le profil par défaut serait effacé côté serveur alors que
        // rien n'a réellement changé.
        const previousName = await this._getDefaultProfileName();

        let selectedProfileUid = null;
        let appliedProfileName = null;

        // Appliquer immédiatement le profil si un profil est sélectionné
        if (selectedProfileName && selectedProfileName !== '') {
            dbgProfiles('🎯 Application immédiate du profil:', selectedProfileName);
            const loaded = await this.loadProfile(selectedProfileName);
            if (!loaded) {
                dbgProfiles('🚫 Chargement annulé ou en échec - profil par défaut inchangé');
                this._syncDefaultProfileSelectorValue();
                return;
            }
            // Récupérer l'UUID du profil chargé
            if (this.currentProfile && this.currentProfile.uid) {
                selectedProfileUid = this.currentProfile.uid;
                appliedProfileName = this.currentProfile.name;
            }
        } else {
            dbgProfiles('🚫 Aucun profil sélectionné - pas d\'application');
        }

        // Sauvegarder le nouveau profil par défaut avec UUID. PUT partiel : les
        // autres réglages (langue, vue par défaut...) sont préservés côté
        // serveur sans avoir eu à les relire.
        dbgProfiles('💾 Sauvegarde profil par défaut:', {
            ancien_nom: previousName,
            nouveau_uuid: selectedProfileUid,
            nom_profil: appliedProfileName,
            nom_selectionne: selectedProfileName
        });

        const result = await this.saveAppSettings({ default_profile_uid: selectedProfileUid });
        if (result.success) {
            dbgProfiles('Profil par défaut sauvegardé avec succès, UUID:', selectedProfileUid);
            this._defaultProfileName = appliedProfileName || '';
            this.showToast(
                appliedProfileName ?
                    pkg.t('Profil "${selectedProfile}" appliqué et défini comme profil par défaut', { selectedProfile: appliedProfileName }) :
                    'Aucun profil par défaut défini',
                appliedProfileName ? 'green' : 'blue'
            );
        } else {
            console.error('❌ Échec de la sauvegarde du profil par défaut');
        }
    }

    async loadDefaultProfileAtStartup() {
        try {
            dbgProfiles('🎯 [DEFAULT_PROFILE] Vérification du profil par défaut - État actuel:', {
                point_mode: pkg?.options?.point?.mode,
                switch_checked: document.getElementById('switchIconeVectoriel')?.checked
            });

            const settings = await this.loadAppSettings();
            dbgProfiles('🎯 [DEFAULT_PROFILE] Paramètres chargés au démarrage:', {
                default_profile_uid: settings.default_profile_uid,
                default_profile_name: settings.default_profile_name,
                all_settings: settings
            });

            // Les réglages viennent d'être lus : en profiter pour amorcer le cache
            // et éviter un second GET /api/settings côté sélecteur.
            this._defaultProfileName = settings.default_profile_name || '';

            const defaultProfileUid = settings.default_profile_uid;

            if (defaultProfileUid) {
                dbgProfiles('🎯 [DEFAULT_PROFILE] Chargement profil par défaut au démarrage (UUID):', defaultProfileUid);
                dbgProfiles('🎯 [DEFAULT_PROFILE] Nom du profil par défaut:', settings.default_profile_name);

                dbgProfiles('🎯 [DEFAULT_PROFILE] État avant chargement du profil:', {
                    point_mode: pkg?.options?.point?.mode,
                    switch_checked: document.getElementById('switchIconeVectoriel')?.checked
                });

                try {
                    await this.loadProfileByUid(defaultProfileUid);

                    dbgProfiles('🎯 [DEFAULT_PROFILE] État après chargement du profil:', {
                        point_mode: pkg?.options?.point?.mode,
                        switch_checked: document.getElementById('switchIconeVectoriel')?.checked,
                        profile_name: this.currentProfile?.name || 'aucun'
                    });
                } catch (error) {
                    console.warn('⚠️ [DEFAULT_PROFILE] Impossible de charger le profil par défaut:', error.message);
                    dbgProfiles('🎯 [DEFAULT_PROFILE] Tentative de chargement du profil par défaut du système...');

                    // Essayer de charger un profil par défaut du système
                    try {
                        await this.loadProfile('Default');
                        dbgProfiles('✅ [DEFAULT_PROFILE] Profil "Default" chargé comme fallback');
                    } catch (fallbackError) {
                        console.error('❌ [DEFAULT_PROFILE] Échec du chargement du profil "Default":', fallbackError.message);

                        // Si même le profil Default n'existe pas, créer un profil temporaire basique
                        dbgProfiles('🎯 [DEFAULT_PROFILE] Création d\'un profil temporaire basique...');
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
                            await this.applyProfile(this.currentProfile);
                            this._markSaved();
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
                    dbgProfiles('✅ [DEFAULT_PROFILE] Mode des points cohérent:', finalPointMode);
                } else {
                    console.warn('⚠️ [DEFAULT_PROFILE] Incohérence détectée - Mode:', finalPointMode, 'Switch:', finalSwitchState);
                }

                // Le toast est déjà affiché dans loadProfileByUid
            } else {
                dbgProfiles('🎯 [DEFAULT_PROFILE] Aucun profil par défaut défini (default_profile_uid est null/undefined)');
                dbgProfiles('🎯 [DEFAULT_PROFILE] Vérifiez que le profil a bien été défini comme par défaut');
            }
        } catch (error) {
            console.error('❌ [DEFAULT_PROFILE] Erreur chargement profil par défaut au démarrage:', error);
            console.error('❌ [DEFAULT_PROFILE] Détails de l\'erreur:', error.message);
        }
    }

    loadCurrentSettings() {
        // Charger les paramètres actuels depuis l'interface
        try {
            // Paramètres de la carte : lus directement dans pkg.options.map, seule
            // source de vérité de l'état carte. switchLayer() y écrit le fond actif
            // et les gestionnaires de ui.js les options vectorMap/Toner. On ne
            // déduit plus rien du DOM (classe d'état des boutons, visibilité des
            // panneaux d'options) : ces indices n'étaient pas fiables tant qu'une
            // transition CSS n'était pas terminée.
            const mapOptions = pkg.options?.map || {};

            const mapSettings = {
                tile_provider: mapOptions.default || 'OSM',
                // Convention persistée : [longitude, latitude]. Ces valeurs ne
                // servent que si la carte n'est exceptionnellement pas disponible.
                default_center: pkg.getDefaultMapCenter(),
                default_zoom: pkg.getDefaultMapZoom()
            };

            const vectorMap = mapOptions.vectorMap;
            if (vectorMap) {
                // Le profil sérialise la couleur de fond sous 'backgroundColor' là
                // où les options la nomment 'background'.
                const width = parseFloat(vectorMap.strokeWidth);
                mapSettings.vectorOptions = {
                    strokeColor: vectorMap.strokeColor,
                    fillColor: vectorMap.fillColor,
                    backgroundColor: vectorMap.background,
                    strokeWidth: Number.isFinite(width) ? width : undefined,
                };
            }

            const stamenToner = mapOptions.stamenToner;
            if (stamenToner && stamenToner.type) {
                mapSettings.tonerOptions = { variant: stamenToner.type };
            }

            dbgProfiles('Carte lue depuis pkg.options.map - Provider:', mapSettings.tile_provider, 'Settings:', mapSettings);

            // Si la carte est disponible, récupérer la vue actuelle.
            // pkg.getMap() et non window.map : `window.map` est le <div id="map">
            // (accès nommé du navigateur sur les id), pas la carte OpenLayers. Il
            // est donc toujours "vrai" mais n'a pas de getView() — la vue courante
            // n'était en réalité jamais capturée et tous les profils enregistraient
            // le centre de repli ci-dessus.
            const olMap = typeof pkg.getMap === 'function' ? pkg.getMap() : null;
            if (olMap && typeof olMap.getView === 'function') {
                const view = olMap.getView();
                const lonLat = ol.proj.toLonLat(view.getCenter());
                // ol.proj.toLonLat() respecte directement la convention persistée
                // de l'app : [longitude, latitude].
                mapSettings.default_center = lonLat;
                mapSettings.default_zoom = view.getZoom();
            }

            // Paramètres des points
            const sizeInput = document.getElementById('sliderSizePoint');
            const colorInput = document.getElementById('pointCenterColor');
            const shapeSelect = document.getElementById('selectShape');
            const borderInput = document.getElementById('sliderSizeBorder');
            const borderColorInput = document.getElementById('pointBorderColor');
            const modeSwitch = document.getElementById('switchIconeVectoriel');

            // Options spécifiques au mode icône
            const selectIconSet = document.getElementById('selectIconSet');
            const inputSizeIcon = document.getElementById('inputSizeIcon');

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
                mode: modeSwitch ? (modeSwitch.checked ? 'vectoriel' : 'icone') : 'vectoriel',
                icon_set: selectIconSet ? (selectIconSet.value || 'geocaching') : (pkg?.options?.point?.iconSet || 'geocaching'),
                icon_size: inputSizeIcon ? (parseInt(inputSizeIcon.value) || 24) : (parseInt(pkg?.options?.point?.iconSize) || 24)
            };

            dbgProfiles('Paramètres points récupérés:', {
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

            dbgProfiles('🔍 État des éléments HTML:', {
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

            dbgProfiles('🔍 Paramètres flash récupérés:', {
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

            dbgProfiles('📄 Paramètres infos récupérés:', {
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

            dbgProfiles('PARAMÈTRES ACTUELS COMPLÈTS - Récupérés depuis l\'interface:', {
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
                    default_center: pkg.getDefaultMapCenter(),
                    default_zoom: pkg.getDefaultMapZoom()
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

    // Reste async pour ses appelants, mais l'application de la carte est
    // désormais synchrone (pkg.options.map écrit directement, sans clic ni
    // délai) : un instantané "état sauvegardé" pris juste après (ex:
    // loadProfile -> _markSaved) ne peut plus capturer un état transitoire.
    async applyProfile(profile) {
        dbgProfiles('🎯 APPLICATION PROFIL - Profil complet chargé:', {
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
            dbgProfiles('Application paramètres carte:', profile.map);
            // Appliquer les paramètres de carte
            applyMapSettings(profile.map);
        }

        if (profile.points) {
            dbgProfiles('Application paramètres points:', profile.points);
            // Appliquer les paramètres des points
            if (typeof applyPointSettings === 'function') {
                applyPointSettings(profile.points);
                // Forcer le reflet sur le switch vectoriel/icône si présent
                try {
                    const switchVector = document.getElementById('switchIconeVectoriel');
                    if (switchVector) {
                        const isVector = profile.points.mode === 'vectoriel';
                        switchVector.checked = isVector;
                        switchVector.dispatchEvent(new Event('change'));
                    }
                } catch (e) {
                    console.warn('Switch vectoriel/icône non mis à jour:', e);
                }
            }
        }

        if (profile.animation) {
            dbgProfiles('Application paramètres animation:', profile.animation);
            // Appliquer les paramètres d'animation
            if (typeof applyAnimationSettings === 'function') {
                applyAnimationSettings(profile.animation);
            }
        }

        if (profile.flash) {
            dbgProfiles('Application paramètres flash:', profile.flash);
            // Appliquer les paramètres flash
            if (typeof applyFlashSettings === 'function') {
                applyFlashSettings(profile.flash);
            }
        }

        // Appliquer les paramètres infos (titre / infosFrame / CSS)
        if (profile.infos) {
            dbgProfiles('📄 Application paramètres infos:', profile.infos);
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
                    const appliedTitleCss = pkg.changeTitleCssValues(cleanedTitleCss) ?? cleanedTitleCss;
                    const titleCssTextarea = document.getElementById('inputTitleCss');
                    if (titleCssTextarea) titleCssTextarea.value = appliedTitleCss;
                }
                if (typeof pkg.changeInfosCssValues === 'function' && typeof profile.infos.infos_css === 'string') {
                    // Nettoyer le CSS avant application
                    const cleanedInfosCss = extractCssDeclarations(profile.infos.infos_css);
                    const appliedInfosCss = pkg.changeInfosCssValues(cleanedInfosCss) ?? cleanedInfosCss;
                    const infosCssTextarea = document.getElementById('inputInfosCss');
                    if (infosCssTextarea) infosCssTextarea.value = appliedInfosCss;
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

        dbgProfiles('Profil appliqué avec succès:', profile.name);
    }

    async saveCurrentAsProfile() {
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

        dbgProfiles('💾 SAUVEGARDE PROFIL - Données complètes:', {
            profile_name: profileData.name,
            map: profileData.map,
            animation: profileData.animation,
            points: profileData.points,
            flash: profileData.flash,
            infos: profileData.infos,
            timestamp: new Date().toISOString()
        });

        const result = await this.saveProfile(profileData);
        if (result && result.success) {
            this._lastSavedSnapshot = this._dirtySnapshot(this.currentSettings);
            this.hasUnsavedChanges = false;
        }
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

        showBsModal(modal);
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

        showBsModal(modal);
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

        hideBsModal(document.getElementById('profile-modal'));
    }

    async renameProfileProperly(oldName, newName) {
        try {
            // Vérifier si c'était le profil actuellement sélectionné
            const wasCurrentProfile = this.currentProfile && this.currentProfile.name === oldName;

            // Renommage atomique côté serveur (conserve l'UUID, refuse si le nouveau nom
            // est déjà pris par un AUTRE profil, gère seule la collision de sanitization)
            const result = await this.apiCall(`/api/profiles/${encodeURIComponent(oldName)}/rename`, 'POST', {
                new_name: newName
            });

            if (result.success) {
                if (wasCurrentProfile && this.currentProfile) {
                    this.currentProfile.name = result.name;
                }

                // L'UID est conservé : le profil par défaut est toujours le même,
                // mais le sélecteur l'identifie par son nom.
                if (this._defaultProfileName === oldName) {
                    this._defaultProfileName = result.name;
                }

                await this.loadProfilesList();

                if (wasCurrentProfile) {
                    this.updateCurrentProfileIndicator();
                }

                this.populateDefaultProfileSelector();

                this.showToast(pkg.t('Profil renommé en "${name}"', { name: result.name }), 'green');
            }
        } catch (error) {
            // apiCall affiche déjà un toast d'erreur avec le message du serveur
            console.error('❌ Erreur lors du renommage du profil:', error);
        }
    }

    confirmDelete(profileName) {
        const modal = document.getElementById('delete-profile-modal');
        const message = document.getElementById('delete-profile-message');
        const confirmBtn = document.getElementById('btn-confirm-delete');

        message.textContent = `Êtes-vous sûr de vouloir supprimer le profil "${profileName}" ?`;
        confirmBtn.dataset.profileName = profileName;

        showBsModal(modal);
    }

    confirmDeleteProfile() {
        const confirmBtn = document.getElementById('btn-confirm-delete');
        const profileName = confirmBtn.dataset.profileName;

        this.deleteProfile(profileName);
        hideBsModal(document.getElementById('delete-profile-modal'));
    }

    confirmReset(profileName) {
        const modal = document.getElementById('reset-profile-modal');
        const message = document.getElementById('reset-profile-message');
        const confirmBtn = document.getElementById('btn-confirm-reset');

        message.textContent = `Êtes-vous sûr de vouloir réinitialiser le profil "${profileName}" aux valeurs par défaut ?`;
        confirmBtn.dataset.profileName = profileName;

        showBsModal(modal);
    }

    confirmResetProfile() {
        const confirmBtn = document.getElementById('btn-confirm-reset');
        const profileName = confirmBtn.dataset.profileName;

        this.resetProfile(profileName);
        hideBsModal(document.getElementById('reset-profile-modal'));
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
            // Fallback : alert simple si le système GCM échoue
            console.warn('Erreur système toast GCM:', error);
            dbgProfiles('[Profile toast]', message);
        }
    }
}

// Fonctions d'application des paramètres (appelées depuis applyProfile)

// Applique un profil à la carte. Synchrone : on écrit d'abord pkg.options.map
// (la source de vérité), puis on appelle directement switchLayer() et les
// fonctions de rafraîchissement. Plus de .click() sur les boutons ni de
// setTimeout d'attente : l'état ne transite plus par le DOM, il n'y a donc plus
// rien à attendre, et l'instantané "profil sauvegardé" pris juste après ne peut
// plus capturer un état carte encore incomplet.
function applyMapSettings(mapOptions) {
    try {
        dbgProfiles('🎯 Application carte - Provider demandé:', mapOptions.tile_provider);

        // 1. Options spécifiques (vectorMap / Toner) écrites dans pkg.options.map.
        //    Toujours les deux, quel que soit le fond actif : elles font partie du
        //    profil et doivent être correctes si l'utilisateur bascule ensuite sur
        //    l'autre fond, ou s'il resauvegarde le profil.
        applyMapSpecificOptions(mapOptions);

        // 2. Fond de carte. switchLayer() écrit pkg.options.map.default et met à
        //    jour couches + boutons ; il reste sans effet visuel tant que les
        //    couches n'existent pas, l'option écrite étant alors relue au démarrage.
        if (typeof pkg.switchLayer === 'function') {
            pkg.switchLayer(mapOptions.tile_provider);
        }

        // 3. Reflet des options dans les contrôles de l'onglet Style.
        if (typeof pkg.syncMapOptionsUI === 'function') {
            pkg.syncMapOptionsUI();
        }

        // 4. Rendu des couches concernées (nécessite une carte initialisée).
        //    pkg.getMap() et non window.map : ce dernier est le <div id="map">,
        //    pas la carte OpenLayers (cf. loadCurrentSettings).
        const olMap = typeof pkg.getMap === 'function' ? pkg.getMap() : null;
        if (olMap) {
            if (typeof pkg.refreshVectorMap === 'function' && pkg.options?.map?.vectorMap) {
                pkg.refreshVectorMap(pkg.options.map.vectorMap);
            }
            if (typeof pkg.refreshStamenTonerMap === 'function' && pkg.options?.map?.stamenToner?.type) {
                pkg.refreshStamenTonerMap(pkg.options.map.stamenToner);
            }

            // Vue (centre et zoom) : l'unique écriture dans OpenLayers est
            // centralisée dans mapgl.js. Un profil doit primer sur les préférences.
            pkg.applyMapDefaults(
                mapOptions.default_center,
                mapOptions.default_zoom,
                false
            );
        } else {
            console.warn('⚠️ Carte non initialisée : options carte enregistrées, elles seront appliquées à sa création');
        }

        dbgProfiles('✅ Paramètres de carte appliqués:', mapOptions);
    } catch (error) {
        console.error('❌ Erreur lors de l\'application des paramètres de carte:', error);
    }
}

// Recopie les options spécifiques du profil (snake_case) dans pkg.options.map
// (camelCase). N'écrit ni le DOM ni les couches : syncMapOptionsUI() et les
// fonctions refresh* s'en chargent ensuite à partir de ces mêmes options.
function applyMapSpecificOptions(mapOptions) {
    try {
        const target = pkg.options?.map;
        if (!target) {
            console.warn('⚠️ pkg.options.map indisponible, options spécifiques de carte ignorées');
            return;
        }

        const v = mapOptions.vector_options;
        if (v) {
            const vectorMap = target.vectorMap || (target.vectorMap = {});
            if (v.stroke_color) vectorMap.strokeColor = v.stroke_color;
            if (v.fill_color) vectorMap.fillColor = v.fill_color;
            if (v.background_color) vectorMap.background = v.background_color;
            if (v.stroke_width != null) {
                const width = parseFloat(v.stroke_width);
                if (Number.isFinite(width)) vectorMap.strokeWidth = width;
            }
            dbgProfiles('🎯 Options vectorMap appliquées:', vectorMap);
        }

        const t = mapOptions.toner_options;
        if (t && (t.variant === 'light' || t.variant === 'dark')) {
            const stamenToner = target.stamenToner || (target.stamenToner = {});
            stamenToner.type = t.variant;
            dbgProfiles('🎯 Options Toner appliquées:', stamenToner);
        }
    } catch (error) {
        console.error('Erreur lors de l\'application des options spécifiques de carte:', error);
    }
}

function applyPointSettings(pointOptions) {
    try {
        dbgProfiles('🎯 APPLICATION PARAMÈTRES POINTS - Données reçues:', pointOptions);

        // Appliquer le mode (icone/vectoriel) + options icône (set/taille)
        const modeSwitch = document.getElementById('switchIconeVectoriel');
        const selectIconSet = document.getElementById('selectIconSet');
        const sliderSizeIcon = document.getElementById('sliderSizeIcon');
        const inputSizeIcon = document.getElementById('inputSizeIcon');

        // Si mode icône: préparer d'abord les champs, puis déclencher le switch (qui appelle initializeIconOptions/updateIconSet)
        if (pointOptions.mode === 'icone') {
            if (selectIconSet && pointOptions.icon_set) {
                selectIconSet.value = pointOptions.icon_set;
                try { refreshTomSelect(selectIconSet); } catch (_) {}
            }
            const size = parseInt(pointOptions.icon_size);
            if (Number.isFinite(size) && size > 0) {
                if (sliderSizeIcon) sliderSizeIcon.value = size;
                if (inputSizeIcon) inputSizeIcon.value = size;
            }
        }

        if (modeSwitch && pointOptions.mode) {
            modeSwitch.checked = pointOptions.mode === 'vectoriel';
            modeSwitch.dispatchEvent(new Event('change'));
            dbgProfiles('🎯 Application mode des points:', pointOptions.mode, '-> switch checked:', modeSwitch.checked);
        }

        // Après initialisation en mode icône, appliquer set/taille au rendu
        if (pointOptions.mode === 'icone') {
            if (selectIconSet) {
                // updateIconSet() est globale (ui.js)
                try { window.updateIconSet?.(); } catch (_) {}
            }
            if (inputSizeIcon) {
                try { window.updateIconSize?.(); } catch (_) {}
            }
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
        dbgProfiles('Application type de couleur des points:', pointOptions.fill_color_type);
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

        dbgProfiles('🔍 État avant application bordure:', {
            borderSizeInput_exists: !!borderSizeInput,
            borderColorInput_exists: !!borderColorInput,
            current_border_size: borderSizeInput ? borderSizeInput.value : 'null',
            current_border_color: borderColorInput ? borderColorInput.value : 'null'
        });

        if (pointOptions.halo) {
            // Activer le type de couleur approprié pour la bordure
            dbgProfiles('Application type de couleur des bordures:', pointOptions.border_color_type);
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
                dbgProfiles('🔵 Application taille bordure:', pointOptions.border_size, '->', borderSizeInput.value);
            }

            // Appliquer la couleur de bordure sauvegardée
            if (borderColorInput) {
                borderColorInput.value = pointOptions.border_color || '#000000';
                borderColorInput.dispatchEvent(new Event('change'));
                dbgProfiles('🟥 Application couleur bordure:', pointOptions.border_color, '->', borderColorInput.value);
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

        dbgProfiles('🔍 État après application bordure:', {
            new_border_size: borderSizeInput ? borderSizeInput.value : 'null',
            new_border_color: borderColorInput ? borderColorInput.value : 'null'
        });

        dbgProfiles('Paramètres des points appliqués avec succès:', pointOptions);
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

        dbgProfiles('Paramètres d\'animation appliqués:', animationOptions, 'timePerDay:', timePerDay);
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

        dbgProfiles('Paramètres flash appliqués:', flashOptions);
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
    // Signaler que le gestionnaire de profils est prêt. init.js attend cet
    // événement (waitForProfileManager) au lieu de scruter window.profileManager
    // en boucle : ce handler DOMContentLoaded s'exécute après celui d'init.js.
    window.dispatchEvent(new Event('profilemanager:ready'));

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
                dbgProfiles('🎯 Changement détecté dans sélecteur profil par défaut');
                profileManager.handleDefaultProfileChange();
            });
        }
    }, 100);
});
