#!/usr/bin/env bash
# Regenerates the *.txt goldens next to this script from the vendored C
# reference (.ai/ahx/references/hvl_replay.c, compiled natively with gcc).
# Needs gcc; cargo test itself never runs this and needs no C toolchain.
# Columns: fixture  freq  defstereo  frames  chunk_frames  channel_cap(0=all)
set -euo pipefail
cd "$(dirname "$0")"
REF=../../../.ai/ahx/references
DEMOS=../../../public/demos/ahx
gcc -O0 -fwrapv -fcommon -w -I"$REF" -o /tmp/hvl_golden hvl_golden.c "$REF/hvl_replay.c" "$REF/hvl_tables.c" -lm

while read -r fixture freq stereo frames chunk cap; do
  [[ -z "${fixture}" || "${fixture}" == \#* ]] && continue
  out="${fixture%.*}.${freq}.s${stereo}.cap${cap}.txt"
  args=("$DEMOS/$fixture" "$freq" "$stereo" "$frames" "$chunk")
  [[ "$cap" != 0 ]] && args+=("$cap")
  /tmp/hvl_golden "${args[@]}" > "$out"
  echo "wrote $out"
done <<'CASES'
karma.ahx               44100 2 3000 50 0
karma.ahx               48000 0 1000 50 0
chiprolled.hvl          44100 2 1500 50 4
moderate_sellotaping.hvl 44100 2 1500 50 4
sunspots.hvl            44100 2 1500 50 4
illuminated.hvl         44100 2 1500 50 0
sliding_away.hvl        44100 2 3000 50 0
doobrey_gubbins.hvl     44100 2 1000 50 0
CASES
