# claude-eco A/B benchmark harness (Windows PowerShell 5.1 compatible)
# Runs the same task with and without the skill, sequentially, and prints a comparison.
# Usage: .\benchmarks\run.ps1 -Task "your task here" [-Skill eco] [-Model claude-fable-5] [-MaxTurns 8] [-ShowAnswers]

param(
  [Parameter(Mandatory = $true)][string]$Task,
  [string]$Skill = "eco",
  [string]$Model = "",
  [int]$MaxTurns = 8,
  [switch]$ShowAnswers
)

function Invoke-Arm([string]$Prompt) {
  $cliArgs = @("-p", $Prompt, "--output-format", "json", "--max-turns", "$MaxTurns")
  if ($Model -ne "") { $cliArgs += @("--model", $Model) }
  $raw = & claude @cliArgs
  if (-not $raw) { throw "claude returned no output — is Claude Code installed and authenticated?" }
  return ($raw | ConvertFrom-Json)
}

Write-Host "[1/2] Baseline arm (no skill)..." -ForegroundColor Cyan
$base = Invoke-Arm $Task
Write-Host "[2/2] Skill arm (/$Skill)..." -ForegroundColor Cyan
$armed = Invoke-Arm "/$Skill $Task"

$bOut = $base.usage.output_tokens
$sOut = $armed.usage.output_tokens
$pct = 0
if ($bOut -gt 0) { $pct = [math]::Round(100 * ($bOut - $sOut) / $bOut, 1) }

Write-Host ""
Write-Host ("{0,-22} {1,14} {2,14}" -f "Metric", "Baseline", "/$Skill")
Write-Host ("{0,-22} {1,14} {2,14}" -f "Output tokens", $bOut, $sOut)
Write-Host ("{0,-22} {1,14:N4} {2,14:N4}" -f "Cost (USD)", $base.total_cost_usd, $armed.total_cost_usd)
Write-Host ("{0,-22} {1,14:N1} {2,14:N1}" -f "Duration (s)", ($base.duration_ms / 1000), ($armed.duration_ms / 1000))
Write-Host ("{0,-22} {1,14} {2,14}" -f "Turns", $base.num_turns, $armed.num_turns)
Write-Host ""
Write-Host ("Output-token savings: {0}%" -f $pct) -ForegroundColor Green

if ($ShowAnswers) {
  Write-Host "`n--- Baseline answer ---`n$($base.result)"
  Write-Host "`n--- Skill answer ---`n$($armed.result)"
}
