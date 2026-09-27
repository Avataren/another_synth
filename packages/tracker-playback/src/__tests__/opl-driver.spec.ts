import { describe, expect, it } from 'vitest';
import {
  OPL_NATIVE_RATE,
  S3mOplDriver,
  st3AdlibHz,
  st3AdlibNote,
  st3AdlibTotalLevel,
} from '../opl-driver';
import { createS3mPitchModel, s3mPeriodForNote } from '../pitch-model';
import type { OplInstrumentData } from '../tracker-sample';
import type { S3mSong } from '../formats/s3m';
import { s3mOplMixGain, s3mSamplePreamp } from '../import/s3m-patterns';

/**
 * .ai/plan-opl.md O3: the S3M AdLib driver emits exactly the register writes
 * st3play's digadl.c makes. Values here are worked by hand from its code;
 * the corpus comparison against st3play itself is s3m-adlib-st3-trace.test.ts.
 */

const pitch = createS3mPitchModel();
/** The engine's musical Hz for an S3M note byte. */
const noteHz = (note: number) => pitch.frequencyFromPeriod(s3mPeriodForNote(note)!);

type Write = [number, number, number];

function recorder() {
  const writes: Write[] = [];
  return { writes, target: { write: (t: number, r: number, v: number) => writes.push([t, r, v]) } };
}

const hex = (w: Write[]) => w.map(([, r, v]) => `${r.toString(16).padStart(2, '0')}=${v.toString(16).padStart(2, '0')}`);

/** An FM instrument: distinctive bytes per register, TL 0x10 / 0x05, feedback 3. */
const FM: OplInstrumentData = {
  kind: 'melody',
  registers: [0x21, 0x31, 0x50, 0x45, 0xf2, 0xf3, 0x14, 0x15, 0x01, 0x02, 0x06, 0x00],
  volume: 64,
  c2spd: 8363,
};
/** Additive (C0 bit 0): the modulator's TL follows the volume too. */
const AM: OplInstrumentData = { ...FM, registers: [...FM.registers.slice(0, 10), 0x07, 0x00] };

function driver(instruments: Record<string, OplInstrumentData>, channelForTrack?: (t: number) => number | undefined) {
  const rec = recorder();
  const d = new S3mOplDriver({
    target: rec.target,
    instrument: (id) => instruments[id],
    ...(channelForTrack ? { channelForTrack } : {}),
  });
  return { d, writes: rec.writes };
}

describe('ST3 AdLib arithmetic', () => {
  it('C-4 (note 0x30, period 3424) is hz 4181, block 2, fnum 0x2AC', () => {
    expect(st3AdlibHz(noteHz(0x30), 8363)).toBe(4181);
    expect(st3AdlibNote(4181)).toBe(0x2aac);
  });

  it('an octave up doubles hz and adds one block', () => {
    const hz = st3AdlibHz(noteHz(0x40), 8363);
    expect(hz).toBe(Math.floor(14317056 / 1712));
    expect(st3AdlibNote(hz) >> 8).toBe(0x2e);
  });

  it('c2spd scales the period; below 1000 it means 8363', () => {
    expect(st3AdlibHz(noteHz(0x30), 16726)).toBe(Math.floor(14317056 / Math.floor((3424 * 8363) / 16726)));
    expect(st3AdlibHz(noteHz(0x30), 500)).toBe(st3AdlibHz(noteHz(0x30), 8363));
  });

  it('the speed converted is clamped to the period limits', () => {
    // A period far below 64 converts as 64; under amiga limits, as 453.
    expect(st3AdlibHz(noteHz(0x30) * 1000, 8363)).toBe(Math.floor(14317056 / 64));
    expect(st3AdlibHz(noteHz(0x30) * 1000, 8363, { min: 453, max: 3424 })).toBe(Math.floor(14317056 / 453));
  });

  it('TL scales the instrument level by volume+1 over 64, keeping KSL', () => {
    expect(st3AdlibTotalLevel(0x10, 32)).toBe(63 - (((63 - 16) * 33) >> 6));
    expect(st3AdlibTotalLevel(0x50, 0)).toBe(0x40 | 63);
    // 63 and above leave the instrument's own level.
    expect(st3AdlibTotalLevel(0x45, 63)).toBe(0x45);
  });
});

describe('S3mOplDriver writes', () => {
  it('reset is initadlib: 120 writes, waveform select on, all silent at note 0', () => {
    const { d, writes } = driver({});
    d.reset(0);
    expect(writes).toHaveLength(120);
    expect(hex(writes.slice(0, 3))).toEqual(['01=20', '08=00', 'bd=00']);
    // Channel 0's empty instrument, then note 0.
    expect(hex(writes.slice(3, 16))).toEqual([
      '20=00', '23=00', '40=3f', '43=3f', '60=00', '63=00', '80=00', '83=00', 'e0=00', 'e3=00', 'c0=00', 'a0=00', 'b0=00',
    ]);
  });

  it('a first note loads the timbre, keys off then on one chip sample later, and sets TL', () => {
    const { d, writes } = driver({ '01': FM });
    d.reset(0);
    writes.length = 0;
    d.noteOn('01', 127, 1, 0, noteHz(0x30));
    d.flush();
    expect(hex(writes)).toEqual([
      '20=21', '23=31', '40=50', '43=45', '60=f2', '63=f3', '80=14', '83=15', 'e0=01', 'e3=02', 'c0=06',
      // outnote(note & 0xDFFF): A0 low byte, B0 with the key bit clear...
      'a0=ac', 'b0=0a',
      // ...then outnote(note): A0 unchanged (cached), B0 keyed.
      'b0=2a',
      // Volume 127 -> avol 63: the carrier keeps its own TL (already 0x45, cached).
    ]);
    const keyOff = writes.find(([, r, v]) => r === 0xb0 && v === 0x0a)!;
    const keyOn = writes.find(([, r, v]) => r === 0xb0 && v === 0x2a)!;
    expect(keyOn[0] - keyOff[0]).toBeCloseTo(1 / OPL_NATIVE_RATE, 12);
  });

  it('a lower volume rewrites the carrier TL only, the modulator too when additive', () => {
    const fm = driver({ '01': FM });
    fm.d.noteOn('01', 127, 0, 0, noteHz(0x30));
    fm.d.flush();
    fm.writes.length = 0;
    fm.d.setVolume(1, 0, 32 / 64);
    fm.d.flush();
    expect(hex(fm.writes)).toEqual([`43=${st3AdlibTotalLevel(0x45, 32).toString(16)}`]);

    const am = driver({ '01': AM });
    am.d.noteOn('01', 127, 0, 0, noteHz(0x30));
    am.d.flush();
    am.writes.length = 0;
    am.d.setVolume(1, 0, 32 / 64);
    am.d.flush();
    expect(hex(am.writes)).toEqual([
      `40=${st3AdlibTotalLevel(0x50, 32).toString(16)}`,
      `43=${st3AdlibTotalLevel(0x45, 32).toString(16)}`,
    ]);
  });

  it('a pitch change rewrites only the registers that change, key bit set', () => {
    const { d, writes } = driver({ '01': FM });
    d.noteOn('01', 127, 0, 0, noteHz(0x30));
    d.flush();
    writes.length = 0;
    d.setPitch(1, 0, noteHz(0x30)); // unchanged: nothing
    expect(writes).toEqual([]);
    d.setPitch(2, 0, noteHz(0x32)); // D-4: same block, new fnum
    const hz = st3AdlibHz(noteHz(0x32), 8363);
    const note = st3AdlibNote(hz);
    expect(hex(writes)).toEqual(
      [`a0=${(note & 0xff).toString(16).padStart(2, '0')}`, ...(note >> 8 !== 0x2a ? [`b0=${(note >> 8).toString(16)}`] : [])],
    );
  });

  it('a key-off writes the current note with the key bit clear, and later pitch moves are ignored', () => {
    const { d, writes } = driver({ '01': FM });
    d.noteOn('01', 127, 0, 0, noteHz(0x30));
    d.flush();
    writes.length = 0;
    d.noteOff(1, 0);
    expect(hex(writes)).toEqual(['b0=0a']);
    d.setPitch(2, 0, noteHz(0x40));
    expect(hex(writes)).toEqual(['b0=0a']);
  });

  it('a repeated note on the same instrument reloads nothing and re-keys', () => {
    const { d, writes } = driver({ '01': FM });
    d.noteOn('01', 127, 0, 0, noteHz(0x30));
    d.flush();
    writes.length = 0;
    d.noteOn('01', 127, 1, 0, noteHz(0x30));
    d.flush();
    expect(hex(writes)).toEqual(['b0=0a', 'b0=2a']);
  });

  it('a non-AdLib instrument does nothing, and the note sounding keeps sounding', () => {
    const { d, writes } = driver({ '01': FM });
    d.noteOn('01', 127, 0, 0, noteHz(0x30));
    d.flush();
    writes.length = 0;
    d.noteOn('02', 127, 1, 0, noteHz(0x40));
    d.flush();
    expect(writes).toEqual([]);
    expect(d.handles('02')).toBe(false);
    expect(d.handles('01')).toBe(true);
  });

  it('tracks use the mapped OPL channel, else the lowest free one', () => {
    const mapped = driver({ '01': FM }, (t) => (t === 3 ? 5 : undefined));
    mapped.d.noteOn('01', 127, 0, 3, noteHz(0x30));
    mapped.d.flush();
    // Channel 5's operators sit at offset 10/13; its C0 is 0xC5.
    expect(hex(mapped.writes).slice(0, 2)).toEqual(['2a=21', '2d=31']);
    expect(hex(mapped.writes)).toContain('c5=06');
    mapped.d.noteOn('01', 127, 0, 7, noteHz(0x30));
    mapped.d.flush();
    expect(hex(mapped.writes)).toContain('c0=06');
  });

  it('a pitch change on the note\'s own tick is in the note it keys on', () => {
    // ST3 computes the tick before updateadlib writes it: `D-3 .. EF4` keys
    // on at the slid pitch, with no write at the unslid one.
    const { d, writes } = driver({ '01': FM });
    d.noteOn('01', 127, 0, 0, noteHz(0x30));
    d.flush();
    writes.length = 0;
    d.noteOn('01', 127, 1, 0, noteHz(0x40));
    const slid = pitch.frequencyFromPeriod(s3mPeriodForNote(0x40)! + 16);
    d.setPitch(1, 0, slid);
    d.flush();
    const low = writes.filter(([, r]) => r === 0xa0);
    const high = writes.filter(([, r]) => r === 0xb0);
    expect(low).toHaveLength(1);
    expect(high.map(([, , v]) => v & 0x20)).toEqual([0, 0x20]);
    expect(high[0]![2] & 0x1f).toBe(high[1]![2] & 0x1f);
  });

  it('all notes off keys off every channel in use', () => {
    const { d, writes } = driver({ '01': FM });
    d.noteOn('01', 127, 0, 0, noteHz(0x30));
    d.flush();
    d.noteOn('01', 127, 0, 1, noteHz(0x40));
    d.flush();
    writes.length = 0;
    d.allNotesOff(1);
    expect(hex(writes)).toEqual(['b0=0a', 'b1=0e']);
  });
});

describe('the OPL mix level against the samples (OpenMPT’s balance)', () => {
  const song = (masterVolume: number, formatVersion = 2) => ({ masterVolume, formatVersion }) as S3mSong;

  it('reads the sample pre-amp as OpenMPT’s Load_s3m does', () => {
    expect(s3mSamplePreamp(song(48))).toBe(48);
    expect(s3mSamplePreamp(song(0xb0))).toBe(48); // stereo bit: 0x30
    expect(s3mSamplePreamp(song(0xff))).toBe(127);
    expect(s3mSamplePreamp(song(0x80))).toBe(48); // 0 means the default
    expect(s3mSamplePreamp(song(0x05))).toBe(16); // clamped up
    expect(s3mSamplePreamp(song(0x12))).toBe(32); // ST3's 2 | 0x10 quirk
    expect(s3mSamplePreamp(song(3, 1))).toBe(64); // old format: (3 + 1) * 16
  });

  it('keeps the chip at OpenMPT’s ratio to a centred full-volume sample', () => {
    // OpenMPT: chip ~1.1297, sample preamp / 128; here the sample is cos(pi/4).
    const openmpt = (32768 * 6169 * 0.75) / 2 ** 27;
    for (const mv of [32, 48, 64, 127]) {
      const ratioHere = s3mOplMixGain(song(mv)) / Math.SQRT1_2;
      expect(ratioHere).toBeCloseTo(openmpt / (mv / 128), 9);
    }
    expect(s3mOplMixGain(song(48))).toBeCloseTo(2.13, 2);
  });
});
