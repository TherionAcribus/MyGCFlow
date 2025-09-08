#!/usr/bin/env python3
"""
Script de test pour déboguer les traductions Flask-Babel
"""

import requests
import json

def test_translations():
    """Test des traductions en français et anglais"""

    base_url = "http://127.0.0.1:5000"

    print("=== TEST DES TRADUCTIONS ===")
    print()

    # Test en français
    print("1. Test en français (?lang=fr):")
    try:
        response = requests.get(f"{base_url}/test_translations?lang=fr")
        if response.status_code == 200:
            data = response.json()
            print(f"   ✓ Locale détectée: {data['current_locale']}")
            print("   ✓ Traductions:")
            for key, value in data['test_strings'].items():
                print(f"      {key}: '{value}'")
        else:
            print(f"   ✗ Erreur HTTP: {response.status_code}")
    except Exception as e:
        print(f"   ✗ Erreur de connexion: {e}")
    print()

    # Test en anglais
    print("2. Test en anglais (?lang=en):")
    try:
        response = requests.get(f"{base_url}/test_translations?lang=en")
        if response.status_code == 200:
            data = response.json()
            print(f"   ✓ Locale détectée: {data['current_locale']}")
            print("   ✓ Traductions:")
            for key, value in data['test_strings'].items():
                print(f"      {key}: '{value}'")
        else:
            print(f"   ✗ Erreur HTTP: {response.status_code}")
    except Exception as e:
        print(f"   ✗ Erreur de connexion: {e}")
    print()

    # Test de la page principale
    print("3. Test de la page principale en anglais:")
    try:
        response = requests.get(f"{base_url}/?lang=en")
        if response.status_code == 200:
            # Chercher le titre
            import re
            title_match = re.search(r'<title>(.*?)</title>', response.text, re.IGNORECASE)
            if title_match:
                title = title_match.group(1).strip()
                print(f"   ✓ Titre trouvé: '{title}'")
                if "My Geocaching Map" in title:
                    print("   ✓ Le titre est correctement traduit en anglais !")
                else:
                    print("   ⚠ Le titre n'est pas en anglais")
            else:
                print("   ✗ Aucun titre trouvé")

            # Chercher les onglets
            tabs = re.findall(r'<li[^>]*class="tab[^"]*">.*?<a[^>]*>([^<]*)</a>.*?</li>', response.text, re.DOTALL)
            if tabs:
                print("   ✓ Onglets trouvés:")
                for tab in tabs:
                    tab_clean = re.sub(r'<[^>]+>', '', tab).strip()
                    if tab_clean:
                        print(f"      - '{tab_clean}'")
        else:
            print(f"   ✗ Erreur HTTP: {response.status_code}")
    except Exception as e:
        print(f"   ✗ Erreur de connexion: {e}")

if __name__ == "__main__":
    test_translations()
