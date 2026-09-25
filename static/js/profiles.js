/**
 * Gestion des profils de configuration pour MyGCFlow
 * Permet de sauvegarder, charger, créer, dupliquer et supprimer des profils
 */

import * as pkg from './index.js';
import { refreshTomSelect, initTomSelect, getTomSelect, showBsModal, hideBsModal, getBsModal } from './ui_bootstrap.js';
import { markSaved, markSaveError } from './saved_indicator.mjs';

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

// Miroir de `SettingsManager._profile_path` côté serveur : le fichier d'un
// profil ne conserve du nom que les caractères alphanumériques, '-' et '_'.
// Deux noms qui se réduisent à la même clé partagent donc le même fichier
// (« Mon Profil » et « MonProfil » se marchent dessus), collision que la modale
// doit rendre visible avant l'envoi plutôt que de la laisser remonter en 409.
//
// `\p{L}\p{N}` reproduit `str.isalnum()` de Python : lettres et nombres Unicode,
// accents compris (ceux-ci sont conservés, seuls ponctuation, espaces et
// symboles tombent). L'itération porte sur les code points, comme côté serveur.
const PROFILE_NAME_KEPT_CHAR = /[\p{L}\p{N}]/u;

function isProfileNameCharKept(ch) {
    return ch === '-' || ch === '_' || PROFILE_NAME_KEPT_CHAR.test(ch);
}

// Clé de fichier d'un nom de profil. Contrairement au serveur, pas de repli sur
// « Default » : une clé vide est une saisie à refuser, pas un nom par défaut à
// écrire par-dessus un profil existant.
function profileNameKey(name) {
    return [...String(name ?? '')].filter(isProfileNameCharKept).join('');
}

// Caractères que la sanitization laissera tomber, dédupliqués et dans l'ordre de
// saisie, pour pouvoir les citer à l'utilisateur. L'espace est rendu par un
// libellé : affiché tel quel dans le message, il serait invisible.
function droppedProfileNameChars(name) {
    const dropped = [];
    for (const ch of String(name ?? '')) {
        if (isProfileNameCharKept(ch) || dropped.includes(ch)) continue;
        dropped.push(ch);
    }
    return dropped.map(ch => (/\s/.test(ch) ? pkg.t('espace') : ch)).join(' ');
}

class ProfileManager {
    constructor() {
        this.currentProfile = null;
        this.profilesList = [];
        this.hasUnsavedChanges = false;
        this._lastSavedSnapshot = null;
        // Recalcul "dirty" débouncé en attente (cf. _bindDirtyTracking) : la
        // garde de fermeture doit pouvoir le forcer avant de décider.
        this._dirtyDebounceTimer = null;
        // Nom du profil par défaut connu (null = pas encore lu du serveur,
        // '' = aucun profil par défaut). Voir _getDefaultProfileName().
        this._defaultProfileName = null;
        // UID du dernier profil actif tel qu'enregistré côté serveur (undefined
        // = jamais lu ni écrit). Évite de réécrire la même valeur à chaque
        // chargement de profil. Voir _rememberActiveProfile().
        this._lastProfileUid = undefined;
        // Requête de lecture en cours, partagée par les appels concurrents.
        this._defaultProfileNamePromise = null;
        // Modale "modifications non enregistrées" en cours d'affichage : elle
        // n'accepte qu'une question à la fois (cf. _askUnsavedChangesChoice).
        this._unsavedChoicePending = false;
        // La modale de gestion des profils s'efface quand une sous-modale
        // s'ouvre par-dessus (Bootstrap ne gère pas l'empilement) ; ce drapeau
        // marque les fermetures de sous-modale qui doivent la faire revenir.
        this._reopenManagerModal = false;
        this.init();
    }

    init() {
        this.bindEvents();
        this.loadProfilesList();
        this.loadCurrentSettings();
        this._lastSavedSnapshot = this._dirtySnapshot(this.currentSettings);
        this._bindDirtyTracking();
        this._bindUnloadGuard();
    }

    // Sérialise les réglages pour la comparaison "modifications non enregistrées".
    // Le snapshot ne contient que des réglages de thème : ni timing (préférences
    // globales), ni centre/zoom (état de vue), qui ne sont plus capturés par
    // loadCurrentSettings — déplacer la carte ne peut donc plus marquer le
    // profil comme modifié.
    _dirtySnapshot(settings) {
        return JSON.stringify(settings || {});
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

        // Sélecteur compact de la barre de profil : changer la valeur charge le
        // profil par le chemin habituel — la garde « modifications non
        // enregistrées » incluse. Si le chargement est refusé ou échoue, on
        // rétablit l'option correspondant au profil réellement actif.
        const profileSelect = document.getElementById('profile-select');
        profileSelect?.addEventListener('change', async () => {
            const loaded = await this.loadProfile(profileSelect.value);
            if (!loaded) this._syncProfileSelect();
        });

        // « Gérer les profils » ouvre la modale qui héberge la liste complète
        // et ses actions (créer, importer, dupliquer, renommer, supprimer,
        // réinitialiser, définir par défaut).
        document.getElementById('btn-manage-profiles')?.addEventListener('click', () => {
            showBsModal('profiles-manager-modal');
        });

        // Bootstrap ne supporte pas les modales empilées (deux pièges à focus
        // concurrents) : une sous-modale de profil ouverte depuis la liste fait
        // effacer la modale de gestion, qui revient à la fermeture de la
        // sous-modale — l'utilisateur retombe où il était.
        const managerModal = document.getElementById('profiles-manager-modal');
        if (managerModal) {
            ['profile-modal', 'delete-profile-modal', 'reset-profile-modal', 'unsaved-changes-modal']
                .forEach(id => {
                    const sub = document.getElementById(id);
                    if (!sub) return;
                    sub.addEventListener('show.bs.modal', () => {
                        if (!managerModal.classList.contains('show')) return;
                        this._reopenManagerModal = true;
                        hideBsModal(managerModal);
                    });
                    sub.addEventListener('hidden.bs.modal', () => {
                        if (!this._reopenManagerModal) return;
                        this._reopenManagerModal = false;
                        showBsModal(managerModal);
                    });
                });
        }

        // Modal de création/renommage
        document.getElementById('btn-confirm-profile')?.addEventListener('click', () => {
            this.confirmProfileAction();
        });

        // Validation à la frappe : nom déjà pris ou caractères que la sanitization
        // du nom de fichier laissera tomber, signalés avant l'envoi au serveur.
        document.getElementById('profile-name-input')?.addEventListener('input', () => {
            this._updateProfileNameFeedback();
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
                if (!resp.ok || !data.success) throw new Error(data.message || pkg.t('Import échoué'));

                this.showToast(pkg.t('Profil "${name}" importé', { name: data.name }), 'green');
                await this.loadProfilesList();
            } catch (e) {
                console.error('Import error', e);
                this.showToast(pkg.t('Erreur import du profil'), 'red');
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
                throw new Error(result.message || pkg.t('Erreur API'));
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
        if (!await this._confirmDiscardChangesIfNeeded()) return false;
        try {
            dbgProfiles('Chargement profil depuis API:', name);
            const profile = await this.apiCall(`/api/profiles/${encodeURIComponent(name)}`);

            dbgProfiles('📥 PROFIL REÇU DU SERVEUR:', {
                profile_name: profile.name,
                uid: profile.uid,
                version: profile.version,
                map: profile.map,
                points: profile.points,
                flash: profile.flash,
                raw_response: profile
            });

            this.currentProfile = profile;
            await this.applyProfile(profile);
            this._markSaved();
            await this._rememberActiveProfile(profile.uid);
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

    // `quiet` : ni toast de succès ni rafraîchissement de la liste. Pour les
    // appelants qui annoncent eux-mêmes le résultat et viennent déjà de relire
    // la liste (création d'un profil), sans quoi l'utilisateur voit deux toasts
    // d'affilée pour une seule action.
    async saveProfile(profileData, { quiet = false } = {}) {
        try {
            dbgProfiles('📤 ENVOI PROFIL AU SERVEUR:', {
                endpoint: `/api/profiles/${encodeURIComponent(profileData.name)}`,
                method: 'PUT',
                data: profileData,
                timestamp: new Date().toISOString()
            });

            const result = await this.apiCall(`/api/profiles/${encodeURIComponent(profileData.name)}`, 'PUT', profileData);

            if (result.success && !quiet) {
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

    // Crée un profil et y enregistre les réglages affichés.
    //
    // POST /api/profiles écrit un profil aux VALEURS PAR DÉFAUT : c'est le rôle
    // du PUT qui suit d'y déposer l'état courant. Sans lui, le profil créé était
    // vide alors que l'écran continuait d'afficher les réglages de
    // l'utilisateur, présentés comme enregistrés — le travail était perdu au
    // rechargement suivant, sans le moindre message.
    //
    // Retourne true si le profil existe ET contient les réglages affichés.
    async createProfile(name, baseProfile = null) {
        try {
            const result = await this.apiCall('/api/profiles', 'POST', {
                name: name,
                base: baseProfile
            });
            if (!result.success) return false;

            // Profil actif avant le PUT : _buildProfilePayload() s'appuie dessus,
            // et un échec d'écriture doit laisser l'utilisateur devant un profil
            // actif qu'il peut re-sauvegarder.
            this.currentProfile = { name: result.name, uid: result.uid, version: result.version };
            await this.loadProfilesList();

            const saved = await this.saveProfile(this._buildProfilePayload(), { quiet: true });
            if (!saved || !saved.success) {
                // Le profil existe mais est resté aux valeurs par défaut : le
                // dire, sinon l'écran (inchangé) laisse croire au succès.
                this.showToast(
                    pkg.t('Profil "${name}" créé, mais l\'enregistrement des réglages a échoué', { name: result.name }),
                    'red'
                );
                this._updateActiveProfileHighlight();
                return false;
            }

            this._markSaved();
            await this._rememberActiveProfile(this.currentProfile.uid);
            this._updateActiveProfileHighlight();
            this.showToast(pkg.t('Profil "${name}" créé', { name: result.name }), 'green');
            return true;
        } catch (error) {
            console.error('Erreur création profil:', error);
            return false;
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
                    // On repasse tout de suite "sans profil actif" : le profil
                    // vient d'être supprimé, ses éventuelles modifications non
                    // sauvegardées n'ont plus de sens (et ne doivent pas faire
                    // redemander une confirmation au basculement), et l'état est
                    // celui qui reste affiché si aucun repli n'aboutit.
                    this._setNoActiveProfile();

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

                    // 3) Plus aucun profil : on en reste à l'état posé plus haut.
                }
            }
        } catch (error) {
            // Le serveur répond 404 si le profil n'existe plus : la liste
            // affichée est désynchronisée du disque, on la refetch pour que
            // l'entrée fantôme disparaisse au lieu de rester cliquable.
            console.error('Erreur suppression profil:', error);
            await this.loadProfilesList();
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
            if (!resp.ok) throw new Error(data.message || pkg.t('Export échoué'));

            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${name}.mygcflow-profile.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            this.showToast(pkg.t('Profil "${name}" exporté', { name }), 'green');
        } catch (e) {
            console.error('Export error', e);
            this.showToast(pkg.t('Erreur export du profil'), 'red');
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
        if (!await this._confirmDiscardChangesIfNeeded()) return;
        try {
            const profile = await this.apiCall(`/api/profiles/${encodeURIComponent(profileName)}`);
            if (!profile || !profile.uid) {
                throw new Error(pkg.t('Profil introuvable ou UID manquant'));
            }

            // Appliquer immédiatement le profil
            this.currentProfile = profile;
            await this.applyProfile(profile);
            this._markSaved();
            await this._rememberActiveProfile(profile.uid);

            // Sauvegarder l'UUID comme profil par défaut
            const result = await this.saveAppSettings({ default_profile_uid: profile.uid });

            if (!result.success) {
                throw new Error(pkg.t('Échec de la sauvegarde du profil par défaut'));
            }

            this._defaultProfileName = profile.name;

            this.showToast(pkg.t('Profil "${name}" défini comme profil par défaut', { name: profile.name }), 'green');

            // Rafraîchir les éléments UI dépendants : la liste des profils n'a
            // pas changé, seules la valeur du sélecteur et la position des
            // marquages "ACTIF" / étoile "par défaut" doivent suivre.
            this._syncDefaultProfileSelectorValue();
            this._updateActiveProfileHighlight();
            this._updateDefaultProfileHighlight();
        } catch (error) {
            console.error('❌ Erreur définition profil par défaut:', error);
            this.showToast(pkg.t('Erreur lors de la définition du profil par défaut'), 'red');
        }
    }

    // UI methods
    renderProfilesList() {
        const container = document.getElementById('profiles-list');
        if (!container) return;

        container.innerHTML = '';

        if (this.profilesList.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'list-group-item text-center';
            empty.textContent = pkg.t('Aucun profil');
            container.appendChild(empty);
            // Le sélecteur compact doit aussi refléter la liste vide (option
            // « Aucun profil », contrôle désactivé) — voir le rendu normal.
            this.updateCurrentProfileIndicator();
            return;
        }

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
            nameWrap.addEventListener('click', () => this.loadProfile(profileName));

            const swatchIcon = document.createElement('i');
            swatchIcon.className = 'ti ti-color-swatch me-1';
            nameWrap.appendChild(swatchIcon);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'profile-name';
            nameSpan.textContent = profileName;
            nameWrap.appendChild(nameSpan);

            // `_defaultProfileName` vaut null tant que les réglages n'ont pas été
            // lus : aucune étoile n'est posée, la comparaison échoue pour tous les
            // profils. Le rattrapage est fait en fin de rendu.
            this._setProfileItemDefault(nameWrap, this._defaultProfileName === profileName);
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
            menu.appendChild(buildMenuItem('ti-copy', pkg.t('Dupliquer'), () => this.showDuplicateProfileModal(profileName)));
            menu.appendChild(buildMenuItem('ti-edit', pkg.t('Renommer'), () => this.renameProfile(profileName)));
            menu.appendChild(buildMenuItem('ti-download', pkg.t('Exporter'), () => this.exportProfile(profileName)));
            menu.appendChild(buildMenuItem('ti-refresh', pkg.t('Réinitialiser'), () => this.confirmReset(profileName), true));
            menu.appendChild(buildMenuItem('ti-trash', pkg.t('Supprimer'), () => this.confirmDelete(profileName), true));
            const divider = document.createElement('li');
            divider.innerHTML = '<hr class="dropdown-divider">';
            menu.appendChild(divider);
            menu.appendChild(buildMenuItem('ti-star', pkg.t('Définir comme par défaut'), () => this.setProfileAsDefault(profileName)));

            dropdown.appendChild(toggleBtn);
            dropdown.appendChild(menu);
            colActions.appendChild(dropdown);

            row.appendChild(colName);
            row.appendChild(colActions);
            item.appendChild(row);

            // Après assemblage seulement : le marquage "actif" pose aussi une
            // classe sur `item` via closest(), qui exige que nameWrap soit déjà
            // rattaché à sa ligne.
            this._setProfileItemActive(nameWrap, this.currentProfile?.name === profileName);

            container.appendChild(item);
        });

        // Les dropdowns Bootstrap 5 sont auto-initialisés via data-bs-toggle="dropdown"

        // Mettre à jour l'indicateur du profil actif (nécessaire pour le rendu initial)
        this.updateCurrentProfileIndicator();

        // Premier rendu avant que les réglages aient été lus (init() rend la liste
        // sans attendre) : on récupère le profil par défaut, puis on pose l'étoile
        // sur la liste déjà affichée plutôt que de la reconstruire.
        if (this._defaultProfileName === null) {
            this._getDefaultProfileName().then(() => this._updateDefaultProfileHighlight());
        }
    }

    // Pose ou retire le marquage "profil actif" sur un élément de liste déjà
    // construit. Marquage volontairement discret : nom en accent + liseré sur
    // la ligne (CSS), sans badge « ACTIF » ni coche. L'information reste
    // accessible aux lecteurs d'écran via aria-current, qui remplace le texte
    // du badge retiré.
    _setProfileItemActive(nameWrap, isActive) {
        nameWrap.classList.toggle('active-profile', !!isActive);
        // Le liseré porte sur toute la ligne (menu « … » compris), donc sur
        // l'élément de liste et non sur le seul bloc du nom.
        nameWrap.closest('.list-group-item')?.classList.toggle('active-profile-item', !!isActive);
        if (isActive) nameWrap.setAttribute('aria-current', 'true');
        else nameWrap.removeAttribute('aria-current');
    }

    // Pose ou retire l'étoile "profil par défaut" sur un élément de liste déjà
    // construit. Profil par défaut et profil actif sont deux états indépendants
    // (on peut travailler sur un profil sans en faire son défaut) : l'étoile est
    // insérée juste après le nom plutôt qu'ajoutée en fin de conteneur, pour que
    // sa position ne dépende pas de l'ordre dans lequel les deux marquages sont
    // rafraîchis.
    _setProfileItemDefault(nameWrap, isDefault) {
        nameWrap.querySelector('.profile-default-star')?.remove();
        if (!isDefault) return;

        const star = document.createElement('i');
        star.className = 'ti ti-star-filled ms-1 profile-default-star';
        star.title = pkg.t('Profil par défaut');
        nameWrap.querySelector('.profile-name')?.after(star);
    }

    // Déplace l'étoile "par défaut" sur la liste déjà rendue (même principe que
    // _updateActiveProfileHighlight : ni requête ni reconstruction du DOM).
    _updateDefaultProfileHighlight() {
        const container = document.getElementById('profiles-list');
        if (!container) return;
        // '' (aucun profil par défaut) ne doit correspondre à aucun nom.
        const defaultName = this._defaultProfileName || null;
        container.querySelectorAll('[data-profile-name]').forEach(item => {
            const nameWrap = item.querySelector('.profile-name-wrap');
            if (nameWrap) {
                this._setProfileItemDefault(nameWrap, item.dataset.profileName === defaultName);
            }
        });
        this._syncProfileSelect();
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
                indicator.title = this.hasUnsavedChanges ? pkg.t('Modifications non enregistrées') : '';
            } else {
                indicator.textContent = '';
                indicator.classList.remove('active');
                indicator.classList.remove('unsaved');
                indicator.title = '';
            }
        }
        this._syncProfileSelect();
    }

    // Maintient le sélecteur compact de la barre de profil aligné sur l'état
    // réel : options = liste des profils (★ pour le profil par défaut, « • »
    // accolé au nom du profil actif quand des modifications attendent d'être
    // enregistrées), sélection = profil actif. Sans profil actif, un
    // placeholder non sélectionnable l'indique ; sans aucun profil, le
    // contrôle est désactivé.
    _syncProfileSelect() {
        const select = document.getElementById('profile-select');
        if (!select) return;

        const current = this.currentProfile?.name ?? null;
        // '' (aucun profil par défaut) ne doit correspondre à aucun nom.
        const defaultName = this._defaultProfileName || null;
        select.innerHTML = '';

        if (this.profilesList.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = pkg.t('Aucun profil');
            opt.selected = true;
            select.appendChild(opt);
            select.disabled = true;
            return;
        }
        select.disabled = false;

        if (!current) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = pkg.t('Choisir un profil');
            opt.selected = true;
            opt.disabled = true;
            select.appendChild(opt);
        }

        for (const name of this.profilesList) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = (name === defaultName ? '★ ' : '')
                + name
                + (name === current && this.hasUnsavedChanges ? ' •' : '');
            opt.selected = name === current;
            select.appendChild(opt);
        }
    }

    // Repasse dans l'état "aucun profil actif" : indicateur vide, badge ACTIF
    // retiré de la liste, suivi des modifications éteint (il n'a plus de
    // référence à comparer). Les réglages en place ne sont pas touchés : ils
    // restent utilisables, simplement rattachés à aucun profil, et l'utilisateur
    // peut les enregistrer dans un nouveau profil.
    _setNoActiveProfile() {
        this.currentProfile = null;
        this.hasUnsavedChanges = false;
        this._updateActiveProfileHighlight();
    }

    // Snapshot des réglages actuels comme référence "sauvegardée" (après chargement/sauvegarde d'un profil)
    _markSaved() {
        this.loadCurrentSettings();
        this._lastSavedSnapshot = this._dirtySnapshot(this.currentSettings);
        this.hasUnsavedChanges = false;
        this.updateCurrentProfileIndicator();
    }

    // Écoute les changements des contrôles de style pour détecter les modifications
    // non sauvegardées.
    //
    // Les événements DOM ne servent qu'à savoir QUAND recalculer : l'état comparé
    // est lu dans pkg.options (cf. loadCurrentSettings). On compare au lieu de
    // poser un simple `dirty = true` parce que la comparaison sait aussi ÉTEINDRE
    // l'indicateur quand l'utilisateur revient à la valeur enregistrée, et parce
    // qu'un contrôle touché ne signifie pas une valeur changée (réouverture d'un
    // select, saisie annulée). Le recalcul est débouncé et ne fait plus, depuis
    // que l'état est centralisé, que quelques lectures d'options et une
    // sérialisation — plus les ~30 lectures DOM d'avant.
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
        const recompute = (event) => {
            // Sans profil courant, l'indicateur n'affiche rien : inutile de
            // programmer un recalcul dont le résultat ne serait pas utilisé.
            if (!this.currentProfile) return;
            // La barre de profil (#profile-bar) est dans #style, mais aucun de
            // ses contrôles n'est un réglage de style (sélecteur, Sauvegarder,
            // Gérer les profils) ; la liste et ses actions sont dans la modale
            // de gestion, rattachée à <body> donc déjà hors de portée — le
            // test sur #profiles-section ne sert que si la modale n'a pas
            // encore été déplacée. Les ignorer évite de programmer un recalcul
            // concurrent d'une sauvegarde en cours, qui rafraîchirait
            // currentSettings juste avant que saveCurrentAsProfile n'en fasse la
            // nouvelle référence enregistrée.
            if (event?.target?.closest?.('#profiles-section, #profile-bar')) return;
            clearTimeout(this._dirtyDebounceTimer);
            this._dirtyDebounceTimer = setTimeout(() => {
                this._dirtyDebounceTimer = null;
                this._recomputeDirtyState();
            }, 300);
        };
        container.addEventListener('input', recompute, true);
        container.addEventListener('change', recompute, true);
        // 'click' en plus des événements de formulaire : plusieurs réglages de
        // profil ne passent par aucun champ mais par un bouton — choix du fond
        // de carte (.changeMap), variante Toner clair/sombre, « Appliquer » du
        // style Titre/Infos. Ces boutons n'émettent ni 'input' ni 'change', et
        // leurs modifications restaient donc invisibles pour l'indicateur « • »
        // alors qu'elles sont bien enregistrées dans le profil.
        //
        // L'écoute en capture voit le clic AVANT le gestionnaire métier qui écrit
        // pkg.options, mais le recalcul est débouncé de 300 ms : il lit l'état
        // une fois ces écritures (synchrones) faites. Et comme le suivi compare
        // au lieu de poser un drapeau, un clic sans effet sur les réglages (un
        // onglet, un bouton d'action) ne rend pas le profil « modifié ».
        container.addEventListener('click', recompute, true);
    }

    // Compare l'état courant à la référence enregistrée et met l'indicateur à
    // jour. Appelé par le suivi débouncé et, sans attendre, par la garde de
    // fermeture (_flushDirtyTracking).
    _recomputeDirtyState() {
        if (!this.currentProfile) return;
        this.loadCurrentSettings();
        const dirty = this._dirtySnapshot(this.currentSettings) !== this._lastSavedSnapshot;
        if (dirty !== this.hasUnsavedChanges) {
            this.hasUnsavedChanges = dirty;
            this.updateCurrentProfileIndicator();
        }
    }

    // Exécute tout de suite un recalcul encore en attente dans le debounce.
    _flushDirtyTracking() {
        if (this._dirtyDebounceTimer === null) return;
        clearTimeout(this._dirtyDebounceTimer);
        this._dirtyDebounceTimer = null;
        this._recomputeDirtyState();
    }

    // Avertit avant la fermeture ou le rafraîchissement de l'onglet quand le
    // profil courant a des modifications non enregistrées : sans cela,
    // l'indicateur « • » signale la perte à venir mais rien ne l'empêche.
    //
    // Le texte n'est pas personnalisable (les navigateurs affichent leur propre
    // message générique depuis longtemps) et la boîte ne s'affiche que si
    // l'utilisateur a interagi avec la page — toujours vrai ici, puisqu'il a
    // fallu modifier un réglage pour rendre le profil "dirty".
    _bindUnloadGuard() {
        window.addEventListener('beforeunload', (event) => {
            // Une modification faite dans les 300 ms qui précèdent la fermeture
            // n'a pas encore été vue par le suivi débouncé : sans ce flush, la
            // garde laisserait partir des modifications bien réelles.
            this._flushDirtyTracking();
            if (!this.hasUnsavedChanges) return;
            event.preventDefault();
            // Navigateurs anciens : seul returnValue déclenche la boîte.
            event.returnValue = '';
        });
    }

    // Avertit avant d'abandonner des modifications non sauvegardées (chargement
    // d'un autre profil, etc.). Retourne true si l'action appelante peut
    // continuer : soit il n'y avait rien à perdre, soit l'utilisateur a
    // enregistré, soit il a explicitement abandonné ses modifications.
    async _confirmDiscardChangesIfNeeded() {
        if (!this.hasUnsavedChanges) return true;

        const choice = await this._askUnsavedChangesChoice();
        if (choice === 'discard') return true;
        // Une sauvegarde en échec (erreur réseau/serveur, déjà signalée par un
        // toast) ne doit pas emporter les modifications : on annule l'action.
        if (choice === 'save') return await this.saveCurrentAsProfile();
        return false;
    }

    // Ouvre la modale à trois issues et résout avec 'save' | 'discard' | 'cancel'.
    // Remplace window.confirm() : même look que les autres modales de l'app et
    // libellés traduisibles, au prix d'une attente asynchrone (d'où les `await`
    // chez les appelants de _confirmDiscardChangesIfNeeded).
    _askUnsavedChangesChoice() {
        const modal = document.getElementById('unsaved-changes-modal');
        // Sans modale utilisable (Bootstrap absent, onglet Style pas rendu), on
        // ne peut pas demander : on annule plutôt que de perdre le travail en
        // cours en silence.
        if (!modal || !getBsModal(modal)) {
            console.warn('ProfileManager: modale "modifications non enregistrées" indisponible, action annulée');
            return Promise.resolve('cancel');
        }
        // Un second appel pendant que la modale est ouverte (clic sur un autre
        // profil) serait ignoré par Bootstrap mais résolu par le MÊME
        // 'hidden.bs.modal' : les deux actions s'exécuteraient sur un seul clic.
        if (this._unsavedChoicePending) return Promise.resolve('cancel');
        this._unsavedChoicePending = true;

        const message = document.getElementById('unsaved-changes-message');
        if (message) {
            message.textContent = this.currentProfile?.name
                ? pkg.t('Le profil "${name}" contient des modifications non enregistrées. Que voulez-vous faire ?', { name: this.currentProfile.name })
                : pkg.t('Vous avez des modifications non enregistrées. Que voulez-vous faire ?');
        }

        return new Promise(resolve => {
            let choice = 'cancel';
            const cleanups = [];
            const on = (el, type, handler) => {
                if (!el) return;
                el.addEventListener(type, handler);
                cleanups.push(() => el.removeEventListener(type, handler));
            };
            // 'hidden.bs.modal' est le seul point de sortie : il couvre aussi
            // Échap, le clic sur le fond et la croix, et garantit que l'action
            // suivante (qui peut ouvrir sa propre modale) ne démarre pas avant
            // la fin de l'animation de fermeture.
            on(modal, 'hidden.bs.modal', () => {
                cleanups.forEach(fn => fn());
                this._unsavedChoicePending = false;
                resolve(choice);
            });
            on(document.getElementById('btn-unsaved-save'), 'click', () => {
                choice = 'save';
                hideBsModal(modal);
            });
            on(document.getElementById('btn-unsaved-discard'), 'click', () => {
                choice = 'discard';
                hideBsModal(modal);
            });
            showBsModal(modal);
        });
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
        if (this._defaultProfileName !== null) return this._defaultProfileName;
        // Plusieurs appels peuvent se croiser au démarrage (rendu de la liste des
        // profils, sélecteur des réglages) : ils partagent la même requête.
        if (!this._defaultProfileNamePromise) {
            this._defaultProfileNamePromise = this.loadAppSettings().then(settings => {
                // Une écriture entre-temps (setProfileAsDefault) fait autorité :
                // elle connaît une valeur plus récente que celle relue ici.
                if (this._defaultProfileName === null) {
                    this._defaultProfileName = settings.default_profile_name || '';
                }
                this._defaultProfileNamePromise = null;
                return this._defaultProfileName;
            });
        }
        return this._defaultProfileNamePromise;
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

    // Mémorise le profil que le prochain démarrage devra restaurer. Appelé à
    // chaque fois que le profil actif change du fait de l'utilisateur, jamais
    // pendant la restauration elle-même (la valeur y est déjà à jour).
    //
    // L'échec n'est pas signalé : l'utilisateur ne perd que la restauration
    // automatique, pas son profil, et le signaler brouillerait le message de
    // l'action qu'il vient réellement de demander. On oublie en revanche la
    // valeur mémorisée pour que le chargement suivant retente l'écriture.
    async _rememberActiveProfile(uid) {
        const value = uid || null;
        if (value === this._lastProfileUid) return;
        this._lastProfileUid = value;
        const result = await this.saveAppSettings({ last_profile_uid: value });
        if (!result || !result.success) {
            console.warn('⚠️ Mémorisation du dernier profil actif impossible (uid=%s)', value);
            this._lastProfileUid = undefined;
        }
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
    // `quiet` supprime le toast d'erreur pour les appelants qui affichent leur
    // propre message (démarrage : « aucun profil actif »), sans quoi l'échec en
    // produirait deux d'affilée.
    // `remember` est mis à false par la restauration au démarrage : elle charge
    // précisément le profil déjà mémorisé, le réécrire ne ferait qu'ajouter une
    // requête à chaque lancement.
    async loadProfileByUid(uid, { quiet = false, remember = true } = {}) {
        if (!await this._confirmDiscardChangesIfNeeded()) return false;
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
                points: profile.points,
                flash: profile.flash,
                infos: profile.infos,
                raw_response: profile
            });

            this.currentProfile = profile;
            await this.applyProfile(profile);
            this._markSaved();
            if (remember) await this._rememberActiveProfile(profile.uid);

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
            if (!quiet) this.showToast(pkg.t('Erreur lors du chargement du profil par défaut'), 'red');
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
            noneOption.textContent = pkg.t('Aucun profil par défaut');
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
        // Le sélecteur "profil par défaut" est une préférence globale : il reçoit
        // le même indicateur inline que ses voisins de l'onglet Préférences. Le
        // toast ci-dessous reste, car il rapporte une autre information — le
        // profil a aussi été APPLIQUÉ à la carte.
        if (result.success) markSaved('selectDefaultProfile');
        else markSaveError('selectDefaultProfile');
        if (result.success) {
            dbgProfiles('Profil par défaut sauvegardé avec succès, UUID:', selectedProfileUid);
            this._defaultProfileName = appliedProfileName || '';
            this._updateDefaultProfileHighlight();
            this.showToast(
                appliedProfileName ?
                    pkg.t('Profil "${selectedProfile}" appliqué et défini comme profil par défaut', { selectedProfile: appliedProfileName }) :
                    pkg.t('Aucun profil par défaut défini'),
                appliedProfileName ? 'green' : 'blue'
            );
        } else {
            console.error('❌ Échec de la sauvegarde du profil par défaut');
        }
    }

    // Restaure le profil du démarrage : le DERNIER PROFIL ACTIF d'abord, le
    // profil par défaut seulement en repli.
    //
    // L'application ne repartait auparavant que du profil par défaut : un profil
    // créé ou sélectionné puis enregistré revenait au lancement suivant sous les
    // réglages d'un autre profil, tant que l'utilisateur n'avait pas pensé à
    // « Définir comme par défaut ». Le réglage « par défaut » garde son rôle,
    // mais pour le seul cas où aucun profil n'a encore été utilisé (première
    // ouverture) ou quand le dernier actif a disparu.
    async restoreStartupProfile() {
        try {
            dbgProfiles('🎯 [STARTUP_PROFILE] Restauration du profil - État actuel:', {
                point_mode: pkg?.options?.point?.mode,
                switch_checked: document.getElementById('switchIconeVectoriel')?.checked
            });

            const settings = await this.loadAppSettings();
            dbgProfiles('🎯 [STARTUP_PROFILE] Paramètres chargés au démarrage:', {
                last_profile_uid: settings.last_profile_uid,
                last_profile_name: settings.last_profile_name,
                default_profile_uid: settings.default_profile_uid,
                default_profile_name: settings.default_profile_name,
                all_settings: settings
            });

            // Les réglages viennent d'être lus : en profiter pour amorcer les
            // caches et éviter un second GET /api/settings côté sélecteur, ainsi
            // qu'une réécriture inutile du dernier profil actif.
            this._defaultProfileName = settings.default_profile_name || '';
            this._lastProfileUid = settings.last_profile_uid || null;
            // La liste peut déjà avoir été rendue (init) sans connaître le défaut.
            this._updateDefaultProfileHighlight();

            // Un UID orphelin est déjà traité en amont (get_app_settings() efface
            // la référence morte et renvoie null) : ne restent ici que des UID
            // censés être lisibles.
            const candidates = [];
            if (settings.last_profile_uid) candidates.push(settings.last_profile_uid);
            if (settings.default_profile_uid && settings.default_profile_uid !== settings.last_profile_uid) {
                candidates.push(settings.default_profile_uid);
            }

            if (!candidates.length) {
                dbgProfiles('🎯 [STARTUP_PROFILE] Ni dernier profil actif ni profil par défaut : démarrage sans profil');
                return;
            }

            for (const uid of candidates) {
                dbgProfiles('🎯 [STARTUP_PROFILE] Tentative de chargement (UUID):', uid);

                // loadProfileByUid() ne lève pas : il journalise, prévient par un
                // toast et retourne false. C'est cette valeur qui décide de la
                // suite, pas un catch (qui ne se déclencherait jamais).
                // `remember: false` : on charge précisément la valeur mémorisée,
                // la réécrire n'apporterait qu'une requête de plus au démarrage.
                const loaded = await this.loadProfileByUid(uid, { quiet: true, remember: false });

                dbgProfiles('🎯 [STARTUP_PROFILE] État après tentative:', {
                    point_mode: pkg?.options?.point?.mode,
                    switch_checked: document.getElementById('switchIconeVectoriel')?.checked,
                    profile_name: this.currentProfile?.name || 'aucun'
                });

                if (!loaded) {
                    console.warn('⚠️ [STARTUP_PROFILE] Profil non chargé (uid=%s)', uid);
                    continue;
                }

                // Le repli sur le profil par défaut a servi : c'est lui qu'il faut
                // restaurer la prochaine fois, sans quoi chaque démarrage
                // repasserait par un échec de lecture du profil disparu.
                if (uid !== this._lastProfileUid) await this._rememberActiveProfile(uid);

                // Vérification finale de cohérence
                const finalSwitchState = document.getElementById('switchIconeVectoriel')?.checked;
                const finalPointMode = pkg?.options?.point?.mode;
                const isConsistent = (finalPointMode === 'vectoriel' && finalSwitchState) ||
                                   (finalPointMode === 'icone' && !finalSwitchState);

                if (isConsistent) {
                    dbgProfiles('✅ [STARTUP_PROFILE] Mode des points cohérent:', finalPointMode);
                } else {
                    console.warn('⚠️ [STARTUP_PROFILE] Incohérence détectée - Mode:', finalPointMode, 'Switch:', finalSwitchState);
                }

                // Le toast est déjà affiché dans loadProfileByUid
                return;
            }

            // Aucun candidat lisible. Pas de repli sur un profil "Default" ni sur
            // un pseudo-profil temporaire : l'un comme l'autre affichaient un
            // profil actif que l'utilisateur ne pouvait ni retrouver dans la liste
            // ni enregistrer. Il ne reste ici que de vraies pannes de lecture, où
            // deviner un profil de secours n'apporte rien. On reste sans profil,
            // en le disant.
            console.warn('⚠️ [STARTUP_PROFILE] Aucun profil chargé, démarrage sans profil actif');
            this._setNoActiveProfile();
            this.showToast(
                pkg.t('Le profil n\'a pas pu être chargé : aucun profil n\'est actif.'),
                'orange'
            );
        } catch (error) {
            console.error('❌ [STARTUP_PROFILE] Erreur restauration du profil au démarrage:', error);
            console.error('❌ [STARTUP_PROFILE] Détails de l\'erreur:', error.message);
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

            // Le centre et le zoom ne font PAS partie du thème : ce sont un
            // état de session/préférence globale (map_default_center,
            // map_default_zoom dans settings.json), jamais sauvegardés ici.
            const mapSettings = {
                tile_provider: mapOptions.default || 'OSM',
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

            // Paramètres des points : lus dans pkg.options.point, pour les mêmes
            // raisons que la carte ci-dessus. Les contrôles n'en sont qu'un
            // reflet (syncPointOptionsUI) et certains réglages, comme la méta
            // sprite du jeu d'icônes, n'existent que dans les options.
            const point = pkg.options?.point || {};
            const center = point.center || {};
            const border = point.border || {};
            const borderSize = parseInt(border.size) || 0;

            const pointSettings = {
                size: parseInt(center.size) || 8,
                color: center.color || '#ff5722',
                shape: point.shape || 'circle',
                halo: borderSize > 0,
                border_color: border.color || '#000000',
                border_size: borderSize,
                fill_color_type: center.mode || 'fix',
                border_color_type: border.mode || 'fix',
                mode: point.mode === 'icone' ? 'icone' : 'vectoriel',
                icon_set: point.iconSet || 'geocaching',
                icon_size: parseInt(point.iconSize) || 24,
                appear_animation: point.appearAnimation === true,
                recent_glow_days: Math.max(0, parseInt(point.recentGlowDays) || 0)
            };

            dbgProfiles('Paramètres points récupérés:', pointSettings);

            // Le rythme et le timing (durée/jour, durée totale, plage de dates,
            // temps additionnel, suivi de caméra, durée du flash) ne sont PAS
            // sérialisés dans le thème : ils vivent dans les préférences
            // globales (settings.json, bloc `animation`).

            // Paramètres flash — la durée en fait exception : réglage temporel,
            // il appartient aux préférences d'animation, pas au thème.
            const flash = pkg.options?.flash || {};
            const flashSettings = {
                mode: flash.mode || 'circle',
                size: parseInt(flash.size) || 50,
                color: flash.color || '#FF00FF',
                color_type: flash.color_type || 'fix'
            };

            dbgProfiles('🔍 Paramètres flash récupérés:', flashSettings);

            // Paramètres infos. Le CSS des overlays fait exception : il n'est pas
            // stocké dans les options, les textareas en sont la source (elles
            // sont resynchronisées par changeTitleCssValues/changeInfosCssValues).
            const infos = pkg.options?.infos || {};
            const titleCssTextarea = document.getElementById('inputTitleCss');
            const infosCssTextarea = document.getElementById('inputInfosCss');

            const infosSettings = {
                title: {
                    display: infos.title?.display !== false,
                    text: infos.title?.text ?? 'My Geocaching Map'
                },
                number_of_caches: infos.numberOfCaches?.display !== false,
                current_date: infos.currentDate?.display !== false,
                title_css: extractCssDeclarations(titleCssTextarea ? titleCssTextarea.value : ''),
                infos_css: extractCssDeclarations(infosCssTextarea ? infosCssTextarea.value : ''),
            };

            dbgProfiles('📄 Paramètres infos récupérés:', {
                title_css_length: (infosSettings.title_css || '').length,
                infos_css_length: (infosSettings.infos_css || '').length,
                final_infos: infosSettings
            });

            this.currentSettings = {
                map: mapSettings,
                points: pointSettings,
                flash: flashSettings,
                infos: infosSettings,
            };

            dbgProfiles('PARAMÈTRES ACTUELS COMPLÈTS - Récupérés depuis l\'interface:', {
                map: mapSettings,
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
                    tile_provider: 'OpenStreetMap'
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
                    size: 50,
                    color: '#FF00FF'
                }
            };
        }
    }

    // Applique un profil. Entièrement synchrone (reste async pour ses appelants)
    // et déterministe : aucun événement DOM simulé, donc rien à attendre. Un
    // instantané "état sauvegardé" pris juste après (ex: loadProfile ->
    // _markSaved) ne peut pas capturer un état transitoire.
    //
    // Trois phases strictement séparées :
    //   1. ÉTAT  : les valeurs du profil sont écrites dans pkg.options, seule
    //              source de vérité. Aucune écriture DOM, aucun rendu.
    //   2. UI    : les contrôles reflètent cet état via pkg.sync*OptionsUI().
    //              Ces fonctions n'écrivent que le DOM.
    //   3. RENDU : une seule passe de rafraîchissement.
    //
    // L'ancienne version pilotait l'interface par .click()/dispatchEvent : le
    // handler de chaque champ redessinait les points (un redraw complet par
    // champ appliqué), et l'ordre dépendait des écouteurs réellement posés — un
    // 'change' dispatché sur un champ écouté en 'input' n'appliquait rien.
    async applyProfile(profile) {
        dbgProfiles('🎯 APPLICATION PROFIL - Profil complet chargé:', {
            profile_name: profile.name,
            uid: profile.uid,
            version: profile.version,
            map: profile.map,
            points: profile.points,
            flash: profile.flash,
            infos: profile.infos,
            timestamp: new Date().toISOString()
        });

        // ---- 1. État ----
        // `profile.animation` (vitesse, suivi de caméra des anciens thèmes) est
        // volontairement ignoré : le timing est une préférence globale, un
        // changement de thème ne doit jamais le modifier. Idem pour
        // `flash.duration` (dans applyFlashState) et pour le centre/zoom de la
        // carte (dans applyMapSettings).
        if (profile.points) applyPointState(profile.points);
        if (profile.flash) applyFlashState(profile.flash);
        if (profile.infos) applyInfosState(profile.infos);

        // ---- 2. Interface ----
        // La carte fait exception : switchLayer() écrit lui-même son option et
        // met à jour couches et boutons (cf. applyMapSettings).
        if (profile.map) applyMapSettings(profile.map);
        if (profile.points) pkg.syncPointOptionsUI();
        if (profile.flash) pkg.syncFlashOptionsUI();
        if (profile.infos) {
            pkg.syncInfosOptionsUI();
            applyInfosCss(profile.infos);
        }

        // ---- 3. Rendu ----
        // Un seul redraw des points, quel que soit le nombre de champs appliqués.
        if (profile.points) {
            const olMap = typeof pkg.getMap === 'function' ? pkg.getMap() : null;
            if (olMap) pkg.refreshPoints(pkg.options);
        }
        // Les compteurs d'images dépendent de l'animation ET du flash : un profil
        // sans bloc animation doit quand même les recalculer.
        pkg.updateInfosForPictures();

        dbgProfiles('Profil appliqué avec succès:', profile.name);
    }

    // Corps du PUT décrivant les réglages affichés, sous le nom du profil actif.
    // Extrait de saveCurrentAsProfile() pour que la création d'un profil écrive
    // exactement la même chose (cf. createProfile) : un profil créé et un profil
    // sauvegardé ne doivent pas pouvoir diverger.
    _buildProfilePayload() {
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

        return {
            name: this.currentProfile.name,
            uid: this.currentProfile.uid,
            version: this.currentProfile.version,
            map: mapNormalized,
            points: this.currentSettings.points,
            flash: this.currentSettings.flash,
            infos: this.currentSettings.infos,
        };
    }

    // Retourne true si le profil a bien été écrit côté serveur. La valeur sert à
    // _confirmDiscardChangesIfNeeded ("Enregistrer et charger") : une sauvegarde
    // en échec doit interrompre l'action qui allait écraser les modifications.
    async saveCurrentAsProfile() {
        if (!this.currentProfile) {
            // Aucun profil actif : l'enregistrement passe par la création d'un
            // profil, qui reprend les réglages affichés (cf. createProfile).
            this.showNewProfileModal({ saveAs: true });
            return false;
        }

        const profileData = this._buildProfilePayload();

        dbgProfiles('💾 SAUVEGARDE PROFIL - Données complètes:', {
            profile_name: profileData.name,
            map: profileData.map,
            points: profileData.points,
            flash: profileData.flash,
            infos: profileData.infos,
            timestamp: new Date().toISOString()
        });

        const result = await this.saveProfile(profileData);
        const saved = !!(result && result.success);
        if (saved) {
            this._lastSavedSnapshot = this._dirtySnapshot(this.currentSettings);
            this.hasUnsavedChanges = false;
        }
        this.updateCurrentProfileIndicator();
        return saved;
    }

    // Modale de nom partagée par "Nouveau profil", "Renommer" et "Dupliquer" :
    // seuls le titre, la valeur pré-remplie, le libellé du bouton et l'action
    // mémorisée changent. C'est confirmProfileAction() qui relit ces données au
    // moment du clic pour savoir quoi faire du nom saisi.
    _showProfileNameModal({ title, value, confirmLabel, action, originalName = '' }) {
        const modal = document.getElementById('profile-modal');
        const titleEl = document.getElementById('profile-modal-title');
        const input = document.getElementById('profile-name-input');
        const confirmBtn = document.getElementById('btn-confirm-profile');

        titleEl.textContent = title;
        input.value = value;
        confirmBtn.textContent = confirmLabel;
        confirmBtn.dataset.action = action;
        // Toujours réécrit, y compris à vide : un reste de l'ouverture
        // précédente ferait porter un renommage ou une duplication sur le
        // mauvais profil.
        confirmBtn.dataset.originalName = originalName;

        // Diagnostic posé dès l'ouverture : il désactive le bouton sur un champ
        // vide (« Nouveau profil ») et signale d'emblée une suggestion de
        // duplication qui contiendrait des caractères ignorés.
        this._updateProfileNameFeedback();

        showBsModal(modal);
        // Un nom pré-rempli est sélectionné plutôt que simplement focalisé :
        // il vaut proposition, une frappe doit suffire à le remplacer.
        setTimeout(() => (value ? input.select() : input.focus()), 100);
    }

    // `saveAs` : ouverture depuis le bouton « Sauvegarder » sans profil actif.
    // Même action (la création enregistre les réglages affichés), mais l'intitulé
    // doit dire ce qui va se passer — « Nouveau profil » laissait croire qu'on
    // repartait de zéro et que le travail en cours n'était pas concerné.
    showNewProfileModal({ saveAs = false } = {}) {
        this._showProfileNameModal({
            title: saveAs ? pkg.t('Enregistrer dans un nouveau profil') : pkg.t('Nouveau profil'),
            value: '',
            // Pas de simple « Enregistrer » : cette chaîne est déjà celle du
            // bouton d'enregistrement vidéo (« Record » en anglais).
            confirmLabel: saveAs ? pkg.t('Enregistrer le profil') : pkg.t('Créer'),
            action: 'create',
        });
    }

    renameProfile(profileName) {
        this._showProfileNameModal({
            title: pkg.t('Renommer le profil'),
            value: profileName,
            confirmLabel: pkg.t('Renommer'),
            action: 'rename',
            originalName: profileName,
        });
    }

    // Dupliquer passe par la modale de nom plutôt que de créer directement
    // "X_copy" : on duplique en général pour partir d'un profil existant et en
    // faire un autre, qui mérite son propre nom. Le nom suggéré reste celui
    // qu'aurait produit l'ancien comportement, une validation immédiate donne
    // donc exactement le même résultat qu'avant.
    showDuplicateProfileModal(profileName) {
        this._showProfileNameModal({
            title: pkg.t('Dupliquer le profil'),
            value: this._suggestDuplicateName(profileName),
            confirmLabel: pkg.t('Dupliquer'),
            action: 'duplicate',
            originalName: profileName,
        });
    }

    // Nom pré-rempli pour une duplication : "X_copy", puis "X_copy (1)"... tant
    // que le nom est déjà pris.
    _suggestDuplicateName(profileName) {
        return this._generateUniqueName(`${profileName}_copy`);
    }

    // Miroir de `_generate_unique_name` côté serveur : suffixe " (n)" tant que le
    // nom est pris, pour que la suggestion et l'annonce faite à l'utilisateur
    // correspondent au nom qui sera réellement créé. La comparaison porte sur la
    // clé de fichier, comme `_name_exists` : "Mon Profil" occupe aussi "MonProfil".
    _generateUniqueName(baseName) {
        const taken = new Set((this.profilesList || []).map(profileNameKey));
        if (!taken.has(profileNameKey(baseName))) return baseName;
        for (let idx = 1; ; idx++) {
            const candidate = `${baseName} (${idx})`;
            if (!taken.has(profileNameKey(candidate))) return candidate;
        }
    }

    // Diagnostic du nom saisi dans la modale, indépendant du DOM pour rester
    // testable. Retourne { valid, level, message } :
    //   - level 'error'   : le serveur refuserait (ou écraserait) — on bloque ;
    //   - level 'warning' : l'action aboutira mais pas sous le nom saisi tel quel ;
    //   - level 'none'    : rien à signaler.
    // `valid` pilote l'activation du bouton de confirmation.
    _validateProfileName(rawValue, action = 'create', originalName = '') {
        const name = String(rawValue ?? '').trim();
        // Champ vide : pas encore une erreur à afficher, mais rien à valider non plus.
        if (!name) return { valid: false, level: 'none', message: '' };

        const key = profileNameKey(name);
        if (!key) {
            return {
                valid: false,
                level: 'error',
                message: pkg.t('Le nom doit contenir au moins une lettre ou un chiffre'),
            };
        }

        // Renommer vers un nom qui retombe sur le fichier du profil lui-même est
        // permis (renommage cosmétique), comme `is_name_available(exclude_uid=)`.
        const conflict = (this.profilesList || []).find(existing => (
            !(action === 'rename' && existing === originalName) && profileNameKey(existing) === key
        ));

        if (conflict) {
            if (action === 'duplicate') {
                // Le serveur résout lui-même la collision en suffixant : inutile de
                // bloquer, mais l'utilisateur doit savoir sous quel nom il atterrit.
                const suggested = this._generateUniqueName(name);
                return {
                    valid: true,
                    level: 'warning',
                    message: pkg.t('« ${conflict} » existe déjà : la copie sera nommée « ${suggested} »', { conflict, suggested }),
                };
            }
            return {
                valid: false,
                level: 'error',
                message: conflict === name
                    ? pkg.t('Un profil nommé « ${name} » existe déjà', { name })
                    : pkg.t('Ce nom est déjà pris par « ${conflict} » : les deux se réduisent au fichier « ${key} »', { conflict, key }),
            };
        }

        const dropped = droppedProfileNameChars(name);
        if (dropped) {
            return {
                valid: true,
                level: 'warning',
                message: pkg.t('Caractères ignorés (${dropped}) : le profil sera enregistré sous « ${key} »', { dropped, key }),
            };
        }

        return { valid: true, level: 'none', message: '' };
    }

    // Applique le diagnostic au DOM de la modale et retourne le résultat, pour que
    // l'appelant (saisie ou confirmation) puisse décider sur la même base.
    _updateProfileNameFeedback() {
        const input = document.getElementById('profile-name-input');
        const confirmBtn = document.getElementById('btn-confirm-profile');
        const feedback = document.getElementById('profile-name-feedback');
        if (!input || !confirmBtn) return null;

        const result = this._validateProfileName(
            input.value,
            confirmBtn.dataset.action,
            confirmBtn.dataset.originalName || '',
        );

        const isError = result.level === 'error';
        input.classList.toggle('is-invalid', isError);
        input.setAttribute('aria-invalid', isError ? 'true' : 'false');
        confirmBtn.disabled = !result.valid;

        if (feedback) {
            feedback.textContent = result.message;
            // `invalid-feedback` seul reste masqué tant que Bootstrap ne voit pas
            // l'input en `.is-invalid` au moment du rendu : `d-block` force son
            // affichage. Sans message, la ligne est retirée du flux pour éviter
            // que la modale ne saute d'une hauteur de ligne à chaque frappe.
            feedback.className = isError ? 'invalid-feedback d-block'
                : result.message ? 'form-text text-warning'
                : 'form-text d-none';
        }
        return result;
    }

    confirmProfileAction() {
        const input = document.getElementById('profile-name-input');
        const confirmBtn = document.getElementById('btn-confirm-profile');
        const name = input.value.trim();

        // Re-validation au moment du clic : le bouton est déjà désactivé dans ce
        // cas, mais la liste des profils a pu être rafraîchie depuis la dernière
        // frappe (import, création dans un autre onglet).
        const check = this._updateProfileNameFeedback();
        if (check && !check.valid) {
            if (!name) this.showToast(pkg.t('Veuillez saisir un nom de profil'), 'orange');
            return;
        }

        const originalName = confirmBtn.dataset.originalName;
        if (confirmBtn.dataset.action === 'create') {
            this.createProfile(name);
        } else if (confirmBtn.dataset.action === 'rename') {
            if (originalName !== name) {
                // Pour renommer, on charge l'ancien profil et on le sauvegarde avec le nouveau nom (même UUID)
                this.renameProfileProperly(originalName, name);
            }
        } else if (confirmBtn.dataset.action === 'duplicate') {
            // Un nom déjà pris (saisi tel quel ou liste rafraîchie entre-temps)
            // reste géré par le serveur, qui répond avec le nom retenu.
            this.duplicateProfile(originalName, name);
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

        message.textContent = pkg.t('Êtes-vous sûr de vouloir supprimer le profil "${name}" ?', { name: profileName });
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

        message.textContent = pkg.t('Êtes-vous sûr de vouloir réinitialiser le profil "${name}" aux valeurs par défaut ?', { name: profileName });
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
        // Adapter les noms de couleur historiques (paramètre `color`) vers les
        // types du système de toasts GCM
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

            // Centre et zoom : volontairement pas touchés. C'est un état de
            // session (la vue courante) ou une préférence globale
            // (map_default_center/zoom de settings.json, appliquée au
            // démarrage) — un thème ne déplace plus la carte.
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

// Recopie les paramètres de points du profil (snake_case) dans pkg.options.point
// (camelCase). N'écrit ni le DOM ni la carte : pkg.syncPointOptionsUI() reflète
// l'état dans les contrôles et pkg.refreshPoints() redessine, une seule fois.
function applyPointState(pointOptions) {
    try {
        dbgProfiles('🎯 APPLICATION PARAMÈTRES POINTS - Données reçues:', pointOptions);

        const point = pkg.options?.point;
        if (!point) {
            console.warn('⚠️ pkg.options.point indisponible, paramètres des points ignorés');
            return;
        }

        if (pointOptions.mode === 'icone' || pointOptions.mode === 'vectoriel') {
            point.mode = pointOptions.mode;
        }
        if (pointOptions.shape) point.shape = pointOptions.shape;

        const center = point.center || (point.center = {});
        const border = point.border || (point.border = {});

        const size = parseInt(pointOptions.size);
        if (Number.isFinite(size)) center.size = Math.max(1, size);
        if (pointOptions.color) center.color = pointOptions.color;
        if (pointOptions.fill_color_type) center.mode = pointOptions.fill_color_type;

        // halo à false = pas de bordure, quelle que soit border_size.
        // Bornage identique à celui du slider (0 à 10).
        const borderSize = pointOptions.halo ? (parseInt(pointOptions.border_size) || 0) : 0;
        border.size = Math.max(0, Math.min(10, borderSize));
        if (pointOptions.border_color) border.color = pointOptions.border_color;
        if (pointOptions.border_color_type) border.mode = pointOptions.border_color_type;

        // Options du mode icône : écrites même en mode vectoriel (comme les
        // options vectorMap/Toner de la carte), pour rester correctes si
        // l'utilisateur bascule ensuite de mode ou resauvegarde le profil.
        // setPointIconSet() dérive aussi la méta sprite utilisée par le rendu.
        pkg.setPointIconSet(pointOptions.icon_set ?? point.iconSet);
        const iconSize = parseInt(pointOptions.icon_size);
        if (Number.isFinite(iconSize) && iconSize > 0) point.iconSize = iconSize;
        // Profils antérieurs à ce réglage : pas d'apparition animée.
        point.appearAnimation = pointOptions.appear_animation === true;
        point.recentGlowDays = Math.max(0, parseInt(pointOptions.recent_glow_days) || 0);

        dbgProfiles('Paramètres des points appliqués:', point);
    } catch (error) {
        console.error('❌ Erreur lors de l\'application des paramètres des points:', error);
    }
}

// Écrit les paramètres de flash du profil dans pkg.options.flash.
function applyFlashState(flashOptions) {
    try {
        const flash = pkg.options?.flash;
        if (!flash) {
            console.warn('⚠️ pkg.options.flash indisponible, paramètres flash ignorés');
            return;
        }

        if (flashOptions.mode) flash.mode = flashOptions.mode;
        // `duration` des anciens fichiers est ignorée : la durée du flash est un
        // réglage d'animation (préférence globale), pas un réglage de thème.
        const size = parseInt(flashOptions.size);
        if (Number.isFinite(size)) flash.size = size;
        if (flashOptions.color) {
            flash.color = flashOptions.color;
            // Voir changeFlashValues : `rgb` est la forme réellement lue par les
            // styles de flash, elle doit suivre `color` à chaque écriture.
            flash.rgb = pkg.hexToRgb(flashOptions.color);
        }
        // Profils antérieurs au type de couleur : couleur fixe.
        flash.color_type = flashOptions.color_type || 'fix';

        dbgProfiles('Paramètres flash appliqués:', flash);
    } catch (error) {
        console.error('Erreur lors de l\'application des paramètres flash:', error);
    }
}

// Écrit les paramètres d'informations du profil dans pkg.options.infos.
// Le CSS des overlays n'y figure pas : il est appliqué par applyInfosCss().
function applyInfosState(infosOptions) {
    try {
        const infos = pkg.options?.infos;
        if (!infos) {
            console.warn('⚠️ pkg.options.infos indisponible, paramètres infos ignorés');
            return;
        }

        const title = infos.title || (infos.title = {});
        if (infosOptions.title) {
            title.display = !!infosOptions.title.display;
            if (typeof infosOptions.title.text === 'string') title.text = infosOptions.title.text;
        } else {
            title.display = false;
        }

        (infos.numberOfCaches || (infos.numberOfCaches = {})).display = !!infosOptions.number_of_caches;
        (infos.currentDate || (infos.currentDate = {})).display = !!infosOptions.current_date;

        dbgProfiles('📄 Paramètres infos appliqués:', infos);
    } catch (error) {
        console.error('Erreur lors de l\'application des paramètres infos:', error);
    }
}

// CSS des overlays titre / infos. Il n'est pas stocké dans pkg.options : la
// source de vérité est le style appliqué aux frames, que changeTitleCssValues()
// et changeInfosCssValues() nettoient avant de resynchroniser les textareas.
function applyInfosCss(infosOptions) {
    try {
        if (typeof pkg.changeTitleCssValues === 'function' && typeof infosOptions.title_css === 'string') {
            const cleanedTitleCss = extractCssDeclarations(infosOptions.title_css);
            // Repli sur le CSS du profil si la frame n'existe pas encore : le
            // textarea reste la valeur de référence pour la prochaine application.
            const appliedTitleCss = pkg.changeTitleCssValues(cleanedTitleCss) ?? cleanedTitleCss;
            const titleCssTextarea = document.getElementById('inputTitleCss');
            if (titleCssTextarea) titleCssTextarea.value = appliedTitleCss;
        }
        if (typeof pkg.changeInfosCssValues === 'function' && typeof infosOptions.infos_css === 'string') {
            const cleanedInfosCss = extractCssDeclarations(infosOptions.infos_css);
            const appliedInfosCss = pkg.changeInfosCssValues(cleanedInfosCss) ?? cleanedInfosCss;
            const infosCssTextarea = document.getElementById('inputInfosCss');
            if (infosCssTextarea) infosCssTextarea.value = appliedInfosCss;
        }

        if (typeof window.gcCssAssistantSyncFromTextareas === 'function') {
            window.gcCssAssistantSyncFromTextareas();
        }
    } catch (e) {
        console.warn('Application du CSS des overlays: erreur non bloquante', e);
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
