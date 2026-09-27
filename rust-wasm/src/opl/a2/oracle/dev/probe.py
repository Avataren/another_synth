#!/usr/bin/env python3
# probe.py '<python dict SPEC>' [ticks] [--all]  -> compact AdPlug (v2 player) trace
import os, subprocess, sys
sys.path.insert(0, '/home/avataren/src/rust/another_synth/rust-wasm/src/opl/a2/oracle')
from craft_a2m import build
S = os.path.dirname(os.path.abspath(__file__))
spec = eval(sys.argv[1])
ticks = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 30
path = os.path.join(S, 'probe.a2m')
open(path, 'wb').write(build(spec))
out = subprocess.run([os.path.join(S, 'trace-oracle'), 'trace', path, str(ticks)],
                     env=dict(os.environ, A2M_PLAYER='v2'), capture_output=True, text=True)
if out.returncode: print(out.stderr); sys.exit(1)
show_init = '--all' in sys.argv
line = None
for l in out.stdout.splitlines():
    f = l.split()
    if f[0] == 'T':
        if line and (len(line) > 1): print(' '.join(line))
        line = ['t%s:' % f[1]]
        if f[1] == '-1' and not show_init: line = None
        if f[1] == '0': line = ['t0:'] if True else None
    elif line is not None and f[0] == 'W' and len(f) == 4:
        reg = int(f[2], 16) | (int(f[1]) << 8)
        line.append('%03x=%s' % (reg, f[3]))
if line and len(line) > 1: print(' '.join(line))
