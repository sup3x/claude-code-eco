# Installs (or removes) the eco skills for Claude Code: /eco, /eco-max, /eco-audit, /eco-report.
#
# Usage
#   .\install.ps1              install into $env:CLAUDE_SKILLS_DIR, or
#                              %USERPROFILE%\.claude\skills when that is unset
#   .\install.ps1 -Uninstall   remove the two skill directories this project installs
#   .\install.ps1 -Help
#
# The old version copied over whatever was there, so a skill you had edited was
# gone without a trace and files removed from a newer release stayed behind for
# ever. This one moves the existing copy to a timestamped backup first - which
# also clears stale files, because the destination is recreated, not merged - and
# then verifies every installed file by SHA256 against the source.
#
# Backups live in <parent of the skills dir>\.eco-backups, deliberately outside
# the skills directory: a copy named "eco-20260101-000000" sitting next to the
# real one would still say `name: eco` in its frontmatter, and the CLI would see
# two skills claiming one name.
#
# This file must stay pure ASCII. It has no BOM, so Windows PowerShell 5.1 reads
# it as ANSI; a single non-ASCII character (an em-dash, once) turns into bytes
# that close a string early and the whole script stops parsing.

param(
  [switch]$Uninstall,
  [switch]$Help,
  # PowerShell binds "--uninstall" (the form install.sh documents) here rather
  # than to -Uninstall, and would otherwise ignore it and install instead.
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = "Stop"

$SkillNames = @("eco", "eco-max", "eco-audit", "eco-report")

# Two skills are backed by a Node script. A plugin install reaches it through
# ${CLAUDE_PLUGIN_ROOT}; a personal install has no such variable, so the script
# is staged next to its SKILL.md and the skill body falls back to that sibling.
$SkillScripts = @{ "eco-audit" = "audit.mjs"; "eco-report" = "report.mjs" }
$SrcRoot = Join-Path $PSScriptRoot "skills"
$Stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")

function Show-Usage {
  Write-Host "Installs (or removes) the eco skills for Claude Code: /eco, /eco-max, /eco-audit, /eco-report."
  Write-Host ""
  Write-Host "Usage"
  Write-Host "  .\install.ps1              install into `$env:CLAUDE_SKILLS_DIR, or"
  Write-Host "                             %USERPROFILE%\.claude\skills when that is unset"
  Write-Host "  .\install.ps1 -Uninstall   remove the two skill directories this project installs"
  Write-Host "  .\install.ps1 -Help"
  Write-Host ""
  Write-Host "An existing copy is moved to <parent of the skills dir>\.eco-backups\<name>-<utc stamp>"
  Write-Host "before anything is written, and the installed files are verified against the source."
}

function Stop-WithError([string]$Message) {
  Write-Host ("install.ps1: " + $Message) -ForegroundColor Red
  exit 2
}

# Relative paths (a relative CLAUDE_SKILLS_DIR) have no parent to hang the backup
# directory on, so everything below works on absolute paths.
function Resolve-AbsolutePath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
}

function Get-RelativeFileList([string]$Root) {
  $prefix = $Root.TrimEnd("\", "/").Length + 1
  return @(Get-ChildItem -LiteralPath $Root -Recurse -File |
      ForEach-Object { $_.FullName.Substring($prefix) } |
      Sort-Object)
}

# Same file list, same bytes - the check that answers both "is it already
# installed?" and "did the copy land intact?".
function Test-TreesMatch([string]$A, [string]$B) {
  if (-not (Test-Path -LiteralPath $A -PathType Container)) { return $false }
  if (-not (Test-Path -LiteralPath $B -PathType Container)) { return $false }
  $listA = Get-RelativeFileList $A
  $listB = Get-RelativeFileList $B
  if ($listA.Count -ne $listB.Count) { return $false }
  for ($i = 0; $i -lt $listA.Count; $i++) {
    if ($listA[$i] -ne $listB[$i]) { return $false }
  }
  foreach ($rel in $listA) {
    $hashA = (Get-FileHash -LiteralPath (Join-Path $A $rel) -Algorithm SHA256).Hash
    $hashB = (Get-FileHash -LiteralPath (Join-Path $B $rel) -Algorithm SHA256).Hash
    if ($hashA -ne $hashB) { return $false }
  }
  return $true
}

function Move-ToBackup([string]$Path, [string]$Name, [string]$BackupRoot) {
  $target = Join-Path $BackupRoot ($Name + "-" + $Stamp)
  $n = 1
  # Two runs inside the same second must not nest one backup inside the other.
  while (Test-Path -LiteralPath $target) {
    $target = Join-Path $BackupRoot ($Name + "-" + $Stamp + "-" + $n)
    $n++
  }
  New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
  Move-Item -LiteralPath $Path -Destination $target
  return $target
}

function Get-FileCount([string]$Root) {
  return @(Get-ChildItem -LiteralPath $Root -Recurse -File).Count
}

if ($Rest) {
  foreach ($arg in $Rest) {
    # @($null) is a one-element array in PowerShell, and powershell.exe -File can
    # deliver an empty trailing argument: an empty string is not an instruction.
    if ([string]::IsNullOrWhiteSpace($arg)) { continue }
    if ($arg -match '^--?uninstall$') {
      $Uninstall = $true
    } elseif ($arg -match '^(--?help|-h|/\?)$') {
      $Help = $true
    } else {
      Stop-WithError ("unknown argument """ + $arg + """ (try -Help)")
    }
  }
}

if ($Help) {
  Show-Usage
  exit 0
}

if ($env:CLAUDE_SKILLS_DIR) {
  $dest = Resolve-AbsolutePath $env:CLAUDE_SKILLS_DIR
  $origin = "CLAUDE_SKILLS_DIR"
} elseif ($env:USERPROFILE) {
  $dest = Join-Path (Join-Path $env:USERPROFILE ".claude") "skills"
  $origin = "default"
} else {
  Stop-WithError "neither CLAUDE_SKILLS_DIR nor USERPROFILE is set - point CLAUDE_SKILLS_DIR at your skills directory"
}
$backupRoot = Join-Path (Split-Path -Parent $dest) ".eco-backups"

Write-Host "claude-code-eco skills"
Write-Host ("  source:     " + $SrcRoot)
Write-Host ("  skills dir: " + $dest + " (" + $origin + ")")

if ($Uninstall) {
  $removed = 0
  foreach ($name in $SkillNames) {
    $dst = Join-Path $dest $name
    if (Test-Path -LiteralPath $dst) {
      $target = Move-ToBackup $dst $name $backupRoot
      Write-Host ("  " + $name + ": removed (copy kept at " + $target + ")")
      $removed++
    } else {
      Write-Host ("  " + $name + ": not installed, nothing to remove")
    }
  }
  Write-Host ("Removed " + $removed + " of " + $SkillNames.Count + " skill directories from " + $dest + ".")
  exit 0
}

foreach ($name in $SkillNames) {
  $skillFile = Join-Path (Join-Path $SrcRoot $name) "SKILL.md"
  if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
    Stop-WithError ("missing source skill: " + $skillFile + " - run this from a full clone of the repository")
  }
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
# Stage each skill (plus its helper script, if it has one) so that what gets
# compared and verified is exactly what will be installed.
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ("eco-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
try {
$changed = 0
foreach ($name in $SkillNames) {
  $src = Join-Path $stageRoot $name
  Copy-Item -LiteralPath (Join-Path $SrcRoot $name) -Destination $src -Recurse
  if ($SkillScripts.ContainsKey($name)) {
    $helper = Join-Path (Join-Path (Split-Path -Parent $SrcRoot) "scripts") $SkillScripts[$name]
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
      Stop-WithError ("missing helper script: " + $helper)
    }
    Copy-Item -LiteralPath $helper -Destination (Join-Path $src $SkillScripts[$name])
  }
  $dst = Join-Path $dest $name
  if (Test-TreesMatch $src $dst) {
    Write-Host ("  " + $name + ": already up to date (" + (Get-FileCount $dst) + " files)")
    continue
  }
  if (Test-Path -LiteralPath $dst) {
    $target = Move-ToBackup $dst $name $backupRoot
    Write-Host ("  " + $name + ": previous copy backed up to " + $target)
  }
  Copy-Item -LiteralPath $src -Destination $dst -Recurse
  if (-not (Test-TreesMatch $src $dst)) {
    Stop-WithError ("copy verification failed: " + $dst + " does not match " + $src)
  }
  Write-Host ("  " + $name + ": installed and verified (" + (Get-FileCount $dst) + " files)")
  $changed++
}

if ($changed -eq 0) {
  Write-Host ("Nothing to do - all " + $SkillNames.Count + " skills were already current.")
} else {
  Write-Host ("Installed " + $changed + " of " + $SkillNames.Count + " skills to " + $dest + ".")
}
} finally {
  Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Open a Claude Code session and type /eco to activate."
exit 0
