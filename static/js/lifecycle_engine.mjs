// Moteur « cycle de vie » des pages Évolution et Mes poses.
//
// Sur ces pages, toutes les caches de la sélection sont ajoutées une fois à la
// couche de points ; le shader décide jour après jour de leur visibilité
// (placedDay / archivedDay contre la variable evoDay). mapgl.js pilote
// l'animation, les deux pipelines d'enregistrement et la carte au repos ; les
// données, la chronologie et l'horloge vivent dans le module de la page
// (evolution_data.js, poses_data.js), qui s'enregistre ici.
//
// Module feuille : aucune dépendance, pour être évalué avant ses importeurs
// (cf. AGENTS.md, ordre d'évaluation des modules).
//
// Interface d'un moteur :
//   id                         'evolution' | 'poses'
//   counterKeys                balises numériques animées de la ligne d'infos
//                              (la première alimente aussi #spanNbCaches)
//   infosTags                  toutes les balises du modèle ({date}, {total}…)
//   hasData()                  une chronologie à jouer existe
//   infosTemplate()            modèle courant de la ligne d'infos
//   begin(start, end, at, { stagger })
//                              début d'animation ; renvoie les valeurs des
//                              compteurs la veille du début ({ tag: n })
//   step(dates, at)            jours affichés -> { placed, archived,
//                              flashes?, values } (null si rien)
//                              flashes : [{ feature, options }] déjà résolus
//                              (moteurs à flashs par événement) ; absent, mapgl
//                              joue le flash d'apparition sur `placed` et le
//                              flash de disparition sur `archived`
//   frameVars(now, msPerDay)   variables de style evo* de l'image
//   end()                      fin d'animation (changements différés)
//   restState()                { day, date, values } à la date de fin
//   refreshRest()              la date de fin a changé (onglet Animation)
//   applySelection()           un filtre a changé
//   statsIndex()               vue de la chronologie pour Stats / barre
//   milestones(axisStart, span) repères par cache de la barre de chronologie
//                              → [{ offset, kind, code, value }] (optionnel ;
//                              Mes poses : première trouvaille, paliers ronds)
//   maxEventsInWindow(days)    pic d'événements, estimation de charge
//   renderPopup(feature, el)   popup d'un point
//   styleChanged()             la couche de points vient d'être recréée par
//                              un changement de style (optionnel ; Mes poses :
//                              attributs des effets de points)

let current = null;

export function registerLifecycleEngine(engine) {
    current = engine || null;
}

export function lifecycleEngine() {
    return current;
}
