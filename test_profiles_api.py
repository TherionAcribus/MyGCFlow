#!/usr/bin/env python3
"""
Script de test pour vérifier le fonctionnement de l'API des profils
Utilisation: python test_profiles_api.py
"""

import requests
import json
import time

BASE_URL = "http://127.0.0.1:5000"

def test_api():
    """Test des endpoints de l'API profils"""
    print("=== Test de l'API Profils ===\n")

    # Test 1: Lister les profils
    print("1. Liste des profils existants:")
    try:
        response = requests.get(f"{BASE_URL}/api/profiles")
        if response.status_code == 200:
            profiles = response.json()
            print(f"   ✓ {len(profiles)} profils trouvés: {profiles}")
        else:
            print(f"   ✗ Erreur {response.status_code}: {response.text}")
    except Exception as e:
        print(f"   ✗ Erreur de connexion: {e}")
        return

    # Test 2: Créer un profil de test
    print("\n2. Création d'un profil de test:")
    test_profile = {
        "name": "Test_Profile",
        "base": None
    }
    try:
        response = requests.post(f"{BASE_URL}/api/profiles", json=test_profile)
        if response.status_code == 200:
            result = response.json()
            print(f"   ✓ Profil créé: {result}")
        else:
            print(f"   ✗ Erreur {response.status_code}: {response.text}")
    except Exception as e:
        print(f"   ✗ Erreur: {e}")

    # Attendre un peu
    time.sleep(0.5)

    # Test 3: Récupérer le profil créé
    print("\n3. Récupération du profil Test_Profile:")
    try:
        response = requests.get(f"{BASE_URL}/api/profiles/Test_Profile")
        if response.status_code == 200:
            profile = response.json()
            print(f"   ✓ Profil récupéré: {json.dumps(profile, indent=2)}")
        else:
            print(f"   ✗ Erreur {response.status_code}: {response.text}")
    except Exception as e:
        print(f"   ✗ Erreur: {e}")

    # Test 4: Sauvegarder des modifications
    print("\n4. Sauvegarde de modifications:")
    updated_profile = {
        "name": "Test_Profile",
        "map": {
            "tile_provider": "OpenStreetMap",
            "default_center": [2.0, 45.0],  # [longitude, latitude]
            "default_zoom": 8
        },
        "animation": {
            "enabled": False,
            "speed": 0.5
        },
        "points": {
            "size": 12,
            "color": "#00ff00",
            "shape": "triangle",
            "halo": True
        }
    }
    try:
        response = requests.put(f"{BASE_URL}/api/profiles/Test_Profile", json=updated_profile)
        if response.status_code == 200:
            print("   ✓ Modifications sauvegardées")
        else:
            print(f"   ✗ Erreur {response.status_code}: {response.text}")
    except Exception as e:
        print(f"   ✗ Erreur: {e}")

    # Test 5: Dupliquer le profil
    print("\n5. Duplication du profil:")
    try:
        response = requests.post(f"{BASE_URL}/api/profiles/Test_Profile/duplicate", json={"new_name": "Test_Profile_Copy"})
        if response.status_code == 200:
            result = response.json()
            print(f"   ✓ Profil dupliqué: {result}")
        else:
            print(f"   ✗ Erreur {response.status_code}: {response.text}")
    except Exception as e:
        print(f"   ✗ Erreur: {e}")

    # Test 6: Lister à nouveau pour voir les changements
    print("\n6. Liste mise à jour des profils:")
    try:
        response = requests.get(f"{BASE_URL}/api/profiles")
        if response.status_code == 200:
            profiles = response.json()
            print(f"   ✓ {len(profiles)} profils: {profiles}")
        else:
            print(f"   ✗ Erreur {response.status_code}: {response.text}")
    except Exception as e:
        print(f"   ✗ Erreur: {e}")

    # Test 7: Supprimer le profil de test
    print("\n7. Suppression du profil Test_Profile:")
    try:
        response = requests.delete(f"{BASE_URL}/api/profiles/Test_Profile")
        if response.status_code == 200:
            print("   ✓ Profil Test_Profile supprimé")
        else:
            print(f"   ✗ Erreur {response.status_code}: {response.text}")
    except Exception as e:
        print(f"   ✗ Erreur: {e}")

    # Test 8: Supprimer la copie
    print("\n8. Suppression du profil Test_Profile_Copy:")
    try:
        response = requests.delete(f"{BASE_URL}/api/profiles/Test_Profile_Copy")
        if response.status_code == 200:
            print("   ✓ Profil Test_Profile_Copy supprimé")
        else:
            print(f"   ✗ Erreur {response.status_code}: {response.text}")
    except Exception as e:
        print(f"   ✗ Erreur: {e}")

    print("\n=== Tests terminés ===")

if __name__ == "__main__":
    print("Assurez-vous que l'application MyGCFlow est démarrée sur http://127.0.0.1:5000")
    print("Puis lancez ce script pour tester l'API des profils.\n")

    try:
        test_api()
    except KeyboardInterrupt:
        print("\nTest interrompu par l'utilisateur")
    except Exception as e:
        print(f"\nErreur inattendue: {e}")
