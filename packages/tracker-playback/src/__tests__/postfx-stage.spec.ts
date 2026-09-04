/**
 * Post-fx graph tests, run against the named mock seam: `AudioNodeFactory`.
 *
 * The test env has no Web Audio (jsdom implements no AudioContext, review
 * M4), so every topology/scheduling pin here drives the real
 * `AmigaLpfStage`/`PostFxRack` code with a stub factory whose nodes record
 * connect()/disconnect() edges and AudioParam event lists.
 */

import { describe, expect, it, vi } from 'vitest';
import { AmigaLpfStage } from '../postfx/amiga-lpf-stage';
import { PostFxRack } from '../postfx/post-fx-rack';
import type { AudioNodeFactory } from '../postfx/post-fx-stage';
import type { PostFxStage } from '../postfx/post-fx-stage';

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
  /** Drop automation and jump straight to a value (mock-only helper). */
  applyImmediate(value: number, now: number): void {
    this.events = this.events.filter(
      (e) => e.type === 'cancelScheduledValues' || (e.args[1] as number) <= now,
    );
    this.value = value;
  }
}

class MockNode {
  readonly gain = new MockParam();
  readonly connections: MockNode[] = [];
  readonly disconnected: MockNode[] = [];
  readonly iir: { ff: number[]; fb: number[] } | null = null;
  constructor(iir?: { ff: number[]; fb: number[] }) {
    if (iir) {
      (this as { iir?: { ff: number[]; fb: number[] } }).iir = iir;
    }
  }
  connect(target: MockNode): MockNode {
    this.connections.push(target);
    return target;
  }
  disconnect(...targets: MockNode[]): MockNode {
    if (targets.length === 0) {
      this.connections.length = 0;
    } else {
      for (const t of targets) {
        const index = this.connections.indexOf(t);
        if (index >= 0) this.connections.splice(index, 1);
        this.disconnected.push(t);
      }
    }
    return this as unknown as MockNode;
  }
}

function createMockFactory() {
  const nodes: MockNode[] = [];
  const factory: AudioNodeFactory = {
    createGain: () => {
      const node = new MockNode();
      nodes.push(node);
      return node as unknown as GainNode;
    },
    createIIRFilter: (ff: number[], fb: number[]) => {
      const node = new MockNode({ ff, fb });
      nodes.push(node);
      return node as unknown as IIRFilterNode;
    },
  };
  return { nodes, factory };
}

const mockContext = (currentTime = 100) =>
  ({ currentTime, sampleRate: 44100 }) as unknown as BaseAudioContext;

/** Context stub for the rack, which builds its endpoints itself. */
const mockRackContext = (currentTime = 100) => {
  const gains: MockNode[] = [];
  return {
    currentTime,
    createGain: () => {
      const node = new MockNode();
      gains.push(node);
      return node as unknown as GainNode;
    },
  } as unknown as BaseAudioContext;
};

describe('AmigaLpfStage topology (mock seam)', () => {
  it('wires the three branches: dry, RC+LED (wet), RC-only', () => {
    const { nodes, factory } = createMockFactory();
    const stage = new AmigaLpfStage(
      mockContext(),
      undefined,
      factory,
    );
    const input = stage.input as unknown as MockNode;
    const gains = nodes.filter((n) => !n.iir);
    const filters = nodes.filter((n) => n.iir);
    expect(gains.length).toBe(5); // input, output, dry, rcBypass, wet
    expect(filters.length).toBe(2); // rc, led

    // input -> dry -> output
    expect(input.connections).toContain(gains[2]);
    expect(gains[2]!.connections).toContain(stage.output as unknown as MockNode);
    // input -> rc -> led -> wet -> output
    expect(input.connections).toContain(filters[0]);
    expect(filters[0]!.connections).toContain(filters[1]);
    expect(filters[1]!.connections).toContain(gains[4]);
    expect(gains[4]!.connections).toContain(stage.output as unknown as MockNode);
    // input -> rc -> rcBypass -> output (RC-only branch, LED bypassed)
    expect(filters[0]!.connections).toContain(gains[3]);
    expect(gains[3]!.connections).toContain(stage.output as unknown as MockNode);
    stage.dispose();
  });

  it('starts in AUTO-off: bypass branch unity, filter branches silent', () => {
    const { nodes, factory } = createMockFactory();
    const stage = new AmigaLpfStage(mockContext(), undefined, factory);
    const gains = nodes.filter((n) => !n.iir);
    // input, output, dry, rcBypass, wet
    expect(gains[2]!.gain.value).toBe(0); // dry
    expect(gains[3]!.gain.value).toBe(1); // rcBypass (static RC engaged)
    expect(gains[4]!.gain.value).toBe(0); // wet (LED off)
    stage.dispose();
  });

  it('schedules the LED crossfade at the target time, not at scheduling time', () => {
    const { nodes, factory } = createMockFactory();
    const stage = new AmigaLpfStage(mockContext(0), undefined, factory);
    const gains = nodes.filter((n) => !n.iir);
    const [rcBypass, wet] = [gains[3]!.gain, gains[4]!.gain];

    stage.setLedActive(true, 1.0);
    // rcBypass: 1 -> 0 at t=1..1.005; wet: 0 -> 1.
    expect(rcBypass.events).toContainEqual({
      type: 'setValueAtTime', args: [1, 1.0],
    });
    expect(rcBypass.events).toContainEqual({
      type: 'linearRampToValueAtTime', args: [0, 1.005],
    });
    expect(wet.events).toContainEqual({
      type: 'setValueAtTime', args: [0, 1.0],
    });
    expect(wet.events).toContainEqual({
      type: 'linearRampToValueAtTime', args: [1, 1.005],
    });
    // Nothing changed at scheduling time -- state flips at the scheduled t.
    expect(stage.getLedActive()).toBe(true);
    expect(gains[2]!.gain.value).toBe(0); // dry still silent

    // Back-to-back events chain: E00 at t=2 must ramp from the values the
    // first event left behind.
    stage.setLedActive(false, 2.0);
    expect(rcBypass.events).toContainEqual({
      type: 'setValueAtTime', args: [0, 2.0],
    });
    expect(rcBypass.events).toContainEqual({
      type: 'linearRampToValueAtTime', args: [1, 2.005],
    });
    expect(wet.events).toContainEqual({
      type: 'setValueAtTime', args: [1, 2.0],
    });
    expect(wet.events).toContainEqual({
      type: 'linearRampToValueAtTime', args: [0, 2.005],
    });
    stage.dispose();
  });

  it('cancels a pending toggle and re-asserts the applied state', () => {
    const { nodes, factory } = createMockFactory();
    const stage = new AmigaLpfStage(mockContext(0), undefined, factory);
    const gains = nodes.filter((n) => !n.iir);
    const [dry, rcBypass, wet] = [gains[2]!, gains[3]!, gains[4]!];

    stage.setLedActive(true, 1.0);
    expect(stage.getLedActive()).toBe(true);
    stage.cancelPending(0.5);
    // Pending events dropped; the resolved state (LED off in AUTO-off) is
    // asserted at `now`.
    for (const fader of [dry, rcBypass, wet]) {
      expect(fader.gain.events).toContainEqual({
        type: 'cancelScheduledValues', args: [0.5],
      });
      expect(fader.gain.events.at(-1)!.type).toBe('setValueAtTime');
      expect(fader.gain.events.at(-1)!.args[1]).toBe(0.5);
    }
    expect(stage.getLedActive()).toBe(false);
    stage.dispose();
  });

  it('manual bypass (OFF) sends dry to unity and silences the filter branch', () => {
    const { nodes, factory } = createMockFactory();
    const stage = new AmigaLpfStage(mockContext(0), undefined, factory);
    const gains = nodes.filter((n) => !n.iir);
    const [dry, , wet] = [gains[2]!, gains[3]!, gains[4]!];

    stage.setBypassed(true, 2.0);
    expect(dry.gain.events).toContainEqual({
      type: 'setValueAtTime', args: [0, 2.0],
    });
    expect(dry.gain.events).toContainEqual({
      type: 'linearRampToValueAtTime', args: [1, 2.005],
    });
    expect(wet.gain.events).toContainEqual({
      type: 'linearRampToValueAtTime', args: [0, 2.005],
    });
    expect(stage.isBypassed()).toBe(true);

    // Un-bypassing restores the LED state held before the bypass.
    stage.setLedActive(true, 2.0);
    stage.setBypassed(false, 3.0);
    expect(wet.gain.events).toContainEqual({
      type: 'linearRampToValueAtTime', args: [1, 3.005],
    });
    stage.dispose();
  });

  it('setParams rebuilds the IIR nodes with the new coefficients', () => {
    const { nodes, factory } = createMockFactory();
    const stage = new AmigaLpfStage(
      { currentTime: 0, sampleRate: 44100 } as unknown as BaseAudioContext,
      undefined,
      factory,
    );
    const filtersBefore = nodes.filter((n) => n.iir);
    stage.setParams({ staticCutoffHz: 2000, ledCutoffHz: 1500, ledResDb: 0 });
    const filtersAfterRebuild = nodes.filter((n) => n.iir);
    // The rebuilt pair are new nodes, not the originals reused.
    const newRcNode = filtersAfterRebuild[filtersAfterRebuild.length - 2]!;
    const newLedNode = filtersAfterRebuild[filtersAfterRebuild.length - 1]!;
    expect(newRcNode).not.toBe(filtersBefore[0]);
    expect(newLedNode).not.toBe(filtersBefore[1]);
    expect(filtersAfterRebuild.length).toBe(filtersBefore.length + 2);
    const newRc = newRcNode.iir!;
    const newLed = newLedNode.iir!;
    expect(newRc.ff[0]).toBeCloseTo(stage.getCoefficients().rc.b0, 15);
    expect(newLed.ff[0]).toBeCloseTo(stage.getCoefficients().led.b0, 15);
    stage.dispose();
  });
});

describe('PostFxRack', () => {
  function makeStage(id: string): PostFxStage {
    const input = new MockNode();
    const output = new MockNode();
    input.connect(output);
    return {
      id,
      input: input as unknown as AudioNode,
      output: output as unknown as AudioNode,
      dispose: vi.fn(),
    };
  }

  it('chains registered stages input -> stage -> output', () => {
    const rack = new PostFxRack(mockRackContext() as unknown as BaseAudioContext);
    const a = makeStage('a');
    const b = makeStage('b');
    rack.registerStage(a);
    rack.registerStage(b);
    expect(rack.activeStages()).toEqual([a, b]);
    const inNode = rack.input as unknown as MockNode;
    expect(inNode.connections).toContain(a.input);
    expect((a.output as unknown as MockNode).connections).toContain(b.input);
    expect((b.output as unknown as MockNode).connections).toContain(rack.output);
  });

  it('drops a disabled stage from the chain by rewiring', () => {
    const rack = new PostFxRack(mockRackContext() as unknown as BaseAudioContext);
    const a = makeStage('a');
    const b = makeStage('b');
    rack.registerStage(a);
    rack.registerStage(b);
    rack.setStageEnabled(a, false);
    expect(rack.activeStages()).toEqual([b]);
    const inNode = rack.input as unknown as MockNode;
    expect(inNode.connections).toContain(b.input);
    expect(inNode.connections).not.toContain(a.input);
    // Re-enabling restores the order.
    rack.setStageEnabled(a, true);
    expect(rack.activeStages()).toEqual([a, b]);
  });

  it('passes straight through before any stage registers', () => {
    const rack = new PostFxRack(mockRackContext() as unknown as BaseAudioContext);
    const inNode = rack.input as unknown as MockNode;
    expect(inNode.connections).toContain(rack.output);
  });

  it('exposes the context clock for store-facing time', () => {
    const rack = new PostFxRack(mockRackContext(7.25));
    expect(rack.contextTime()).toBe(7.25);
  });
});