import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type { Song, PlaybackScheduler } from '../../packages/tracker-playback/src/types';
import { importXmToTrackerSong, looksLikeXm } from 'src/audio/tracker/xm-import';
import { parseXm } from '../../packages/tracker-playback/src/formats/xm';

/**
 * Ticks per row ("speed", the Fxx 01-1F parameter) is separate from BPM, and
 * the tracker default of 6 is not what most XM files ask for -- 3 is common.
 * Ignoring the header value played those songs at exactly half speed while the
 * BPM was correct.
 */
function makeEngine() {
  const scheduler: PlaybackScheduler = { start: vi.fn(), stop: vi.fn() };
  const audioContext = { currentTime: 0 } as unknown as AudioContext;
  return new PlaybackEngine({ scheduler, audioContext, scheduledNoteHandler: vi.fn() });
}

function rowMs(engine: PlaybackEngine): number {
  return (engine as unknown as { getMsPerRow: () => number }).getMsPerRow();
}

const baseSong: Song = {
  title: '',
  author: '',
  bpm: 125,
  patterns: [{ id: 'p', length: 64, tracks: [] }],
  sequence: ['p'],
};

describe('initial speed', () => {
  it('defaults to 6 ticks per row when the song does not say', () => {
    const engine = makeEngine();
    engine.loadSong(baseSong);
    // 125 BPM, speed 6 -> 120ms per row.
    expect(rowMs(engine)).toBeCloseTo(120, 6);
  });

  it('honours a song that declares its own speed', () => {
    const engine = makeEngine();
    engine.loadSong({ ...baseSong, initialSpeed: 3 });
    // Half the ticks per row means half the row duration.
    expect(rowMs(engine)).toBeCloseTo(60, 6);
  });

  it('does not carry a previous song’s speed into the next', () => {
    const engine = makeEngine();
    engine.loadSong({ ...baseSong, initialSpeed: 3 });
    engine.loadSong(baseSong);
    expect(rowMs(engine)).toBeCloseTo(120, 6);
  });

  it('keeps BPM and speed independent', () => {
    const engine = makeEngine();
    engine.loadSong({ ...baseSong, bpm: 150, initialSpeed: 3 });
    // 150 BPM at speed 3: (60000/150/4) * (3/6) = 50ms.
    expect(rowMs(engine)).toBeCloseTo(50, 6);
  });
});

describe('XM import carries the header speed', () => {
  it('reads defaultSpeed from real modules', () => {
    const path = '/home/avataren/Downloads/mods/ft2/4-mat_-_rose.xm';
    if (!fs.existsSync(path)) return; // corpus is not checked in
    const b = fs.readFileSync(path);
    const buf = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (!looksLikeXm(buf)) return;

    const xm = parseXm(buf);
    const song = importXmToTrackerSong(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    );

    expect(song.data.initialSpeed).toBe(xm.defaultSpeed);
    // This module declares 3; playing it at the default 6 halved its tempo.
    expect(song.data.initialSpeed).toBe(3);
    expect(song.data.currentSong.bpm).toBe(xm.defaultBpm);
  });
});
