// Dimensions de filtre « inclusives » du panneau Filtres (onglet Données,
// mode principal) — règles pures, sans DOM ni carte, testées par
// tests/js/filter_model.test.mjs.
//
// Sémantique INVERSÉE par rapport aux dimensions exclusives (type, taille,
// pays… où tout décoché exclut tout) : une sélection VIDE est NEUTRE — le
// critère ne retire rien. Attributs et propriétaire ne s'appliquent pas aux
// Lab Caches (écart traité par l'appelant, bdd.js) ; la recherche, si.

// Attributs GPX d'une feature : properties.attributes est la liste
// [{id, name, inc}] produite par bdd.create_geojson (inc '1' = présent,
// '0' = explicitement absent, null si aucun). Une chaîne JSON du même
// format est acceptée — exports ou caches sérialisés.
export function featureAttributes(props) {
    const raw = props?.attributes;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

// Clé stable d'un attribut — valeur d'option ET terme de comparaison :
// l'id GPX quand il existe (canonique Groundspeak), le libellé sinon.
export function attributeKey(attr) {
    if (!attr) return '';
    if (attr.id !== null && attr.id !== undefined && attr.id !== '') return String(attr.id);
    return String(attr.name || '');
}

// Attribut réellement « porté » par la cache : inc '0' marque une absence
// explicite, toute autre valeur ('1', absence d'inc) est une présence.
export function attributePresent(attr) {
    return !!attr && String(attr.inc) !== '0';
}

// Vrai si la feature porte TOUS les attributs demandés avec inc ≠ '0'
// (ET logique). `selectedKeys` : itérable de clés attributeKey. Une
// sélection vide est neutre — vrai par convention d'un « et » sur rien.
export function matchesAttributes(props, selectedKeys) {
    const wanted = [...(selectedKeys || [])];
    if (!wanted.length) return true;
    const present = new Set(
        featureAttributes(props).filter(attributePresent).map(attributeKey));
    return wanted.every(k => present.has(k));
}

// Propriétaire de la cache : `owner`, `placed_by` en repli. Chaîne vide ou
// absente → null (la feature ne peut matcher aucune option).
export function featureOwner(props) {
    const v = props?.owner || props?.placed_by;
    return (typeof v === 'string' && v.trim() !== '') ? v : null;
}

// Texte normalisé pour la recherche : minuscules et diacritiques retirés —
// « Café » et « cafe » confondus (NFD puis suppression des marques).
export function normalizeSearchText(value) {
    return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// Vrai si `needle` (déjà normalisé via normalizeSearchText) est une
// sous-chaîne du code OU du nom. « Ce qui existe » suffit : les Labs ont
// un name sans gc_code, les features annexes (DNF, caches posées) les
// deux — un champ absent ne peut pas matcher mais ne bloque pas l'autre.
export function matchesSearch(props, needle) {
    if (!needle) return true;
    return normalizeSearchText(props?.gc_code).includes(needle)
        || normalizeSearchText(props?.name).includes(needle);
}
