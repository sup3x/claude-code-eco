#!/usr/bin/env bash
# claude-eco A/B benchmark harness (requires jq)
# Runs the same task with and without the skill, sequentially, and prints a comparison.
# Usage: ./benchmarks/run.sh "your task here" [skill-name] [model] [max-turns]

set -euo pipefail

TASK="${1:?Usage: run.sh \"task\" [skill] [model] [max-turns]}"
SKILL="${2:-eco}"
MODEL="${3:-}"
MAX_TURNS="${4:-8}"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

run_arm() {
  local prompt="$1"
  if [ -n "$MODEL" ]; then
    claude -p "$prompt" --output-format json --max-turns "$MAX_TURNS" --model "$MODEL"
  else
    claude -p "$prompt" --output-format json --max-turns "$MAX_TURNS"
  fi
}

echo "[1/2] Baseline arm (no skill)..."
BASE_JSON="$(run_arm "$TASK")"
echo "[2/2] Skill arm (/$SKILL)..."
SKILL_JSON="$(run_arm "/$SKILL $TASK")"

b_out=$(jq -r '.usage.output_tokens' <<<"$BASE_JSON")
s_out=$(jq -r '.usage.output_tokens' <<<"$SKILL_JSON")
b_cost=$(jq -r '.total_cost_usd' <<<"$BASE_JSON")
s_cost=$(jq -r '.total_cost_usd' <<<"$SKILL_JSON")
b_ms=$(jq -r '.duration_ms' <<<"$BASE_JSON")
s_ms=$(jq -r '.duration_ms' <<<"$SKILL_JSON")

printf "\n%-22s %14s %14s\n" "Metric" "Baseline" "/$SKILL"
printf "%-22s %14s %14s\n" "Output tokens" "$b_out" "$s_out"
printf "%-22s %14s %14s\n" "Cost (USD)" "$b_cost" "$s_cost"
printf "%-22s %14s %14s\n" "Duration (s)" "$((b_ms / 1000))" "$((s_ms / 1000))"
if [ "$b_out" -gt 0 ]; then
  printf "\nOutput-token savings: %s%%\n" "$(( (b_out - s_out) * 100 / b_out ))"
fi
