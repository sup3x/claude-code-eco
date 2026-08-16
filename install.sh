#!/usr/bin/env bash
# Installs (or removes) the /eco and /eco-max skills for Claude Code.
#
# Usage
#   ./install.sh               install into ${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}
#   ./install.sh --uninstall   remove the skill directories this project installs
#   ./install.sh --help
#
# The old version copied over whatever was there, so a skill you had edited was
# gone without a trace and files removed from a newer release stayed behind for
# ever. This one moves the existing copy to a timestamped backup first - which
# also clears stale files, because the destination is recreated, not merged - and
# then verifies every installed byte against the source.
#
# Backups live in <parent of the skills dir>/.eco-backups, deliberately outside
# the skills directory: a copy named "eco-20260101-000000" sitting next to the
# real one would still say `name: eco` in its frontmatter, and the CLI would see
# two skills claiming one name.
set -euo pipefail

SKILL_NAMES="eco eco-max eco-audit eco-report"
# Two skills are backed by a Node script. In a plugin install the skill body
# reaches it through ${CLAUDE_PLUGIN_ROOT}; a personal install has no such
# variable, so the script is copied next to its SKILL.md and the body falls back
# to that sibling. One source file, no committed duplicate.
script_for() {
  case "$1" in
    eco-audit) printf 'audit.mjs' ;;
    eco-report) printf 'report.mjs' ;;
    *) printf '' ;;
  esac
}
SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skills"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
MODE="install"

usage() {
  cat <<'EOF'
Installs (or removes) the eco skills for Claude Code:
/eco, /eco-max, /eco-audit and /eco-report.

Usage
  ./install.sh               install into ${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}
  ./install.sh --uninstall   remove the skill directories this project installs
  ./install.sh --help

An existing copy is moved to <parent of the skills dir>/.eco-backups/<name>-<utc stamp>
before anything is written, and the installed files are verified against the source.
EOF
}

die() {
  echo "install.sh: $1" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE="uninstall" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument \"$1\" (try --help)" ;;
  esac
  shift
done

if [ -n "${CLAUDE_SKILLS_DIR:-}" ]; then
  DEST="$CLAUDE_SKILLS_DIR"
  ORIGIN="CLAUDE_SKILLS_DIR"
else
  [ -n "${HOME:-}" ] || die "neither CLAUDE_SKILLS_DIR nor HOME is set - point CLAUDE_SKILLS_DIR at your skills directory"
  DEST="$HOME/.claude/skills"
  ORIGIN="default"
fi
BACKUP_ROOT="$(dirname "$DEST")/.eco-backups"

# Same file list, same bytes - the check that answers both "is it already
# installed?" and "did the copy land intact?".
trees_match() {
  local a="$1" b="$2" rel list_a list_b
  [ -d "$a" ] && [ -d "$b" ] || return 1
  list_a="$(cd "$a" && find . -type f | LC_ALL=C sort)"
  list_b="$(cd "$b" && find . -type f | LC_ALL=C sort)"
  [ "$list_a" = "$list_b" ] || return 1
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    cmp -s "$a/$rel" "$b/$rel" || return 1
  done <<< "$list_a"
  return 0
}

move_to_backup() {
  # Separate `local` statements on purpose: a variable assigned in the same
  # `local` is not reliably readable by the assignments after it (SC2318).
  local src="$1"
  local name="$2"
  local target="$BACKUP_ROOT/$name-$STAMP"
  local n=1
  # Two runs inside the same second must not nest one backup inside the other.
  while [ -e "$target" ]; do
    target="$BACKUP_ROOT/$name-$STAMP-$n"
    n=$((n + 1))
  done
  mkdir -p "$BACKUP_ROOT"
  mv "$src" "$target"
  printf '%s' "$target"
}

count_files() {
  find "$1" -type f | wc -l | tr -d ' '
}

echo "claude-code-eco skills"
echo "  source:     $SRC_ROOT"
echo "  skills dir: $DEST ($ORIGIN)"

if [ "$MODE" = "uninstall" ]; then
  removed=0
  for name in $SKILL_NAMES; do
    dst="$DEST/$name"
    if [ -e "$dst" ]; then
      target="$(move_to_backup "$dst" "$name")"
      echo "  $name: removed (copy kept at $target)"
      removed=$((removed + 1))
    else
      echo "  $name: not installed, nothing to remove"
    fi
  done
  echo "Removed $removed of $(set -- $SKILL_NAMES; echo $#) skill directories from $DEST."
  exit 0
fi

for name in $SKILL_NAMES; do
  [ -f "$SRC_ROOT/$name/SKILL.md" ] ||
    die "missing source skill: $SRC_ROOT/$name/SKILL.md - run this from a full clone of the repository"
done

mkdir -p "$DEST"
changed=0
STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$STAGE_ROOT"' EXIT

for name in $SKILL_NAMES; do
  src="$STAGE_ROOT/$name"
  dst="$DEST/$name"
  cp -R "$SRC_ROOT/$name" "$src"
  extra="$(script_for "$name")"
  if [ -n "$extra" ]; then
    [ -f "$SRC_ROOT/../scripts/$extra" ] || die "missing helper script: scripts/$extra"
    cp "$SRC_ROOT/../scripts/$extra" "$src/$extra"
  fi
  if trees_match "$src" "$dst"; then
    echo "  $name: already up to date ($(count_files "$dst") files)"
    continue
  fi
  if [ -e "$dst" ]; then
    target="$(move_to_backup "$dst" "$name")"
    echo "  $name: previous copy backed up to $target"
  fi
  cp -R "$src" "$dst"
  trees_match "$src" "$dst" || die "copy verification failed: $dst does not match $src"
  echo "  $name: installed and verified ($(count_files "$dst") files)"
  changed=$((changed + 1))
done

total="$(set -- $SKILL_NAMES; echo $#)"
if [ "$changed" -eq 0 ]; then
  echo "Nothing to do - all $total skills were already current."
else
  echo "Installed $changed of $total skills to $DEST."
fi
echo "Open a Claude Code session and type /eco to activate."
