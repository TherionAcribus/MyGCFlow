// Gestion du thème clair/sombre.
//
// L'application INITIALE du thème est faite très tôt par un script inline (templates/_theme_boot.html,
// inclus dans le <head> d'app.html) pour éviter le flash au chargement. Ce module gère la
// suite : le toggle de l'onglet Paramètres (#selectTheme), la persistance, et la
// réactivité au thème système quand la préférence est "system".
//
// Trois préférences possibles :
//   - "system" (défaut) : suit le réglage OS via prefers-color-scheme, en direct
//   - "light" / "dark"  : forcé, quel que soit l'OS
// Le thème EFFECTIF appliqué sur <html> (data-bs-theme) est toujours "light" ou
// "dark" ; "system" n'est qu'une préférence, résolue à la volée.
//
// PERSISTANCE : la référence est `settings.json` côté serveur (comme la langue),
// pour que le thème suive l'utilisateur d'un navigateur à l'autre et survive à
// un vidage du cache. localStorage n'en est qu'un MIROIR, conservé pour une
// seule raison : le script anti-FOUC du <head> doit connaître la préférence
// avant le premier octet de CSS, donc avant tout aller-retour réseau. Le miroir
// est réaligné sur le serveur au démarrage (cf. syncThemeFromSettings).

import { saveSettingsPatch } from './settings_api.mjs';
import { reportSave } from './saved_indicator.mjs';

const THEME_KEY = 'mygcflow_theme';
const VALID_PREFS = ['system', 'light', 'dark'];
const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function isValidPref(pref) {
    return VALID_PREFS.includes(pref);
}

// Lit le miroir local. Utilisé avant que les préférences serveur ne soient
// arrivées, et comme repli si le serveur est injoignable.
function getPref() {
    try {
        const stored = localStorage.getItem(THEME_KEY);
        return isValidPref(stored) ? stored : 'system';
    } catch (_) {
        return 'system';
    }
}

function writeMirror(pref) {
    try {
        localStorage.setItem(THEME_KEY, pref);
    } catch (_) {}
}

// Résout la préférence en thème effectif ("light" | "dark").
function resolveEffective(pref) {
    if (pref === 'dark') return 'dark';
    if (pref === 'light') return 'light';
    return (mql && mql.matches) ? 'dark' : 'light';
}

// Applique le thème effectif correspondant à une préférence sur <html>.
export function applyTheme(pref) {
    document.documentElement.setAttribute('data-bs-theme', resolveEffective(pref));
}

// Ids de tous les contrôles qui pilotent la préférence de thème : le select
// de l'onglet Préférences (#selectTheme) et celui de l'en-tête d'application
// (#appHeaderTheme). Les deux restent synchronisés via l'événement
// `theme:applied` (cf. initThemeControls).
const THEME_SELECT_IDS = ['selectTheme', 'appHeaderTheme'];

function themeSelects() {
    return THEME_SELECT_IDS
        .map((id) => document.getElementById(id))
        .filter(Boolean);
}

// Enregistre une préférence (serveur + miroir local) et l'applique immédiatement.
// Le miroir est écrit sans attendre le serveur : le thème doit être correct au
// prochain chargement même si la requête échoue, et l'indicateur du champ dira
// alors que la valeur n'a pas été enregistrée durablement.
// Émet `theme:applied` (detail.pref) pour que les autres contrôles de thème
// reflètent la nouvelle valeur — poser .value ne déclenche pas `change`, donc
// pas de boucle.
export function setThemePref(pref) {
    const safePref = isValidPref(pref) ? pref : 'system';
    writeMirror(safePref);
    applyTheme(safePref);
    document.dispatchEvent(new CustomEvent('theme:applied', { detail: { pref: safePref } }));
    return reportSave(THEME_SELECT_IDS, saveSettingsPatch({ theme: safePref }));
}

// Point d'entrée public pour un contrôle hors de l'onglet Préférences (ex. le
// select de l'en-tête) : même persistance, même application immédiate et même
// événement que le handler `change` de #selectTheme.
export function applyThemeValue(value) {
    return setThemePref(value);
}

// Réaligne le miroir local sur la préférence enregistrée côté serveur. Appelée
// au démarrage par init.js avec la réponse de /api/settings : sur un nouveau
// navigateur (miroir absent), c'est ce qui rend le thème choisi ailleurs.
// L'écart visuel est invisible en pratique — le repaint a lieu avant que la
// carte ne soit rendue.
export function syncThemeFromSettings(userSettings) {
    const serverPref = userSettings && userSettings.theme;
    if (!isValidPref(serverPref)) return;
    if (serverPref !== getPref()) {
        writeMirror(serverPref);
        applyTheme(serverPref);
    }
    themeSelects().forEach((select) => { select.value = serverPref; });
}

function initThemeControls() {
    const pref = getPref();

    // Synchroniser les contrôles de thème (onglet Préférences + en-tête
    // d'application) avec la préférence courante : chacun persiste via
    // setThemePref, qui émet `theme:applied` pour réaligner l'autre select.
    const selects = themeSelects();
    selects.forEach((select) => {
        select.value = pref;
        select.addEventListener('change', () => setThemePref(select.value));
    });
    document.addEventListener('theme:applied', (e) => {
        const p = e.detail && e.detail.pref;
        if (!isValidPref(p)) return;
        selects.forEach((select) => { if (select.value !== p) select.value = p; });
    });

    // Re-synchroniser data-bs-theme (déjà posé par le script inline du <head>) :
    // sans effet visible, mais garantit la cohérence si le DOM a été manipulé.
    applyTheme(pref);

    // En mode "system", suivre les changements de thème de l'OS en direct.
    if (mql) {
        const onSystemChange = () => {
            if (getPref() === 'system') applyTheme('system');
        };
        if (mql.addEventListener) {
            mql.addEventListener('change', onSystemChange);
        } else if (mql.addListener) {
            // Safari < 14 : ancienne API.
            mql.addListener(onSystemChange);
        }
    }
}

document.addEventListener('DOMContentLoaded', initThemeControls);
