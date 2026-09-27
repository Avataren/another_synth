#!/usr/bin/env python3
# mapfx.py <old version 4|8> : for each old effect number, find v11 effects whose
# per-tick register state matches AdPlug's for a set of parameters.
import os, subprocess, sys
sys.path.insert(0, '/home/avataren/src/rust/another_synth/rust-wasm/src/opl/a2/oracle')
from craft_a2m import build
S = os.path.dirname(os.path.abspath(__file__))
ver = int(sys.argv[1])
only = [int(x, 16) for x in sys.argv[2:]]
I1 = [0x01,0x02,0x10,0x05,0xf3,0xf4,0x0a,0x06,0,0,0x04]
I2 = [0x21,0x22,0x11,0x06,0xf1,0xf2,0x1a,0x16,1,2,0x05]
def trace(spec):
    path = S + '/mapfx.a2m'
    open(path, 'wb').write(build(spec))
    out = subprocess.run([S + '/trace-oracle', 'trace', path, '40'], env=dict(os.environ, A2M_PLAYER='v2'), capture_output=True, text=True).stdout
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
    return dict(version=v, tempo=50, speed=4, instruments={1: dict(fm=I1), 2: dict(fm=I2)},
                patterns={0: [(0,0,49,1),(0,1,49,2),(1,0,51,0,e,p),(1,1,0,0,e,p),(2,0,0,0,e,p),(3,0,0,0,e,0),(4,0,52,0,e,p)]})
params = [0x21, 0x04, 0x40, 0x1f, 0x00]
base_old = trace(spec(ver, 0, 0)); base_new = trace(spec(11, 0, 0))
print('baseline equal:', base_old == base_new, flush=True)
maxe = 16 if ver < 5 else 36
for e in (only or range(maxe)):
    old = [trace(spec(ver, e, p)) for p in params]
    matches = []
    for n in range(0x30):
        if all(trace(spec(11, n, p)) == old[i] for i, p in enumerate(params)):
            matches.append(n)
    print('old %02x -> new %s' % (e, ' '.join('%02x' % n for n in matches) or 'NONE'), flush=True)
