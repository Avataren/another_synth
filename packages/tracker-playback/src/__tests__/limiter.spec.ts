/**
 * Limiter pins: the shaper's transfer function (the part that actually
 * guarantees the ceiling) and the stage's graph/bypass behaviour, driven
 * through the same `AudioNodeFactory` seam the other post-fx tests use.
 */

import { describe, expect, it } from 'vitest';
import {
  LIMITER_ATTACK_SECONDS,
  LIMITER_DEFAULT_PARAMS,
  LIMITER_RATIO,
  LIMITER_SHAPER_KNEE,
  buildLimiterCurve,
  dbToLinear,
  limiterShaperTransfer,
  sanitizeLimiterParams,
} from '../postfx/limiter-math';
import { LimiterStage } from '../postfx/limiter-stage';
import type { AudioNodeFactory } from '../postfx/post-fx-stage';

class MockParam {
  value = 1;
  events: Array<{ type: string; args: unknown[] }> = [];
  setValueAtTime(...args: unknown[]): void {
    this.events.push({ type: 'setValueAtTime', args });
  }
  linearRampToValueAtTime(...args: unknown[]): void {
    this.events.push({ type: 'linearRampToValueAtTime', args });
  }
  cancelScheduledValues(...args: unknown[]): void {
    this.events.push({ type: 'cancelScheduledValues', args });
  }
}

class MockNode {
  readonly gain = new MockParam();
  readonly threshold = new MockParam();
  readonly knee = new MockParam();
  readonly ratio = new MockParam();
  readonly attack = new MockParam();
  readonly release = new MockParam();
  reduction = 0;
  oversample = 'none';
  curve: Float32Array | null = null;
  readonly connections: MockNode[] = [];
  connect(target: MockNode): MockNode {
    this.connections.push(target);
    return target;
  }
  disconnect(): void {
    this.connections.length = 0;
  }
}

function createMockFactory() {
  const gains: MockNode[] = [];
  let compressor: MockNode | null = null;
  let shaper: MockNode | null = null;
  const factory: AudioNodeFactory = {
    createGain: () => {
      const node = new MockNode();
      gains.push(node);
      return node as unknown as GainNode;
    },
    createIIRFilter: () => new MockNode() as unknown as IIRFilterNode,
    createDynamicsCompressor: () => {
      compressor = new MockNode();
      return compressor as unknown as DynamicsCompressorNode;
    },
    createWaveShaper: () => {
      shaper = new MockNode();
      return shaper as unknown as WaveShaperNode;
    },
  };
  return {
    factory,
    gains,
    get compressor(): MockNode {
      return compressor!;
    },
    get shaper(): MockNode {
      return shaper!;
    },
  };
}

function makeStage(now = 0) {
  const mock = createMockFactory();
  const context = { currentTime: now, sampleRate: 48000 } as BaseAudioContext;
  const stage = new LimiterStage(context, undefined, mock.factory);
  // Construction order in LimiterStage: input, output, dry, wet.
  const [input, output, dry, wet] = mock.gains as [
    MockNode,
    MockNode,
    MockNode,
    MockNode,
  ];
  return { stage, mock, input, output, dry, wet };
}

describe('limiter shaper transfer', () => {
  const ceiling = dbToLinear(LIMITER_DEFAULT_PARAMS.ceilingDb);

  it('is exactly the identity below the knee', () => {
    for (const x of [0, 0.1, 0.3, LIMITER_SHAPER_KNEE * ceiling]) {
      expect(limiterShaperTransfer(x, ceiling)).toBeCloseTo(x, 12);
      expect(limiterShaperTransfer(-x, ceiling)).toBeCloseTo(-x, 12);
    }
  });

  it('never exceeds the ceiling, however hot the input', () => {
    // tanh saturates to exactly 1 in float64 well before the extremes here,
    // so the bound is "<=": landing *on* the ceiling is not clipping.
    for (const x of [0.9, 1, 2, 10, 1000]) {
      expect(Math.abs(limiterShaperTransfer(x, ceiling))).toBeLessThanOrEqual(
        ceiling,
      );
      expect(Math.abs(limiterShaperTransfer(-x, ceiling))).toBeLessThanOrEqual(
        ceiling,
      );
    }
  });

  it('is monotone and odd across the curve table', () => {
    const curve = buildLimiterCurve(ceiling);
    const mid = (curve.length - 1) / 2;
    expect(curve[mid]).toBeCloseTo(0, 12);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
      expect(Math.abs(curve[i]!)).toBeLessThanOrEqual(ceiling);
    }
    expect(curve[0]).toBeCloseTo(-curve[curve.length - 1]!, 12);
  });

  it('holds a full-scale input just under the ceiling', () => {
    // The whole point: 0 dBFS in, ceiling-ish out.
    const out = limiterShaperTransfer(1, ceiling);
    expect(out).toBeLessThan(ceiling);
    expect(out).toBeGreaterThan(ceiling * 0.9);
  });
});

describe('limiter parameter sanitizing', () => {
  it('clamps and falls back on garbage', () => {
    expect(sanitizeLimiterParams({ ceilingDb: 12, releaseMs: 5 })).toEqual({
      ceilingDb: 0,
      releaseMs: 20,
    });
    expect(
      sanitizeLimiterParams({ ceilingDb: Number.NaN, releaseMs: 1e9 }),
    ).toEqual({
      ceilingDb: LIMITER_DEFAULT_PARAMS.ceilingDb,
      releaseMs: 1000,
    });
    expect(sanitizeLimiterParams({})).toEqual(LIMITER_DEFAULT_PARAMS);
  });
});

describe('limiter stage graph', () => {
  it('wires a dry bypass branch alongside compressor -> shaper -> wet', () => {
    const { mock, input, output, dry, wet } = makeStage();
    expect(input.connections).toContain(dry);
    expect(input.connections).toContain(mock.compressor);
    expect(dry.connections).toContain(output);
    expect(mock.compressor.connections).toContain(mock.shaper);
    expect(mock.shaper.connections).toContain(wet);
    expect(wet.connections).toContain(output);
  });

  it('starts engaged, with limiter (not compressor) settings', () => {
    const { stage, mock, dry, wet } = makeStage();
    expect(stage.isBypassed()).toBe(false);
    expect(dry.gain.value).toBe(0);
    expect(wet.gain.value).toBe(1);
    expect(mock.compressor.ratio.value).toBe(LIMITER_RATIO);
    expect(mock.compressor.knee.value).toBe(0);
    expect(mock.compressor.attack.value).toBe(LIMITER_ATTACK_SECONDS);
    expect(mock.compressor.threshold.value).toBe(
      LIMITER_DEFAULT_PARAMS.ceilingDb,
    );
    expect(mock.compressor.release.value).toBeCloseTo(
      LIMITER_DEFAULT_PARAMS.releaseMs / 1000,
    );
    expect(mock.shaper.oversample).toBe('4x');
    expect(mock.shaper.curve).toBeInstanceOf(Float32Array);
  });

  it('crossfades rather than jumping on bypass, and is idempotent', () => {
    const { stage, dry, wet } = makeStage();
    stage.setBypassed(true, 5);
    expect(stage.isBypassed()).toBe(true);
    for (const [fader, target] of [
      [dry, 1],
      [wet, 0],
    ] as Array<[MockNode, number]>) {
      const ramp = fader.gain.events.filter(
        (e) => e.type === 'linearRampToValueAtTime',
      );
      expect(ramp).toHaveLength(1);
      expect(ramp[0]!.args[0]).toBe(target);
      expect(ramp[0]!.args[1] as number).toBeGreaterThan(5);
      expect(
        fader.gain.events.some((e) => e.type === 'setValueAtTime'),
      ).toBe(true);
    }

    const before = dry.gain.events.length;
    stage.setBypassed(true, 6);
    expect(dry.gain.events.length).toBe(before);
  });

  it('rebuilds the curve and retunes the compressor on setParams', () => {
    const { stage, mock } = makeStage();
    const first = mock.shaper.curve;
    stage.setParams({ ceilingDb: -6, releaseMs: 400 });
    expect(mock.compressor.threshold.value).toBe(-6);
    expect(mock.compressor.release.value).toBeCloseTo(0.4);
    expect(mock.shaper.curve).not.toBe(first);
    const peak = Math.max(...Array.from(mock.shaper.curve!));
    expect(peak).toBeLessThanOrEqual(dbToLinear(-6));
    expect(peak).toBeGreaterThan(dbToLinear(-6) * 0.9);
    expect(stage.getParams()).toEqual({ ceilingDb: -6, releaseMs: 400 });
  });

  it('reports gain reduction only while engaged', () => {
    const { stage, mock } = makeStage();
    mock.compressor.reduction = -4.2;
    expect(stage.getReduction()).toBeCloseTo(-4.2);
    stage.setBypassed(true, 0);
    expect(stage.getReduction()).toBe(0);
  });
});
