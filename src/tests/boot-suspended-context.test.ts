/**
 * Boot-stall regression (2026-09-06 mobile boot fix; supersedes the parked
 * diagnostic test diag-boot-stall.test.ts).
 *
 * The handheld failure mode: a fresh tab boots with a SUSPENDED
 * AudioContext (autoplay policy — no user gesture yet; see D122). While
 * suspended the render thread never runs, so the synth worklet never
 * finishes its WASM init handshake. The old boot awaited the patch chain
 * (`loadSystemBankIfPresent` → `applyPatchObject` → `waitForInstrumentReady`)
 * against that dead handshake, burned the full 8 s readiness timeout, and
 * mounted degraded: default patch never applied, audio dead, and the
 * song-loading overlay stuck over the pattern.
 *
 * The fix (plan in .ai/plan.md):
 *   1. loader: the 5 s handshake window only starts once the context is
 *      running (suspend-aware), and a rejected handshake leaves no live
 *      listeners/ports behind;
 *   2. InstrumentV2.ensureInitialized(): a failed attempt can be retried;
 *   3. AudioSystem.whenRunning(): awaitable "context is running" signal;
 *   4. boot: strict awaited sequencing on a running context (desktop),
 *      deferred patch init + resume trigger on a suspended one.
 *
 * Coverage here:
 *   A. boot does not block on a suspended context (no patch chain starts,
 *      boot's awaited set settles without the 8 s burn);
 *   B. resume completes the handshake and applies the system bank's default
 *      patch EXACTLY ONCE, even when the resume trigger fires twice;
 *   C. suspend-aware loader timeout (no 5 s rejection while suspended;
 *      completes once running; closed context bails; running-context
 *      failure cleans up its listeners and abandons the node);
 *   D. the old bounded-cap behaviour: waitForInstrumentReady still returns
 *      false after ONE 8 s window when the context never resumes, and
 *      applyPatchObject still bails without applying.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import type InstrumentV2 from 'src/audio/instrument-v2';
import { createStandardAudioWorklet } from 'src/audio/audio-processor-loader';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { usePatchStore } from 'src/stores/patch-store';
import runBoot from 'src/boot/pinia-audio-system';

// Under vue-tsc the '#q-app/wrappers' stub resolves through tsconfig paths to
// Quasar's real typing, whose returned boot fn takes a context parameter;
// normalize both worlds to the zero-arg async fn the boot module exports.
const runBootFn = runBoot as unknown as () => Promise<void>;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type PortListener = (ev: MessageEvent) => void;

interface FakePort {
  sent: Array<Record<string, unknown>>;
  deliver(data: unknown): void;
  deliverError(data?: unknown): void;
  listenerCount(type: string): number;
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener(type: string, fn: PortListener): void;
  removeEventListener(type: string, fn: PortListener): void;
}

function makeFakePort(): FakePort {
  const listeners: Record<string, PortListener[]> = {
    message: [],
    messageerror: [],
  };
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    start: vi.fn(),
    close: vi.fn(),
    postMessage: vi.fn((msg: Record<string, unknown>) => {
      sent.push(msg);
    }),
    addEventListener(type: string, fn: PortListener) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: PortListener) {
      const arr = listeners[type];
      if (!arr) return;
      const index = arr.indexOf(fn);
      if (index >= 0) arr.splice(index, 1);
    },
    deliver(data: unknown) {
      for (const fn of [...(listeners.message ?? [])]) {
        fn({ data } as MessageEvent);
      }
    },
    deliverError(data?: unknown) {
      for (const fn of [...(listeners.messageerror ?? [])]) {
        fn({ data } as MessageEvent);
      }
    },
    listenerCount(type: string) {
      return (listeners[type] ?? []).length;
    },
  };
}

interface FakeNode {
  port: FakePort;
  parameters: { get(name: string): Record<string, unknown> };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeParam() {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

function makeFakeNode(): FakeNode {
  const params = new Map<string, Record<string, unknown>>();
  return {
    port: makeFakePort(),
    parameters: {
      get(name: string) {
        if (!params.has(name)) params.set(name, makeParam());
        return params.get(name)!;
      },
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

const fakeNodes: FakeNode[] = [];

interface FakeContext {
  state: string;
  currentTime: number;
  sampleRate: number;
  destination: { connect: ReturnType<typeof vi.fn> };
  createGain(): { gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  audioWorklet: { addModule: ReturnType<typeof vi.fn> };
  resume: ReturnType<typeof vi.fn>;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  setState(next: string): void;
}

function makeFakeContext(initialState: string): FakeContext {
  const stateListeners = new Set<() => void>();
  const ctx: FakeContext = {
    state: initialState,
    currentTime: 0,
    sampleRate: 48000,
    destination: { connect: vi.fn() },
    createGain: () => ({
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    resume: vi.fn().mockResolvedValue(undefined),
    addEventListener(type: string, fn: () => void) {
      if (type === 'statechange') stateListeners.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      stateListeners.delete(fn);
    },
    setState(next: string) {
      ctx.state = next;
      for (const fn of [...stateListeners]) fn();
    },
  };
  return ctx;
}

function makeFakeAudioSystem(ctx: FakeContext) {
  return {
    audioContext: ctx,
    destinationNode: ctx.createGain(),
    // Mirrors AudioSystem.whenRunning: resolve on statechange reaching
    // running (or closed); never a bare resume() await.
    whenRunning(): Promise<void> {
      if (ctx.state === 'running') return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = () => {
          if (ctx.state === 'running' || ctx.state === 'closed') {
            ctx.removeEventListener('statechange', check);
            resolve();
          }
        };
        ctx.addEventListener('statechange', check);
        if (ctx.state === 'running' || ctx.state === 'closed') {
          ctx.removeEventListener('statechange', check);
          resolve();
        }
      });
    },
  };
}

// The shipped system bank's first patch — a real, validated patch fixture so
// applyPatchObject's full path (deserialize → layout/asset/macro stores →
// loadPatch) is exercised, not a hand-rolled minimal shape.
const systemBankJson = readFileSync(
  // Vite rewrites import.meta.url to a non-file URL under vitest; resolve
  // against the process working directory (the project root) instead.
  resolve(process.cwd(), 'public/system-bank.json'),
  'utf-8',
);
const systemBankFirstPatch = (
  JSON.parse(systemBankJson) as {
    patches: Array<{ metadata: { id: string; name: string } }>;
  }
).patches[0]!;

const fetchStub = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url.includes('system-bank.json')) {
    return {
      ok: true,
      status: 200,
      text: async () => systemBankJson,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
  if (url.includes('wasm')) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
      text: async () => '',
    };
  }
  return {
    ok: false,
    status: 404,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => '',
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let fakeContext: ReturnType<typeof makeFakeContext>;
let fakeSystem: ReturnType<typeof makeFakeAudioSystem>;

vi.mock('src/audio/shared-audio-system', () => ({
  getSharedAudioSystem: () => fakeSystem,
  peekSharedAudioSystem: () => fakeSystem,
  resetSharedAudioSystem: () => {},
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

beforeEach(() => {
  setActivePinia(createPinia());
  fakeNodes.length = 0;
  fakeContext = makeFakeContext('suspended');
  fakeSystem = makeFakeAudioSystem(fakeContext);
  vi.useFakeTimers();
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port: FakePort;
      parameters: FakeNode['parameters'];
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      constructor() {
        const node = makeFakeNode();
        this.port = node.port;
        this.parameters = node.parameters;
        this.connect = node.connect;
        this.disconnect = node.disconnect;
        fakeNodes.push(this as unknown as FakeNode);
      }
    },
  );
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// A + B: boot on a suspended context
// ---------------------------------------------------------------------------

describe('boot with a suspended AudioContext (mobile boot-stall fix)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('A: mounts immediately — no patch chain, no 8 s burn, init stays pending', async () => {
    const patchStore = usePatchStore();
    const instrumentStore = useInstrumentStore();
    const actionNames: string[] = [];
    patchStore.$onAction(({ name }) => actionNames.push(name));

    await runBootFn();

    // Boot's awaited set (settings store, AudioSystem init, setupAudio)
    // settled without blocking on the handshake: the suspended-context
    // readiness burn (>= 8 s) never happened before mount.
    expect(instrumentStore.currentInstrument).toBeTruthy();
    expect(actionNames).toContain('initializeSessionOnce');
    expect(actionNames).not.toContain('loadSystemBankIfPresent');
    expect(actionNames).not.toContain('applyPatchObject');
    expect(patchStore.currentPatchId).toBeNull();

    // The deferred session init is parked on the resume signal: still
    // pending well past the old immediate-fail window, and no patch was
    // applied in the meantime.
    let settled = false;
    void patchStore.initializeSessionOnce().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    expect(patchStore.currentPatchId).toBeNull();
  });

  it('B: resume completes the handshake and applies the default patch exactly once', async () => {
    const patchStore = usePatchStore();
    const instrumentStore = useInstrumentStore();

    await runBootFn();
    const instrument = instrumentStore.currentInstrument as InstrumentV2;
    const loadPatchSpy = vi.spyOn(instrument, 'loadPatch');

    // The resume trigger from boot fires twice (belt-and-braces in the plan:
    // ensureInitialized + re-kick converge on the exactly-once owner).
    const trigger = async () => {
      await instrument.ensureInitialized();
      await patchStore.initializeSessionOnce();
    };

    // First gesture: the context resumes -------------------------------
    fakeContext.setState('running');
    await vi.advanceTimersByTimeAsync(1);

    // Render thread now runs: the processor constructor posts `ready`, the
    // loader fetches the WASM and posts it back.
    const node = fakeNodes[0]!;
    node.port.deliver({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(1);
    expect(node.port.sent.some((m) => m.type === 'wasm-binary')).toBe(true);

    // Handshake completes: the instrument wires the message handler.
    await vi.advanceTimersByTimeAsync(1);

    // WASM init done: the processor broadcasts its initial state, which
    // auto-initializes the message handler.
    node.port.deliver({ type: 'initialState', state: {} });
    expect(instrument.isReady).toBe(true);

    // Flush the readiness poll + the system bank application (incl. the
    // convolver regeneration's 2 s generation wait).
    await vi.advanceTimersByTimeAsync(6000);

    expect(patchStore.currentPatchId).toBe(systemBankFirstPatch.metadata.id);
    expect(loadPatchSpy).toHaveBeenCalledTimes(1);

    // --- resume trigger fires twice: still exactly once --------------------
    await trigger();
    await vi.advanceTimersByTimeAsync(500);
    expect(loadPatchSpy).toHaveBeenCalledTimes(1);
    expect(patchStore.currentPatchId).toBe(systemBankFirstPatch.metadata.id);
  });
});

// ---------------------------------------------------------------------------
// C: suspend-aware loader handshake
// ---------------------------------------------------------------------------

describe('createStandardAudioWorklet handshake window', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('does not reject at 5 s while suspended; completes once running', async () => {
    let resolved = false;
    let rejected = false;
    const promise = createStandardAudioWorklet(
      fakeContext as unknown as AudioContext,
    ).then(
      () => {
        resolved = true;
      },
      () => {
        rejected = true;
      },
    );

    // Well past the old 5 s window, still suspended: no timeout, no
    // rejection — the handshake window has not even started.
    await vi.advanceTimersByTimeAsync(6000);
    expect(resolved).toBe(false);
    expect(rejected).toBe(false);

    // First gesture: context runs, the render thread posts `ready`.
    fakeContext.setState('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(fakeNodes).toHaveLength(1);
    const node = fakeNodes[0]!;
    node.port.deliver({ type: 'ready' });
    // Within 5 s of running: resolved.
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(resolved).toBe(true);
    expect(rejected).toBe(false);
    expect(node.port.sent.some((m) => m.type === 'wasm-binary')).toBe(
      true,
    );
  });

  it('running context with a dead handshake rejects at 5 s and abandons the node', async () => {
    fakeContext.state = 'running';
    const pending = createStandardAudioWorklet(
      fakeContext as unknown as AudioContext,
    );

    await vi.advanceTimersByTimeAsync(5200);
    await expect(pending).rejects.toThrow(
      'Timeout waiting for synth initialization',
    );

    const node = fakeNodes[0]!;
    // No zombie processor: the handshake listeners are gone and the port is
    // closed, so a later resume cannot spin up a second, never-connected
    // engine graph on the render thread.
    expect(node.port.listenerCount('message')).toBe(0);
    expect(node.port.listenerCount('messageerror')).toBe(0);
    expect(node.port.close).toHaveBeenCalled();
    expect(node.disconnect).toHaveBeenCalled();
  });

  it('a closed context rejects instead of waiting forever', async () => {
    fakeContext.state = 'closed';
    await expect(
      createStandardAudioWorklet(fakeContext as unknown as AudioContext),
    ).rejects.toThrow('AudioContext closed before synth initialization');
  });

  it('a messageerror rejects and cleans up the listeners', async () => {
    fakeContext.state = 'running';
    const pending = createStandardAudioWorklet(
      fakeContext as unknown as AudioContext,
    );
    // Flush the addModule await so the node (and its port listeners) exist.
    await vi.advanceTimersByTimeAsync(1);
    const node = fakeNodes[0]!;
    node.port.deliverError(new Error('boom'));
    await expect(pending).rejects.toThrow('boom');
    expect(node.port.listenerCount('message')).toBe(0);
    expect(node.port.close).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D: the old bounded-cap behaviour (kept from the diagnostic test)
// ---------------------------------------------------------------------------

describe('bounded readiness cap when the context never resumes', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('waitForInstrumentReady burns ONE 8 s window and returns false', async () => {
    const instrumentStore = useInstrumentStore();
    await instrumentStore.setupAudio();
    const start = Date.now();
    const readyPromise = instrumentStore.waitForInstrumentReady(8000);
    // Drive the 50 ms poll loop with fake timers past the 8 s deadline.
    await vi.advanceTimersByTimeAsync(8300);
    const ok = await readyPromise;
    const elapsed = Date.now() - start;
    expect(ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(8000 - 50);
  });

  it('applyPatchObject bails without applying anything when never resumed', async () => {
    const patchStore = usePatchStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const patch = {
      metadata: { id: 'diag-patch', name: 'diag' },
      synthState: {
        layout: {
          voiceCount: 1,
          voices: [{ id: 'v0', node_type: 'oscillator' }],
        },
      },
    } as unknown as Parameters<
      ReturnType<typeof usePatchStore>['applyPatchObject']
    >[0];

    const applyPromise = patchStore.applyPatchObject(patch as never);
    await vi.advanceTimersByTimeAsync(8300);
    const applied = await applyPromise;

    expect(applied).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'Cannot apply patch because instrument is not ready',
    );
  });
});