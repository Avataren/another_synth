#!/usr/bin/env bash
#
# Build and deploy the app to the web host.
#
# The demo modules live in public/demos/, so the Quasar build copies them into
# dist/spa and this deploy carries them like any other asset. They used to be
# published separately and excluded from the `--delete` here; that exclusion is
# gone, and with it the failure mode where deploying with plain rsync -- or
# forgetting the exclusion -- wiped the whole collection off the server.
#
# The Rust toolchain needs the nightly bin directory on PATH: rust-wasm pins
# nightly via rust-toolchain.toml, but that file is only honoured by rustup's
# shims, and this machine has the toolchains without them. Invoking stable's
# cargo directly fails on the crate's portable_simd feature.
#
#   scripts/deploy.sh [user@host] [remote-dir]
set -euo pipefail

REMOTE_HOST="${1:-avatar@192.168.50.161}"
REMOTE_DIR="${2:-~/repos/docker-info-ws-server/html/synth}"

NIGHTLY_BIN="$HOME/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu/bin"
if [ -d "$NIGHTLY_BIN" ]; then
  export PATH="$NIGHTLY_BIN:$PATH"
fi

echo "Building…"
npm run build

if [ ! -f dist/spa/demos/index.json ]; then
  echo "dist/spa/demos/index.json is missing -- refusing to deploy." >&2
  echo "The demo browser would come up empty. Check public/demos/." >&2
  exit 1
fi

echo "Deploying to $REMOTE_HOST:$REMOTE_DIR"
rsync -az --delete dist/spa/ "$REMOTE_HOST:$REMOTE_DIR/"

echo "Verifying…"
LOCAL_SUM="$(md5sum dist/spa/index.html | cut -d' ' -f1)"
REMOTE_SUM="$(ssh "$REMOTE_HOST" "md5sum $REMOTE_DIR/index.html" | cut -d' ' -f1)"
if [ "$LOCAL_SUM" != "$REMOTE_SUM" ]; then
  echo "Checksum mismatch: local $LOCAL_SUM, remote $REMOTE_SUM" >&2
  exit 1
fi
echo "Deployed and verified ($LOCAL_SUM)"
