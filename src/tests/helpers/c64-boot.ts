import { Cpu6502 } from './cpu6502';

/**
 * Enough of a C64 to RUN an exported `.prg` on the test 6502
 * (plan-sid-authoring.md phase 5): the program is loaded where its first two
 * bytes say, its BASIC line must be `SYS <address>`, and the 6502 starts
 * there as BASIC's SYS would (interrupts on). No ROM image: a few stand-ins
 * of our own sit where the KERNAL's entry points are:
 *  - $FFFE -> $FF48: push A, X, Y and `jmp ($0314)` (the KERNAL's IRQ entry);
 *  - $EA31: acknowledge CIA 1 and leave through $EA81 (the KERNAL's handler,
 *    without its keyboard scan and clock); $EA81: pull Y, X, A and RTI;
 *  - $FFE4 GETIN: the next key of `keys` once its time has come, else 0.
 *
 * Interrupts come from the source the program armed, at its rate, counted
 * in cycles: a raster interrupt ($D01A bit 0) once per PAL frame (312 lines
 * of 63 cycles), or CIA 1 timer A ($DC0D = $81, $DC0E bit 0) every latch + 1
 * cycles. Before the program touches them the KERNAL's own CIA interrupt
 * runs, as after a reset. A request waits while I is set, as the chips hold
 * the IRQ line until acknowledged. The registers are plain memory: the last
 * value written is what counts.
 *
 * While the main loop polls GETIN with nothing typed, time jumps to the next
 * interrupt (the poll changes nothing).
 */

export const PAL_FRAME_CYCLES = 312 * 63;
const KEY_BUFFER = 0xe0f0;
const GETIN = 0xffe4;
const GETIN_BODY = 0xe000;

export interface PrgKey {
  /** PETSCII, e.g. $31 for `1`. */
  readonly key: number;
  /** Typed once this many play calls (interrupts) have happened since boot. */
  readonly afterPlays: number;
}

export interface PrgRun {
  /** The SYS address of the BASIC line. */
  readonly sys: number;
  /** Which interrupt drove the player, and its period in cycles. */
  readonly source: 'raster' | 'cia';
  readonly period: number;
  /** Each call of the player's init: A, and how many interrupts had run before it. */
  readonly inits: readonly { readonly subsong: number; readonly atPlay: number }[];
  /** The 25 SID registers after each interrupt handler since the last init. */
  readonly regs: Uint8Array[];
  /** The longest interrupt handler, in cycles from the request to its RTI. */
  readonly maxHandlerCycles: number;
  readonly cpu: Cpu6502;
}

/** The BASIC line's SYS address, or throw: the stub must be exactly `SYS <digits>`. */
export function readSysLine(mem: Uint8Array): number {
  const link = mem[0x0801]! | (mem[0x0802]! << 8);
  if (mem[0x0805] !== 0x9e) throw new Error('the BASIC line is not a SYS');
  let digits = '';
  let at = 0x0806;
  while (mem[at] !== 0) digits += String.fromCharCode(mem[at++]!);
  if (!/^\d+$/.test(digits)) throw new Error(`SYS ${digits}`);
  if (link !== at + 1 || mem[link] !== 0 || mem[link + 1] !== 0) throw new Error('more than one BASIC line');
  return Number(digits);
}

export function runPrg(
  prg: Uint8Array,
  options: { readonly plays: number; readonly player: number; readonly keys?: readonly PrgKey[]; readonly maxSteps?: number },
): PrgRun {
  const cpu = new Cpu6502();
  const mem = cpu.mem;
  const load = prg[0]! | (prg[1]! << 8);
  if (load !== 0x0801) throw new Error(`loads at $${load.toString(16)}, not $0801`);
  mem.set(prg.subarray(2), load);
  const sys = readSysLine(mem);

  // KERNAL state after reset, and our stand-ins.
  mem.set([0x31, 0xea], 0x0314);
  mem[0x01] = 0x37;
  mem.set([0x25, 0x40], 0xdc04); // the KERNAL's 60 Hz latch
  mem[0xdc0d] = 0x81;
  mem[0xdc0e] = 0x11;
  mem.set([0x48, 0x8a, 0x48, 0x98, 0x48, 0x6c, 0x14, 0x03], 0xff48);
  mem.set([0x48, 0xff], 0xfffe);
  mem.set([0xad, 0x0d, 0xdc, 0x4c, 0x81, 0xea], 0xea31);
  mem.set([0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40], 0xea81);
  mem.set([0x4c, GETIN_BODY & 0xff, GETIN_BODY >> 8], GETIN);
  // ldx buffer / lda #0 / sta buffer / txa / rts
  mem.set([0xae, KEY_BUFFER & 0xff, KEY_BUFFER >> 8, 0xa9, 0, 0x8d, KEY_BUFFER & 0xff, KEY_BUFFER >> 8, 0x8a, 0x60], GETIN_BODY);

  // BASIC's SYS: a JSR from the interpreter, interrupts on.
  const BASIC = 0xa7ea;
  cpu.sp = 0xf6;
  mem[0x100 | cpu.sp] = (BASIC - 1) >> 8;
  cpu.sp--;
  mem[0x100 | cpu.sp] = (BASIC - 1) & 0xff;
  cpu.sp--;
  cpu.p = 0x20;
  cpu.pc = sys;

  const keys = [...(options.keys ?? [])];
  const inits: { subsong: number; atPlay: number }[] = [];
  let regs: Uint8Array[] = [];
  let plays = 0;
  let next = Infinity;
  let pending = false;
  let handlerStart = -1;
  let maxHandlerCycles = 0;
  let source: PrgRun['source'] = 'cia';
  let period = 0;
  const maxSteps = options.maxSteps ?? 50_000_000;

  const arm = (): void => {
    const raster = (mem[0xd01a]! & 1) !== 0;
    const cia = mem[0xdc0d] === 0x81 && (mem[0xdc0e]! & 1) !== 0;
    if (raster && cia) throw new Error('both the raster and the CIA interrupt are on');
    source = raster ? 'raster' : 'cia';
    period = raster ? PAL_FRAME_CYCLES : cia ? (mem[0xdc04]! | (mem[0xdc05]! << 8)) + 1 : 0;
  };

  let armed = -1;
  const typing = (): boolean => keys.length > 0 || mem[KEY_BUFFER] !== 0;
  while (regs.length < options.plays || inits.length === 0 || typing()) {
    if (cpu.steps > maxSteps) throw new Error(`no end after ${maxSteps} instructions (${plays} interrupts)`);
    arm();
    if (period !== armed) {
      // A source switched on, off or to another rate: a request of the old one is gone.
      armed = period;
      next = period === 0 ? Infinity : cpu.cycles + period;
      pending = false;
    }
    if (cpu.cycles >= next) {
      pending = true;
      while (next <= cpu.cycles) next += period;
    }
    if (pending && handlerStart < 0 && cpu.irq()) {
      pending = false;
      handlerStart = cpu.cycles - 7;
    }
    if (keys.length > 0 && keys[0]!.afterPlays <= plays && mem[KEY_BUFFER] === 0) mem[KEY_BUFFER] = keys.shift()!.key;
    if (cpu.pc === GETIN && handlerStart < 0 && mem[KEY_BUFFER] === 0 && !pending && next !== Infinity) {
      if (keys.length === 0 || keys[0]!.afterPlays > plays) cpu.cycles = Math.max(cpu.cycles, next);
    }
    if (cpu.pc === options.player) {
      inits.push({ subsong: cpu.a, atPlay: plays });
      regs = [];
    }
    const op = mem[cpu.pc];
    cpu.step();
    if (op === 0x40 && handlerStart >= 0) {
      maxHandlerCycles = Math.max(maxHandlerCycles, cpu.cycles - handlerStart);
      handlerStart = -1;
      plays++;
      if (inits.length > 0) regs.push(mem.slice(0xd400, 0xd419));
    }
  }
  return { sys, source, period, inits, regs, maxHandlerCycles, cpu };
}

/** Screen RAM as 25 lines of text, lower/upper case set, trailing spaces cut. */
export function screenText(mem: Uint8Array): string[] {
  const out: string[] = [];
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 40; col++) {
      const c = mem[0x0400 + row * 40 + col]!;
      if (c === 0) line += '@';
      else if (c <= 26) line += String.fromCharCode(c + 0x60);
      else if (c === 0x1b) line += '[';
      else if (c === 0x1d) line += ']';
      else if (c === 0x64) line += '_';
      else if (c >= 0x20 && c <= 0x3f) line += String.fromCharCode(c);
      else if (c >= 0x41 && c <= 0x5a) line += String.fromCharCode(c);
      else line += '¿';
    }
    out.push(line.trimEnd());
  }
  return out;
}

