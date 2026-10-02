// Choix de la base qui reçoit un import CSV (mode Évolution).
//
// Une fusion ne s'annule pas : déposer l'export d'une autre zone dans la base
// ouverte mélangerait deux zones sans retour possible. L'interface demande
// donc confirmation quand un fichier ne ressemble pas à la base ouverte —
// ni à son nom, ni aux exports qu'elle a déjà reçus — et propose la base dont
// le nom correspond, ou une nouvelle base.
//
// Aucune dépendance au DOM : logique pure, testable.

// Nom d'un fichier sans extension ni l'horodatage que les outils d'export y
// ajoutent (« SlovnieCroatie-20260930061930.csv » -> « SlovnieCroatie »).
export function fileStem(filename) {
    return String(filename || '')
        .replace(/\.[^.]+$/, '')
        .replace(/[-_ ]?\d{8,14}$/, '')
        .trim();
}

// Clé de comparaison d'un nom de base ou de fichier : sans accents, casse,
// ponctuation ni suffixe « (2) » ajouté pour éviter un nom déjà pris.
export function matchKey(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s*\(\d+\)\s*$/, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

// Clé d'un nom de fichier : celle de son nom sans horodatage.
export function fileKey(filename) {
    return matchKey(fileStem(filename));
}

// Fichiers qui ne correspondent pas à la base ouverte `dataset`, dans l'ordre
// d'envoi : ni à son nom, ni à un export qu'elle a déjà reçu
// (`importedFilenames`, historique des imports). Aucun quand il n'y a pas de
// base ouverte (une base est créée au nom du premier fichier) ou quand elle
// est vide (rien à mélanger).
export function unmatchedFilenames({ dataset, importedFilenames = [], filenames = [] } = {}) {
    if (!dataset) return [];
    if (!(dataset.stats?.total > 0) && !(dataset.import_count > 0)) return [];
    const known = new Set(importedFilenames.map(fileKey).filter(Boolean));
    const nameKey = matchKey(dataset.name);
    if (nameKey) known.add(nameKey);
    return filenames.filter((name) => {
        const key = fileKey(name);
        return !key || !known.has(key);
    });
}

// Faut-il demander où importer `filenames` ?
export function needsImportTargetChoice(args = {}) {
    return unmatchedFilenames(args).length > 0;
}

// Choix proposé par défaut : une AUTRE base dont le nom correspond au premier
// fichier non reconnu ({ kind: 'existing', id }), sinon une nouvelle base
// ({ kind: 'new' }) — jamais la base ouverte, puisque c'est elle qui ne
// correspond pas.
export function suggestedImportTarget({ datasets = [], currentId = null, filenames = [] } = {}) {
    for (const name of filenames) {
        const key = fileKey(name);
        if (!key) continue;
        const match = datasets.find((d) => d.id !== currentId && matchKey(d.name) === key);
        if (match) return { kind: 'existing', id: match.id };
    }
    return { kind: 'new' };
}
