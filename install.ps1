# Installs the /eco and /eco-max skills to %USERPROFILE%\.claude\skills
$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "skills"
$dest = Join-Path $env:USERPROFILE ".claude\skills"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Recurse -Force (Join-Path $src "eco") $dest
Copy-Item -Recurse -Force (Join-Path $src "eco-max") $dest
Write-Host "Installed /eco and /eco-max to $dest"
Write-Host "Open a Claude Code session and type /eco to activate."
