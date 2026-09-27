#!/usr/bin/env python3
# freqs.py <ch-reg-offset hex, e.g. 3 or 106> [ticks]: per tick fnum/block/key of probe.a2m
import os, subprocess, sys
S = os.path.dirname(os.path.abspath(__file__))
ch = int(sys.argv[1], 16); ticks = sys.argv[2] if len(sys.argv) > 2 else '60'
out = subprocess.run([S + '/trace-oracle', 'trace', S + '/probe.a2m', ticks], env=dict(os.environ, A2M_PLAYER='v2'), capture_output=True, text=True).stdout
regs = [0] * 512; t = None; res = []
for l in out.splitlines():
    f = l.split()
    if f[0] == 'T':
        if t is not None and t >= 0:
            a = regs[0xa0 + ch]; b = regs[0xb0 + ch]
            res.append('%d:%s%x/%03x' % (t, '+' if b & 0x20 else '-', (b >> 2) & 7, a | (b & 3) << 8))
        t = int(f[1])
    elif len(f) == 4:
        regs[int(f[2], 16) | int(f[1]) << 8] = int(f[3], 16)
print(' '.join(res))
