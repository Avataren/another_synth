import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import type { ScheduledNoteEvent } from '@another-synth/tracker-playback';
import { buildXm, cell } from './helpers/xm-builder';
import type { XmPatternCell } from '@another-synth/tracker-playback';

/**
 * FT2 key-off followed by a tone-portamento note.
 *
 * A 3xx note only continues the voice already on the channel. If key-off has
 * already taken that voice away, the note must trigger normally -- otherwise
 * the rest of a legato melody stays silent. This is the shape of the lead in
 * radix_-_take_on_me.xm's fifth pattern.
 */
function noteEventsFor(cells: XmPatternCell[][]): ScheduledNoteEvent[] {
  const xm = buildXm({
    numChannels: 1,
    linearFrequency: true,
    instruments: [{ samples: [{ frames: [0, 1, 0, -1], volume: 64 }] }],
    patterns: [{ numRows: cells.length, cells }],
  });
  const imported = importXmToTrackerSong(xm.buffer as ArrayBuffer);
  const patterns = imported.data.patterns;
  const context: TrackerSongBuilderContext = {
    currentSong: ref(imported.data.currentSong),
    moduleFormat: ref(imported.data.moduleFormat!),
    initialSpeed: ref(imported.data.initialSpeed ?? 6),
    linearFrequency: ref(imported.data.linearFrequency ?? true),
    patterns: ref(patterns),
    sequence: ref(imported.data.sequence),
    currentPatternId: ref(patterns[0]!.id),
    currentPattern: ref(patterns[0]),
    defaultPatternRows: ref(64),
    instrumentSlots: ref(imported.data.instrumentSlots),
    songPatches: ref(imported.data.songPatches ?? {}),
    songBank: {} as TrackerSongBuilderContext['songBank'],
    normalizeInstrumentId: (id) => id,
    formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
  };
  const song = useTrackerSongBuilder(context).buildPlaybackSong('song');
  const events: ScheduledNoteEvent[] = [];
  const audioContext = { currentTime: 0 };
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: audioContext as unknown as AudioContext,
    scheduledPitchHandler: () => {},
    scheduledVolumeHandler: () => {},
  });
  Reflect.set(engine, 'scheduledNoteHandler', (event: ScheduledNoteEvent) => {
    events.push(event);
  });
  engine.loadSong(song);
  engine.loadPattern(song.patterns[0]!.id);
  const scheduleRow = (
    engine as unknown as { scheduleRow: (row: number, time: number) => void }
  ).scheduleRow.bind(engine);
  for (let row = 0; row < cells.length; row += 1) scheduleRow(row, 0);
  return events;
}

describe('XM tone portamento after key-off', () => {
  it('retriggers the tone-portamento note when key-off already cleared the channel', () => {
    const events = noteEventsFor([
      [cell(67, { instrument: 1 })],
      [cell(97)],
      [cell(66, { instrument: 1, effectType: 3, effectParam: 0xf0 })],
    ]);

    expect(events.map((event) => `${event.type}:${event.row}`)).toEqual([
      'noteOn:0',
      'noteOff:1',
      'noteOn:2',
    ]);
  });

  it('still continues the sounding voice when there was no key-off', () => {
    const events = noteEventsFor([
      [cell(67, { instrument: 1 })],
      [cell(66, { instrument: 1, effectType: 3, effectParam: 0xf0 })],
    ]);

    expect(events.map((event) => `${event.type}:${event.row}`)).toEqual([
      'noteOn:0',
    ]);
  });
});
