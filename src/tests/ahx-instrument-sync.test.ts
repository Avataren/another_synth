// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AhxInstrumentSync } from 'src/audio/tracker/ahx-instrument-sync';
import {
  currentAhxInstrumentEdits,
  currentAhxSource,
  onAhxInstrumentEdit,
  onCurrentAhxSourceChange,
  ahxSourceInfo,
  ahxSourceInfoOf,
  recordAhxInstrumentEdit,
  setCurrentAhxSource,
  snapshotAhxSource,
} from 'src/audio/tracker/ahx-source';
import { AhxTransport } from 'src/audio/tracker/ahx-transport';
import { AhxPreview } from 'src/audio/tracker/ahx-preview';
import type { AhxPlayerClient } from 'src/audio/tracker/ahx-player';

const bytesOf = (...values: number[]) => new Uint8Array(values);

describe('AhxInstrumentSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the last edit of each instrument once a burst has been quiet', () => {
    const send = vi.fn();
    const sync = new AhxInstrumentSync(send, 100);
    sync.push({ instrument: 3, bytes: bytesOf(1) });
    sync.push({ instrument: 3, bytes: bytesOf(2) });
    sync.push({ instrument: 1, bytes: bytesOf(9) });
    vi.advanceTimersByTime(99);
    expect(send).not.toHaveBeenCalled();
    sync.push({ instrument: 3, bytes: bytesOf(3) }); // the burst goes on: the wait restarts
    vi.advanceTimersByTime(99);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    // One call, every instrument of the burst in it (the worklet walks the song once).
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].map((e: { instrument: number; bytes: Uint8Array }) => [e.instrument, Array.from(e.bytes)])).toEqual([
      [1, [9]],
      [3, [3]],
    ]);
    expect(sync.pending).toBe(0);
  });

  it('flush sends what is waiting at once, and only once', () => {
    const send = vi.fn();
    const sync = new AhxInstrumentSync(send, 100);
    sync.push({ instrument: 2, bytes: bytesOf(5) });
    sync.flush();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    sync.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('discard drops what belonged to a song that is gone', () => {
    const send = vi.fn();
    const sync = new AhxInstrumentSync(send, 100);
    sync.push({ instrument: 2, bytes: bytesOf(5) });
    sync.discard();
    vi.advanceTimersByTime(500);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ahx-source instrument edits', () => {
  afterEach(() => setCurrentAhxSource(null));

  it('records nothing without a current AHX song (a saved song has no bytes to edit on top of)', () => {
    setCurrentAhxSource(null);
    expect(recordAhxInstrumentEdit(3, bytesOf(1))).toBe(false);
    expect(currentAhxInstrumentEdits()).toEqual([]);
  });

  it('keeps the latest edit per instrument, in instrument order, and tells listeners', () => {
    setCurrentAhxSource(bytesOf(0));
    const heard: number[] = [];
    const off = onAhxInstrumentEdit((e) => heard.push(e.instrument));
    expect(recordAhxInstrumentEdit(5, bytesOf(1))).toBe(true);
    recordAhxInstrumentEdit(2, bytesOf(2));
    recordAhxInstrumentEdit(5, bytesOf(3));
    off();
    recordAhxInstrumentEdit(7, bytesOf(4));
    expect(heard).toEqual([5, 2, 5]);
    expect(currentAhxInstrumentEdits().map((e) => [e.instrument, Array.from(e.bytes)])).toEqual([
      [2, [2]],
      [5, [3]],
      [7, [4]],
    ]);
  });

  it('copies the bytes it is given', () => {
    setCurrentAhxSource(bytesOf(0));
    const mine = bytesOf(1, 2);
    recordAhxInstrumentEdit(1, mine);
    mine[0] = 99;
    expect(Array.from(currentAhxInstrumentEdits()[0]!.bytes)).toEqual([1, 2]);
  });

  it('a different song drops the edits; the same song applied again gets a new identity when it had edits', () => {
    const song = bytesOf(0, 0, 0);
    setCurrentAhxSource(song);
    recordAhxInstrumentEdit(1, bytesOf(1));
    setCurrentAhxSource(bytesOf(7));
    expect(currentAhxInstrumentEdits()).toEqual([]);

    setCurrentAhxSource(song);
    // Applied again with nothing edited: the same song, nothing to tell anyone.
    let changes = 0;
    const off = onCurrentAhxSourceChange(() => changes++);
    setCurrentAhxSource(song);
    expect(changes).toBe(0);
    expect(currentAhxSource()).toBe(song);

    recordAhxInstrumentEdit(1, bytesOf(1));
    setCurrentAhxSource(song); // the store re-read the slots as parsed: the edit is gone from the display
    off();
    expect(changes).toBe(1);
    expect(currentAhxInstrumentEdits()).toEqual([]);
    const now = currentAhxSource()!;
    expect(now).not.toBe(song); // a loader keyed on identity treats it as another song
    expect(Array.from(now)).toEqual(Array.from(song));
  });
});

describe('ahx-source header info and snapshots', () => {
  afterEach(() => setCurrentAhxSource(null));

  it('reads the format and version from the header', () => {
    expect(ahxSourceInfoOf(bytesOf(0x54, 0x48, 0x58, 2))).toEqual({ format: 'ahx', version: 2 });
    expect(ahxSourceInfoOf(bytesOf(0x54, 0x48, 0x58, 0))).toEqual({ format: 'ahx', version: 0 });
    expect(ahxSourceInfoOf(bytesOf(0x48, 0x56, 0x4c, 1))).toEqual({ format: 'hvl', version: 1 });
  });

  it('tracks the current song\'s info, and clears it with the song', () => {
    setCurrentAhxSource(bytesOf(0x48, 0x56, 0x4c, 1));
    expect(ahxSourceInfo.value).toEqual({ format: 'hvl', version: 1 });
    setCurrentAhxSource(bytesOf(0x54, 0x48, 0x58, 1), { format: 'ahx', version: 1 });
    expect(ahxSourceInfo.value).toEqual({ format: 'ahx', version: 1 });
    setCurrentAhxSource(null);
    expect(ahxSourceInfo.value).toBeNull();
    expect(snapshotAhxSource()).toBeNull();
  });

  it('a snapshot puts the song back with its edits, however the current song changed meanwhile', () => {
    const song = bytesOf(0x54, 0x48, 0x58, 1, 9);
    setCurrentAhxSource(song);
    recordAhxInstrumentEdit(4, bytesOf(1, 2));
    const snapshot = snapshotAhxSource()!;
    expect(snapshot).toMatchObject({ format: 'ahx', version: 1 });
    expect(snapshot.edits!.map((e) => [e.instrument, Array.from(e.bytes)])).toEqual([[4, [1, 2]]]);

    // Another song plays (the Jukebox), then the editor's comes back.
    setCurrentAhxSource(null);
    setCurrentAhxSource(snapshot.bytes, snapshot);
    expect(currentAhxSource()).toBe(song);
    expect(currentAhxInstrumentEdits().map((e) => [e.instrument, Array.from(e.bytes)])).toEqual([[4, [1, 2]]]);
    expect(ahxSourceInfo.value).toEqual({ format: 'ahx', version: 1 });
  });

  it('a snapshot applied over the very same bytes with the edits gone gives the song a new identity', () => {
    const song = bytesOf(0x54, 0x48, 0x58, 1, 9);
    setCurrentAhxSource(song);
    recordAhxInstrumentEdit(4, bytesOf(1));
    const snapshot = snapshotAhxSource()!;
    // Another song, then this very file again as parsed (a Jukebox replay): no edits on it now,
    // and a worklet may hold it as it was.
    setCurrentAhxSource(null);
    setCurrentAhxSource(song);
    expect(currentAhxInstrumentEdits()).toEqual([]);
    setCurrentAhxSource(snapshot.bytes, snapshot);
    expect(currentAhxSource()).not.toBe(song);
    expect(currentAhxInstrumentEdits()).toHaveLength(1);
  });
});

/** A stand-in for the worklet client that records what it is told. */
function fakeClient(ctx: object) {
  const calls: string[] = [];
  const loads: Array<{ instruments: Array<{ instrument: number; bytes: number[] }> }> = [];
  const client = {
    audioContext: ctx,
    output: { connect: vi.fn() },
    setPreview: () => undefined,
    setHifi: () => undefined,
    setStopAtEnd: () => undefined,
    onPosition: () => () => undefined,
    onSongEnd: () => () => undefined,
    onWaveforms: () => () => undefined,
    onPListRow: () => () => undefined,
    loadSong: vi.fn(
      async (
        _bytes: Uint8Array,
        _stereo?: number,
        instruments: ReadonlyArray<{ instrument: number; bytes: Uint8Array }> = [],
      ) => {
        loads.push({ instruments: instruments.map((e) => ({ instrument: e.instrument, bytes: Array.from(e.bytes) })) });
        return {};
      },
    ),
    replaceInstrument: vi.fn(async (instrument: number, bytes: Uint8Array) => {
      calls.push(`replace:${instrument}:${Array.from(bytes).join(',')}`);
    }),
    previewNoteOn: () => undefined,
    previewNoteOff: () => undefined,
    dispose: vi.fn(),
  };
  return { client: client as unknown as AhxPlayerClient, calls, loads };
}

describe('AhxTransport and AhxPreview with instrument edits', () => {
  const ctx = {};
  const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
  const song = bytesOf(1, 2, 3);
  const edits = () => [{ instrument: 16, bytes: bytesOf(7, 7) }];

  it('a load hands the worklet every edit made so far, so no worklet plays a song that lacks one', async () => {
    const t = fakeClient(ctx);
    const transport = new AhxTransport(host, async () => t.client, edits);
    await transport.load(song);
    expect(t.loads).toEqual([{ instruments: [{ instrument: 16, bytes: [7, 7] }] }]);

    const p = fakeClient(ctx);
    const preview = new AhxPreview(host, async () => p.client, edits);
    await preview.preload(song);
    expect(p.loads).toEqual([{ instruments: [{ instrument: 16, bytes: [7, 7] }] }]);
  });

  it('replaceInstrument goes to the loaded worklet as a live command, without a reload', async () => {
    const t = fakeClient(ctx);
    const transport = new AhxTransport(host, async () => t.client, () => []);
    await transport.load(song);
    await transport.replaceInstrument(4, bytesOf(9));
    expect(t.calls).toEqual(['replace:4:9']);
    expect(t.loads).toHaveLength(1);

    const p = fakeClient(ctx);
    const preview = new AhxPreview(host, async () => p.client, () => []);
    await preview.preload(song);
    await preview.replaceInstrument(4, bytesOf(9));
    expect(p.calls).toEqual(['replace:4:9']);
    expect(p.loads).toHaveLength(1);
  });

  it('with no worklet yet there is nothing to tell: the coming load applies the edit', async () => {
    const transport = new AhxTransport(host, async () => fakeClient(ctx).client, () => []);
    await expect(transport.replaceInstrument(4, bytesOf(9))).resolves.toBeUndefined();
    const preview = new AhxPreview(host, async () => fakeClient(ctx).client, () => []);
    await expect(preview.replaceInstrument(4, bytesOf(9))).resolves.toBeUndefined();
  });

  it('a refusal by the worklet is the caller’s to see', async () => {
    const t = fakeClient(ctx);
    (t.client.replaceInstrument as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no instrument 4'));
    const transport = new AhxTransport(host, async () => t.client, () => []);
    await transport.load(song);
    await expect(transport.replaceInstrument(4, bytesOf(9))).rejects.toThrow('no instrument 4');
  });
});
