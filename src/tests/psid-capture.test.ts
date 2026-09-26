import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePsid, type PsidFile } from 'src/audio/tracker/psid';
import {
  captureSid,
  psidBanksFor,
  SID_EVENT_CTRL_WRITTEN,
  SID_EVENT_GATE_LOW,
  SID_EVENT_GATE_ON,
  type SidTrace,
} from 'src/audio/tracker/psid/sid-capture';
import { traceFrames } from 'src/audio/tracker/psid/transcribe/frames';
import { buildPsid, placeCode } from './helpers/psid-builder';

/**
 * plan-psid-import.md D3/D5: a subsong run on the emulated C64 and recorded
 * tick by tick. Small tunes of our own drive each of the three ways a tune
 * is run (host play calls, its own interrupts, a main loop) and show the
 * loop detection; the fixtures pin what their players really do.
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
const traced = (file: PsidFile, subsong: number, maxSeconds?: number): SidTrace => {
  const c = captureSid(file, maxSeconds === undefined ? { subsong } : { subsong, maxSeconds });
  if (!c.ok) throw new Error(c.reason);
  return c.trace;
};
/** Register `reg` of the first SID after each tick. */
const regAt = (t: SidTrace, reg: number): number[] => Array.from({ length: t.ticks }, (_, i) => t.regs[i * 25 + reg]!);

/** $F0 counts 1, 2, 3, 0, ... and goes to $D400 (the body of every tune below). */
const COUNT_TO_D400 = [0xa6, 0xf0, 0xe8, 0x8a, 0x29, 0x03, 0x85, 0xf0, 0x8d, 0x00, 0xd4];

describe('captureSid: the three ways a tune is run', () => {
  it('a PSID with a play address: init, then play once per PAL frame; the state repeats after four ticks, and the loop is where', () => {
    // $1000 init: LDA #0; STA $F0; RTS. $1005 play: count; RTS.
    const bytes = buildPsid({ init: 0x1000, play: 0x1005 }, placeCode([
      [0x00, [0xa9, 0x00, 0x85, 0xf0, 0x60]],
      [0x05, [...COUNT_TO_D400, 0x60]],
    ]));
    const t = traced(fileOf(bytes), 0);
    expect(t.mode).toBe('play');
    expect(t.clock).toBe('pal');
    expect(t.tickCycles).toBe(312 * 63);
    expect(regAt(t, 0)).toEqual([1, 2, 3, 0, 1]);
    // Tick 4 is tick 0 again: the music goes on with tick 1.
    expect(t.end).toBe('loop');
    expect(t.loopTick).toBe(1);
    expect(t.digi).toBe(false);
  });

  it('records the gate edges of each tick', () => {
    // play: LDA $F0; EOR #1; STA $F0; ORA #$40; STA $D404; RTS (gate on, off, on, ...)
    const bytes = buildPsid({ init: 0x1000, play: 0x1001 }, [0x60, 0xa5, 0xf0, 0x49, 0x01, 0x85, 0xf0, 0x09, 0x40, 0x8d, 0x04, 0xd4, 0x60]);
    const t = traced(fileOf(bytes), 0);
    const events = Array.from({ length: t.ticks }, (_, i) => t.voiceEvents[i * 3]!);
    expect(events).toEqual([SID_EVENT_GATE_ON | SID_EVENT_CTRL_WRITTEN, SID_EVENT_GATE_LOW | SID_EVENT_CTRL_WRITTEN, SID_EVENT_GATE_ON | SID_EVENT_CTRL_WRITTEN]);
    expect(regAt(t, 4)).toEqual([0x41, 0x40, 0x41]);
  });

  it('an RSID: its own CIA interrupt plays it; a tick is one interrupt that writes the SID', () => {
    // init: SEI; ($0314) = $1020; CIA 1 timer A latch $2000, force-loaded, running; CLI; RTS.
    // irq ($1020): count; LDA $DC0D (acknowledge); JMP $EA81 (the KERNAL's exit).
    const bytes = buildPsid({ magic: 'RSID', init: 0x1000, play: 0 }, placeCode([
      [0x00, [0x78, 0xa9, 0x20, 0x8d, 0x14, 0x03, 0xa9, 0x10, 0x8d, 0x15, 0x03]],
      [0x0b, [0xa9, 0x00, 0x8d, 0x04, 0xdc, 0xa9, 0x20, 0x8d, 0x05, 0xdc, 0xa9, 0x11, 0x8d, 0x0e, 0xdc, 0x58, 0x60]],
      [0x20, [...COUNT_TO_D400, 0xad, 0x0d, 0xdc, 0x4c, 0x81, 0xea]],
    ]));
    const t = traced(fileOf(bytes), 0);
    expect(t.mode).toBe('irq');
    // The timer underflows every latch + 1 cycles.
    expect(t.tickCycles).toBe(0x2001);
    expect(regAt(t, 0)).toEqual([1, 2, 3, 0, 1]);
    expect(t.loopTick).toBe(1);
  });

  it('a tune that plays from its main loop, never returning from init: sampled once per video frame', () => {
    // SEI; CIA 1 interrupts off; loop: wait for raster line $80, count, wait for the line to pass.
    const bytes = buildPsid({ magic: 'RSID', init: 0x1000, play: 0 }, [
      0x78, 0xa9, 0x7f, 0x8d, 0x0d, 0xdc,
      0xad, 0x12, 0xd0, 0xc9, 0x80, 0xd0, 0xf9,
      ...COUNT_TO_D400,
      0xad, 0x12, 0xd0, 0xc9, 0x80, 0xf0, 0xf9,
      0x4c, 0x06, 0x10,
    ]);
    const t = traced(fileOf(bytes), 0, 10);
    expect(t.mode).toBe('frame');
    expect(t.tickCycles).toBe(312 * 63);
    // One count per frame, whichever frame the sampling started in.
    const counts = regAt(t, 0);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBe((counts[i - 1]! + 1) & 3);
    expect(t.end).toBe('loop');
  });

  it('samples through $D418 from a CIA 2 NMI are digi (GoatTracker cannot play them)', () => {
    // init: ($0314) = $1030 (the KERNAL's 60 Hz CIA 1 interrupt stays), ($0318) = $1050, and CIA 2
    // timer A every 101 cycles on the NMI line. irq ($1030): count; acknowledge; the KERNAL's exit.
    // nmi ($1050): PHA; toggle $F1 into $D418; LDA $DD0D; PLA; RTI. The NMIs come inside the IRQ
    // too: its tick is still the IRQ's.
    const bytes = buildPsid({ magic: 'RSID', init: 0x1000, play: 0 }, placeCode([
      [0x00, [0x78, 0xa9, 0x30, 0x8d, 0x14, 0x03, 0xa9, 0x10, 0x8d, 0x15, 0x03]],
      [0x0b, [0xa9, 0x50, 0x8d, 0x18, 0x03, 0xa9, 0x10, 0x8d, 0x19, 0x03]],
      [0x15, [0xa9, 0x64, 0x8d, 0x04, 0xdd, 0xa9, 0x00, 0x8d, 0x05, 0xdd, 0xa9, 0x81, 0x8d, 0x0d, 0xdd, 0xa9, 0x11, 0x8d, 0x0e, 0xdd]],
      [0x29, [0x58, 0x60]],
      [0x30, [...COUNT_TO_D400, 0xad, 0x0d, 0xdc, 0x4c, 0x81, 0xea]],
      [0x50, [0x48, 0xa5, 0xf1, 0x49, 0x0f, 0x85, 0xf1, 0x8d, 0x18, 0xd4, 0xad, 0x0d, 0xdd, 0x68, 0x40]],
    ]));
    const t = traced(fileOf(bytes), 0, 2);
    expect(t.mode).toBe('irq');
    expect(t.digi).toBe(true);
    // The KERNAL's timer: 60 Hz, a tick per interrupt, counting on.
    expect(t.tickCycles).toBe(0x4025 + 1);
    expect(regAt(t, 0).slice(0, 5)).toEqual([1, 2, 3, 0, 1]);
  });

  it('says why a tune cannot be run', () => {
    const jam = buildPsid({ init: 0x1000, play: 0x1001 }, [0x02, 0x60]);
    const r = captureSid(fileOf(jam), { subsong: 0 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/init routine \(\$1000\) stopped the CPU \(a JAM opcode at \$1000\)/);
    const brk = buildPsid({ init: 0x1000, play: 0x1001 }, [0x60, 0x00]);
    const b = captureSid(fileOf(brk), { subsong: 0 });
    expect(!b.ok && b.reason).toMatch(/play routine \(\$1001\) hit a BRK/);
    // An RSID whose init only returns: no interrupt, nothing written.
    const idle = buildPsid({ magic: 'RSID', init: 0x1000, play: 0 }, [0x60]);
    const i = captureSid(fileOf(idle), { subsong: 0, maxSeconds: 5 });
    expect(!i.ok && i.reason).toMatch(/no interrupt that plays music/);
  });

  it("sets $01 for the call's address as libsidplayfp does", () => {
    expect([0x1000, 0x9fff, 0xa000, 0xcfff, 0xd000, 0xdfff, 0xe000, 0xffff].map(psidBanksFor)).toEqual([0x37, 0x37, 0x36, 0x36, 0x34, 0x34, 0x35, 0x35]);
  });
});

describe('captureSid: the fixtures', () => {
  it('Commando: a PSID played once per PAL frame, some 11 register writes a tick', () => {
    const t = traced(fixture('hubbard_rob/commando.sid'), 0, 10);
    expect(t.mode).toBe('play');
    expect(t.tickCycles).toBe(19656);
    expect(t.end).toBe('cycles');
    expect(Math.abs(t.ticks - 10 * (985248 / 19656))).toBeLessThan(2);
    expect(t.writesPerTick).toBeGreaterThan(5);
    expect(t.digi).toBe(false);
    expect(t.extraSidWrites).toBe(0);
  });

  it('Knucklebusters (start song 2) and The Last Ninja (3) repeat exactly: the capture ends where the state comes back', () => {
    const k = traced(fixture('hubbard_rob/knucklebusters.sid'), 1);
    expect([k.end, k.ticks, k.loopTick]).toEqual(['loop', 10161, 10158]);
    const n = traced(fixture('daglish_ben/last_ninja.sid'), 2);
    expect([n.end, n.ticks, n.loopTick]).toEqual(['loop', 15177, 2117]);
  });

  it('Defender of the Crown: CIA-timed at ~394 Hz, writing on every 4th call; its frames are the calls that write (98.5 Hz)', () => {
    const t = traced(fixture('joseph_richard/defender_of_the_crown.sid'), 0, 10);
    expect(t.mode).toBe('play');
    expect(t.tickCycles).toBe(2501);
    const f = traceFrames(t);
    expect(f.decimation).toBe(4);
    expect(f.rateHz).toBeCloseTo(985248 / 2501 / 4, 1);
  });

  it('Chimera and The Great Giana Sisters are RSIDs: their own interrupts; Giana and Arkanoid play samples through $D418', () => {
    const chimera = traced(fixture('hubbard_rob/chimera.sid'), 0, 10);
    expect(chimera.mode).toBe('irq');
    expect(chimera.tickCycles).toBe(19656);
    expect(chimera.digi).toBe(false);
    const giana = traced(fixture('huelsbeck_chris/great_giana_sisters.sid'), 0, 30);
    expect(giana.mode).toBe('irq');
    // Its own timer: 50.64 Hz, not the frame's 50.12.
    expect(giana.tickCycles).toBe(19457);
    expect(giana.digi).toBe(true);
    // The music plays on while the drum samples' NMIs run inside its interrupt: every tick is
    // counted (a starved IRQ once read as silence after two seconds).
    expect(giana.end).toBe('cycles');
    expect(giana.ticks).toBeGreaterThan(25 * 50);
    const arkanoid = traced(fixture('galway_martin/arkanoid.sid'), 0, 10);
    expect(arkanoid.mode).toBe('irq');
    expect(arkanoid.digi).toBe(true);
  });

  it('an NTSC tune runs on an NTSC machine (vibratotest.sid, a GoatTracker export)', () => {
    const t = traced(fixture('chiptunesak/vibratotest.sid'), 0);
    expect(t.clock).toBe('ntsc');
    expect(t.frameCycles).toBe(263 * 65);
    expect(t.clockHz).toBe(1022727);
  });
});
