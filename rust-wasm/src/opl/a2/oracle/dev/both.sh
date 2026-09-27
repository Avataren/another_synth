#!/usr/bin/env bash
# both.sh <file> <from> <to> <reg regex>: per-tick writes (oracle, then engine) for matching regs
S=${A2M_SCRATCH:?set A2M_SCRATCH}
f="$1"; [ -f "$f" ] || f="/home/avataren/src/rust/another_synth/src/tests/fixtures/opl/a2m/$1"
A2M_PLAYER=v2 $S/trace-oracle trace "$f" $3 | awk -v a=$2 -v b=$3 -v re="$4" '/^T/{t++} $1=="W" && t-2>=a && t-2<=b {r=($2=="1" ? "1" substr($3,2) : $3); if (r ~ re) w[t-2]=w[t-2] " " r "=" $4} END{for(i=a;i<=b;i++) print "A " i ":" w[i]}' > $S/.a
/home/avataren/src/rust/another_synth/rust-wasm/target/release/examples/a2m_tool mine "$f" $(( $3 + 1 )) $(printf '%x ' $(seq 0 511)) | tr ' ' '\n' | awk -F'[:=]' -v a=$2 -v b=$3 -v re="$4" '$1>=a && $1<=b && $2 ~ re {w[$1]=w[$1] " " $2 "=" $3} END{for(i=a;i<=b;i++) print "B " i ":" w[i]}' > $S/.b
paste -d'\n' $S/.a $S/.b
