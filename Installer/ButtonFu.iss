; ButtonFu Installer Script
; Inno Setup 6.x

#define MyAppName "ButtonFu"
#ifndef MyAppVersion
  #define MyAppVersion "1.1.2"
#endif
#define MyAppPublisher "NullCity"
#ifndef MyAppURL
  #define MyAppURL "https://github.com/NullCitySoftware/buttonfu"
#endif
#ifndef MyVsixFileName
  #define MyVsixFileName "buttonfu-" + MyAppVersion + ".vsix"
#endif

[Setup]
; NOTE: The value of AppId uniquely identifies this application.
AppId={{D4A2E8F1-7B3C-4D5E-A9F0-1C2B3D4E5F6A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
LicenseFile=License.rtf
OutputDir=..\bin\publish
OutputBaseFilename=ButtonFu_{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Components]
Name: "extension"; Description: "ButtonFu VS Code Extension"; Types: full compact custom; Flags: fixed

[Files]
; VS Code extension VSIX - copy to app folder so it persists and is accessible
Source: "staging\extension\{#MyVsixFileName}"; DestDir: "{app}"; Flags: ignoreversion; Components: extension

[Icons]
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; Install VS Code extension - runasoriginaluser is crucial for per-user VS Code installations
Filename: "{localappdata}\Programs\Microsoft VS Code\bin\code.cmd"; Parameters: "--install-extension ""{app}\{#MyVsixFileName}"" --force"; StatusMsg: "Installing VS Code extension..."; Flags: runhidden runasoriginaluser; Components: extension; Check: VSCodeUserInstallExists
Filename: "{autopf}\Microsoft VS Code\bin\code.cmd"; Parameters: "--install-extension ""{app}\{#MyVsixFileName}"" --force"; StatusMsg: "Installing VS Code extension..."; Flags: runhidden runasoriginaluser; Components: extension; Check: VSCodeSystemInstallExists

[Code]
var
  LogFile: String;

procedure WriteLog(Msg: String);
var
  S: String;
begin
  S := GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + ' - ' + Msg;
  SaveStringToFile(LogFile, S + #13#10, True);
end;

function VSCodeUserInstallExists(): Boolean;
var
  CodePath: String;
begin
  CodePath := ExpandConstant('{localappdata}\Programs\Microsoft VS Code\bin\code.cmd');
  Result := FileExists(CodePath);
  WriteLog('Checking VS Code user install: ' + CodePath + ' - ' + IntToStr(Ord(Result)));
end;

function VSCodeSystemInstallExists(): Boolean;
var
  CodePath: String;
begin
  // Only check system install if user install doesn't exist
  if VSCodeUserInstallExists() then
  begin
    Result := False;
    Exit;
  end;
  CodePath := ExpandConstant('{autopf}\Microsoft VS Code\bin\code.cmd');
  Result := FileExists(CodePath);
  WriteLog('Checking VS Code system install: ' + CodePath + ' - ' + IntToStr(Ord(Result)));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
end;

procedure InitializeWizard;
begin
  LogFile := ExpandConstant('{tmp}\ButtonFu_Install.log');
  WriteLog('=== ButtonFu Installer Started ===');
  WriteLog('Temp directory: ' + ExpandConstant('{tmp}'));
end;
