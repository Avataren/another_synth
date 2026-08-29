#!/usr/bin/env bash
#
# Regenerate the demo module collection in public/demos/.
#
# The modules are committed to the repository, so this only needs running when
# the collection itself changes -- adding a module, dropping one, or picking up
# a manifest-format change. The Quasar build copies public/demos/ into
# dist/spa, and scripts/deploy.sh ships it from there.
#
# They were previously kept out of the repo and pushed straight to the server,
# which meant the app's own deploy had to remember `--exclude=demos/` against
# its `--delete`. Any deploy that did not -- including a hand-written rsync --
# silently wiped the collection. Roughly ten megabytes of never-changing binary
# is a cheap price for making that unrepresentable.
#
#   scripts/refresh-demos.sh [source-root]
#
# <source-root> holds one directory per collection, e.g. amiga/ and ft2/.
set -euo pipefail

SOURCE_ROOT="${1:-$HOME/Downloads/mods}"
DEST="$(dirname "$0")/../public/demos"

if [ ! -d "$SOURCE_ROOT" ]; then
  echo "No such source root: $SOURCE_ROOT" >&2
  exit 1
fi

node "$(dirname "$0")/build-demo-manifest.mjs" "$SOURCE_ROOT" "$DEST"
echo "Wrote $DEST -- review with 'git status' and commit."
