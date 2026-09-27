#!/usr/bin/env bash
# runprobes.sh [pattern]: craft each probe, compare engine vs oracle
S=/tmp/claude-1000/-home-avataren-src-rust-another-synth/1d731c94-ffcf-44ed-a504-85d0ecb6aa1e/scratchpad
export PATH="$HOME/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu/bin:$PATH"
(cd /home/avataren/src/rust/another_synth/rust-wasm && cargo build -q --release --example a2m_tool 2>&1 | grep -E '^error' -A8 | head -40)
T=/home/avataren/src/rust/another_synth/rust-wasm/target/release/examples/a2m_tool
for p in $S/probes/${1:-*}.py; do
  n=$(basename $p .py)
  python3 /home/avataren/src/rust/another_synth/rust-wasm/src/opl/a2/oracle/craft_a2m.py $p $S/probes/$n.a2m
  r=$(A2M_ORACLE=$S/trace-oracle $T cmp $S/probes/$n.a2m ${TICKS:-80} ${SHOW:-0})
  echo "$r" | grep -q ' 81 of 81 \| \([0-9]*\) of \1 ' && echo "ok   $n" || { echo "FAIL $n"; [ -n "$V" ] && echo "$r" | cut -c1-${W:-400}; }
done
