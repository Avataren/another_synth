import { describe, expect, it } from 'vitest';
import {
  XM_BASE_RATE,
  addPoint,
  addSample,
  defaultEnvelope,
  emptyXmInstrument,
  emptyXmSample,
  fromPcm,
  generatePulse,
  generateWave,
  halve,
  movePoint,
  newXmInstrument,
  normalize,
  paintKeymap,
  quantize,
  removePoint,
  removeSample,
  reverse,
  setBits,
  withData,
  withLoop,
  xmSampleRate,
} from 'src/audio/tracker/xm-sample-ops';
import { readXmSampleFile, writeXmAiff, writeXmSampleFile } from 'src/audio/tracker/xm-sample-formats';

describe('xm sample ops', () => {
  it('holds data on the sample bit-depth grid', () => {
    const s = withData(emptyXmSample('', 8), Float32Array.from([0.5004, -0.2501, 1.5, -1.5]));
    expect(Array.from(s.data)).toEqual([64 / 128, -32 / 128, 127 / 128, -1]);
    expect(Array.from(setBits(s, 16).data)).toEqual(Array.from(quantize(s.data, 16)));
  });

  it('keeps loops inside the data and drops degenerate ones', () => {
    const s = withData(emptyXmSample(), new Float32Array(100));
    expect(withLoop(s, 10, 50, 'pingpong')).toMatchObject({ loopStart: 10, loopLength: 50, loopType: 'pingpong' });
    expect(withLoop(s, 90, 50)).toMatchObject({ loopStart: 90, loopLength: 10, loopType: 'forward' });
    expect(withLoop(s, 10, 1)).toMatchObject({ loopLength: 0, loopType: 'none' });
    // Shortening the data refits the loop.
    expect(withData(withLoop(s, 10, 80), new Float32Array(50))).toMatchObject({ loopStart: 10, loopLength: 40 });
  });

  it('reverses and halves a looped sample with its loop', () => {
    const s = withLoop(withData(emptyXmSample(), Float32Array.from({ length: 100 }, (_, i) => i / 128)), 10, 20, 'forward');
    const r = reverse(s);
    expect(r.data[0]).toBe(s.data[99]);
    expect([r.loopStart, r.loopLength]).toEqual([70, 20]);
    const h = halve(s);
    expect(h.data.length).toBe(50);
    expect([h.loopStart, h.loopLength]).toEqual([5, 10]);
  });

  it('normalizes to near full scale', () => {
    const s = normalize(withData(emptyXmSample('', 16), Float32Array.from([0.25, -0.1])));
    expect(Math.max(...s.data.map(Math.abs))).toBeCloseTo(0.99, 3);
  });

  it('tunes a loaded file to its own pitch with relative note and finetune, not by resampling', () => {
    const pcm = new Float32Array(1000);
    const s = fromPcm(emptyXmSample(), pcm, XM_BASE_RATE * 2, 16);
    expect(s.data.length).toBe(1000);
    expect([s.relativeNote, s.finetune]).toEqual([12, 0]);
    const odd = fromPcm(emptyXmSample(), pcm, 44100, 16);
    expect(xmSampleRate(odd) / 44100).toBeGreaterThan(0.998);
    expect(xmSampleRate(odd) / 44100).toBeLessThan(1.002);
  });

  it('generates looped waves and pulse sweeps', () => {
    const wave = generateWave(emptyXmSample(), 'sine', 64);
    expect([wave.data.length, wave.loopType, wave.loopStart, wave.loopLength, wave.name]).toEqual([64, 'forward', 0, 64, 'sine']);
    const pulse = generatePulse(emptyXmSample(), { cycleLength: 32, cycles: 8, dutyStart: 10, dutyEnd: 50, sweep: 'up' });
    expect(pulse.data.length).toBe(256);
    const highs = (c: number) => Array.from(pulse.data.slice(c * 32, c * 32 + 32)).filter((v) => v > 0).length;
    expect(highs(7)).toBeGreaterThan(highs(0));
  });
});

describe('xm instrument ops', () => {
  it('limits an instrument to 16 samples', () => {
    let ins = emptyXmInstrument();
    for (let i = 0; i < 16; i++) ins = addSample(ins)!;
    expect(addSample(ins)).toBeNull();
  });

  it('paints the keymap and repairs it when a sample is removed', () => {
    let ins = addSample(addSample(newXmInstrument())!)!;
    ins = paintKeymap(ins, 40, 60, 1);
    ins = paintKeymap(ins, 70, 95, 2);
    expect(ins.keymap[39]).toBe(0);
    expect(ins.keymap[40]).toBe(1);
    expect(ins.keymap[60]).toBe(1);
    expect(ins.keymap[61]).toBe(0);
    const gone = removeSample(ins, 1);
    expect(gone.samples).toHaveLength(2);
    expect(gone.keymap[50]).toBe(0);
    expect(gone.keymap[80]).toBe(1);
  });
});

describe('xm envelope ops', () => {
  it('adds points in order up to 12 and keeps markers on their points', () => {
    let env = { ...defaultEnvelope('volume'), sustainEnabled: true, sustainPoint: 1 };
    env = addPoint(env, 10, 50);
    expect(env.points.map((p) => p.frame)).toEqual([0, 10, 32]);
    expect(env.sustainPoint).toBe(2);
    for (let f = 40; f < 400; f += 20) env = addPoint(env, f, 10);
    expect(env.points.length).toBe(12);
    expect(addPoint(env, 5, 5)).toBe(env);
  });

  it('moves points between their neighbours and pins the first to frame 0', () => {
    let env = addPoint(defaultEnvelope('volume'), 16, 40);
    env = movePoint(env, 1, 500, 100);
    expect(env.points[1]).toEqual({ frame: 31, value: 64 });
    env = movePoint(env, 0, 20, 20);
    expect(env.points[0]).toEqual({ frame: 0, value: 20 });
  });

  it('keeps at least two points and repairs markers on removal', () => {
    let env = addPoint(addPoint(defaultEnvelope('panning'), 10, 40), 20, 10);
    env = { ...env, loopEnabled: true, loopStart: 1, loopEnd: 3 };
    const less = removePoint(env, 1);
    expect(less.points).toHaveLength(3);
    expect([less.loopStart, less.loopEnd]).toEqual([1, 2]);
    const two = removePoint(removePoint(less, 0), 0);
    expect(two.points).toHaveLength(2);
    expect(removePoint(two, 0)).toBe(two);
  });
});

describe('xm sample files', () => {
  const sample = withLoop(withData({ ...emptyXmSample('tone', 16), relativeNote: 12 }, Float32Array.from({ length: 200 }, (_, i) => Math.sin(i / 5) * 0.5)), 20, 100, 'forward');

  it('round-trips a 16-bit sample and its loop through AIFF', () => {
    const loaded = readXmSampleFile(writeXmAiff(sample), 'tone.aiff', 8)!;
    expect(loaded.bits).toBe(16);
    expect(loaded.rate).toBeCloseTo(xmSampleRate(sample), 0);
    expect([loaded.loopStart, loaded.loopLength]).toEqual([20, 100]);
    expect(loaded.name).toBe('tone');
    expect(Array.from(loaded.pcm)).toEqual(Array.from(sample.data));
  });

  it('writes raw at the sample depth and reads it back', () => {
    const bytes = writeXmSampleFile('raw', sample);
    expect(bytes.length).toBe(400);
    expect(Array.from(readXmSampleFile(bytes, 'tone.raw', 16)!.pcm)).toEqual(Array.from(sample.data));
    const eight = setBits(sample, 8);
    expect(writeXmSampleFile('raw', eight).length).toBe(200);
  });

  it('writes a 16-bit WAV at the rate C-4 plays the sample at', () => {
    const wav = writeXmSampleFile('wav', sample);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(Math.round(xmSampleRate(sample)));
    expect(view.getUint16(34, true)).toBe(16);
    expect(wav.length).toBe(44 + 400);
  });

  it('carries the rate in an 8SVX header', () => {
    const bytes = writeXmSampleFile('8svx', setBits(sample, 8));
    expect(new DataView(bytes.buffer).getUint16(32, false)).toBe(Math.round(xmSampleRate(sample)));
  });
});
