#!/usr/bin/env python3
"""S1 gate 3: first cause of the S0 saw-harmonic deviation. Standard library only.

Loads the S0 spectral tool's own analysis functions (unmodified) and runs four
measurements:
  A. ideal band-limited saw at A-4 (440.02 Hz) through the S0 estimator
     -> reproduces the S0 selftest failure with NO chip, NO decimator.
  B. the same ideal saw at a bin-centred pitch (41 * SR / N = 441.43 Hz)
     -> if the deviation vanishes, the estimator's bin-grid position is the cause.
  C. the rendered S0 wave-saw.wav through the S0 estimator (the failing
     S0 numbers).
  D. the rendered wave-saw.wav with a scalloping-free estimator: Hann-windowed
     DFT evaluated at the exact harmonic frequency k*f0 (no bin grid).
     Remaining deviation = what the chip model + boxcar decimator really do.
Plus the Hann scalloping loss predicted for each harmonic's bin offset.
"""
import cmath, importlib.util, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
spec = importlib.util.spec_from_file_location('spectral', os.path.join(ROOT, 'sidspike', 'tools', 'spectral.py'))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
SR, N, A4 = S.SR, S.N, S.A4
WANT = [-20 * math.log10(k) for k in range(1, 11)]

def ideal_saw(f0, secs=2.5):
    return [sum(math.sin(2 * math.pi * k * f0 * i / SR) / k for k in range(1, 30)) for i in range(int(secs * SR))]

def s0_est(x, f0):
    return S.harmonic_db(S.avg_spectrum(x, 0.6, 2.3), f0)

def exact_est(x, f0, t0=0.6, t1=2.3):
    seg = x[int(t0 * SR):int(t1 * SR)]
    L = len(seg)
    w = [0.5 - 0.5 * math.cos(2 * math.pi * i / L) for i in range(L)]
    amps = []
    for k in range(1, 11):
        step = cmath.exp(-2j * math.pi * k * f0 / SR); ph = 1.0; acc = 0j
        for v, h in zip(seg, w):
            acc += v * h * ph; ph *= step
        amps.append(abs(acc))
    return [20 * math.log10(a / amps[0]) for a in amps]

def hann_scallop_db(offset):
    # Hann window response at `offset` bins from its centre (continuous DTFT, large N).
    if offset == 0: return 0.0
    x = math.pi * offset
    return 20 * math.log10(abs(math.sin(x) / x / (1 - offset * offset)))

def row(label, vals):
    print('%-44s' % label + ' '.join('%6.2f' % v for v in vals))

def dev(got):
    return [g - w for g, w in zip(got, WANT)]

print('harmonic k                                  ' + ' '.join('%6d' % k for k in range(1, 11)))
row('want -20log10(k)', WANT)
offs = [abs(k * A4 * N / SR - round(k * A4 * N / SR)) for k in range(1, 11)]
row('bin offset of k*440.02 (bins)', offs)
pred = [hann_scallop_db(o) - hann_scallop_db(offs[0]) for o in offs]
row('predicted Hann scalloping re k=1 (dB)', pred)
a = s0_est(ideal_saw(A4), A4); row('A ideal saw @440.02, S0 est: dev', dev(a))
fb = 41 * SR / N
b = s0_est(ideal_saw(fb), fb); row('B ideal saw @%.2f bin-centred, S0 est: dev' % fb, dev(b))
x = S.read_wav(os.path.join(ROOT, '.ai', 'sid-spike-ref', 'wave-saw.wav'))
c = s0_est(x, A4); row('C rendered wave-saw.wav, S0 est: dev', dev(c))
row('C minus predicted scalloping', [d - p for d, p in zip(dev(c), pred)])
d = exact_est(x, A4); row('D rendered wave-saw.wav, exact-freq DFT: dev', dev(d))
box = [20 * math.log10(abs(math.sin(math.pi * k * A4 / SR) / (math.pi * k * A4 / SR)) /
       abs(math.sin(math.pi * A4 / SR) / (math.pi * A4 / SR))) for k in range(1, 11)]
row('boxcar sinc(f/44100) droop re k=1 (dB)', box)
row('D minus boxcar droop', [v - bx for v, bx in zip(dev(d), box)])
print('max |dev| A=%.2f B=%.2f C=%.2f D=%.2f dB' % tuple(max(abs(v) for v in dev(z)) for z in (a, b, c, d)))
