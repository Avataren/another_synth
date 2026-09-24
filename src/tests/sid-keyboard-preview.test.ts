import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { SidSongTransport, type SidSongTransportDeps } from 'src/audio/tracker/sid-song-transport';
import type { SidPlayerClient } from 'src/audio/tracker/sid-player';
import { pickActiveInstrumentId } from 'src/audio/tracker/instrument-ids';
import type { InstrumentSlot } from 'src/stores/tracker-store';
import { buildSidChainSong } from './helpers/sid-chain-song';

/**
 * The SID preview voice as the keyboard plays it (the tracker page and the SID
 * instrument page): one voice, last key wins, and a note-on that has to wait
 * for the voice to be made must not outlive a key-up that came meanwhile.
 */

interface FakeClient {
  log: string[];
  client: SidPlayerClient;
}

function fakeClient(): FakeClient {
  const log: string[] = [];
  const client = {
    audioContext: context,
    output: { connect: () => undefined },
    setPreview: () => undefined,
    loadSong: () => {
      log.push('load');
      return Promise.resolve({});
    },
    previewNoteOn: (instrument: number, note: number) => log.push(`on ${instrument}:${note}`),
    previewNoteOff: () => log.push('off'),
    dispose: () => undefined,
  } as unknown as SidPlayerClient;
  return { log, client };
}

const context = {} as BaseAudioContext;

function transport(created: Promise<SidPlayerClient>) {
  const doc = buildSidChainSong();
  const deps = {
    trackerStore: { sidDoc: doc },
    getSongBank: () => ({
      audioContext: context,
      output: {},
      ensureAudioContextRunning: async () => true,
    }),
    createPlayer: () => created,
    isPlaying: ref(false),
  } as unknown as SidSongTransportDeps;
  return new SidSongTransport(deps);
}

/** SID note index of MIDI `midi` (`SID_INDEX_TO_MIDI` is 12: C-0 is MIDI 12). */
const idx = (midi: number) => midi - 12;

describe('SID preview voice from the keyboard', () => {
  it('a key-up while the voice is still being made cancels the strike', async () => {
    const { log, client } = fakeClient();
    let resolve!: (c: SidPlayerClient) => void;
    const t = transport(new Promise((r) => (resolve = r)));
    const on = t.previewNoteOn(1, 60);
    t.previewNoteOff(60);
    resolve(client);
    expect(await on).toBe(false);
    expect(log.filter((e) => e.startsWith('on'))).toEqual([]);
  });

  it('letting go of a key another has taken over from leaves the newer note', async () => {
    const { log, client } = fakeClient();
    const t = transport(Promise.resolve(client));
    await t.previewNoteOn(1, 60);
    await t.previewNoteOn(1, 64);
    t.previewNoteOff(60); // the earlier key: not the one sounding
    expect(log.filter((e) => e !== 'load')).toEqual([`on 1:${idx(60)}`, `on 1:${idx(64)}`]);
    t.previewNoteOff(64);
    expect(log.at(-1)).toBe('off');
  });

  it('a note-off without a key always silences', async () => {
    const { log, client } = fakeClient();
    const t = transport(Promise.resolve(client));
    await t.previewNoteOn(1, 60);
    t.previewNoteOff();
    expect(log.at(-1)).toBe('off');
  });

  it('preparing makes the voice and loads the song once, before any key', async () => {
    const { log, client } = fakeClient();
    const t = transport(Promise.resolve(client));
    await t.preparePreview();
    expect(log).toEqual(['load']);
    await t.previewNoteOn(2, 60);
    expect(log).toEqual(['load', `on 2:${idx(60)}`]);
  });
});

describe('the instrument selected when a SID song loads', () => {
  const slot = (n: number, extra: Partial<InstrumentSlot> = {}) =>
    ({ slot: n, bankName: '', patchName: '', instrumentName: '', ...extra }) as InstrumentSlot;

  it('is the first SID instrument: a SID slot has no patch, but it is filled', () => {
    const slots = [slot(1, { instrumentFormat: 'sid' }), slot(2, { instrumentFormat: 'sid' }), slot(3)];
    expect(pickActiveInstrumentId(slots, null)).toBe('01');
    expect(pickActiveInstrumentId(slots, '02')).toBe('02');
    // A selection the song does not have (the previous song's) moves to the first.
    expect(pickActiveInstrumentId(slots, '03')).toBe('01');
  });
});
