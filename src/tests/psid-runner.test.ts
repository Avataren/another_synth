import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePsid, type PsidFile } from 'src/audio/tracker/psid';
import { PsidRunner } from 'src/audio/tracker/psid/psid-runner';
import { captureSid } from 'src/audio/tracker/psid/sid-capture';
import { buildPsid, placeCode } from './helpers/psid-builder';

/**
 * .ai/plan-psid-playback.md: a `.sid` run in step with the audio. The runner
 * is the capture's driver made resumable, so the capture is the oracle: the
 * registers the runner's writes leave at the end of each tick are the ones the
 * capture recorded there.
 */

const FIXTURES = resolve(__dirname, 'fixtures/psid');
const fixture = (name: string): PsidFile => {
  const r = parsePsid(new Uint8Array(readFileSync(resolve(FIXTURES, name))));
  if (!r.ok) throw new Error(r.reason);
  return r.file;
};
const fileOf = (bytes: Uint8Array): PsidFile => {
  const r = parsePsid(bytes);
  if (!r.ok) throw new Error(r.reason);
  return r.file;
};
const created = (file: PsidFile, subsong = 0): PsidRunner => {
  const r = PsidRunner.create(file, subsong);
  if (!r.ok) throw new Error(r.reason);
  return r.runner;
};

interface Write {
  cycle: number;
  reg: number;
  value: number;
}

/** Everything `runner` writes in its first `cycles` cycles, advanced in steps of `step`. */
function writesOver(runner: PsidRunner, cycles: number, step: number): Write[] {
  const out: Write[] = [];
  for (let t = step; t <= cycles; t += step) {
    runner.advance(t);
    expect(runner.horizon).toBeGreaterThanOrEqual(t);
    runner.drain(t, (cycle, reg, value) => out.push({ cycle, reg, value }));
  }
  return out;
}

/** $F0 counts 1, 2, 3, 0, ... and goes to $D400. */
const COUNT_TO_D400 = [0xa6, 0xf0, 0xe8, 0x8a, 0x29, 0x03, 0x85, 0xf0, 0x8d, 0x00, 0xd4];

describe('PsidRunner: a host-driven tune', () => {
  const bytes = buildPsid(
    { init: 0x1000, play: 0x1005 },
    placeCode([
      [0x00, [0xa9, 0x00, 0x85, 0xf0, 0x60]],
      [0x05, [...COUNT_TO_D400, 0x60]],
    ]),
  );

  it('calls play once per PAL frame and stamps each write with the cycle it was made on', () => {
    const w = writesOver(created(fileOf(bytes)), 5 * 312 * 63, 1000).filter((x) => x.reg === 0);
    expect(w.map((x) => x.value)).toEqual([1, 2, 3, 0, 1]);
    const gaps = w.slice(1).map((x, i) => x.cycle - w[i]!.cycle);
    expect(gaps).toEqual([312 * 63, 312 * 63, 312 * 63, 312 * 63]);
  });

  it('gives the same writes however finely it is advanced', () => {
    const total = 12 * 312 * 63;
    const whole = writesOver(created(fileOf(bytes)), total, total);
    const parts = writesOver(created(fileOf(bytes)), total, 2500);
    expect(parts).toEqual(whole);
    expect(whole.length).toBeGreaterThan(5);
  });

  it('does not hand over a write before its cycle, and keeps it for the next drain', () => {
    const runner = created(fileOf(bytes));
    runner.advance(312 * 63 * 3);
    const early: Write[] = [];
    runner.drain(1, (cycle, reg, value) => early.push({ cycle, reg, value }));
    expect(early.every((x) => x.cycle < 1)).toBe(true);
    const rest: Write[] = [];
    runner.drain(312 * 63 * 3, (cycle, reg, value) => rest.push({ cycle, reg, value }));
    expect(rest.filter((x) => x.reg === 0).length).toBe(3);
  });

  it('uses the CIA timer period for a song marked CIA-timed', () => {
    // Init sets CIA 1 timer A's latch to 9999 ($270F) -> a tick every 10000 cycles.
    const cia = buildPsid(
      { init: 0x1000, play: 0x1010, speed: 1 },
      placeCode([
        [0x00, [0xa9, 0x0f, 0x8d, 0x04, 0xdc, 0xa9, 0x27, 0x8d, 0x05, 0xdc, 0x60]],
        [0x10, [...COUNT_TO_D400, 0x60]],
      ]),
    );
    const runner = created(fileOf(cia));
    expect(runner.tickCycles).toBe(10000);
    const w = writesOver(runner, 50_000, 700).filter((x) => x.reg === 0);
    expect(w.length).toBeGreaterThanOrEqual(5);
    expect(w[1]!.cycle - w[0]!.cycle).toBe(10000);
  });

  it('follows a CIA-timed tune that reprograms the timer while it plays (Rubicon: 60 Hz after init, about 124 Hz in play)', () => {
    // Init: latch 9999 (a tick every 10000 cycles). Play: count to $D400, then set the latch to 4999 (every 5000).
    const retimed = buildPsid(
      { init: 0x1000, play: 0x1010, speed: 1 },
      placeCode([
        [0x00, [0xa9, 0x0f, 0x8d, 0x04, 0xdc, 0xa9, 0x27, 0x8d, 0x05, 0xdc, 0x60]],
        [0x10, [...COUNT_TO_D400, 0xa9, 0x87, 0x8d, 0x04, 0xdc, 0xa9, 0x13, 0x8d, 0x05, 0xdc, 0x60]],
      ]),
    );
    const runner = created(fileOf(retimed));
    expect(runner.tickCycles).toBe(10000);
    const w = writesOver(runner, 60_000, 700).filter((x) => x.reg === 0);
    expect(runner.tickCycles).toBe(5000);
    // The first tick set the faster timer: every gap after the first is the new period.
    const gaps = w.slice(1).map((x, i) => x.cycle - w[i]!.cycle);
    expect(gaps.slice(1).every((g) => g === 5000)).toBe(true);
    expect(gaps.length).toBeGreaterThan(5);
  });

  it('stops, and says why, when the player jams the CPU; the horizon is then unbounded', () => {
    const jam = buildPsid(
      { init: 0x1000, play: 0x1005 },
      placeCode([
        [0x00, [0x60]],
        [0x05, [0x02]],
      ]),
    );
    const runner = created(fileOf(jam));
    runner.advance(200_000);
    expect(runner.ended).toMatch(/stopped the CPU/);
    expect(runner.horizon).toBe(Number.POSITIVE_INFINITY);
  });

  it('refuses a tune whose init jams', () => {
    const r = PsidRunner.create(fileOf(buildPsid({ init: 0x1000, play: 0x1005 }, placeCode([[0x00, [0x02]]]))), 0);
    expect(r.ok).toBe(false);
  });
});

describe('PsidRunner: against the capture (the fixtures)', () => {
  const FILES = [
    'hubbard_rob/commando.sid',
    'hubbard_rob/crazy_comets.sid',
    'hubbard_rob/knucklebusters.sid',
    'galway_martin/comic_bakery.sid',
    'daglish_ben/krakout.sid',
    'huelsbeck_chris/r_type.sid',
    'joseph_richard/defender_of_the_crown.sid',
    'tel_jeroen/golden_axe.sid',
    'tel_jeroen/robocop_3.sid',
  ];

  for (const name of FILES) {
    it(`${name}: the registers after each tick are the capture's`, () => {
      const file = fixture(name);
      const cap = captureSid(file, { subsong: file.startSong - 1, maxSeconds: 8 });
      if (!cap.ok) throw new Error(cap.reason);
      const trace = cap.trace;
      // Interrupt-driven tunes have no host ticks to compare at (Chimera, below, is the one of those here).
      expect(trace.mode).toBe('play');
      const runner = created(file, file.startSong - 1);
      expect(runner.mode).toBe('play');
      expect(runner.tickCycles).toBe(trace.tickCycles);
      const ticks = Math.min(trace.ticks, 200);
      const regs = new Uint8Array(32);
      let mismatches = 0;
      let t = 0;
      for (let k = 0; k < ticks; k++) {
        // State just before tick k+1 starts: everything tick k wrote has landed.
        const at = (k + 1) * trace.tickCycles - 1;
        runner.advance(at);
        runner.drain(at, (_c, reg, value) => (regs[reg] = value));
        for (let r = 0; r < 25; r++) if (regs[r] !== trace.regs[k * 25 + r]) mismatches++;
        t = at;
      }
      expect(t).toBeGreaterThan(0);
      expect(mismatches).toBe(0);
    });
  }
});

describe('PsidRunner: a tune that plays from its own interrupts', () => {
  it('Chimera (an RSID) makes sound: it writes a gate-on to a voice', () => {
    const file = fixture('hubbard_rob/chimera.sid');
    const runner = created(file, file.startSong - 1);
    expect(runner.mode).toBe('irq');
    const w = writesOver(runner, 985_248 * 6, 4000);
    expect(w.some((x) => (x.reg === 4 || x.reg === 11 || x.reg === 18) && (x.value & 1) === 1)).toBe(true);
    expect(runner.ended).toBeNull();
  });

  it('is the same however finely it is advanced', () => {
    const file = fixture('hubbard_rob/chimera.sid');
    const total = 985_248 * 2;
    const whole = writesOver(created(file, file.startSong - 1), total, total);
    const parts = writesOver(created(file, file.startSong - 1), total, 2700);
    expect(parts.length).toBe(whole.length);
    expect(parts).toEqual(whole);
  });

  it('an NTSC tune runs on the NTSC clock', () => {
    const file = fixture('chiptunesak/vibratotest.sid');
    const runner = created(file, file.startSong - 1);
    expect(runner.clock).toBe(file.clock === 'ntsc' ? 'ntsc' : 'pal');
    expect(runner.clockHz).toBe(file.clock === 'ntsc' ? 1022727 : 985248);
  });
});
