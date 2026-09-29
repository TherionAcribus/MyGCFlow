// Renvoi de la modale de première utilisation, partagé par les specs.
//
// Sur une base vide, l'app ouvre #modal_first_use après un aller-retour
// réseau ; son backdrop intercepte alors tous les clics. Chaque spec avait sa
// copie d'un renvoi qui attendait la modale 5 s au plus puis cliquait
// « Ignorer ». Deux défauts rendaient la suite instable :
//   - une modale ouverte après ces 5 s n'était jamais fermée ;
//   - un clic pendant l'animation d'ouverture était ignoré par Bootstrap, et
//     l'attente de fermeture échouait au bout de 90 s.
// L'app signale maintenant le moment où la décision est prise, modale
// entièrement ouverte le cas échéant (window.mygcflowFirstUseSettled, cf.
// markFirstUseSettled dans static/js/bdd.js) : on l'attend, puis on ferme.

export async function dismissFirstUseModal(page) {
  await page.waitForFunction(() => window.mygcflowFirstUseSettled === true);

  const firstUse = page.locator('#modal_first_use');
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}
