# claude-code-eco A/B benchmark - a thin wrapper over benchmarks/bench.mjs.
#
# Usage
#   .\benchmarks\run.ps1 -Task "your task here" [-Skill eco] [-Model sonnet]
#                        [-MaxTurns 8] [-ShowAnswers] [-WhatIf] [bench flags...]
#
#   Anything this script does not recognise is forwarded to bench.mjs verbatim,
#   so --n, --rubric, --fixture, --skill-dir, --effort, --budget, --dry-run and
#   --tag all work here (node benchmarks/bench.mjs --help lists them).
#
#   -WhatIf (alias -PrintCommand) prints the exact node argv this would run and
#   exits without spending anything.
#
# Why a wrapper and not an implementation: bench.mjs is the one place that knows
# how to check the CLI is installed, preflight that /<skill> actually resolves,
# write every raw run to disk before parsing it, reject broken runs and compute
# the statistics. The previous version of this file reimplemented a slice of that
# and reported "0% savings" when the skill was not installed at all.
#
# This file must stay pure ASCII. It has no BOM, so Windows PowerShell 5.1 reads
# it as ANSI; a single non-ASCII character (an em-dash, once) turns into bytes
# that close a string early and the whole script stops parsing.

param(
  # Not Mandatory on purpose: a mandatory parameter makes PowerShell prompt, and
  # a prompt in a CI job or a piped session hangs instead of failing.
  [Parameter(Position = 0)][string]$Task = "",
  [string]$Skill = "eco",
  [string]$Model = "",
  [int]$MaxTurns = 8,
  [switch]$ShowAnswers,
  [Alias("PrintCommand")][switch]$WhatIf,
  [switch]$Help,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Extra
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  Write-Host "claude-code-eco A/B benchmark (wrapper over benchmarks/bench.mjs)"
  Write-Host ""
  Write-Host "Usage"
  Write-Host "  .\benchmarks\run.ps1 -Task ""your task here"" [-Skill eco] [-Model sonnet]"
  Write-Host "                       [-MaxTurns 8] [-ShowAnswers] [-WhatIf] [bench flags...]"
  Write-Host ""
  Write-Host "Anything this script does not recognise is forwarded to bench.mjs verbatim:"
  Write-Host "  --n, --rubric, --fixture, --skill-dir, --effort, --budget, --dry-run, --tag ..."
  Write-Host "  (node benchmarks/bench.mjs --help lists them all)"
  Write-Host ""
  Write-Host "  -WhatIf         print the exact node argv this would run, then exit"
  Write-Host "  -ShowAnswers    after the run, print each arm's answer from the raw JSON"
  Write-Host ""
  Write-Host "Results, including every raw run JSON, are written under benchmarks\results\<tag>."
}

# ECO_BENCH_SCRIPT: driver override. benchmarks/test/wrappers.test.mjs points it
# at an argv printer to test argument handling without spending money.
$bench = if ($env:ECO_BENCH_SCRIPT) { $env:ECO_BENCH_SCRIPT } else { Join-Path $PSScriptRoot "bench.mjs" }

<#
Windows PowerShell 5.1 builds the command line for a native program itself, and
it does it wrongly: it strips embedded double quotes and lets a trailing
backslash escape its own closing quote, which swallows every later argument.
Measured on 5.1.26100.8655, passing 'say "hi" to me' and 'path C:\tmp\':

  naive & node @args  ->  [4] "say hi to me"
                          [6] "path C:\\tmp\" --max-turns 8"

So this script quotes each argument by the rules the C runtime actually parses
and hands CreateProcess one command line it built itself. Same inputs, verified:

  [4] "say \"hi\" to me"   [6] "path C:\\tmp\\"
#>
function ConvertTo-NativeArg([string]$Value) {
  if ($Value -eq "") { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  # Double the backslashes that precede a quote, then escape the quote; double a
  # run of trailing backslashes so it cannot escape the closing quote.
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArg $_ }) -join " ")
  $psi.UseShellExecute = $false
  # Inherit the console: the driver's progress output must stream, not buffer.
  $psi.WorkingDirectory = (Get-Location).ProviderPath
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
  } catch {
    Write-Host ("run.ps1: could not start " + $FilePath + " - " + $_.Exception.Message) -ForegroundColor Red
    exit 127
  }
  $proc.WaitForExit()
  return $proc.ExitCode
}

if ($Help) {
  Show-Usage
  exit 0
}
if ($Task -eq "") {
  Show-Usage
  exit 2
}
if ($MaxTurns -lt 1) {
  Write-Host "run.ps1: -MaxTurns must be a positive integer" -ForegroundColor Red
  exit 2
}

$extras = @()
# @($null) is a one-element array in PowerShell, and powershell.exe -File can
# deliver an empty trailing argument: neither is a flag worth forwarding.
if ($Extra) { $extras = @($Extra | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }

# Name the result directory here rather than letting bench.mjs derive one, so
# -ShowAnswers can find the raw JSON this run just wrote. A --tag the caller
# passed through wins, because bench.mjs takes the last value it is given.
$tag = ""
for ($i = 0; $i -lt $extras.Count; $i++) {
  if ($extras[$i] -eq "--tag" -and ($i + 1) -lt $extras.Count) { $tag = $extras[$i + 1] }
}
if ($tag -eq "") {
  $tag = "ab-" + [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
  $extras += @("--tag", $tag)
}

$benchArgs = @($bench, "ab", "--task", $Task, "--skill", $Skill, "--max-turns", "$MaxTurns")
if ($Model -ne "") { $benchArgs += @("--model", $Model) }
if ($extras.Count -gt 0) { $benchArgs += $extras }

$node = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = "node"
if ($node -and $node.Source -and $node.Source.ToLower().EndsWith(".exe")) { $nodeExe = $node.Source }

if ($WhatIf) {
  Write-Output $nodeExe
  foreach ($a in $benchArgs) { Write-Output $a }
  exit 0
}

if (-not $node) {
  Write-Host "run.ps1: node is required but was not found on PATH - install Node.js 24+ (see package.json engines) from https://nodejs.org" -ForegroundColor Red
  exit 127
}
if (-not (Test-Path -LiteralPath $bench)) {
  Write-Host ("run.ps1: benchmark driver not found: " + $bench) -ForegroundColor Red
  exit 2
}

$status = Invoke-Native $nodeExe $benchArgs

if ($ShowAnswers) {
  $rawDir = Join-Path (Join-Path (Join-Path $PSScriptRoot "results") $tag) "raw"
  if (Test-Path -LiteralPath $rawDir) {
    foreach ($file in (Get-ChildItem -LiteralPath $rawDir -Filter *.json | Sort-Object Name)) {
      # -Encoding UTF8 is required: PS 5.1's Get-Content assumes the ANSI code
      # page for a BOM-less file, and every answer with a dash in it comes back
      # as mojibake.
      $run = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      $answer = if ($run.result -is [string]) { $run.result } else { "(this run recorded no result text)" }
      Write-Host ""
      Write-Host ("--- " + $file.BaseName + " ---")
      Write-Host $answer
    }
  } else {
    Write-Host ("run.ps1: no raw runs under " + $rawDir + " - nothing to show") -ForegroundColor Yellow
  }
}

exit $status
