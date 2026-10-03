import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parseXm } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { snapshotEditorSong } from 'src/audio/tracker/ahx-source';
import { xmExporter } from 'src/audio/tracker/song-export/xm-exporter';
import { SONG_EXPORTERS, describeSongExporter } from 'src/audio/tracker/song-export/registry';
import { patchFromXmInstrument, xmInstrumentOfSlot } from 'src/audio/tracker/xm-instrument-codec';
import { xmMetaOf } from '@another-synth/tracker-playback';
import {
  addSample,
  emptyXmSample,
  generateWave,
  newXmInstrument,
  paintKeymap,
  withLoop,
  withSample,
} from 'src/audio/tracker/xm-sample-ops';

describe('a FastTracker 2 module made from scratch', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('is an eight-channel xm song that only the .xm exporter lists', () => {
    const store = useTrackerStore();
    store.resetToNewXmSong();
    expect(store.moduleFormat).toBe('xm');
    const song = snapshotEditorSong(store);
    expect(song.data.patterns[0]!.tracks).toHaveLength(8);
    const listed = SONG_EXPORTERS.filter((e) => describeSongExporter(e, song).state === 'enabled').map((e) => e.id);
    expect(listed).toEqual(['xm']);
  });

  it('writes a multi-sample instrument made in the editor, and the notes using it, into the .xm', () => {
    const store = useTrackerStore();
    store.resetToNewXmSong();
    let instrument = { ...newXmInstrument(), name: 'split', volumeFadeout: 700, vibratoDepth: 4, vibratoRate: 20, vibratoSweep: 8 };
    const wave = generateWave({ ...emptyXmSample('high', 16), volume: 40, panning: 200 }, 'saw', 128);
    const second = withLoop({ ...wave, relativeNote: 5, finetune: -9 }, 16, 64, 'pingpong');
    instrument = addSample(instrument, second)!;
    instrument = paintKeymap(instrument, 48, 95, 1);
    instrument = withSample(instrument, 0, { ...instrument.samples[0]!, volume: 33 });
    instrument.volumeEnvelope = {
      points: [{ frame: 0, value: 64 }, { frame: 20, value: 30 }, { frame: 60, value: 0 }],
      sustainPoint: 1,
      loopStart: 0,
      loopEnd: 0,
      enabled: true,
      sustainEnabled: true,
      loopEnabled: false,
    };
    store.setXmInstrument(3, patchFromXmInstrument(3, instrument), xmMetaOf(instrument));
    store.patterns[0]!.tracks[1]!.entries.push(
      { row: 0, note: 'C-4', instrument: '03' },
      { row: 4, note: 'C-6', instrument: '03' },
    );

    const xm = parseXm(xmExporter.serialize(snapshotEditorSong(store)));
    expect(xm.instruments).toHaveLength(3);
    const out = xm.instruments[2]!;
    expect(out.name).toBe('split');
    expect(out.samples).toHaveLength(2);
    expect(out.keymap[47]).toBe(0);
    expect(out.keymap[48]).toBe(1);
    expect(out.volumeFadeout).toBe(700);
    expect([out.vibratoDepth, out.vibratoRate, out.vibratoSweep]).toEqual([4, 20, 8]);
    expect(out.volumeEnvelope).toEqual(instrument.volumeEnvelope);
    const [a, b] = out.samples;
    expect([a!.volume, a!.bits, a!.loopType]).toEqual([33, 8, 'forward']);
    expect([b!.volume, b!.bits, b!.panning, b!.relativeNote, b!.finetune, b!.loopType, b!.loopStart, b!.loopLength]).toEqual([40, 16, 200, 5, -9, 'pingpong', 16, 64]);
    expect(Array.from(b!.data)).toEqual(Array.from(instrument.samples[1]!.data));
    // No explicit volume: each sample's own default plays, so no volume column is written.
    const rows = xm.patterns[0]!.rows;
    expect(rows[0]![1]).toEqual({ note: 49, instrument: 3, volumeColumn: 0, effectType: 0, effectParam: 0 });
    expect(rows[4]![1]).toEqual({ note: 73, instrument: 3, volumeColumn: 0, effectType: 0, effectParam: 0 });
  });

  it('reads an instrument back from its slot', () => {
    const store = useTrackerStore();
    store.resetToNewXmSong();
    const instrument = newXmInstrument();
    store.setXmInstrument(1, patchFromXmInstrument(1, instrument), xmMetaOf(instrument));
    const slot = store.instrumentSlots.find((s) => s.slot === 1)!;
    const back = xmInstrumentOfSlot(slot, store.songPatches[slot.patchId!]);
    expect(back?.samples).toHaveLength(1);
    expect(Array.from(back!.samples[0]!.data)).toEqual(Array.from(instrument.samples[0]!.data));
    expect(slot.instrumentFormat).toBe('xm');
  });
});
