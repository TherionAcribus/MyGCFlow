#!/usr/bin/env python3
"""
Script pour mettre à jour les profils existants avec le paramètre mode manquant
"""

from settings_manager import SettingsManager

def main():
    print("🔄 Mise à jour des profils existants...")
    manager = SettingsManager()
    manager.update_existing_profiles_with_mode()
    print("✅ Mise à jour terminée")

if __name__ == "__main__":
    main()
