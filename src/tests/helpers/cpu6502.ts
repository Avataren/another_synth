/**
 * A 6502 for tests (plan-sid-authoring.md phase 4): enough of a C64 to run a
 * PSID's init and play routines and read what they left in the SID's
 * registers. Our own code: every documented opcode, binary arithmetic
 * (decimal mode throws: GoatTracker's player never sets it), flat 64 KB of
 * RAM with no I/O (a write to $D400-$D418 is simply kept, which is the
 * register image GoatTracker's `sidreg[]` dump shows).
 *
 * `runPsid` loads a PSID v2 file, calls init with the subsong in A, then play
 * `frames` times, and returns the 25 SID registers after each play call:
 * the format of `gtref`'s `.regs` and of `rust-wasm/examples/sid_regs.rs`.
 */

type Mode = 'imp' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'absx' | 'absy' | 'ind' | 'indx' | 'indy' | 'rel';

const C = 0x01;
const Z = 0x02;
const I = 0x04;
const D = 0x08;
const V = 0x40;
const N = 0x80;

/** Opcode -> [mnemonic, mode]; `acc` forms are `imp` here (the mnemonic tells). */
const TABLE: Record<number, readonly [string, Mode]> = {};
const def = (m: string, modes: Partial<Record<Mode | 'acc', number>>): void => {
  for (const [mode, code] of Object.entries(modes)) TABLE[code] = [m, mode === 'acc' ? 'imp' : (mode as Mode)];
};
def('adc', { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, absx: 0x7d, absy: 0x79, indx: 0x61, indy: 0x71 });
def('and', { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, absx: 0x3d, absy: 0x39, indx: 0x21, indy: 0x31 });
def('asl', { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, absx: 0x1e });
def('bcc', { rel: 0x90 });
def('bcs', { rel: 0xb0 });
def('beq', { rel: 0xf0 });
def('bit', { zp: 0x24, abs: 0x2c });
def('bmi', { rel: 0x30 });
def('bne', { rel: 0xd0 });
def('bpl', { rel: 0x10 });
def('brk', { imp: 0x00 });
def('bvc', { rel: 0x50 });
def('bvs', { rel: 0x70 });
def('clc', { imp: 0x18 });
def('cld', { imp: 0xd8 });
def('cli', { imp: 0x58 });
def('clv', { imp: 0xb8 });
def('cmp', { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, absx: 0xdd, absy: 0xd9, indx: 0xc1, indy: 0xd1 });
def('cpx', { imm: 0xe0, zp: 0xe4, abs: 0xec });
def('cpy', { imm: 0xc0, zp: 0xc4, abs: 0xcc });
def('dec', { zp: 0xc6, zpx: 0xd6, abs: 0xce, absx: 0xde });
def('dex', { imp: 0xca });
def('dey', { imp: 0x88 });
def('eor', { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, absx: 0x5d, absy: 0x59, indx: 0x41, indy: 0x51 });
def('inc', { zp: 0xe6, zpx: 0xf6, abs: 0xee, absx: 0xfe });
def('inx', { imp: 0xe8 });
def('iny', { imp: 0xc8 });
def('jmp', { abs: 0x4c, ind: 0x6c });
def('jsr', { abs: 0x20 });
def('lda', { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, absx: 0xbd, absy: 0xb9, indx: 0xa1, indy: 0xb1 });
def('ldx', { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, absy: 0xbe });
def('ldy', { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, absx: 0xbc });
def('lsr', { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, absx: 0x5e });
def('nop', { imp: 0xea });
def('ora', { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, absx: 0x1d, absy: 0x19, indx: 0x01, indy: 0x11 });
def('pha', { imp: 0x48 });
def('php', { imp: 0x08 });
def('pla', { imp: 0x68 });
def('plp', { imp: 0x28 });
def('rol', { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, absx: 0x3e });
def('ror', { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, absx: 0x7e });
def('rti', { imp: 0x40 });
def('rts', { imp: 0x60 });
def('sbc', { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, absx: 0xfd, absy: 0xf9, indx: 0xe1, indy: 0xf1 });
def('sec', { imp: 0x38 });
def('sed', { imp: 0xf8 });
def('sei', { imp: 0x78 });
def('sta', { zp: 0x85, zpx: 0x95, abs: 0x8d, absx: 0x9d, absy: 0x99, indx: 0x81, indy: 0x91 });
def('stx', { zp: 0x86, zpy: 0x96, abs: 0x8e });
def('sty', { zp: 0x84, zpx: 0x94, abs: 0x8c });
def('tax', { imp: 0xaa });
def('tay', { imp: 0xa8 });
def('tsx', { imp: 0xba });
def('txa', { imp: 0x8a });
def('txs', { imp: 0x9a });
def('tya', { imp: 0x98 });

export class Cpu6502 {
  readonly mem = new Uint8Array(0x10000);
  a = 0;
  x = 0;
  y = 0;
  sp = 0xff;
  p = 0x24;
  pc = 0;
  /** Instructions executed so far. */
  steps = 0;

  private rd(addr: number): number {
    return this.mem[addr & 0xffff]!;
  }
  private wr(addr: number, v: number): void {
    this.mem[addr & 0xffff] = v & 0xff;
  }
  private word(addr: number): number {
    return this.rd(addr) | (this.rd(addr + 1) << 8);
  }
  /** The zero-page word at `zp`, wrapping inside page 0 as the 6502 does. */
  private zpWord(zp: number): number {
    return this.rd(zp & 0xff) | (this.rd((zp + 1) & 0xff) << 8);
  }
  private push(v: number): void {
    this.wr(0x100 | this.sp, v);
    this.sp = (this.sp - 1) & 0xff;
  }
  private pull(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.rd(0x100 | this.sp);
  }
  private nz(v: number): number {
    this.p = (this.p & ~(N | Z)) | (v & N) | (v & 0xff ? 0 : Z);
    return v & 0xff;
  }
  private flag(f: number, on: boolean): void {
    this.p = on ? this.p | f : this.p & ~f;
  }

  /** The effective address of the operand (after the opcode byte at `pc - 1`). */
  private ea(mode: Mode): number {
    const pc = this.pc;
    switch (mode) {
      case 'imm':
        this.pc += 1;
        return pc;
      case 'zp':
        this.pc += 1;
        return this.rd(pc);
      case 'zpx':
        this.pc += 1;
        return (this.rd(pc) + this.x) & 0xff;
      case 'zpy':
        this.pc += 1;
        return (this.rd(pc) + this.y) & 0xff;
      case 'abs':
        this.pc += 2;
        return this.word(pc);
      case 'absx':
        this.pc += 2;
        return (this.word(pc) + this.x) & 0xffff;
      case 'absy':
        this.pc += 2;
        return (this.word(pc) + this.y) & 0xffff;
      case 'ind': {
        // The 6502's page-wrap bug: the high byte comes from the same page.
        this.pc += 2;
        const at = this.word(pc);
        return this.rd(at) | (this.rd((at & 0xff00) | ((at + 1) & 0xff)) << 8);
      }
      case 'indx':
        this.pc += 1;
        return this.zpWord(this.rd(pc) + this.x);
      case 'indy':
        this.pc += 1;
        return (this.zpWord(this.rd(pc)) + this.y) & 0xffff;
      case 'rel': {
        this.pc += 1;
        const d = this.rd(pc);
        return (this.pc + (d < 0x80 ? d : d - 0x100)) & 0xffff;
      }
      case 'imp':
        return 0;
    }
  }

  private adc(v: number): void {
    if (this.p & D) throw new Error(`decimal-mode ADC at $${this.pc.toString(16)}`);
    const r = this.a + v + (this.p & C);
    this.flag(V, (~(this.a ^ v) & (this.a ^ r) & 0x80) !== 0);
    this.flag(C, r > 0xff);
    this.a = this.nz(r);
  }

  private compare(reg: number, v: number): void {
    this.flag(C, reg >= v);
    this.nz(reg - v);
  }

  /** Run one instruction. */
  step(): void {
    const op = this.rd(this.pc);
    const entry = TABLE[op];
    if (entry === undefined) throw new Error(`illegal opcode $${op.toString(16)} at $${this.pc.toString(16)}`);
    this.pc = (this.pc + 1) & 0xffff;
    this.steps++;
    const [m, mode] = entry;
    const acc = mode === 'imp';
    const addr = this.ea(mode);
    const load = (): number => this.rd(addr);
    const rmw = (fn: (v: number) => number): void => {
      if (acc) this.a = fn(this.a);
      else this.wr(addr, fn(this.rd(addr)));
    };
    switch (m) {
      case 'adc':
        this.adc(load());
        break;
      case 'sbc':
        this.adc(load() ^ 0xff);
        break;
      case 'and':
        this.a = this.nz(this.a & load());
        break;
      case 'ora':
        this.a = this.nz(this.a | load());
        break;
      case 'eor':
        this.a = this.nz(this.a ^ load());
        break;
      case 'asl':
        rmw((v) => {
          this.flag(C, (v & 0x80) !== 0);
          return this.nz(v << 1);
        });
        break;
      case 'lsr':
        rmw((v) => {
          this.flag(C, (v & 1) !== 0);
          return this.nz(v >> 1);
        });
        break;
      case 'rol':
        rmw((v) => {
          const c = this.p & C;
          this.flag(C, (v & 0x80) !== 0);
          return this.nz((v << 1) | c);
        });
        break;
      case 'ror':
        rmw((v) => {
          const c = this.p & C;
          this.flag(C, (v & 1) !== 0);
          return this.nz((v >> 1) | (c << 7));
        });
        break;
      case 'bit': {
        const v = load();
        this.flag(Z, (this.a & v) === 0);
        this.p = (this.p & ~(N | V)) | (v & (N | V));
        break;
      }
      case 'bcc':
        if (!(this.p & C)) this.pc = addr;
        break;
      case 'bcs':
        if (this.p & C) this.pc = addr;
        break;
      case 'beq':
        if (this.p & Z) this.pc = addr;
        break;
      case 'bne':
        if (!(this.p & Z)) this.pc = addr;
        break;
      case 'bmi':
        if (this.p & N) this.pc = addr;
        break;
      case 'bpl':
        if (!(this.p & N)) this.pc = addr;
        break;
      case 'bvc':
        if (!(this.p & V)) this.pc = addr;
        break;
      case 'bvs':
        if (this.p & V) this.pc = addr;
        break;
      case 'brk':
        throw new Error(`BRK at $${((this.pc - 1) & 0xffff).toString(16)}`);
      case 'clc':
        this.flag(C, false);
        break;
      case 'cld':
        this.flag(D, false);
        break;
      case 'cli':
        this.flag(I, false);
        break;
      case 'clv':
        this.flag(V, false);
        break;
      case 'sec':
        this.flag(C, true);
        break;
      case 'sed':
        this.flag(D, true);
        break;
      case 'sei':
        this.flag(I, true);
        break;
      case 'cmp':
        this.compare(this.a, load());
        break;
      case 'cpx':
        this.compare(this.x, load());
        break;
      case 'cpy':
        this.compare(this.y, load());
        break;
      case 'dec':
        this.wr(addr, this.nz(this.rd(addr) - 1));
        break;
      case 'inc':
        this.wr(addr, this.nz(this.rd(addr) + 1));
        break;
      case 'dex':
        this.x = this.nz(this.x - 1);
        break;
      case 'dey':
        this.y = this.nz(this.y - 1);
        break;
      case 'inx':
        this.x = this.nz(this.x + 1);
        break;
      case 'iny':
        this.y = this.nz(this.y + 1);
        break;
      case 'jmp':
        this.pc = addr;
        break;
      case 'jsr': {
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret & 0xff);
        this.pc = addr;
        break;
      }
      case 'rts': {
        const lo = this.pull();
        this.pc = (((this.pull() << 8) | lo) + 1) & 0xffff;
        break;
      }
      case 'rti': {
        this.p = (this.pull() & ~0x10) | 0x20;
        const lo = this.pull();
        this.pc = (this.pull() << 8) | lo;
        break;
      }
      case 'lda':
        this.a = this.nz(load());
        break;
      case 'ldx':
        this.x = this.nz(load());
        break;
      case 'ldy':
        this.y = this.nz(load());
        break;
      case 'sta':
        this.wr(addr, this.a);
        break;
      case 'stx':
        this.wr(addr, this.x);
        break;
      case 'sty':
        this.wr(addr, this.y);
        break;
      case 'nop':
        break;
      case 'pha':
        this.push(this.a);
        break;
      case 'php':
        this.push(this.p | 0x30);
        break;
      case 'pla':
        this.a = this.nz(this.pull());
        break;
      case 'plp':
        this.p = (this.pull() & ~0x10) | 0x20;
        break;
      case 'tax':
        this.x = this.nz(this.a);
        break;
      case 'tay':
        this.y = this.nz(this.a);
        break;
      case 'txa':
        this.a = this.nz(this.x);
        break;
      case 'tya':
        this.a = this.nz(this.y);
        break;
      case 'tsx':
        this.x = this.nz(this.sp);
        break;
      case 'txs':
        this.sp = this.x;
        break;
      default:
        throw new Error(`unimplemented ${m}`);
    }
  }

  /**
   * JSR to `addr` with A = `a` and run until it returns. Throws past
   * `maxSteps` (a routine that never returns).
   */
  call(addr: number, a = 0, maxSteps = 1_000_000): void {
    const RETURN = 0xfff0;
    this.a = a;
    this.push((RETURN - 1) >> 8);
    this.push((RETURN - 1) & 0xff);
    this.pc = addr;
    const start = this.steps;
    while (this.pc !== RETURN) {
      if (this.steps - start > maxSteps) throw new Error(`$${addr.toString(16)} did not return in ${maxSteps} instructions`);
      this.step();
    }
  }
}

export interface PsidHeader {
  readonly version: number;
  readonly dataOffset: number;
  readonly load: number;
  readonly init: number;
  readonly play: number;
  readonly songs: number;
  readonly startSong: number;
  readonly speed: number;
  readonly name: string;
  readonly author: string;
  readonly released: string;
  readonly flags: number;
}

export function readPsidHeader(bytes: Uint8Array): PsidHeader {
  const be = (at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
  const text = (at: number): string => {
    let s = '';
    for (let i = 0; i < 32 && bytes[at + i]; i++) s += String.fromCharCode(bytes[at + i]!);
    return s;
  };
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic !== 'PSID') throw new Error(`not a PSID file (${magic})`);
  const dataOffset = be(6);
  const load = be(8) || bytes[dataOffset]! | (bytes[dataOffset + 1]! << 8);
  return {
    version: be(4),
    dataOffset,
    load,
    init: be(10),
    play: be(12),
    songs: be(14),
    startSong: be(16),
    speed: ((bytes[18]! << 24) | (bytes[19]! << 16) | (bytes[20]! << 8) | bytes[21]!) >>> 0,
    name: text(0x16),
    author: text(0x36),
    released: text(0x56),
    flags: be(0x76),
  };
}

/**
 * Load a PSID into a fresh 6502, call init with `subsong` (0-based) in A,
 * then play `frames` times; the 25 SID registers after each play call.
 * The CIA timer latch init leaves at $DC04/5 is returned too (multispeed).
 */
export function runPsid(bytes: Uint8Array, subsong: number, frames: number): { regs: Uint8Array[]; ciaLatch: number } {
  const h = readPsidHeader(bytes);
  const cpu = new Cpu6502();
  const data = bytes.slice(h.dataOffset + (bytes[8]! | bytes[9]! ? 0 : 2));
  cpu.mem.set(data, h.load);
  cpu.call(h.init, subsong);
  const ciaLatch = cpu.mem[0xdc04]! | (cpu.mem[0xdc05]! << 8);
  const regs: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    cpu.call(h.play);
    regs.push(cpu.mem.slice(0xd400, 0xd419));
  }
  return { regs, ciaLatch };
}

/** `regs` as `gtref`'s `.regs` text: "frame r00 .. r24" in hex, a line per frame. */
export function regsText(regs: readonly Uint8Array[]): string {
  return regs.map((r, f) => `${f} ${Array.from(r, (v) => v.toString(16).padStart(2, '0')).join(' ')}\n`).join('');
}
