#!/usr/bin/env bash
set -euo pipefail

# Rigorium self-update script.
# Pulls latest code, rebuilds, and signals the parent process to restart.
#
# Usage:
#   scripts/update.sh [--restart]
#
# Exit codes:
#   0 = update successful (caller should restart services)
#   1 = error during update
#   2 = already up-to-date (no changes pulled)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

log()  { printf "${GREEN}[update]${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}[update]${RESET} %s\n" "$1"; }
fail() { printf "${RED}[update]${RESET} %s\n" "$1" >&2; exit 1; }

DO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --restart) DO_RESTART=1 ;;
  esac
done

cd "$PROJECT_ROOT"

if [[ ! -d ".git" ]]; then
  fail "Not a git repository. Cannot update."
fi

CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo "unknown")"
log "Current branch: $CURRENT_BRANCH"

log "Fetching latest changes..."
git fetch origin "$CURRENT_BRANCH" 2>&1

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "origin/$CURRENT_BRANCH" 2>/dev/null || echo "")"

if [[ -z "$REMOTE_HEAD" ]]; then
  fail "Cannot determine remote HEAD for branch $CURRENT_BRANCH"
fi

if [[ "$LOCAL_HEAD" == "$REMOTE_HEAD" ]]; then
  log "Already up-to-date (${LOCAL_HEAD:0:8})"
  exit 2
fi

log "Updating from ${LOCAL_HEAD:0:8} to ${REMOTE_HEAD:0:8}..."

STASHED=0
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  warn "Working directory has uncommitted changes. Stashing..."
  git stash push -m "rigorium-auto-update-$(date +%Y%m%d-%H%M%S)" 2>&1
  STASHED=1
fi

# Strictly fast-forward: an auto-update must never force-reset the working
# tree (that would silently destroy uncommitted work). If the local branch
# diverged, fail loudly and hand the situation back to the operator.
if ! git pull --ff-only origin "$CURRENT_BRANCH" 2>&1; then
  if [[ "$STASHED" -eq 1 ]]; then
    warn "Update failed; restoring your stashed changes."
    git stash pop 2>&1 || true
  fi
  fail "Fast-forward pull failed: the local branch has diverged from origin/$CURRENT_BRANCH. Refusing to force-reset (uncommitted work would be destroyed). Resolve manually, then re-run the update."
fi

if [[ "$STASHED" -eq 1 ]]; then
  warn "Restoring stashed changes..."
  if ! git stash pop 2>&1; then
    warn "Stash pop reported conflicts (upstream changed the same files). Your changes are preserved in the stash:"
    git stash list 2>&1
    warn "Resolve the conflicts manually and run 'git stash drop' when done."
  fi
fi

log "Installing dependencies..."
if command -v pnpm >/dev/null 2>&1; then
  HUSKY=0 pnpm install --frozen-lockfile 2>&1 || HUSKY=0 pnpm install 2>&1
else
  HUSKY=0 npm install --no-audit --no-fund 2>&1
fi

log "Building gateway (TypeScript)..."
npm run build 2>&1

log "Building UI frontend..."
cd ui
npm run build 2>&1
cd "$PROJECT_ROOT"

NEW_HEAD="$(git rev-parse HEAD)"
log "Update complete: ${NEW_HEAD:0:8}"

COMMIT_MSG="$(git log --oneline -1 HEAD)"
log "Latest commit: $COMMIT_MSG"

if [[ "$DO_RESTART" -eq 1 ]]; then
  log "Restarting Rigorium..."
  if [[ -n "${RIGORIUM_PID:-}" ]] && kill -0 "$RIGORIUM_PID" 2>/dev/null; then
    kill -SIGUSR2 "$RIGORIUM_PID" 2>/dev/null || true
  fi
fi

exit 0
