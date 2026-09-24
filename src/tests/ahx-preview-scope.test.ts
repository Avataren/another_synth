// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AhxPlayerClient, AhxWaveforms } from 'src/audio/tracker/ahx-player';
import { AhxPreview } from 'src/audio/tracker/ahx-preview';

/**
 * The instrument page's scope reads the keyboard preview voice's own waveform
 * (`AhxPreview.setCapture` / `getWaveform`): the worklet records it only while
 * asked, a client made later is asked too, and the waveform is voice 0's run
 * of the snapshot (the previewed note's voice).
 */

interface FakeClient {
  capture: boolean[];
  emit: (w: AhxWaveforms) => void;
  subscribers: () => number;
  client: AhxPlayerClient;
}

function fakeClient(ctx: object): FakeClient {
  const capture: boolean[] = [];
  const listeners = new Set<(w: AhxWaveforms) => void>();
  const client = {
    audioContext: ctx,
    output: { connect: () => undefined },
    setPreview: () => undefined,
    setHifi: () => undefined,
    setCapture: (enabled: boolean) => capture.push(enabled),
    loadSong: async () => ({}),
    previewNoteOn: () => undefined,
    previewNoteOff: () => undefined,
    onPListRow: () => () => true,
    onWaveforms: (listener: (w: AhxWaveforms) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => undefined,
  } as unknown as AhxPlayerClient;
  return {
    capture,
    emit: (w) => {
      for (const listener of listeners) listener(w);
    },
    subscribers: () => listeners.size,
    client,
  };
}

const snapshot = (): AhxWaveforms =>
  ({ type: 'waveforms', channels: 2, points: 3, data: new Int16Array([1, 2, 3, 7, 8, 9]) }) as AhxWaveforms;

function preview() {
  const clients: FakeClient[] = [];
  const host = { audioContext: {} as AudioContext, output: {} as AudioNode };
  const p = new AhxPreview(host, async (c) => {
    const fake = fakeClient(c);
    clients.push(fake);
    return fake.client;
  });
  return { p, clients };
}

describe('AhxPreview waveform capture', () => {
  it('is off by default: nothing asked of the worklet, no waveform', async () => {
    const { p, clients } = preview();
    await p.preload(new Uint8Array([1]));
    expect(clients[0]!.capture).toEqual([]);
    expect(clients[0]!.subscribers()).toBe(0);
    expect(p.getWaveform()).toBeNull();
  });

  it('asked for before the worklet exists, the new worklet records; the waveform is voice 0', async () => {
    const { p, clients } = preview();
    p.setCapture(true);
    await p.preload(new Uint8Array([1]));
    expect(clients[0]!.capture).toEqual([true]);
    clients[0]!.emit(snapshot());
    expect(Array.from(p.getWaveform() ?? [])).toEqual([1, 2, 3]);
  });

  it('turned off, the worklet stops recording and the waveform goes', async () => {
    const { p, clients } = preview();
    await p.preload(new Uint8Array([1]));
    p.setCapture(true);
    clients[0]!.emit(snapshot());
    p.setCapture(false);
    expect(clients[0]!.capture).toEqual([true, false]);
    expect(clients[0]!.subscribers()).toBe(0);
    expect(p.getWaveform()).toBeNull();
  });
});
