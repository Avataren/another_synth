import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parseMod } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { snapshotEditorSong } from 'src/audio/tracker/ahx-source';
import { modExporter } from 'src/audio/tracker/song-export/mod-exporter';
import { SONG_EXPORTERS, describeSongExporter } from 'src/audio/tracker/song-export/registry';
import { emptyModSample, patchFromModSample } from 'src/audio/tracker/mod-sample-codec';
import { withLoop } from 'src/audio/tracker/mod-sample-ops';

describe('a ProTracker module made from scratch', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('is a four-channel protracker song that only the .mod exporter lists', () => {
    const store = useTrackerStore();
    store.resetToNewModSong();
    expect(store.moduleFormat).toBe('protracker');
    const song = snapshotEditorSong(store);
    expect(song.data.patterns[0]!.tracks).toHaveLength(4);
    expect(song.data.patterns[0]!.rows).toBe(64);
    const listed = SONG_EXPORTERS.filter((e) => describeSongExporter(e, song).state === 'enabled').map((e) => e.id);
    expect(listed).toEqual(['mod']);
  });

  it('writes a sample made in the editor, and the notes using it, into the .mod', () => {
    const store = useTrackerStore();
    store.resetToNewModSong();
    const data = Int8Array.from({ length: 128 }, (_, i) => (i < 64 ? 100 : -100));
    const sample = withLoop({ ...emptyModSample(48), name: 'square', data, length: 128, finetune: 2 }, 0, 128);
    store.setModSample(2, patchFromModSample(2, sample), { name: sample.name, volume: sample.volume });
    store.patterns[0]!.tracks[1]!.entries.push({ row: 0, note: 'C-2', instrument: '02' });

    const mod = parseMod(modExporter.serialize(snapshotEditorSong(store)));
    const out = mod.samples[1]!;
    expect(out.name).toBe('square');
    expect(out.volume).toBe(48);
    expect(out.finetune).toBe(2);
    expect(Array.from(out.data)).toEqual(Array.from(data));
    expect([out.loopStart, out.loopLength]).toEqual([0, 128]);
    // No explicit volume: the sample's own 48 plays, so no Cxx is written.
    expect(mod.patterns[0]!.rows[0]![1]).toEqual({ period: 428, sampleNumber: 2, effectCmd: 0, effectParam: 0 });
  });
});
