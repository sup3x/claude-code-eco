#!/usr/bin/env bash
# claude-code-eco A/B benchmark - a thin wrapper over benchmarks/bench.mjs.
#
# Why a wrapper and not an implementation: bench.mjs is the one place that knows
# how to check the CLI is installed, preflight that /<skill> actually resolves,
# write every raw run to disk before parsing it, reject broken runs and compute
# the statistics. The previous version of this file reimplemented a slice of that
# in jq and printed "0% savings" when the skill was not installed at all - two
# implementations of one measurement is how a benchmark starts lying.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ECO_BENCH_SCRIPT: driver override. benchmarks/test/wrappers.test.mjs points it
# at an argv printer to test argument handling without spending money.
BENCH="${ECO_BENCH_SCRIPT:-$SCRIPT_DIR/bench.mjs}"

# Git Bash rewrites an argument that looks like a POSIX path - "/eco fix the bug"
# becomes "C:/Program Files/Git/eco fix the bug" - before a native program such
# as node.exe ever sees it. That mangling silently changes the measured prompt,
# so opt every argument out of the conversion.
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

# ...which means the paths this script passes to node.exe are no longer converted
# either, and node.exe cannot open "/c/Users/...". Translate ours explicitly.
to_native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

usage() {
  cat <<'EOF'
claude-code-eco A/B benchmark (wrapper over benchmarks/bench.mjs)

Usage
  ./benchmarks/run.sh "your task here" [skill] [model] [max-turns] [bench flags...]
  ./benchmarks/run.sh "your task here" --n 5 --rubric orders-review
  ./benchmarks/run.sh "your task here" --print-command    print the argv, run nothing
  ./benchmarks/run.sh --help

Positionals (defaults: skill=eco, model=session default, max-turns=8)
  The first four bare words are task, skill, model and max-turns. From the first
  flag onwards, every argument is forwarded to bench.mjs verbatim, so anything
  bench.mjs accepts works here: --n, --rubric, --fixture, --skill-dir, --budget,
  --effort, --dry-run, --tag ... (node benchmarks/bench.mjs --help lists them).

Wrapper flags (consumed here, never forwarded)
  --print-command   print the exact node argv this would run, then exit
  --show-answers    after the run, print each arm's answer from the raw JSON
  --help            this text

Results, including every raw run JSON, are written under benchmarks/results/<tag>.
EOF
}

die() {
  echo "run.sh: $1" >&2
  exit 2
}

TASK=""
SKILL=""
MODEL=""
MAX_TURNS=""
TAG=""
PRINT_ONLY=0
SHOW_ANSWERS=0
POS=0
SEEN_FLAG=0
EXPECT_TAG=0
PASS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --print-command)
      PRINT_ONLY=1
      ;;
    --show-answers)
      SHOW_ANSWERS=1
      ;;
    --)
      shift
      SEEN_FLAG=1
      while [ $# -gt 0 ]; do
        PASS+=("$1")
        shift
      done
      break
      ;;
    -*)
      SEEN_FLAG=1
      if [ "$1" = "--tag" ]; then EXPECT_TAG=1; fi
      PASS+=("$1")
      ;;
    *)
      if [ "$SEEN_FLAG" -eq 1 ]; then
        # A bare word after a flag is that flag's value: forward it untouched.
        if [ "$EXPECT_TAG" -eq 1 ]; then
          TAG="$1"
          EXPECT_TAG=0
        fi
        PASS+=("$1")
      else
        POS=$((POS + 1))
        case "$POS" in
          1) TASK="$1" ;;
          2) SKILL="$1" ;;
          3) MODEL="$1" ;;
          4) MAX_TURNS="$1" ;;
          *) die "unexpected 5th positional \"$1\" - usage: run.sh \"task\" [skill] [model] [max-turns]" ;;
        esac
      fi
      ;;
  esac
  shift
done

if [ -z "$TASK" ]; then
  usage >&2
  exit 2
fi
SKILL="${SKILL:-eco}"
MAX_TURNS="${MAX_TURNS:-8}"
case "$MAX_TURNS" in
  '' | *[!0-9]* | 0 | 0*) die "max-turns must be a positive integer (got \"$MAX_TURNS\")" ;;
esac

# Name the result directory here rather than letting bench.mjs derive one, so
# --show-answers can find the raw JSON this run just wrote.
if [ -z "$TAG" ]; then
  TAG="ab-$(date -u +%Y%m%d-%H%M%S)"
  PASS+=("--tag" "$TAG")
fi

ARGS=(ab --task "$TASK" --skill "$SKILL" --max-turns "$MAX_TURNS")
if [ -n "$MODEL" ]; then
  ARGS+=(--model "$MODEL")
fi
# ${arr[@]+"${arr[@]}"} keeps `set -u` quiet about an empty array on bash 3.2 (macOS).
CMD=(node "$(to_native "$BENCH")" "${ARGS[@]}" ${PASS[@]+"${PASS[@]}"})

if [ "$PRINT_ONLY" -eq 1 ]; then
  printf '%s\n' "${CMD[@]}"
  exit 0
fi

command -v node >/dev/null 2>&1 ||
  die "node is required but was not found on PATH - install Node.js 24+ (see package.json engines) from https://nodejs.org"
[ -f "$BENCH" ] || die "benchmark driver not found: $BENCH"

set +e
"${CMD[@]}"
STATUS=$?
set -e

RAW_DIR="$SCRIPT_DIR/results/$TAG/raw"
if [ "$SHOW_ANSWERS" -eq 1 ]; then
  if [ -d "$RAW_DIR" ]; then
    ECO_RAW_DIR="$(to_native "$RAW_DIR")" node -e 'const {readdirSync,readFileSync}=require("node:fs");const {join}=require("node:path");const d=process.env.ECO_RAW_DIR;for(const f of readdirSync(d).filter((x)=>x.endsWith(".json")).sort()){const r=JSON.parse(readFileSync(join(d,f),"utf8").replace(/^\uFEFF/,""));console.log("\n--- "+f.replace(/\.json$/,"")+" ---\n"+(typeof r.result==="string"?r.result:"(this run recorded no result text)"));}'
  else
    echo "run.sh: no raw runs under $RAW_DIR - nothing to show" >&2
  fi
fi

exit "$STATUS"
