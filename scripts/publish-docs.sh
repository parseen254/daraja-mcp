#!/usr/bin/env bash
#
# Publish site/ to the gh-pages branch.
#
# GitHub Pages serves this repository from a branch rather than a workflow, so
# deploying is a push. Uses a temporary worktree to avoid touching the checkout
# you are working in.

set -euo pipefail

BRANCH="gh-pages"
SOURCE_DIR="site"
WORKTREE=".gh-pages-worktree"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ ! -f "$SOURCE_DIR/index.html" ]]; then
  echo "error: $SOURCE_DIR/index.html not found" >&2
  exit 1
fi

# A stale worktree from an interrupted run would block the checkout below.
if [[ -d "$WORKTREE" ]]; then
  git worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"
fi

cleanup() {
  git worktree remove --force "$WORKTREE" 2>/dev/null || true
}
trap cleanup EXIT

git fetch --quiet origin "$BRANCH" 2>/dev/null || true

if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  git worktree add --quiet "$WORKTREE" -B "$BRANCH" "origin/$BRANCH"
else
  echo "Creating $BRANCH for the first time."
  git worktree add --quiet --detach "$WORKTREE"
  git -C "$WORKTREE" checkout --quiet --orphan "$BRANCH"
  git -C "$WORKTREE" rm -rqf . 2>/dev/null || true
fi

# Replace the published contents wholesale so deleted files actually disappear.
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -R "$SOURCE_DIR"/. "$WORKTREE"/

# Tells Pages to serve the files as-is instead of running Jekyll over them.
touch "$WORKTREE/.nojekyll"

cd "$WORKTREE"
git add -A

if git diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi

git commit --quiet -m "Publish docs site

Built from site/ on $(git -C "$repo_root" rev-parse --short HEAD)."

git push --quiet origin "$BRANCH"

echo "Published to https://parseen254.github.io/daraja-mcp/"
