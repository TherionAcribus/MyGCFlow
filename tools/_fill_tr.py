# Remplit les msgstr vides des catalogues pour un jeu de msgids donné.
# Jetable : utilisé pendant les lots Parcours, pas un outil du projet.
import io
import json
import re
import sys

def po_literal(lines, i):
    """Lit la chaîne littérale commençant à lines[i] (après le mot-clé)
    et les lignes de continuation entre guillemets. Retourne (texte, fin)."""
    parts = []
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith('"'):
            parts.append(line)
            i += 1
        elif line.startswith('msgid ') or line.startswith('msgstr '):
            # première ligne : extraire le littéral après le mot-clé
            lit = line[line.index('"') :]
            parts.append(lit)
            i += 1
        else:
            break
    text = ''.join(json.loads(p) for p in parts)
    return text, i

def fill(path, translations):
    text = io.open(path, encoding='utf-8').read()
    lines = text.split('\n')
    out = []
    filled = set()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('msgid ') and not (out and out[-1].startswith('#~')):
            msgid, j = po_literal(lines, i)
            # avance jusqu'au msgstr de cette entrée
            block_end = j
            while block_end < len(lines) and lines[block_end].strip() and not lines[block_end].startswith('msgstr'):
                block_end += 1
            if block_end < len(lines) and msgid in translations:
                msgstr, k = po_literal(lines, block_end)
                if msgstr == '':
                    out.extend(lines[i:block_end])
                    out.append('msgstr ' + json.dumps(translations[msgid], ensure_ascii=False))
                    i = k
                    filled.add(msgid)
                    continue
        out.append(line)
        i += 1
    io.open(path, 'w', encoding='utf-8', newline='').write('\n'.join(out))
    return filled

FR = {
    'Glisser pour réordonner': 'Glisser pour réordonner',
    'Raccourcir le parcours': 'Raccourcir le parcours',
    'Raccourcir quand même': 'Raccourcir quand même',
    'Exporter l’itinéraire en GPX (une route par journée)': 'Exporter l’itinéraire en GPX (une route par journée)',
    'Calcul interrompu : ${routed} trajets sur ${legs} gardent leurs itinéraires.': 'Calcul interrompu : ${routed} trajets sur ${legs} gardent leurs itinéraires.',
    'Envoi interrompu : ${sent} photos sur ${total} envoyées': 'Envoi interrompu : ${sent} photos sur ${total} envoyées',
    'Envoi interrompu : ${sent} traces sur ${total} envoyées': 'Envoi interrompu : ${sent} traces sur ${total} envoyées',
    '${n} lieux ou bases seront supprimés': '${n} lieux ou bases seront supprimés',
    '${n} étapes retrouveront leur journée d’origine': '${n} étapes retrouveront leur journée d’origine',
    'La nouvelle plage laisse des lieux ou des étapes déplacées dehors': 'La nouvelle plage laisse des lieux ou des étapes déplacées dehors',
    'La nouvelle plage laisse des éléments dehors : ${items}.': 'La nouvelle plage laisse des éléments dehors : ${items}.',
}
EN = {
    'Glisser pour réordonner': 'Drag to reorder',
    'Raccourcir le parcours': 'Shorten the parcours',
    'Raccourcir quand même': 'Shorten anyway',
    'Exporter l’itinéraire en GPX (une route par journée)': 'Export the route as GPX (one route per day)',
    'Calcul interrompu : ${routed} trajets sur ${legs} gardent leurs itinéraires.': 'Calculation interrupted: ${routed} legs out of ${legs} keep their routes.',
    'Envoi interrompu : ${sent} photos sur ${total} envoyées': 'Upload interrupted: ${sent} photos out of ${total} sent',
    'Envoi interrompu : ${sent} traces sur ${total} envoyées': 'Upload interrupted: ${sent} tracks out of ${total} sent',
    '${n} lieux ou bases seront supprimés': '${n} places or bases will be deleted',
    '${n} étapes retrouveront leur journée d’origine': '${n} stops will return to their original day',
    'La nouvelle plage laisse des lieux ou des étapes déplacées dehors': 'The new range leaves some places or moved stops outside',
    'La nouvelle plage laisse des éléments dehors : ${items}.': 'The new range leaves some items outside: ${items}.',
}
DE = {
    'Glisser pour réordonner': 'Zum Ändern der Reihenfolge ziehen',
    'Raccourcir le parcours': 'Parcours kürzen',
    'Raccourcir quand même': 'Trotzdem kürzen',
    'Exporter l’itinéraire en GPX (une route par journée)': 'Route als GPX exportieren (eine Route pro Tag)',
    'Calcul interrompu : ${routed} trajets sur ${legs} gardent leurs itinéraires.': 'Berechnung abgebrochen: ${routed} von ${legs} Etappen behalten ihre Routen.',
    'Envoi interrompu : ${sent} photos sur ${total} envoyées': 'Upload abgebrochen: ${sent} von ${total} Fotos gesendet',
    'Envoi interrompu : ${sent} traces sur ${total} envoyées': 'Upload abgebrochen: ${sent} von ${total} Spuren gesendet',
    '${n} lieux ou bases seront supprimés': '${n} Orte oder Basen werden gelöscht',
    '${n} étapes retrouveront leur journée d’origine': '${n} Etappen kehren zu ihrem ursprünglichen Tag zurück',
    'La nouvelle plage laisse des lieux ou des étapes déplacées dehors': 'Der neue Bereich lässt Orte oder verschobene Etappen außerhalb',
    'La nouvelle plage laisse des éléments dehors : ${items}.': 'Der neue Bereich lässt Elemente außerhalb: ${items}.',
}

for lang, table in (('fr', FR), ('en', EN), ('de', DE)):
    filled = fill(f'translations/{lang}/LC_MESSAGES/messages.po', table)
    missing = set(table) - filled
    print(lang, len(filled), 'remplis', ('— reste: ' + repr(sorted(missing)[:3])) if missing else '')
