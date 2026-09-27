#!/usr/bin/env bash
# pp.sh VER FX P [ticks] [speed]: 2 tracks (ins 1 fm, ins 2 additive), fx on rows 1-3, note on row 3
# needs trace-oracle and probe.py next to it (copy this dev dir into $A2M_SCRATCH)
cd "$(dirname "$0")"
I1='[0x01,0x02,0x10,0x05,0xf3,0xf4,0x0a,0x06,0,0,0x04]'; I2='[0x21,0x22,0x11,0x06,0xf1,0xf2,0x1a,0x16,1,2,0x05]'
python3 probe.py "dict(version=$1, tempo=50, speed=${5:-3}, instruments={1: dict(fm=$I1),2: dict(fm=$I2)}, patterns={0: [(0,0,49,1),(0,1,49,2),(1,0,0,0,$2,$3),(1,1,0,0,$2,$3),(2,0,0,0,$2,$3),(3,0,51,0,$2,$3)]})" ${4:-16} | grep -v '^t2:'
