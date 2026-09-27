#!/usr/bin/env python3
# mapext.py <ver> <old effect hex>: for x in 0..15, find new (effect, param) with same trace as old (e, x<<4|y) for several y
import os, subprocess, sys
sys.path.insert(0, '/home/avataren/src/rust/another_synth/rust-wasm/src/opl/a2/oracle')
from craft_a2m import build
S = os.path.dirname(os.path.abspath(__file__))
ver, oe = int(sys.argv[1]), int(sys.argv[2], 16)
I1 = [0x01,0x02,0x10,0x05,0xf3,0xf4,0x0a,0x06,0,0,0x04]
I2 = [0x21,0x22,0x11,0x06,0xf1,0xf2,0x1a,0x16,1,2,0x05]
def trace(spec):
    path = S + '/mapext.a2m'
    open(path, 'wb').write(build(spec))
    out = subprocess.run([S + '/trace-oracle', 'trace', path, '30'], env=dict(os.environ, A2M_PLAYER='v2'), capture_output=True, text=True).stdout
    regs = [0]*512; states = []; t = None
    for l in out.splitlines():
        f = l.split()
        if f[0] == 'T':
            if t is not None: states.append(tuple(regs))
            t = f[1]
        elif len(f) == 4:
            regs[int(f[2],16) | int(f[1]) << 8] = int(f[3],16)
    states.append(tuple(regs))
    return states
def spec(v, e, p):
    return dict(version=v, tempo=50, speed=3, instruments={1: dict(fm=I1), 2: dict(fm=I2)},
                patterns={0: [(0,0,49,1),(0,1,49,2),(1,0,0,0,e,p),(1,1,0,0,e,p),(2,0,0,0,e,p),(3,0,51,0,e,p)]})
ys = [1, 5, 0xf, 0]
cands = [(n, z) for n in (0x23, 0x24, 0x29) for z in range(16)] + [(n, None) for n in range(0x23)] + [(0x25, None), (0x28, None)]
for x in range(16):
    old = [trace(spec(ver, oe, x << 4 | y)) for y in ys]
    base = trace(spec(11, 0, 0))
    if all(o == base for o in old):
        print('x=%x: no effect' % x, flush=True); continue
    found = []
    for n, z in cands:
        ok = True
        for i, y in enumerate(ys):
            p = (z << 4 | y) if z is not None else y
            if trace(spec(11, n, p)) != old[i]:
                ok = False; break
        if ok: found.append('%02x%s' % (n, ('%x.' % z) if z is not None else ' y'))
    print('x=%x: %s' % (x, ' '.join(found) or 'NONE'), flush=True)
