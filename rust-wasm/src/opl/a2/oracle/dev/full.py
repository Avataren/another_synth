#!/usr/bin/env python3
# full.py [filter]: state compare (with diffs shown by cmp) every corpus file for its gate.tsv length
import os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
S = os.environ['A2M_SCRATCH']
C = '/home/avataren/src/rust/another_synth/src/tests/fixtures/opl/a2m'
T = '/home/avataren/src/rust/another_synth/rust-wasm/target/release/examples/a2m_tool'
CAP = 120000
rows = []
# lengths from the committed gate (AdPlug's end flag, capped)
for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gate.tsv')):
    if line.startswith('#'):
        continue
    f, n = line.split('\t')[:2]
    n = int(n)
    if len(sys.argv) > 1 and sys.argv[1] not in f:
        continue
    rows.append((n, f))
def run(nf):
    n, f = nf
    env = dict(os.environ, A2M_STATE='1', A2M_ORACLE=os.path.join(S, 'trace-oracle'))
    out = subprocess.run([T, 'cmp', os.path.join(C, f), str(n), '0'], env=env, capture_output=True, text=True).stdout
    m = re.search(r'(\d+) of (\d+) ticks', out)
    return f, int(m.group(1)), int(m.group(2))
ok = 0
with ThreadPoolExecutor(os.cpu_count()) as ex:
    for f, a, b in ex.map(run, rows):
        if a == b:
            ok += 1
        else:
            print(f'{f}: {a} of {b}')
print(f'full length: {ok} / {len(rows)} match')
