<#
.SYNOPSIS
  Install / uninstall the discussion-tree Task Scheduler tasks for the current
  user on Windows: the broker supervisor (at logon, runs forever) and the daily
  SQLite backup.

.DESCRIPTION
  Creates two tasks (names "<TaskPrefix>-broker" and "<TaskPrefix>-backup"):

  broker: at logon of the current user, runs
            bun scripts/broker-supervisor.ts --home <DtHome> --port <Port>
          with no visible window, no execution time limit, not stopped on
          battery, Task Scheduler restart-on-failure as a second safety net
          (the supervisor itself restarts the broker), normal priority, and
          LogonType Interactive ("run only when user is logged on") so the
          user's profile and drive mappings such as the Google Drive G: drive
          are available.

  backup: daily at -BackupTime (default 11:30 local), StartWhenAvailable (runs
          on wake/logon if the scheduled time was missed), runs
            bun scripts/backup-db.ts --backup-dir <BackupDir> --home <DtHome>
          with no visible window.

  Nothing machine-specific is stored in the repository: every path is a
  parameter. Task actions cannot carry environment variables, so the home,
  port and backup dir are passed as command-line flags instead.

  HIDDEN LAUNCH: bun.exe is a console program, so a task in the interactive
  session would open a console window. We run it through
  `conhost.exe --headless <bun> ...`: the console host creates the console
  without any window, and the broker child inherits that hidden console (it is
  spawned with windowsHide). Alternatives rejected: `powershell -WindowStyle
  Hidden` still flashes a window at every start; a wscript/VBS launcher depends
  on VBScript, which Windows 11 is deprecating; "run whether user is logged on
  or not" hides the window but runs without the interactive session's drive
  mappings (G:) and needs a stored password.

  STOPPING: -Uninstall first asks the supervisor to stop through its stop file
  (`bun broker-supervisor.ts --stop`), which stops the broker cleanly; only
  then are the tasks ended and removed. Ending the task from the Task
  Scheduler UI instead kills the supervisor hard and may leave the broker
  process running (a later supervisor simply stands by while it serves).

.EXAMPLE
  # install (real)
  powershell -ExecutionPolicy Bypass -File scripts\windows\dt-tasks.ps1 `
    -BackupDir "G:\My Drive\Apps\discussion-tree\db-backups" -StartNow

.EXAMPLE
  # throwaway test install on another port / home
  powershell -ExecutionPolicy Bypass -File scripts\windows\dt-tasks.ps1 `
    -TaskPrefix dt-test -Port 17941 -DtHome "$env:TEMP\dt-test-home" `
    -BackupDir "$env:TEMP\dt-test-backups" -StartNow

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\dt-tasks.ps1 -Uninstall
  powershell -ExecutionPolicy Bypass -File scripts\windows\dt-tasks.ps1 -Uninstall -TaskPrefix dt-test -DtHome "$env:TEMP\dt-test-home"
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [string]$TaskPrefix = "discussion-tree",
  # Repo root (contains broker.ts). Default: two levels above this script.
  [string]$RepoRoot = "",
  # Path to bun.exe. Default: whatever `bun` resolves to on PATH.
  [string]$BunPath = "",
  # Required for install unless -NoBackup.
  [string]$BackupDir = "",
  # dt state dir. Default: %USERPROFILE%\.discussion-tree (same as the broker).
  # Named DtHome because $Home is a read-only PowerShell automatic variable;
  # -Home works as an alias.
  [Alias("Home")]
  [string]$DtHome = "",
  [int]$Port = 7898,
  [string]$BackupTime = "11:30",
  [switch]$NoBackup,
  [switch]$StartNow
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$brokerTask = "$TaskPrefix-broker"
$backupTask = "$TaskPrefix-backup"

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
if (-not $DtHome) { $DtHome = Join-Path $env:USERPROFILE ".discussion-tree" }

function Get-Bun {
  if ($BunPath) { return $BunPath }
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "bun not found on PATH; pass -BunPath C:\path\to\bun.exe" }
  return $cmd.Source
}

# Quote one argument for a CreateProcess command line. A trailing backslash
# before the closing quote would escape it (C:\dir\" -> C:\dir"), so trailing
# backslashes are dropped; embedded double quotes are refused outright.
function Quote-Arg([string]$s) {
  if ($s.Contains('"')) { throw "argument contains a double quote: $s" }
  $t = $s.TrimEnd('\')
  if ($t -match '^[A-Za-z]:$') { $t = "$t\." }  # keep "C:\" meaning the root
  return '"' + $t + '"'
}

function Stop-Supervisor([string]$bun) {
  $sup = Join-Path $RepoRoot "scripts\broker-supervisor.ts"
  if (-not (Test-Path $sup)) { return }
  Write-Host "Asking the broker supervisor to stop (home: $DtHome) ..."
  & $bun $sup --stop --home $DtHome
  if ($LASTEXITCODE -ne 0) { Write-Warning "supervisor did not confirm stop (exit $LASTEXITCODE); ending the task anyway" }
}

function Remove-DtTask([string]$name) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "Task $name not present"; return }
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "Removed task $name"
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($Uninstall) {
  # bun is only needed for the graceful stop; a missing bun must not block removal.
  $bunForStop = $null
  try { $bunForStop = Get-Bun } catch { Write-Warning $_ }
  if ($bunForStop) { Stop-Supervisor $bunForStop }
  Remove-DtTask $brokerTask
  Remove-DtTask $backupTask
  Write-Host "Done. Check that nothing still listens: Get-NetTCPConnection -LocalPort $Port -State Listen"
  exit 0
}

$bun = Get-Bun
if (-not (Test-Path (Join-Path $RepoRoot "broker.ts"))) { throw "broker.ts not found under -RepoRoot $RepoRoot" }
if (-not (Test-Path $bun)) { throw "bun not found at $bun" }
if (-not $NoBackup -and -not $BackupDir) { throw "-BackupDir is required (or pass -NoBackup)" }
New-Item -ItemType Directory -Force -Path $DtHome | Out-Null

$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

# ---- broker supervisor task
$supArgs = @(
  "--headless",
  (Quote-Arg $bun),
  (Quote-Arg (Join-Path $RepoRoot "scripts\broker-supervisor.ts")),
  "--home", (Quote-Arg $DtHome),
  "--port", "$Port"
) -join " "
$brokerAction = New-ScheduledTaskAction -Execute $conhost -Argument $supArgs -WorkingDirectory $RepoRoot
$brokerTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# ExecutionTimeLimit 0 = PT0S = no limit. Priority 4 = normal process priority
# (the Task Scheduler default 7 is below-normal CPU AND low I/O priority, which
# makes a server sluggish). IgnoreNew: a 2nd trigger while running is a no-op.
$brokerSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable `
  -Priority 4
Register-ScheduledTask -TaskName $brokerTask -Force `
  -Description "discussion-tree broker supervisor (keeps the broker on 127.0.0.1:$Port running). Logs: $DtHome\supervisor.log, $DtHome\broker.log" `
  -Action $brokerAction -Trigger $brokerTrigger -Settings $brokerSettings -Principal $principal | Out-Null
Write-Host "Registered $brokerTask : $conhost $supArgs"

# ---- daily backup task
if (-not $NoBackup) {
  $bkArgs = @(
    "--headless",
    (Quote-Arg $bun),
    (Quote-Arg (Join-Path $RepoRoot "scripts\backup-db.ts")),
    "--backup-dir", (Quote-Arg $BackupDir),
    "--home", (Quote-Arg $DtHome)
  ) -join " "
  $bkAction = New-ScheduledTaskAction -Execute $conhost -Argument $bkArgs -WorkingDirectory $RepoRoot
  $bkTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
  $bkSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $backupTask -Force `
    -Description "discussion-tree daily SQLite backup to $BackupDir. Status: $DtHome\backup-status.json, log: $DtHome\backup.log" `
    -Action $bkAction -Trigger $bkTrigger -Settings $bkSettings -Principal $principal | Out-Null
  Write-Host "Registered $backupTask : $conhost $bkArgs (daily $BackupTime)"
}

if ($StartNow) {
  Start-ScheduledTask -TaskName $brokerTask
  Write-Host "Started $brokerTask. Health: Invoke-RestMethod http://127.0.0.1:$Port/health"
}
