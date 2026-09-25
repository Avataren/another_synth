import {
  DEFAULT_SID_INSTRUMENT,
  SID_FILE_VERSION,
  SID_NOTE_KEY_OFF,
  addSidInstrument,
  blankSidPattern,
  makeSidDoc,
  setSidChipModel,
  setSidInstrument,
  setSidRow,
  setSidTableRow,
  type SidDoc,
  type SidInstrument,
  type SidOpResult,
  type SidTableName,
} from 'src/audio/tracker/sid-doc';

/**
 * The S3 chain-proof song (plan-sid-tracking.md S3). Its skeleton is made with
 * `makeSidDoc`, and every note, instrument, table row and the chip model are
 * written with the doc's own ops, so the edit path is part of what reaches the
 * chip. `rust-wasm/tests/sid_song_chain.rs` plays the file the app saves for it
 * (`rust-wasm/tests/fixtures/sid/s3-chain.asid`), and asserts what this layout
 * implies frame by frame, so a change here changes both tests:
 *
 *   tempo 6, 50 Hz, one frame = 882 samples at 44.1 kHz, row r = frame 6r
 *   GoatTracker instruments (plan-sid-authoring.md D1): the first-frame byte
 *   is the waveform until a wave table sets one, and a table starts on the
 *   frame after the note's.
 *   voice 1 (P0, 32 rows): r0 A-4 "Tri lead" (first-frame 0x11, no wave
 *     table: triangle all through); r16 key off; r20 C-5 "Vib lead"
 *     (first-frame 0x09, then wave rows 5-6: triangle; vibrato delay 10);
 *     r28 porta up at speed row 2
 *   voice 2 (P1, 32 rows): r8 C-4 "Arp pulse" (first-frame 0x41, wave table
 *     C/E/G arpeggio, pulse table 0x400 then +/-0x10 sweeps); r24 key off
 *   voice 3 (P2, 16 rows, twice, transpose +5): r10 E-3 -> A-3 "Filt saw"
 *     (first-frame 0x21; filter table: LP, res 12, voice 3 routed, cutoff
 *     0x100 then +0x10/frame)
 *   subsong 1: voice 3 plays P0 up an octave (a second orderlist set)
 *   chip model 6581, set by `setSidChipModel` (the per-song tag)
 */
export const SID_CHAIN_SONG_NAME = 'S3 chain proof';

function must(result: SidOpResult): SidDoc {
  if (!result.ok) throw new Error(result.reason);
  return result.doc;
}

/** No hard restart unless asked: GoatTracker's new-instrument gate timer is not part of this layout. */
const instrument = (fields: Partial<SidInstrument>): SidInstrument => ({ ...DEFAULT_SID_INSTRUMENT, gateTimer: 0, hardRestart: false, ...fields });

export function buildSidChainSong(): SidDoc {
  let doc = makeSidDoc({
    format: 'sid',
    version: SID_FILE_VERSION,
    songName: SID_CHAIN_SONG_NAME,
    author: 'OpenClaw',
    copyright: '2026',
    chipModel: '8580',
    channels: 3,
    speedMultiplier: 1,
    tempo: 6,
    subsongs: [
      {
        orderlists: [
          { entries: [{ pattern: 0, transpose: 0, repeat: 1 }], restart: 0 },
          { entries: [{ pattern: 1, transpose: 0, repeat: 1 }], restart: 0 },
          { entries: [{ pattern: 2, transpose: 5, repeat: 2 }], restart: 0 },
        ],
      },
      {
        orderlists: [
          { entries: [{ pattern: 1, transpose: 0, repeat: 1 }], restart: 0 },
          { entries: [{ pattern: 2, transpose: 0, repeat: 1 }], restart: 0 },
          { entries: [{ pattern: 0, transpose: 12, repeat: 1 }], restart: 0 },
        ],
      },
    ],
    patterns: [blankSidPattern(32), blankSidPattern(32), blankSidPattern(16)],
    instruments: [DEFAULT_SID_INSTRUMENT],
    tables: { wave: [], pulse: [], filter: [], speed: [] },
  });

  const tables: Array<[SidTableName, number, number]> = [
    // wave: pulse + gate at +0, +4, +7 semitones, then back to row 1 (a C
    // major arpeggio). The gate bit is the row's own, as in GoatTracker
    // (S5.9): a $40 row would release the note.
    ['wave', 0x41, 0x00],
    ['wave', 0x41, 0x04],
    ['wave', 0x41, 0x07],
    ['wave', 0xff, 0x01],
    // wave rows 5-6: triangle + gate, then stop ("Vib lead" after its $09)
    ['wave', 0x11, 0x00],
    ['wave', 0xff, 0x00],
    // pulse: width 0x400, then 32 frames of +0x10, 32 of -0x10, loop to row 2
    ['pulse', 0x84, 0x00],
    ['pulse', 0x20, 0x10],
    ['pulse', 0x20, 0xf0],
    ['pulse', 0xff, 0x02],
    // filter: LP, resonance 12 + voice 3 routed; cutoff 0x20<<3; 64 frames of +2<<3; stop
    ['filter', 0x90, 0xc4],
    ['filter', 0x00, 0x20],
    ['filter', 0x40, 0x02],
    ['filter', 0xff, 0x00],
    // speed: row 1 vibrato (turn value 4, 0x28 a frame); row 2 portamento 0x0040
    ['speed', 0x04, 0x28],
    ['speed', 0x00, 0x40],
  ];
  for (const [name, left, right] of tables) {
    doc = must(setSidTableRow(doc, name, doc.tables[name].length, { left, right }));
  }

  doc = must(setSidInstrument(doc, 1, instrument({ name: 'Tri lead', firstWave: 0x11, attack: 0, decay: 0, sustain: 15, release: 4 })));
  doc = must(addSidInstrument(doc, instrument({ name: 'Arp pulse', firstWave: 0x41, sustain: 15, decay: 0, release: 6, wavePtr: 1, pulsePtr: 1 })));
  doc = must(addSidInstrument(doc, instrument({ name: 'Filt saw', firstWave: 0x21, decay: 0, sustain: 12, release: 8, filterPtr: 1 })));
  doc = must(
    addSidInstrument(
      doc,
      instrument({ name: 'Vib lead', decay: 4, sustain: 10, release: 4, wavePtr: 5, speedPtr: 1, vibratoDelay: 10, hardRestart: true, gateTimer: 2, firstWave: 0x09 }),
    ),
  );

  const rows: Array<[number, number, number, number, number, number]> = [
    // pattern, row, note, instrument, command, param
    [0, 0, 58, 1, 0, 0], // A-4
    [0, 16, SID_NOTE_KEY_OFF, 0, 0, 0],
    [0, 20, 61, 4, 0, 0], // C-5
    [0, 28, 0, 0, 0x1, 2], // porta up, speed row 2
    [1, 8, 49, 2, 0, 0], // C-4
    [1, 24, SID_NOTE_KEY_OFF, 0, 0, 0],
    [2, 10, 41, 3, 0, 0], // E-3, +5 in the orderlist = A-3
  ];
  for (const [pattern, row, note, ins, command, param] of rows) {
    doc = must(setSidRow(doc, pattern, row, { note, instrument: ins, command, param }));
  }
  return must(setSidChipModel(doc, '6581'));
}
