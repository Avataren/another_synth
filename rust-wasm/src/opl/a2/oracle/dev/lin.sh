#!/bin/bash
# lin.sh ch base_block base_fnum ticks : linear deltas
./freqs.py $1 $4 | tr ' ' '\n' | awk -F'[:/]' -v bb=$2 -v bf=$3 '{blk=substr($2,2)+0; f=strtonum("0x"$3); printf "%d ", (blk-bb)*344 + f - strtonum(bf)}'; echo
