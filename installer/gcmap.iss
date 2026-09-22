; Installeur Windows de GCMap (Inno Setup 6).
;
;   iscc /DAppVersion=1.0.0 installer\gcmap.iss
;
; Prérequis : dist\GCMap\ construit par PyInstaller (installer\build.ps1 fait
; les deux). Produit dist\GCMap-Setup-<version>.exe.
;
; Installation par utilisateur (%LOCALAPPDATA%\Programs\GCMap), sans droits
; administrateur ; l'assistant propose l'installation pour tous si on le
; souhaite. Les données (base, vidéos, préférences) ne sont pas dans le
; dossier d'installation : mise à jour et désinstallation les conservent.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "GCMap"
#define AppExe "GCMap.exe"

[Setup]
; Identifiant permanent : ne jamais le changer, c'est lui qui fait reconnaître
; une installation existante lors d'une mise à jour.
AppId={{B86CA1D8-794D-4C01-AF22-6586C84257C5}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
SetupIconFile=gcmap.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; Ferme GCMap s'il tourne pendant une mise à jour (fichiers verrouillés).
CloseApplications=force
RestartApplications=no

[Languages]
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Mise à jour : on repart d'un dossier de bibliothèques propre. Un module
; retiré dans la nouvelle version ne doit pas rester chargé depuis l'ancienne.
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "..\dist\GCMap\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; GCMap tourne en arrière-plan (icône de notification) : on l'arrête avant de
; supprimer ses fichiers.
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#AppExe} /F"; Flags: runhidden; RunOnceId: "StopGCMap"
