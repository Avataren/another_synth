import { describe, it, expect, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import {
  buildBugReport,
  scanRangeForReport,
  sha256Hex,
  type BugReportInput,
  type BugReportPatternData,
} from '../composables/bug-report';
import {
  clearLoadedSongHash,
  getLoadedSongHash,
} from '../composables/song-identity';
import { useJukeboxPlayer } from '../composables/useJukeboxPlayer';
import type { TrackerSongHost } from '../composables/useTrackerSongHost';
import { useJukeboxStore, type JukeboxEntry } from '../stores/jukebox-store';
import type { TrackerSongFile } from '../stores/tracker-store';

const HASH = 'a'.repeat(4) + 'b'.repeat(4) + 'c'.repeat(56);

/** Overrides may explicitly clear an optional field with undefined. */
type BugReportOverrides = {
  [K in keyof BugReportInput]?: BugReportInput[K] | undefined;
};

function baseInput(overrides: BugReportOverrides = {}): BugReportInput {
  // Optional fields: defaulted when the key is absent, cleared when the
  // override explicitly passes undefined.
  const endPosition =
    'endPosition' in overrides ? overrides.endPosition : { order: 14, row: 10 };
  const channels = 'channels' in overrides ? overrides.channels : [7, 3];
  const instrument =
    'instrument' in overrides ? overrides.instrument : { id: '05', name: 'Strings' };
  return {
    songIdentity: overrides.songIdentity ?? {
      name: 'satellite_one.s3m',
      formatLabel: 'S3M',
      sha256: HASH,
    },
    title: overrides.title ?? 'Satellite One',
    build: overrides.build ?? 'v0.2.0 (000592a)',
    startPosition: overrides.startPosition ?? { order: 12, row: 34 },
    ...(endPosition ? { endPosition } : {}),
    ...(channels ? { channels } : {}),
    ...(instrument ? { instrument } : {}),
    heard: overrides.heard ?? 'buzz on the strings',
    expected: overrides.expected ?? 'clean strings',
  };
}

function fieldLines(report: string): string[] {
  return report.split('\n').filter((line) => /^\S/.test(line));
}

describe('buildBugReport', () => {
  it('renders every field in order, with the shared key column', () => {
    const report = buildBugReport(baseInput());

    const lines = report.split('\n');
    expect(lines[0]).toBe('[another_synth bug report]');
    expect(lines[1]).toBe(`song:      satellite_one.s3m  (S3M, sha256: ${HASH})`);
    expect(lines[2]).toBe('title:     "Satellite One"');
    expect(lines[3]).toBe('build:     v0.2.0 (000592a)');
    expect(lines[4]).toBe('position:  order 12 row 34 -> order 14 row 10');
    expect(lines[5]).toBe('channels:  3, 7');
    expect(lines[6]).toBe('instr:     05 "Strings"');
    expect(lines[7]).toBe('heard:     buzz on the strings');
    expect(lines[8]).toBe('expected:  clean strings');
    expect(report.endsWith('\n')).toBe(true);
  });

  it('emits a single position when no end mark was captured', () => {
    const report = buildBugReport(
      baseInput({ endPosition: undefined, channels: undefined, instrument: undefined }),
    );
    expect(report).toContain('position:  order 12 row 34\n');
    expect(report).not.toContain('->');
  });

  it('prints a range ascending even when the marks were captured in reverse', () => {
    const report = buildBugReport(
      baseInput({
        startPosition: { order: 14, row: 10 },
        endPosition: { order: 12, row: 34 },
      }),
    );
    expect(report).toContain('position:  order 12 row 34 -> order 14 row 10\n');
  });

  it('omits the title line when the module has no title', () => {
    const report = buildBugReport(baseInput({ title: '  ' }));
    expect(report).not.toContain('title:');
    expect(report).toContain('build:     v0.2.0 (000592a)\n');
  });

  it('falls back to the native-song line when no file hash exists', () => {
    const report = buildBugReport(
      baseInput({ songIdentity: { name: 'untitled.cmod' } }),
    );
    expect(report).toContain('song:      untitled.cmod (native song, no file hash)\n');
    expect(report).not.toContain('sha256');
  });

  it('omits channels and instr lines when the range has none', () => {
    const report = buildBugReport(baseInput({ channels: undefined, instrument: undefined }));
    expect(report).not.toContain('channels:');
    expect(report).not.toContain('instr:');
  });

  it('sorts channels ascending regardless of capture order', () => {
    const report = buildBugReport(baseInput({ channels: [9, 1, 4] }));
    expect(report).toContain('channels:  1, 4, 9\n');
  });

  it('omits the instrument name when the slot has none', () => {
    const report = buildBugReport(baseInput({ instrument: { id: '05' } }));
    expect(report).toContain('instr:     05\n');
  });

  it('keeps empty free-text fields as empty field lines', () => {
    const report = buildBugReport(baseInput({ heard: '', expected: '' }));
    expect(report).toContain('heard:     \n');
    expect(report).toContain('expected:  \n');
  });

  it('normalizes Unicode line terminators into the continuation prefix', () => {
    const sneaky = 'fine\u2028build:     forged\u2029also\u0085more\u000Bstuff\u000Ctail';
    const report = buildBugReport(baseInput({ heard: sneaky }));

    expect(report).not.toContain('\u2028');
    expect(report).not.toContain('\u2029');
    expect(report).not.toContain('\u0085');
    expect(report).not.toContain('\u000B');
    expect(report).not.toContain('\u000C');
    // Every escaped fragment rides behind the prefix, so a paste target that
    // renders them as breaks still cannot show an unprefixed field line.
    expect(report).toContain('  | build:     forged');
    expect(report).toContain('  | also');
    expect(report).toContain('  | more');
    expect(report).toContain('  | stuff');
    expect(report).toContain('  | tail');
    expect(report.match(/^build:/gm)).toHaveLength(1);
  });
});

describe('buildBugReport hostile free text', () => {
  const hostile =
    'buzz\nbuild:     v9.9.9 (deadbeef)\n[another_synth bug report]\nsong:      evil.s3m (S3M, sha256: f)\n' +
    '"quoted"\tstuff\n\n\nlast line';

  it('confines every line of user text behind the continuation prefix', () => {
    const report = buildBugReport(baseInput({ heard: hostile, expected: hostile }));

    for (const line of report.split('\n')) {
      if (line === '') continue;
      // A line is either a structural field line from the report itself, or
      // a continuation: "  | " plus user text. Nothing else may exist.
      const isContinuation = line.startsWith('  |');
      const isStructural = /^\S/.test(line);
      expect(isContinuation || isStructural).toBe(true);
    }

    // ...and the continuations are exactly the user's lines, blanks included.
    const continuations = report
      .split('\n')
      .filter((line) => line.startsWith('  |'))
      .map((line) => line.slice(4).trimEnd());
    expect(continuations).toEqual([
      'build:     v9.9.9 (deadbeef)',
      '[another_synth bug report]',
      'song:      evil.s3m (S3M, sha256: f)',
      '"quoted"\tstuff',
      '',
      '',
      'last line',
      'build:     v9.9.9 (deadbeef)',
      '[another_synth bug report]',
      'song:      evil.s3m (S3M, sha256: f)',
      '"quoted"\tstuff',
      '',
      '',
      'last line',
    ]);
  });

  it('never lets user text forge a field line or the header', () => {
    const report = buildBugReport(baseInput({ heard: hostile, expected: hostile }));

    const starts = report.split('\n').filter((line) => line.startsWith('['));
    expect(starts).toEqual(['[another_synth bug report]']);

    // User text may quote field text, but only the report's own lines may
    // start at column zero.
    expect(report.match(/^build:/gm)).toHaveLength(1);
    expect(report.match(/^song:/gm)).toHaveLength(1);
    expect(report.match(/^heard:/gm)).toHaveLength(1);
    expect(report.match(/^expected:/gm)).toHaveLength(1);
    expect(report).toContain('build:     v0.2.0 (000592a)\n');
    expect(report).toContain(`song:      satellite_one.s3m  (S3M, sha256: ${HASH})\n`);
  });

  it('keeps the field order intact after hostile input', () => {
    const report = buildBugReport(baseInput({ heard: hostile, expected: hostile }));
    const keys = fieldLines(report)
      .filter((line) => line.includes(':'))
      .map((line) => line.slice(0, line.indexOf(':') + 1));
    expect(keys).toEqual([
      'song:',
      'title:',
      'build:',
      'position:',
      'channels:',
      'instr:',
      'heard:',
      'expected:',
    ]);
  });
});

describe('scanRangeForReport', () => {
  const patterns: BugReportPatternData[] = [
    {
      id: 'p0',
      rows: 64,
      tracks: [
        { entries: [{ row: 0, note: 'C-4', instrument: '5' }] },
        { entries: [{ row: 4, note: '---' }, { row: 8, note: 'E-4', instrument: '05' }] },
        { entries: [{ row: 2, note: '###', instrument: '05' }] },
        { entries: [] },
      ],
    },
    {
      id: 'p1',
      rows: 32,
      tracks: [
        { entries: [{ row: 70, note: 'C-4' }] }, // beyond pattern rows: ignored
        { entries: [{ row: 1, note: 'G-4', instrument: '07' }] },
        { entries: [] },
        { entries: [] },
      ],
    },
    { id: 'p2', rows: 64, tracks: [{ entries: [] }, { entries: [] }, { entries: [] }, { entries: [] }] },
  ];
  const sequence = ['p0', 'p1', 'p2'];

  it('collects 1-based channels and instrument ids across the range', () => {
    const scan = scanRangeForReport(
      sequence,
      patterns,
      { order: 0, row: 0 },
      { order: 1, row: 10 },
    );
    expect(scan.channels).toEqual([1, 2, 3]);
    expect(scan.instrumentIds).toEqual(['05', '07']);
  });

  it('scans a single order when there is no end mark', () => {
    const scan = scanRangeForReport(sequence, patterns, { order: 2, row: 0 });
    expect(scan.channels).toEqual([]);
    expect(scan.instrumentIds).toEqual([]);
  });

  it('handles reversed capture order', () => {
    const scan = scanRangeForReport(
      sequence,
      patterns,
      { order: 1, row: 0 },
      { order: 0, row: 0 },
    );
    expect(scan.channels).toEqual([1, 2, 3]);
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 test vector', async () => {
    if (!globalThis.crypto?.subtle) {
      // No WebCrypto in this environment: the app degrades to the
      // native-song fallback, which its own test covers.
      return;
    }
    const digest = await sha256Hex(new TextEncoder().encode('abc'));
    expect(digest).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('jukebox warmed-load path (regression)', () => {
  const MODULE_TEXT = 'fake module bytes for the warmed path';
  const moduleBytes = new TextEncoder().encode(MODULE_TEXT);

  function entry(file: string): JukeboxEntry {
    return {
      file,
      url: `demos/${file}`,
      title: file,
      format: 'S3M',
      channels: 4,
      bytes: moduleBytes.byteLength,
    };
  }

  function makeHost() {
    const parsedSong = { title: 'Warmed song' } as unknown as TrackerSongFile;
    const applied: TrackerSongFile[] = [];
    return {
      parsedSong,
      applied,
      host: {
        isLoadingSong: ref(false),
        playbackStore: { setLoopSong: vi.fn() },
        parseSongBuffer: vi.fn(async () => parsedSong),
        applySongFile: vi.fn(async (songFile: TrackerSongFile) => {
          applied.push(songFile);
        }),
        loadSongFromUrl: vi.fn(async () => {}),
        play: vi.fn(async () => {}),
        stopPlayback: vi.fn(),
      } as unknown as TrackerSongHost,
    };
  }

  it('applies the parsed song and records the real hash of the retained bytes', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    clearLoadedSongHash();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          moduleBytes.slice().buffer as ArrayBuffer,
      })),
    );

    const { host, applied, parsedSong } = makeHost();
    const jukebox = useJukeboxStore();
    jukebox.setEntries([entry('a.s3m'), entry('b.s3m')], false);
    const player = useJukeboxPlayer(host);

    // Warm the next entry, then play it: this is the jukebox's primary path.
    expect(jukebox.indexAfter(1)).not.toBeNull();
    await player.prefetchNext();
    await player.playIndex(1);

    // The parsed song the prefetch produced is what reaches the tracker --
    // not undefined, which would silently keep the previous song playing.
    expect(applied).toEqual([parsedSong]);

    // And the hash recorded for the report is the sha256 of the actual
    // module bytes, not the empty-buffer digest a undefined-bytes bug
    // would produce.
    const expected = await sha256Hex(moduleBytes);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(getLoadedSongHash()).toBe(expected);

    vi.unstubAllGlobals();
  });
});
