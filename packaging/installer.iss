; Inno Setup script for AI Data Conversion Studio.
; Wraps the PyInstaller one-file exe in a proper Windows installer that:
;   - installs per-user (no admin rights needed),
;   - asks for the Anthropic API key + model DURING installation,
;   - writes them to %LOCALAPPDATA%\AI Data Conversion Studio\.env so the app
;     skips its first-run wizard (leave the key blank to be asked in-app instead),
;   - adds Start Menu / optional desktop shortcuts and an uninstaller.
;
; Build: run packaging\build.ps1 (it invokes ISCC.exe if Inno Setup is installed),
; or open this file in the Inno Setup Compiler after building the exe.

#define AppName "AI Data Conversion Studio"
#define AppVersion "1.0.0"
#define AppExe "AI Data Conversion Studio.exe"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=AI Data Conversion Studio
DefaultDirName={localappdata}\Programs\AI Data Conversion Studio
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=installer_output
OutputBaseFilename=AIMS-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Optional: set an icon shown in Add/Remove Programs if you ship assets\app.ico
; SetupIconFile=..\assets\app.ico

[Files]
Source: "dist\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
var
  KeyPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  KeyPage := CreateInputQueryPage(wpSelectDir,
    'Claude API key',
    'Connect the app to Anthropic',
    'Enter your Anthropic (Claude) API key so the app is ready to use on first launch.' + #13#10 +
    'Get a key at https://console.anthropic.com/settings/keys.' + #13#10 +
    'You can leave this blank and enter it in the app later.');
  { index 0 = API key (masked), index 1 = model }
  KeyPage.Add('Anthropic API key (starts with sk-ant-):', True);
  KeyPage.Add('Model:', False);
  KeyPage.Values[1] := 'claude-sonnet-5';
end;

{ Write %LOCALAPPDATA%\AI Data Conversion Studio\.env after files are installed,
  so the running app (which reads the same path) picks up the key with no wizard. }
procedure WriteEnvFile;
var
  Dir, Path, Content, ApiKey, Model: string;
begin
  ApiKey := Trim(KeyPage.Values[0]);
  if ApiKey = '' then
    Exit;  { no key entered -> the app shows its own first-run wizard }

  Model := Trim(KeyPage.Values[1]);
  if Model = '' then
    Model := 'claude-sonnet-5';

  Dir := ExpandConstant('{localappdata}\AI Data Conversion Studio');
  ForceDirectories(Dir);
  Path := Dir + '\.env';

  Content :=
    '# AI Data Conversion Studio config — written by the installer.' + #13#10 +
    '# Holds your Claude API key; do not share this file.' + #13#10 +
    'ANTHROPIC_API_KEY=' + ApiKey + #13#10 +
    'AIMS_MODEL=' + Model + #13#10;

  SaveStringToFile(Path, Content, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteEnvFile;
end;
