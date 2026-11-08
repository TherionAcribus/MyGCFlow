// Arrêt de l'application depuis l'interface (POST /api/quit).
//
// L'icône de la zone de notification reste la sortie « officielle », mais
// Windows 11 la masque par défaut : ce chemin-ci est le seul que l'utilisateur
// ait sous les yeux. `force` est renvoyé après confirmation lorsque le serveur
// signale un import ou un encodage encore en cours.
//
// Module à part (sorti de ui.js) : la page Statistiques, qui ne charge ni la
// carte ni index.js, a le même bouton « Quitter » dans son en-tête. Ses seules
// dépendances sont les modales de notifications.js.

import { showConfirmation, showError, t } from './notifications.js';

export function quitApp() {
    showConfirmation(
        t('Fermer MyGCFlow ? Le serveur local sera arrêté.'),
        t('Quitter'),
        () => sendQuit(false),
        null,
        { confirmText: t('Quitter') }
    );
}

// Branche « Quitter » sur les boutons présents dans la page. Ils ne sont
// rendus que si l'application tourne sous launcher.py (`can_quit`).
export function bindQuitButtons(ids = ['buttonQuitAppHeader', 'buttonQuitApp']) {
    ids.forEach(id => {
        const button = document.getElementById(id);
        if (button) button.addEventListener('click', quitApp);
    });
}

// `force` à false laisse le serveur répondre 409 s'il reste un import ou un
// encodage en cours ; on ne repasse à true qu'après accord de l'utilisateur.
async function sendQuit(force) {
    let response;
    try {
        response = await fetch('/api/quit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force })
        });
    } catch (_) {
        // Le serveur coupe parfois avant d'avoir répondu au second envoi.
        if (force) { showAppClosed(); return; }
        showError(t("MyGCFlow n'a pas pu être arrêté."), t('Quitter'));
        return;
    }

    if (response.status === 409) {
        showConfirmation(
            t('Un import ou un traitement vidéo est en cours. Il sera interrompu. Quitter quand même ?'),
            t('Quitter'),
            () => sendQuit(true),
            null,
            { danger: true, confirmText: t('Quitter quand même') }
        );
        return;
    }
    if (!response.ok) {
        showError(t("MyGCFlow n'a pas pu être arrêté."), t('Quitter'));
        return;
    }
    showAppClosed();
}

// L'onglet survit au serveur : sans ce remplacement, l'utilisateur garde une
// interface d'apparence normale dont chaque action échouera.
function showAppClosed() {
    // Les deux appels à t() restent hors du littéral de gabarit : l'extracteur
    // JavaScript de Babel ne regarde pas à l'intérieur (cf. babel.cfg).
    const title = t('MyGCFlow est fermé');
    const hint = t('Vous pouvez fermer cet onglet.');
    document.body.innerHTML = `
        <div class="d-flex flex-column align-items-center justify-content-center text-center"
             style="height:100vh;gap:.75rem;">
            <i class="ti ti-power" style="font-size:3rem;"></i>
            <h2>${title}</h2>
            <p>${hint}</p>
        </div>
    `;
}
