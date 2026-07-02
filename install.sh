#!/usr/bin/env bash
# Installs the /eco and /eco-max skills to ~/.claude/skills
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/skills"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
mkdir -p "$DEST"
cp -r "$SRC/eco" "$SRC/eco-max" "$DEST/"
echo "Installed /eco and /eco-max to $DEST"
echo "Open a Claude Code session and type /eco to activate."
