#!/usr/bin/env bash
#
# worktree.sh: make a fresh git worktree of this repo ready to run.
#
# `git worktree add` (and Orca's workspace creation) checks out tracked files
# only; gitignored local files stay behind in the main checkout. `sync-in`
# runs inside a worktree, locates the main checkout, copies those files over,
# and installs dependencies (root and server/).
#
# Usage:
#   bash tools/worktree.sh sync-in [--no-install]
#
# Orca setup hook (repo settings -> setup script):
#   bash "$ORCA_ROOT_PATH/tools/worktree.sh" sync-in
set -euo pipefail

# gitignored paths a worktree needs; existing ones are never overwritten
SYNC_PATHS=(.claude server/.dev.vars)

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

cmd_sync_in() {
  local no_install=0
  [[ "${1:-}" == "--no-install" ]] && no_install=1

  local here
  if [[ -n "${ORCA_WORKTREE_PATH:-}" ]]; then
    here="$ORCA_WORKTREE_PATH"
  else
    here="$(git rev-parse --show-toplevel)"
  fi
  cd "$here"

  local main
  if [[ -n "${ORCA_ROOT_PATH:-}" ]]; then
    main="$ORCA_ROOT_PATH"
  else
    main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
  fi

  if [[ "$main" == "$here" ]]; then
    echo "sync-in: already in the main checkout ($main); nothing to copy"
  else
    echo "Syncing local files from $main"
    local p
    for p in "${SYNC_PATHS[@]}"; do
      if [[ -e "$main/$p" && ! -e "$here/$p" ]]; then
        mkdir -p "$here/$(dirname "$p")"
        cp -R "$main/$p" "$here/$p"
        echo "  copied $p"
      fi
    done
  fi

  if [[ "$no_install" -eq 0 ]]; then
    echo "Installing dependencies..."
    npm install
    npm install --prefix server
  fi

  echo "sync-in: done"
}

case "${1:-}" in
  sync-in) shift; cmd_sync_in "$@" ;;
  *)       usage ;;
esac
