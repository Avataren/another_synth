import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PortId, WasmModulationType } from 'app/public/wasm/audio_processor';
import { VoiceNodeType } from '../../src/audio/types/synth-layout';
import type { EnvelopeConfig } from '../../src/audio/types/synth-layout';
import { PooledInstrument } from '../../src/audio/pooled-instrument-factory';
import { SynthAudioProcessor } from './synth-worklet-testable';

type EngineCalls = {
  createdNodes: string[];
  deletedNodes: string[];
  connections: Array<{
    fromId: string;
    fromPort: PortId;
    toId: string;
    toPort: PortId;
    amount: number;
    modulationType: WasmModulationType;
    modulationTransformation: number;
  }>;
  removedConnections: Array<{
    fromId: string;
    toId: string;
    toPort: PortId;
  }>;
};

const createEngine = (name: string) => {
  const calls: EngineCalls = {
    createdNodes: [],
    deletedNodes: [],
    connections: [],
    removedConnections: [],
  };
  const nodeId = 'shared-node-id';

  const engine = {
    name,
    create_oscillator: vi.fn(() => {
      calls.createdNodes.push(nodeId);
      return nodeId;
    }),
    create_filter: vi.fn(() => {
      calls.createdNodes.push(nodeId);
      return nodeId;
    }),
    create_envelope: vi.fn(() => {
      calls.createdNodes.push(nodeId);
      return nodeId;
    }),
    create_lfo: vi.fn(() => {
      calls.createdNodes.push(nodeId);
      return nodeId;
    }),
    create_wavetable_oscillator: vi.fn(() => {
      calls.createdNodes.push(nodeId);
      return nodeId;
    }),
    create_sampler: vi.fn(() => {
      calls.createdNodes.push(nodeId);
      return nodeId;
    }),
    create_noise: vi.fn(() => {
      calls.createdNodes.push(nodeId);
      return nodeId;
    }),
    delete_node: vi.fn((nodeId: string) => {
      calls.deletedNodes.push(nodeId);
    }),
    init: vi.fn(),
    initWithPatch: vi.fn(),
    get_current_state: vi.fn(() => ({ voices: [] })),
    update_noise: vi.fn(),
    update_envelope: vi.fn(),
    update_oscillator: vi.fn(),
    update_wavetable_oscillator: vi.fn(),
    get_filter_ir_waveform: vi.fn(() => new Float32Array([0, 0.5, 1, 0.5])),
    update_lfos: vi.fn(),
    connect_nodes: vi.fn(
      (
        fromId: string,
        fromPort: PortId,
        toId: string,
        toPort: PortId,
        amount: number,
        modulationType: WasmModulationType,
        modulationTransformation: number,
      ) => {
        calls.connections.push({
          fromId,
          fromPort,
          toId,
          toPort,
          amount,
          modulationType,
          modulationTransformation,
        });
      },
    ),
    remove_specific_connection: vi.fn(
      (fromId: string, toId: string, toPort: PortId) => {
        calls.removedConnections.push({ fromId, toId, toPort });
      },
    ),
  };

  return { engine, calls };
};

class TestSynthAudioProcessor extends SynthAudioProcessor {
  // Engine doubles intentionally replace the WASM AudioEngine boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  testGraphEngines: any[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(engines: any[]) {
    super();
    this.testGraphEngines = engines;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).audioEngines = engines;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).instrumentSlots = new Map([
      [
        'instrument-01',
        { engine: engines[0], adapter: null, initialized: true },
      ],
    ]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override getGraphEngines(): any[] {
    return this.testGraphEngines;
  }

  public exposeInstrumentSlots(): Map<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).instrumentSlots;
  }

  public createSlot(
    instrumentId: string,
    startVoice: number,
    voiceCount: number,
    voiceLimit: number,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).getOrCreateInstrumentSlot(
      instrumentId,
      startVoice,
      voiceCount,
      voiceLimit,
    );
  }
}

const createProcessorHarness = () => {
  const first = createEngine('engine-0');
  const second = createEngine('engine-1');
  const posted: unknown[] = [];

  vi.stubGlobal('sampleRate', 48000);
  const processor = new TestSynthAudioProcessor([first.engine, second.engine]);
  (
    processor as unknown as {
      port: { postMessage: (message: unknown) => void };
    }
  ).port.postMessage = vi.fn((message: unknown) => {
    posted.push(message);
  });

  return {
    processor,
    engines: [first, second],
    posted,
  };
};

describe('worklet graph editing synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the same node id in every pooled engine', () => {
    const harness = createProcessorHarness();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (harness.processor as any).handleCreateNode({
      nodeType: VoiceNodeType.Oscillator,
    });

    const created = harness.engines.map(({ calls }) => calls.createdNodes);
    expect(created[0]).toEqual(created[1]);
    expect(created[0]).toHaveLength(1);
    expect(harness.posted).toContainEqual(
      expect.objectContaining({
        type: 'nodeCreated',
        nodeId: created[0]![0],
      }),
    );
  });

  it('applies node state updates to every pooled engine', () => {
    const harness = createProcessorHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = harness.processor as any;

    processor.audioEngines = harness.engines.map(({ engine }) => engine);
    processor.instrumentSlots = new Map();

    processor.handleNoiseUpdate({
      noiseId: 'noise-node',
      config: { noise_type: 0, cutoff: 1000, gain: 0.5, enabled: true },
    });

    harness.engines.forEach(({ engine }) => {
      expect(engine.update_noise).toHaveBeenCalledWith(
        'noise-node',
        expect.anything(),
      );
    });
  });

  it('applies oscillator and envelope state updates to every pooled engine', () => {
    const harness = createProcessorHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = harness.processor as any;

    processor.audioEngines = harness.engines.map(({ engine }) => engine);
    processor.instrumentSlots = new Map();

    processor.handleUpdateOscillator({
      oscillatorId: 'osc-node',
      newState: {
        phase_mod_amount: 0,
        detune: 0,
        hard_sync: false,
        gain: 0.5,
        active: true,
        feedback_amount: 0,
        waveform: 1,
        unison_voices: 1,
        spread: 0,
      },
    });
    processor.handleUpdateEnvelope({
      envelopeId: 'env-node',
      config: {
        attack: 0,
        decay: 0.1,
        sustain: 0.5,
        release: 0.2,
        attackCurve: 0,
        decayCurve: 0,
        releaseCurve: 0,
        active: true,
      },
      messageId: 'message-1',
    });

    const oscillatorState = expect.objectContaining({ gain: 0.5 });
    harness.engines.forEach(({ engine }) => {
      expect(engine.update_oscillator).toHaveBeenCalledWith(
        'osc-node',
        oscillatorState,
      );
      expect(engine.update_envelope).toHaveBeenCalledWith(
        'env-node',
        0,
        0.1,
        0.5,
        0.2,
        0,
        0,
        0,
        true,
      );
    });
  });

  it('applies connection changes to every pooled engine', () => {
    const harness = createProcessorHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = harness.processor as any;

    processor.instrumentSlots = new Map();

    processor.handleUpdateConnection({
      connection: {
        fromId: 'source-node',
        toId: 'target-node',
        target: PortId.CutoffMod,
        amount: 0.75,
        modulationType: WasmModulationType.Additive,
        modulationTransformation: 0,
      },
    });

    harness.engines.forEach(({ engine, calls }) => {
      expect(engine.remove_specific_connection).toHaveBeenCalledWith(
        'source-node',
        'target-node',
        PortId.CutoffMod,
      );
      expect(calls.connections).toEqual([
        expect.objectContaining({
          fromId: 'source-node',
          toId: 'target-node',
          toPort: PortId.CutoffMod,
          amount: 0.75,
        }),
      ]);
    });
  });

  it('removes connection changes from every pooled engine', () => {
    const harness = createProcessorHarness();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = harness.processor as any;
    processor.instrumentSlots = new Map();

    processor.handleUpdateConnection({
      connection: {
        fromId: 'source-node',
        toId: 'target-node',
        target: PortId.GainMod,
        amount: 0,
        isRemoving: true,
        modulationTransformation: 0,
      },
    });

    harness.engines.forEach(({ engine, calls }) => {
      expect(engine.remove_specific_connection).toHaveBeenCalledWith(
        'source-node',
        'target-node',
        PortId.GainMod,
      );
      expect(calls.connections).toHaveLength(0);
    });
  });

  it('replaces pooled adapters and parameter caches when voice count changes', () => {
    const harness = createProcessorHarness();

    const mono = harness.processor.createSlot('instrument', 0, 1, 1);
    expect(mono.adapter).toBeDefined();
    const firstAdapter = mono.adapter;

    const poly = harness.processor.createSlot('instrument', 0, 8, 8);
    expect(poly).not.toBe(mono);
    expect(poly.adapter).not.toBe(firstAdapter);
    expect(firstAdapter.free).toHaveBeenCalledOnce();

    const reused = harness.processor.createSlot('instrument', 4, 8, 4);
    expect(reused).toBe(poly);
    expect(reused.startVoice).toBe(4);
    expect(reused.voiceLimit).toBe(4);
    expect(reused.adapter).toBe(poly.adapter);
    expect(poly.adapter.free).not.toHaveBeenCalled();
  });
});

describe('filter IR request contract', () => {
  it('correlates responses by messageId and instrument', () => {
    const harness = createProcessorHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = harness.processor as any;

    processor.handleGetFilterIrWaveform({
      node_id: '10003',
      length: 4,
      messageId: 'ir-request-1',
      instrumentId: 'instrument-01',
    });

    const message = harness.posted.find(
      (item) =>
        (item as { type?: string; messageId?: string }).messageId ===
        'ir-request-1',
    ) as { type?: string; waveform?: Float32Array } | undefined;

    expect(message?.type).toBe('FilterIrWaveform');
    expect(Array.from(message!.waveform!)).toEqual([0, 0.5, 1, 0.5]);

    const calls = harness.engines.flatMap(
      ({ engine }) =>
        // Engine doubles are intentionally loosely typed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (engine.get_filter_ir_waveform as any).mock.calls,
    );

    expect(calls).toContainEqual(expect.arrayContaining(['10003', 4]));
    expect(calls.some((call) => call[0] === '10003' && call[1] === 4)).toBe(
      true,
    );
  });
});

describe('pooled instrument postMessage safety', () => {
  it('clones reactive convolver state before posting', () => {
    const port = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const allocation = {
      workletNode: { port } as unknown as AudioWorkletNode,
      workletIndex: 0,
      startVoice: 0,
      endVoice: 1,
      voiceCount: 1,
      memory: {} as WebAssembly.Memory,
    };

    const instrument = new PooledInstrument(
      { connect: vi.fn() } as unknown as AudioNode,
      {
        createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
        currentTime: 0,
      } as unknown as AudioContext,
      'instrument-01',
      allocation,
    );

    const reactiveState = {
      id: 'convolver-node',
      wetMix: 0.5,
      active: true,
      generator: {
        type: 'hall' as const,
        decayTime: 2,
        size: 0.7,
        sampleRate: 48000,
      },
    };

    instrument.updateConvolverState('convolver-node', reactiveState);

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'updateConvolver',
        nodeId: 'convolver-node',
        state: {
          id: 'convolver-node',
          wetMix: 0.5,
          active: true,
          generator: {
            type: 'hall',
            decayTime: 2,
            size: 0.7,
            sampleRate: 48000,
          },
        },
        instrumentId: 'instrument-01',
      }),
    );

    const posted = (port.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      state: object;
    };
    expect(posted.state).not.toBe(reactiveState);
  });

  it('accepts pooled envelope updates using the documented state field', () => {
    const harness = createProcessorHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = harness.processor as any;
    const slots = processor.exposeInstrumentSlots();
    const existingSlot = slots.get('instrument-01');
    slots.set('instrument-01', {
      ...existingSlot,
      voiceCount: 1,
      voiceLimit: 1,
      startVoice: 0,
    });

    processor.handleUpdateEnvelope({
      envelopeId: 'env-node',
      messageId: 'env-update-1',
      instrumentId: 'instrument-01',
      state: {
        id: 'env-node',
        attack: 0.01,
        decay: 0.2,
        sustain: 0.4,
        release: 0.8,
        attackCurve: -2,
        decayCurve: 3,
        releaseCurve: 1,
        active: false,
      },
    });

    expect(
      harness.engines[0]!.engine.update_envelope,
    ).toHaveBeenCalledWith(
      'env-node',
      0.01,
      0.2,
      0.4,
      0.8,
      -2,
      3,
      1,
      false,
    );
    expect(
      harness.engines[1]!.engine.update_envelope,
    ).not.toHaveBeenCalled();
  });
});

describe('pooled envelope message serialization', () => {
  const createPooledInstrument = () => {
    const port = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const allocation = {
      workletNode: { port } as unknown as AudioWorkletNode,
      workletIndex: 0,
      startVoice: 0,
      endVoice: 1,
      voiceCount: 1,
      memory: {} as WebAssembly.Memory,
    };

    const instrument = new PooledInstrument(
      { connect: vi.fn() } as unknown as AudioNode,
      {
        createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
        currentTime: 0,
      } as unknown as AudioContext,
      'instrument-01',
      allocation,
    );

    return { instrument, port };
  };

  it('clones reactive envelope updates before posting', () => {
    const { instrument, port } = createPooledInstrument();
    const reactiveState = {
      id: 'env-node',
      attack: 0.02,
      decay: 0.3,
      sustain: 0.6,
      release: 0.9,
      attackCurve: 1,
      decayCurve: 2,
      releaseCurve: 3,
      active: true,
    };

    void instrument.updateEnvelopeState('env-node', reactiveState);

    const posted = (port.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { state: object };
    expect(posted.state).toEqual({
      id: 'env-node',
      attack: 0.02,
      decay: 0.3,
      sustain: 0.6,
      release: 0.9,
      active: true,
    });
    expect(posted.state).not.toBe(reactiveState);
  });

  it('clones reactive envelope preview configs before posting', () => {
    const { instrument, port } = createPooledInstrument();
    const reactiveConfig = {
      id: 'env-node',
      attack: 0.03,
      decay: 0.25,
      sustain: 0.7,
      release: 0.5,
      attackCurve: 0,
      decayCurve: 0,
      releaseCurve: 0,
      active: true,
    } as EnvelopeConfig;

    void instrument.getEnvelopePreview(reactiveConfig, 2);

    const posted = (port.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { config: EnvelopeConfig };
    expect(posted.config).toEqual(reactiveConfig);
    expect(posted.config).not.toBe(reactiveConfig);
  });
});

describe('envelope preview request contract', () => {
  it('correlates preview response by messageId', () => {
    const harness = createProcessorHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = harness.processor as any;

    const config = {
      id: 'env-node',
      attack: 0,
      decay: 0.1,
      sustain: 0.5,
      release: 0.1,
      active: true,
    };

    processor.handleGetEnvelopePreview({
      config,
      previewDuration: 1,
      messageId: 'preview-request-1',
      instrumentId: 'instrument-01',
    });

    expect(harness.posted).toContainEqual(
      expect.objectContaining({
        type: 'envelopePreview',
        source: 'getEnvelopePreview',
        messageId: 'preview-request-1',
        instrumentId: 'instrument-01',
      }),
    );
  });
});
