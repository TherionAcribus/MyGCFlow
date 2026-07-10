// Gestion du thème clair/sombre.
//
// L'application INITIALE du thème est faite très tôt par un script inline dans
// le <head> d'app.html (pour éviter le flash au chargement). Ce module gère la
// suite : le toggle de l'onglet Paramètres (#selectTheme), la persistance dans
// localStorage, et la réactivité au thème système quand la préférence est
// "system".
//
// Trois préférences possibles :
//   - "system" (défaut) : suit le réglage OS via prefers-color-scheme, en direct
//   - "light" / "dark"  : forcé, quel que soit l'OS
// Le thème EFFECTIF appliqué sur <html> (data-bs-theme) est toujours "light" ou
// "dark" ; "system" n'est qu'une préférence, résolue à la volée.

const THEME_KEY = 'gcmap_theme';
const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function getPref() {
    try {
        return localStorage.getItem(THEME_KEY) || 'system';
    } catch (_) {
        return 'system';
    }
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

// Enregistre une préférence et l'applique immédiatement.
export function setThemePref(pref) {
    try {
        localStorage.setItem(THEME_KEY, pref);
    } catch (_) {}
    applyTheme(pref);
}

function initThemeControls() {
    const pref = getPref();

    // Synchroniser le <select> de l'onglet Paramètres avec la préférence courante.
    const select = document.getElementById('selectTheme');
    if (select) {
        select.value = pref;
        select.addEventListener('change', () => setThemePref(select.value));
    }

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
