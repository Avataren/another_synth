import { C64, c64FrameCycles, KERNAL_BRK_HANDLER, type C64Clock } from './c64';
import { psidSongUsesCia, type PsidFile } from './psid-file';

/**
 * Runs one subsong of a `.sid` on the emulated C64 and records what its
 * player does to the SID, tick by tick (plan-psid-import.md D3, D5): the
 * register trace every later step reads.
 *
 * How the tune is driven, as HVSC's SID file environment says:
 *  - **PSID with a play address** (`mode: 'play'`): `$01` is set for the call
 *    address (`$37` below $A000, `$36` to $CFFF, `$34` in $D000-$DFFF, `$35`
 *    from $E000, as libsidplayfp's driver does), init is called with the
 *    subsong in A, then play once per tick with interrupts off: per video
 *    frame (VBI) or at CIA 1 timer A's rate as init left it (speed bit set).
 *    A play routine that leaves through the KERNAL's interrupt exit
 *    (`$EA31`-`$EA83`) or with an RTI ends its call there.
 *  - **RSID, or a play address of 0** (`mode: 'irq'`): the C64 as the KERNAL
 *    leaves it (CIA 1's 60 Hz interrupt through `$0314`), init is called, then
 *    the CPU idles with interrupts on and the tune's own interrupts run. A
 *    tick is one IRQ handler run that writes the SID. A tune whose player
 *    runs outside interrupts (a main loop) is sampled once per video frame
 *    instead (`mode: 'frame'`).
 *
 * The capture ends when the machine's state (RAM, I/O written) is one it had
 * after an earlier tick: from there the music repeats exactly, and
 * `loopTick` says where. Otherwise it ends at the tick or cycle cap.
 */

export type SidCaptureMode = 'play' | 'irq' | 'frame';

export interface SidCaptureOptions {
  /** 0-based. */
  readonly subsong: number;
  /** At most this many ticks (default: ten minutes' worth). */
  readonly maxTicks?: number;
  /** At most this much emulated time, in seconds (default 600). */
  readonly maxSeconds?: number;
}

/** Per voice per tick, `SidTrace.voiceEvents` bits. */
export const SID_EVENT_GATE_ON = 1;
export const SID_EVENT_GATE_LOW = 2;
export const SID_EVENT_TEST = 4;
export const SID_EVENT_CTRL_WRITTEN = 8;

export const SID_TRACE_REGS = 25;

export interface SidTrace {
  readonly clock: C64Clock;
  readonly mode: SidCaptureMode;
  /** CPU cycles per second of the machine that ran it. */
  readonly clockHz: number;
  /** Cycles of one video frame. */
  readonly frameCycles: number;
  /** Cycles between ticks: the median. */
  readonly tickCycles: number;
  readonly ticks: number;
  /** `ticks` x 25: the first SID's registers after each tick. */
  readonly regs: Uint8Array;
  /**
   * `ticks` x 3: per voice, what happened to its control register inside the
   * tick: `SID_EVENT_GATE_ON` a 0->1 gate edge, `SID_EVENT_GATE_LOW` the gate
   * written 0, `SID_EVENT_TEST` the test bit written 1, `SID_EVENT_CTRL_WRITTEN`.
   */
  readonly voiceEvents: Uint8Array;
  /** The tick the music continues with after the last (an exact repeat), or null (cut at a cap). */
  readonly loopTick: number | null;
  /** SID writes per tick, on average. */
  readonly writesPerTick: number;
  /** `$D418` writes from NMI handlers, or several per tick: sample playback. */
  readonly digi: boolean;
  /** A second or third SID was written. */
  readonly extraSidWrites: number;
  /** Why the capture stopped. */
  readonly end: 'loop' | 'ticks' | 'cycles' | 'silent' | 'jam' | 'brk';
}

export type SidCapture = { readonly ok: true; readonly trace: SidTrace } | { readonly ok: false; readonly reason: string };

/** Where a host call returns to: in the I/O area, where no player's code runs. */
const RETURN_TRAP = 0xdff0;
/** Where the host idles between the tune's interrupts. */
const IDLE_TRAP = 0xdff8;
const INIT_MAX_CYCLES = 60_000_000;
/** Seconds without a SID-writing interrupt that end an interrupt-driven capture. */
const SILENCE_SECONDS = 3;
const PLAY_MAX_CYCLES = 2_000_000;

/** The `$01` value for a PSID call at `addr` (libsidplayfp's `iomap`). */
export function psidBanksFor(addr: number): number {
  if (addr < 0xa000) return 0x37;
  if (addr < 0xd000) return 0x36;
  if (addr >= 0xe000) return 0x35;
  return 0x34;
}

const hex4 = (v: number): string => `$${v.toString(16).toUpperCase().padStart(4, '0')}`;

type CallEnd = 'return' | 'kernal-exit' | 'rti' | 'jam' | 'brk' | 'timeout';

class Recorder {
  readonly regs = new Uint8Array(32);
  readonly ctrl = new Uint8Array(3);
  events = new Uint8Array(3);
  writes = 0;
  tickWrites = 0;
  volumeWrites = 0;
  nmiVolumeWrites = 0;
  extraSidWrites = 0;
  /** The code running is an NMI handler's (the innermost interrupt is an NMI). */
  inNmi = false;

  constructor(machine: C64) {
    machine.onSidWrite = (chip, reg, value) => {
      if (chip !== 0) {
        this.extraSidWrites++;
        return;
      }
      this.writes++;
      // An NMI's writes (samples) are not the tick's: a tick is the music's interrupt.
      if (!this.inNmi) this.tickWrites++;
      this.regs[reg] = value;
      if (reg === 0x18) {
        this.volumeWrites++;
        if (this.inNmi) this.nmiVolumeWrites++;
      }
      if (reg === 4 || reg === 11 || reg === 18) {
        const v = (reg - 4) / 7;
        const old = this.ctrl[v]!;
        let e = this.events[v]! | SID_EVENT_CTRL_WRITTEN;
        if (value & 1 && !(old & 1)) e |= SID_EVENT_GATE_ON;
        if (!(value & 1)) e |= SID_EVENT_GATE_LOW;
        if (value & 8) e |= SID_EVENT_TEST;
        this.events[v] = e;
        this.ctrl[v] = value;
      }
    };
  }
}

/** Growable per-tick storage. */
class TickStore {
  regs = new Uint8Array(25 * 1024);
  events = new Uint8Array(3 * 1024);
  cycles: number[] = [];
  ticks = 0;

  push(rec: Recorder, cycle: number): void {
    if ((this.ticks + 1) * 25 > this.regs.length) {
      const r = new Uint8Array(this.regs.length * 2);
      r.set(this.regs);
      this.regs = r;
      const e = new Uint8Array(this.events.length * 2);
      e.set(this.events);
      this.events = e;
    }
    this.regs.set(rec.regs.subarray(0, 25), this.ticks * 25);
    this.events.set(rec.events, this.ticks * 3);
    rec.events = new Uint8Array(3);
    this.cycles.push(cycle);
    this.ticks++;
  }
}

/** Set the CPU up as if the host had JSR'd to `addr` with A = `a` and interrupts off. */
function enterCall(machine: C64, addr: number, a: number): void {
  const cpu = machine.cpu;
  cpu.a = a;
  cpu.x = 0;
  cpu.y = 0;
  cpu.p = 0x24;
  machine.write(0x1ff, (RETURN_TRAP - 1) >> 8);
  machine.write(0x1fe, (RETURN_TRAP - 1) & 0xff);
  cpu.sp = 0xfd;
  cpu.pc = addr;
  cpu.jammed = false;
}

/** Run `file`'s subsong `options.subsong` and record its SID trace. Never throws for a tune's behaviour. */
export function captureSid(file: PsidFile, options: SidCaptureOptions): SidCapture {
  const clock: C64Clock = file.clock === 'ntsc' ? 'ntsc' : 'pal';
  const machine = new C64(clock, file.extraSids);
  const cpu = machine.cpu;
  machine.load(file.loadAddress, file.data);
  const rec = new Recorder(machine);
  const frameCycles = c64FrameCycles(machine.timing);
  const subsong = Math.max(0, Math.min(file.songs - 1, options.subsong));
  const irqMode = file.type === 'RSID' || file.playAddress === 0;

  // A host JSR to `addr` with interrupts off, run until it returns (or leaves
  // the way an interrupt handler does).
  const call = (addr: number, a: number, maxCycles: number): CallEnd => {
    enterCall(machine, addr, a);
    const limit = cpu.cycles + maxCycles;
    while (cpu.cycles < limit) {
      const pc = cpu.pc;
      if (pc === RETURN_TRAP) return 'return';
      if (pc >= 0xea31 && pc <= 0xea83 && (machine.banks & 2) !== 0) return 'kernal-exit';
      if (pc === KERNAL_BRK_HANDLER && (machine.banks & 2) !== 0) return 'brk';
      if (cpu.jammed) return 'jam';
      if (machine.read(pc) === 0x40 && cpu.sp >= 0xfd) return 'rti';
      cpu.step();
    }
    return 'timeout';
  };

  if (!irqMode) {
    machine.setBanks(psidBanksFor(file.initAddress));
    const initEnd = call(file.initAddress, subsong, INIT_MAX_CYCLES);
    if (initEnd === 'jam') return { ok: false, reason: `the tune's init routine (${hex4(file.initAddress)}) stopped the CPU (a JAM opcode at ${hex4(cpu.pc)})` };
    if (initEnd === 'brk') return { ok: false, reason: `the tune's init routine (${hex4(file.initAddress)}) hit a BRK` };
    if (initEnd === 'timeout') {
      return { ok: false, reason: `the tune's init routine (${hex4(file.initAddress)}) did not return in ${INIT_MAX_CYCLES / 1e6} million cycles` };
    }
  } else {
    if (file.type === 'PSID') machine.setBanks(psidBanksFor(file.initAddress));
    enterCall(machine, file.initAddress, subsong);
  }

  const store = new TickStore();
  const seen = new Map<string, number>();
  const maxCycles = (options.maxSeconds ?? 600) * machine.timing.hz;
  let loopTick: number | null = null;
  let end: SidTrace['end'] = 'ticks';
  let mode: SidCaptureMode = irqMode ? 'irq' : 'play';
  let tickCycles = frameCycles;

  const endTick = (cycle: number): boolean => {
    store.push(rec, cycle);
    const h = machine.stateHash();
    const earlier = seen.get(h);
    if (earlier !== undefined) {
      loopTick = earlier + 1;
      end = 'loop';
      return true;
    }
    seen.set(h, store.ticks - 1);
    return false;
  };

  if (!irqMode) {
    // Host-driven play calls.
    const cia = psidSongUsesCia(file, subsong + 1);
    tickCycles = cia ? machine.cia1.a.latch + 1 : frameCycles;
    const maxTicks = options.maxTicks ?? Math.ceil((600 * machine.timing.hz) / tickCycles);
    let next = cpu.cycles;
    while (store.ticks < maxTicks) {
      machine.idleTo(next);
      machine.setBanks(psidBanksFor(file.playAddress));
      rec.tickWrites = 0;
      const e = call(file.playAddress, 0, PLAY_MAX_CYCLES);
      if (e === 'jam' || e === 'brk' || e === 'timeout') {
        if (store.ticks === 0) {
          const why = e === 'jam' ? `stopped the CPU (JAM at ${hex4(cpu.pc)})` : e === 'brk' ? 'hit a BRK' : 'did not return';
          return { ok: false, reason: `the tune's play routine (${hex4(file.playAddress)}) ${why}` };
        }
        end = e === 'timeout' ? 'cycles' : e;
        break;
      }
      if (endTick(next)) break;
      next += tickCycles;
      if (cpu.cycles > maxCycles) {
        end = 'cycles';
        break;
      }
    }
  } else {
    const r = runInterruptDriven(machine, rec, store, endTick, options, frameCycles, maxCycles);
    if (!r.ok) return r;
    mode = r.mode;
    tickCycles = r.tickCycles;
    end = r.end ?? end;
  }

  if (store.ticks === 0) return { ok: false, reason: 'the tune never wrote to the SID' };
  const ticks = store.ticks;
  const volumePerTick = rec.volumeWrites / ticks;
  return {
    ok: true,
    trace: {
      clock,
      mode,
      clockHz: machine.timing.hz,
      frameCycles,
      tickCycles,
      ticks,
      regs: store.regs.slice(0, ticks * 25),
      voiceEvents: store.events.slice(0, ticks * 3),
      loopTick,
      writesPerTick: rec.writes / ticks,
      digi: rec.nmiVolumeWrites > ticks || volumePerTick > 4,
      extraSidWrites: rec.extraSidWrites,
      end,
    },
  };
}

type InterruptRun =
  | { readonly ok: true; readonly mode: SidCaptureMode; readonly tickCycles: number; readonly end: SidTrace['end'] | null }
  | { readonly ok: false; readonly reason: string };

/**
 * RSID / play address 0: the tune's own interrupts, from init's first
 * instruction on (init is running when this starts). When init returns, the
 * host turns interrupts on and idles at `IDLE_TRAP` (time jumps to the next
 * interrupt); a tune whose init never returns keeps running as the main
 * program.
 */
function runInterruptDriven(
  machine: C64,
  rec: Recorder,
  store: TickStore,
  endTick: (cycle: number) => boolean,
  options: SidCaptureOptions,
  frameCycles: number,
  maxCycles: number,
): InterruptRun {
  const cpu = machine.cpu;
  const hz = machine.timing.hz;
  const maxTicks = options.maxTicks ?? Math.ceil((600 * hz) / frameCycles) * 4;
  /** The interrupts being handled, innermost last (an NMI can come inside the music's IRQ). */
  const stack: ('irq' | 'nmi')[] = [];
  /** When the outermost interrupt being handled was taken. */
  let entered = cpu.cycles;
  let irqWrites = 0;
  let mainWrites = 0;
  let mode: SidCaptureMode = 'irq';
  let lastFrameCut = cpu.cycles;
  const start = cpu.cycles;
  let end: SidTrace['end'] | null = null;
  // No SID-writing interrupt for this long after the last: the music has stopped.
  const silence = SILENCE_SECONDS * hz;

  while (store.ticks < maxTicks) {
    if (cpu.cycles - start > maxCycles) {
      end = 'cycles';
      break;
    }
    const last = store.ticks > 0 ? store.cycles[store.ticks - 1]! : start;
    if (cpu.cycles - last > silence && (store.ticks > 0 || mode === 'irq' && irqWrites === 0 && mainWrites === 0)) {
      end = 'silent';
      break;
    }
    if (cpu.jammed) {
      end = 'jam';
      break;
    }
    if (cpu.pc === KERNAL_BRK_HANDLER && (machine.banks & 2) !== 0) {
      end = 'brk';
      break;
    }
    if (cpu.pc === RETURN_TRAP && stack.length === 0) {
      // Init returned to the host: interrupts on, idle.
      cpu.pc = IDLE_TRAP;
      cpu.p &= ~0x04;
    }
    // Idle between interrupts: nothing runs, time jumps (unless one is already waiting).
    if (cpu.pc === IDLE_TRAP && stack.length === 0 && !machine.interruptWaiting()) {
      const next = machine.nextEventCycle;
      if (next === Infinity) {
        end = 'silent';
        break;
      }
      if (mode === 'frame') {
        const cut = lastFrameCut + frameCycles;
        if (cut <= next) {
          machine.idleTo(cut);
          lastFrameCut = cut;
          if (endTick(cut)) break;
          continue;
        }
      }
      machine.idleTo(next);
    }
    const before = rec.writes;
    const taken = machine.takeInterrupt();
    if (taken !== null) {
      if (stack.length === 0) {
        rec.tickWrites = 0;
        entered = cpu.cycles;
      }
      stack.push(taken);
      rec.inNmi = taken === 'nmi';
      machine.hashPaused = rec.inNmi;
      continue;
    }
    const op = machine.read(cpu.pc);
    cpu.step();
    const wrote = rec.writes - before;
    if (stack.length > 0) {
      if (!rec.inNmi) irqWrites += wrote;
      if (op === 0x40) {
        const kind = stack.pop();
        rec.inNmi = stack[stack.length - 1] === 'nmi';
        machine.hashPaused = rec.inNmi;
        // The tick is timed from the interrupt's start: its handler's length varies.
        if (stack.length === 0 && kind === 'irq' && mode === 'irq' && rec.tickWrites > 0 && endTick(entered)) break;
      }
    } else {
      mainWrites += wrote;
    }
    // A player that writes the SID outside interrupts: sample per frame.
    if (mode === 'irq' && store.ticks === 0 && cpu.cycles - start > 2 * hz && mainWrites > 0 && irqWrites === 0) {
      mode = 'frame';
      lastFrameCut = cpu.cycles;
    }
    if (mode === 'frame' && cpu.cycles - lastFrameCut >= frameCycles && stack.length === 0) {
      lastFrameCut += frameCycles;
      if (endTick(lastFrameCut)) break;
    }
  }
  if (store.ticks === 0) {
    return { ok: false, reason: 'the tune set up no interrupt that plays music, and wrote nothing to the SID from its main program' };
  }
  const c = store.cycles;
  const gaps = c.slice(1).map((v, i) => v - c[i]!).sort((x, y) => x - y);
  const tickCycles = mode === 'frame' ? frameCycles : gaps.length > 0 ? gaps[gaps.length >> 1]! : frameCycles;
  return { ok: true, mode, tickCycles, end };
}
