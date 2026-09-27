#!/usr/bin/env bash
# cmp.sh <corpus-relative file> [ticks] [show]
export PATH="$HOME/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu/bin:$PATH"
S=${A2M_SCRATCH:?set A2M_SCRATCH to a directory holding trace-oracle, probes/ and tier1.txt}
cd /home/avataren/src/rust/another_synth/rust-wasm && cargo build -q --release --example a2m_tool 2>&1 | grep -E '^error' -A8 | head -40
f="$1"; [ -f "$f" ] || f="/home/avataren/src/rust/another_synth/src/tests/fixtures/opl/a2m/$1"
A2M_ORACLE=$S/trace-oracle ./target/release/examples/a2m_tool cmp "$f" "${2:-3000}" "${3:-2}"
