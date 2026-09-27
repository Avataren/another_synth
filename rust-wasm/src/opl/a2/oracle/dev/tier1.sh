#!/usr/bin/env bash
S=/tmp/claude-1000/-home-avataren-src-rust-another-synth/1d731c94-ffcf-44ed-a504-85d0ecb6aa1e/scratchpad
export PATH="$HOME/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu/bin:$PATH"
(cd /home/avataren/src/rust/another_synth/rust-wasm && cargo build -q --release --example a2m_tool 2>&1 | grep -E '^error' -A8 | head -40)
T=/home/avataren/src/rust/another_synth/rust-wasm/target/release/examples/a2m_tool
while IFS= read -r f; do
  A2M_ORACLE=$S/trace-oracle $T cmp "/home/avataren/src/rust/another_synth/src/tests/fixtures/opl/a2m/$f" ${TICKS:-3000} 0 | sed 's|.*/a2m/||'
done < ${LIST:-$S/tier1.txt}
