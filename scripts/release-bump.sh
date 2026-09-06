#!/usr/bin/env bash
#
# The one place a release version is minted.
#
# Both deploy paths call this rather than each carrying their own copy of the
# bump: deploy-pi.sh on the OpenClaw instance that publishes, and the
# untracked deploy-local.sh that deploys to the LAN test host. The version it
# writes is what quasar.config.ts bakes into the bundle as __APP_VERSION__,
# which is what the settings page shows (AppVersion.vue).
#
#   scripts/release-bump.sh bump [--push]   bump the patch level, commit, tag
#   scripts/release-bump.sh rollback X.Y.Z  undo that commit and tag
#
# `bump` prints the new version to stdout and nothing else, so a caller can do
#   NEW_VERSION="$(scripts/release-bump.sh bump)"
# Progress goes to stderr.
#
# Always the patch level: a version with meaning behind it is a deliberate
# `npm version` by hand, not a side effect of deploying.
#
# The release commit carries package.json, package-lock.json and
# public/demos/index.json -- the same three files every previous
# `release: vX.Y.Z` commit does; the manifest is in there because the caller
# regenerates it just before releasing.
#
# Two machines mint versions, so the guard against them colliding is
# origin/main: a bump refuses when the local branch is behind it, which is
# exactly the state that would mint a number the other machine already used.
# That guard only works if releases actually reach origin -- pass --push (the
# publishing deploy should), or push the commit and tag yourself.
set -euo pipefail

cd "$(dirname "$0")/.."

RELEASE_FILES=(package.json package-lock.json public/demos/index.json)

usage() {
  echo "usage: scripts/release-bump.sh bump [--push] | rollback <version>" >&2
  exit 2
}

do_bump() {
  local push=0
  for arg in "$@"; do
    case "$arg" in
      --push) push=1 ;;
      *) usage ;;
    esac
  done

  # Untracked files are ignored (deploy-local.sh is one); modified tracked
  # files are not, because the git hash shown beside the version would
  # otherwise name a commit that is not what was built. The regenerated demo
  # manifest is the one expected exception -- it goes into the release commit.
  local dirty
  dirty="$(git status --porcelain -uno -- . ':!public/demos/index.json')"
  if [ -n "$dirty" ]; then
    echo "working tree has uncommitted changes -- commit them first:" >&2
    echo "$dirty" >&2
    exit 1
  fi

  # Behind origin/main means the other machine has already released; bumping
  # from here would mint a number that is taken. A machine with no network
  # gets a warning rather than a block: an offline deploy to the LAN host is
  # a normal thing to do.
  if git fetch --quiet origin main 2>/dev/null; then
    local behind
    behind="$(git rev-list --count HEAD..origin/main)"
    if [ "$behind" != 0 ]; then
      echo "local main is $behind commit(s) behind origin/main." >&2
      echo "Pull first -- releasing from here would reuse a version." >&2
      exit 1
    fi
  else
    echo "warning: could not reach origin; releasing without the collision check" >&2
  fi

  npm version patch --no-git-tag-version >/dev/null
  local version
  version="$(node -p "require('./package.json').version")"
  git add "${RELEASE_FILES[@]}"
  git commit -q -m "release: v$version"
  git tag "v$version"

  if [ "$push" = 1 ]; then
    git push --quiet origin HEAD "v$version"
    echo "released v$version (pushed to origin)" >&2
  else
    echo "released v$version (local commit + tag; not pushed)" >&2
  fi
  echo "$version"
}

do_rollback() {
  local version="${1:-}"
  [ -n "$version" ] || usage
  echo "rolling back the v$version commit and tag" >&2
  git tag -d "v$version" >/dev/null 2>&1 || true
  git reset --soft HEAD~1 >/dev/null 2>&1 || true
  git restore --staged --worktree "${RELEASE_FILES[@]}" 2>/dev/null || true
}

case "${1:-}" in
  bump) shift; do_bump "$@" ;;
  rollback) shift; do_rollback "$@" ;;
  *) usage ;;
esac
