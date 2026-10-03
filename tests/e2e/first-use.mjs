// Attente du jalon « première utilisation réglée », partagé par les specs.
//
// La modale #modal_first_use ne s'ouvre plus automatiquement : sur base
// vide, c'est l'état vide de la carte qui porte l'appel à l'action (la
// modale n'est plus qu'une aide, ouverte via le lien « Comment obtenir mon
// fichier .gpx ? » de l'état vide). Le jalon window.mygcflowFirstUseSettled
// (cf. markFirstUseSettled dans static/js/bdd.js) signale que la
// vérification /db_status du démarrage est terminée : on l'attend pour
// stabiliser la page, puis on referme la modale par prudence si elle était
// ouverte (ex. une spec qui l'a affichée via le lien d'aide).

export async function dismissFirstUseModal(page) {
  await page.waitForFunction(() => window.mygcflowFirstUseSettled === true);

  const firstUse = page.locator('#modal_first_use');
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}
