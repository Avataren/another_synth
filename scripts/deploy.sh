#!/usr/bin/env bash
#
# Build and deploy the app to the web host.
#
# `--exclude=demos/` matters: the deploy uses `--delete` to remove stale build
# output, and the demo module collection lives in the same directory but is
# published separately by scripts/publish-demos.sh. Without the exclusion every
# deploy would delete it.
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

echo "Deploying to $REMOTE_HOST:$REMOTE_DIR"
rsync -az --delete --exclude=demos/ dist/spa/ "$REMOTE_HOST:$REMOTE_DIR/"

echo "Verifying…"
LOCAL_SUM="$(md5sum dist/spa/index.html | cut -d' ' -f1)"
REMOTE_SUM="$(ssh "$REMOTE_HOST" "md5sum $REMOTE_DIR/index.html" | cut -d' ' -f1)"
if [ "$LOCAL_SUM" != "$REMOTE_SUM" ]; then
  echo "Checksum mismatch: local $LOCAL_SUM, remote $REMOTE_SUM" >&2
  exit 1
fi
echo "Deployed and verified ($LOCAL_SUM)"
