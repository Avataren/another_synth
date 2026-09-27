#!/usr/bin/env bash
# Regenerate the ST3 AdLib register traces from st3play (BSD-3).
#
#   src/tests/fixtures/opl/st3-traces/regen.sh [scratch-dir]
#
# Clones st3play at the pinned commit, builds st3-adlib-trace.c against its
# replayer with a stub audio driver, and traces each song in SONGS for TICKS
# ticks into <name>.trace. Nothing of st3play is vendored, only its output.
set -euo pipefail
ST3PLAY_COMMIT=216b165183a657123e42aa1a5657086cbdb2cc59
TICKS=3000
HERE="$(cd "$(dirname "$0")" && pwd)"
CORPUS="$HERE/../s3m-adlib"
WORK="${1:-$(mktemp -d)}"
[ -d "$WORK/st3play" ] || git clone -q https://github.com/8bitbubsy/st3play.git "$WORK/st3play"
git -C "$WORK/st3play" checkout -q "$ST3PLAY_COMMIT"
S="$WORK/st3play"
gcc -O1 -std=gnu11 -I"$S" -include "$HERE/stubdriver.h" -o "$WORK/st3-adlib-trace" "$HERE/st3-adlib-trace.c" \
  "$S"/dig.c "$S"/digread.c "$S"/digcmd.c "$S"/digadl.c "$S"/digdata.c "$S"/load.c "$S"/dig_gus.c "$S"/digamg.c \
  "$S"/mixer/sbpro.c "$S"/mixer/gus_gf1.c "$S"/mixer/sinc.c -lm
# name|path under s3m-adlib (the README's tier 1)
SONGS=(
  "starport|Purple Motion/starport bbs introtune.s3m"
  "starport2|Skaven/starport bbs introtune 2 v2.s3m"
  "first-adlib-attempt|Skaven/first adlib attempt.as3m"
  "church|Bisqwit/some kind of church theme.s3m"
  "mystic|Mayaman/mystic reflections.s3m"
  "redemptions|Omega/redemptions.s3m"
  "rance-bird|- unknown/(opl2) rance 4.1 - bird.s3m"
  "a-vision|Basehead/a vision.s3m"
  "koakuma|Viraxor/koakuma.s3m"
  "rotagilla|Manwe/rotagilla.s3m"
)
for entry in "${SONGS[@]}"; do
  name="${entry%%|*}"; file="${entry#*|}"
  "$WORK/st3-adlib-trace" "$CORPUS/$file" "$TICKS" > "$HERE/$name.trace"
  echo "$name: $(grep -vc '^T' "$HERE/$name.trace") writes"
done
