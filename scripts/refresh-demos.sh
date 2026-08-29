#!/usr/bin/env bash
#
# Rebuild the demo collection manifest, public/demos/index.json.
#
# public/demos/ is committed and copied into dist/spa by the Quasar build, so
# it is the source of truth for what the collection contains: add a module by
# dropping it in there and running this to re-index. The browser reads the
# manifest, not the directory, so a module that is not listed will not appear.
#
# With no argument it re-indexes public/demos/ in place. Given a source root it
# imports from there first -- one directory per collection, e.g. amiga/ and
# ft2/ -- copying modules in before indexing. Importing never removes anything;
# delete unwanted modules from public/demos/ by hand so the removal is a
# reviewable part of the commit.
#
# Only .mod and .xm are recognised. Anything else in the directory (an .s3m,
# say) is left alone and stays out of the manifest.
#
#   scripts/refresh-demos.sh [source-root]
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/public/demos"
SOURCE_ROOT="${1:-$DEST}"

if [ ! -d "$SOURCE_ROOT" ]; then
  echo "No such source root: $SOURCE_ROOT" >&2
  exit 1
fi

node "$(dirname "$0")/build-demo-manifest.mjs" "$SOURCE_ROOT" "$DEST"
echo "Review with 'git status' and commit."
