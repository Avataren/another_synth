#!/usr/bin/env bash
#
# Publish the demo module collection to the web host.
#
# The modules are third-party music and several megabytes of it, so they are
# neither committed to the repository nor included in the Quasar build. They
# live alongside the app on the server and are published by this script.
#
# The app's own deploy uses `rsync --delete` against the same directory, so it
# must exclude `demos/` or every deploy would wipe the collection. See
# scripts/deploy.sh.
#
#   scripts/publish-demos.sh <source-root> [user@host] [remote-dir]
#
# <source-root> holds one directory per collection, e.g. amiga/ and ft2/.
set -euo pipefail

SOURCE_ROOT="${1:?Usage: publish-demos.sh <source-root> [user@host] [remote-dir]}"
REMOTE_HOST="${2:-avatar@192.168.50.161}"
REMOTE_DIR="${3:-~/repos/docker-info-ws-server/html/synth/demos}"

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "Staging demo modules from $SOURCE_ROOT"
node "$(dirname "$0")/build-demo-manifest.mjs" "$SOURCE_ROOT" "$STAGE_DIR"

echo "Publishing to $REMOTE_HOST:$REMOTE_DIR"
# --chmod is required, not cosmetic: the staging directory comes from
# `mktemp -d`, which is 0700, and plain `rsync -a` would carry that mode to the
# server. The web server could then stat the directory but not traverse it,
# serving 403 for the directory and 404 for every file inside it.
rsync -az --delete --chmod=D755,F644 "$STAGE_DIR/" "$REMOTE_HOST:$REMOTE_DIR/"

echo "Done. The app reads demos/index.json relative to its own base URL."
