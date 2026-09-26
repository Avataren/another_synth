/**
 * The C64's CPU, a MOS 6510 (an NMOS 6502 with an I/O port), for running
 * `.sid` players (plan-psid-import.md D2). Our own code. It runs every
 * opcode the NMOS part runs, because players use the undocumented ones:
 *
 *  - the documented set, with decimal-mode ADC/SBC as the NMOS part computes
 *    them (flags N, V, Z from the binary sum, as documented by VICE);
 *  - the stable undocumented ones (SLO RLA SRE RRA SAX LAX DCP ISC ANC ALR
 *    ARR SBX, the NOPs of every length, SBC $EB);
 *  - the unstable ones with their common behaviour (ANE and LXA with the
 *    magic constant $EE, SHA/SHX/SHY/TAS store `value & (high + 1)`, LAS);
 *  - the twelve JAM opcodes stop the CPU (`jammed`).
 *
 * Cycle counts are the documented NMOS ones, with the page-crossing and
 * branch penalties. A read-modify-write instruction writes the unmodified
 * value first and then the result, as the chip does: an IRQ handler's
 * `inc $d019` acknowledges the VIC through that first write.
 */

export interface CpuBus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

const C = 0x01;
const Z = 0x02;
const I = 0x04;
const D = 0x08;
const B = 0x10;
const U = 0x20;
const V = 0x40;
const N = 0x80;

// Addressing modes.
const IMP = 0;
const IMM = 1;
const ZP = 2;
const ZPX = 3;
const ZPY = 4;
const ABS = 5;
const ABX = 6;
const ABY = 7;
const IND = 8;
const IZX = 9;
const IZY = 10;
const REL = 11;
const ACC = 12;

// Operations.
const enumOps = [
  'ADC', 'AND', 'ASL', 'BCC', 'BCS', 'BEQ', 'BIT', 'BMI', 'BNE', 'BPL', 'BRK', 'BVC', 'BVS', 'CLC',
  'CLD', 'CLI', 'CLV', 'CMP', 'CPX', 'CPY', 'DEC', 'DEX', 'DEY', 'EOR', 'INC', 'INX', 'INY', 'JMP',
  'JSR', 'LDA', 'LDX', 'LDY', 'LSR', 'NOP', 'ORA', 'PHA', 'PHP', 'PLA', 'PLP', 'ROL', 'ROR', 'RTI',
  'RTS', 'SBC', 'SEC', 'SED', 'SEI', 'STA', 'STX', 'STY', 'TAX', 'TAY', 'TSX', 'TXA', 'TXS', 'TYA',
  'SLO', 'RLA', 'SRE', 'RRA', 'SAX', 'LAX', 'DCP', 'ISC', 'ANC', 'ALR', 'ARR', 'SBX', 'LAS', 'SHA',
  'SHX', 'SHY', 'TAS', 'ANE', 'LXA', 'JAM',
] as const;
type OpName = (typeof enumOps)[number];
const OP: Record<OpName, number> = Object.fromEntries(enumOps.map((n, i) => [n, i])) as Record<OpName, number>;

/** Per opcode: operation, mode, base cycles, +1 on a page cross (reads only). */
const KIND = new Uint8Array(256).fill(OP.JAM);
const MODE = new Uint8Array(256);
const CYCLES = new Uint8Array(256).fill(2);
const PAGE = new Uint8Array(256);

function op(code: number, name: OpName, mode: number, cycles: number, page = 0): void {
  KIND[code] = OP[name];
  MODE[code] = mode;
  CYCLES[code] = cycles;
  PAGE[code] = page;
}

/** The eight-mode group of ORA/AND/EOR/ADC/LDA/CMP/SBC at `base` (base = the (zp,X) opcode). */
function aluGroup(base: number, name: OpName): void {
  op(base + 0x00, name, IZX, 6);
  op(base + 0x04, name, ZP, 3);
  op(base + 0x08, name, IMM, 2);
  op(base + 0x0c, name, ABS, 4);
  op(base + 0x10, name, IZY, 5, 1);
  op(base + 0x14, name, ZPX, 4);
  op(base + 0x18, name, ABY, 4, 1);
  op(base + 0x1c, name, ABX, 4, 1);
}
aluGroup(0x01, 'ORA');
aluGroup(0x21, 'AND');
aluGroup(0x41, 'EOR');
aluGroup(0x61, 'ADC');
aluGroup(0xa1, 'LDA');
aluGroup(0xc1, 'CMP');
aluGroup(0xe1, 'SBC');
// STA: no immediate, no page penalty.
op(0x81, 'STA', IZX, 6);
op(0x85, 'STA', ZP, 3);
op(0x8d, 'STA', ABS, 4);
op(0x91, 'STA', IZY, 6);
op(0x95, 'STA', ZPX, 4);
op(0x99, 'STA', ABY, 5);
op(0x9d, 'STA', ABX, 5);
op(0x89, 'NOP', IMM, 2);

/** The shift/INC/DEC group at `base` (base = the zp opcode - 4 for ASL at $06). */
function rmwGroup(zp: number, name: OpName, acc: boolean): void {
  op(zp, name, ZP, 5);
  if (acc) op(zp + 0x04, name, ACC, 2);
  op(zp + 0x08, name, ABS, 6);
  op(zp + 0x10, name, ZPX, 6);
  op(zp + 0x18, name, ABX, 7);
}
rmwGroup(0x06, 'ASL', true);
rmwGroup(0x26, 'ROL', true);
rmwGroup(0x46, 'LSR', true);
rmwGroup(0x66, 'ROR', true);
rmwGroup(0xc6, 'DEC', false);
rmwGroup(0xe6, 'INC', false);

/** The undocumented read-modify-write + ALU group (SLO..ISC) at `base` (the (zp,X) opcode). */
function illegalRmwGroup(base: number, name: OpName): void {
  op(base + 0x00, name, IZX, 8);
  op(base + 0x04, name, ZP, 5);
  op(base + 0x0c, name, ABS, 6);
  op(base + 0x10, name, IZY, 8);
  op(base + 0x14, name, ZPX, 6);
  op(base + 0x18, name, ABY, 7);
  op(base + 0x1c, name, ABX, 7);
}
illegalRmwGroup(0x03, 'SLO');
illegalRmwGroup(0x23, 'RLA');
illegalRmwGroup(0x43, 'SRE');
illegalRmwGroup(0x63, 'RRA');
illegalRmwGroup(0xc3, 'DCP');
illegalRmwGroup(0xe3, 'ISC');

op(0x83, 'SAX', IZX, 6);
op(0x87, 'SAX', ZP, 3);
op(0x8f, 'SAX', ABS, 4);
op(0x97, 'SAX', ZPY, 4);
op(0xa3, 'LAX', IZX, 6);
op(0xa7, 'LAX', ZP, 3);
op(0xab, 'LXA', IMM, 2);
op(0xaf, 'LAX', ABS, 4);
op(0xb3, 'LAX', IZY, 5, 1);
op(0xb7, 'LAX', ZPY, 4);
op(0xbf, 'LAX', ABY, 4, 1);
op(0x0b, 'ANC', IMM, 2);
op(0x2b, 'ANC', IMM, 2);
op(0x4b, 'ALR', IMM, 2);
op(0x6b, 'ARR', IMM, 2);
op(0x8b, 'ANE', IMM, 2);
op(0xcb, 'SBX', IMM, 2);
op(0xeb, 'SBC', IMM, 2);
op(0x93, 'SHA', IZY, 6);
op(0x9f, 'SHA', ABY, 5);
op(0x9b, 'TAS', ABY, 5);
op(0x9c, 'SHY', ABX, 5);
op(0x9e, 'SHX', ABY, 5);
op(0xbb, 'LAS', ABY, 4, 1);

// LDX/LDY/STX/STY/CPX/CPY/BIT.
op(0xa2, 'LDX', IMM, 2);
op(0xa6, 'LDX', ZP, 3);
op(0xae, 'LDX', ABS, 4);
op(0xb6, 'LDX', ZPY, 4);
op(0xbe, 'LDX', ABY, 4, 1);
op(0xa0, 'LDY', IMM, 2);
op(0xa4, 'LDY', ZP, 3);
op(0xac, 'LDY', ABS, 4);
op(0xb4, 'LDY', ZPX, 4);
op(0xbc, 'LDY', ABX, 4, 1);
op(0x86, 'STX', ZP, 3);
op(0x8e, 'STX', ABS, 4);
op(0x96, 'STX', ZPY, 4);
op(0x84, 'STY', ZP, 3);
op(0x8c, 'STY', ABS, 4);
op(0x94, 'STY', ZPX, 4);
op(0xe0, 'CPX', IMM, 2);
op(0xe4, 'CPX', ZP, 3);
op(0xec, 'CPX', ABS, 4);
op(0xc0, 'CPY', IMM, 2);
op(0xc4, 'CPY', ZP, 3);
op(0xcc, 'CPY', ABS, 4);
op(0x24, 'BIT', ZP, 3);
op(0x2c, 'BIT', ABS, 4);

// Branches.
op(0x10, 'BPL', REL, 2);
op(0x30, 'BMI', REL, 2);
op(0x50, 'BVC', REL, 2);
op(0x70, 'BVS', REL, 2);
op(0x90, 'BCC', REL, 2);
op(0xb0, 'BCS', REL, 2);
op(0xd0, 'BNE', REL, 2);
op(0xf0, 'BEQ', REL, 2);

// Jumps, stack, implied.
op(0x00, 'BRK', IMP, 7);
op(0x20, 'JSR', ABS, 6);
op(0x40, 'RTI', IMP, 6);
op(0x60, 'RTS', IMP, 6);
op(0x4c, 'JMP', ABS, 3);
op(0x6c, 'JMP', IND, 5);
op(0x08, 'PHP', IMP, 3);
op(0x28, 'PLP', IMP, 4);
op(0x48, 'PHA', IMP, 3);
op(0x68, 'PLA', IMP, 4);
op(0x18, 'CLC', IMP, 2);
op(0x38, 'SEC', IMP, 2);
op(0x58, 'CLI', IMP, 2);
op(0x78, 'SEI', IMP, 2);
op(0xb8, 'CLV', IMP, 2);
op(0xd8, 'CLD', IMP, 2);
op(0xf8, 'SED', IMP, 2);
op(0x88, 'DEY', IMP, 2);
op(0xc8, 'INY', IMP, 2);
op(0xca, 'DEX', IMP, 2);
op(0xe8, 'INX', IMP, 2);
op(0x8a, 'TXA', IMP, 2);
op(0x98, 'TYA', IMP, 2);
op(0x9a, 'TXS', IMP, 2);
op(0xa8, 'TAY', IMP, 2);
op(0xaa, 'TAX', IMP, 2);
op(0xba, 'TSX', IMP, 2);
op(0xea, 'NOP', IMP, 2);
for (const c of [0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa]) op(c, 'NOP', IMP, 2);
for (const c of [0x80, 0x82, 0xc2, 0xe2]) op(c, 'NOP', IMM, 2);
for (const c of [0x04, 0x44, 0x64]) op(c, 'NOP', ZP, 3);
for (const c of [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4]) op(c, 'NOP', ZPX, 4);
op(0x0c, 'NOP', ABS, 4);
for (const c of [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc]) op(c, 'NOP', ABX, 4, 1);
for (const c of [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2]) op(c, 'JAM', IMP, 2);

/** The mnemonic of `opcode` (lower case), for messages and tests. */
export function mos6510Mnemonic(opcode: number): string {
  return enumOps[KIND[opcode & 0xff]!]!.toLowerCase();
}

export class Mos6510 {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xff;
  p = U | I;
  pc = 0;
  /** Clock cycles run so far. */
  cycles = 0;
  /** A JAM opcode stopped the CPU at `pc`. */
  jammed = false;

  constructor(private readonly bus: CpuBus) {}

  private push(v: number): void {
    this.bus.write(0x100 | this.sp, v);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pull(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.bus.read(0x100 | this.sp);
  }

  private setNZ(v: number): number {
    this.p = (this.p & ~(N | Z)) | (v & N) | (v === 0 ? Z : 0);
    return v;
  }

  private adc(v: number): void {
    const a = this.a;
    const c = this.p & C;
    if (this.p & D) {
      let lo = (a & 0x0f) + (v & 0x0f) + c;
      if (lo > 0x09) lo += 0x06;
      let t = lo <= 0x0f ? (lo & 0x0f) + (a & 0xf0) + (v & 0xf0) : (lo & 0x0f) + (a & 0xf0) + (v & 0xf0) + 0x10;
      const zero = ((a + v + c) & 0xff) === 0;
      const neg = (t & 0x80) !== 0;
      const ovf = ((a ^ t) & 0x80) !== 0 && ((a ^ v) & 0x80) === 0;
      if ((t & 0x1f0) > 0x90) t += 0x60;
      const carry = (t & 0xff0) > 0xf0;
      this.p = (this.p & ~(N | V | Z | C)) | (neg ? N : 0) | (ovf ? V : 0) | (zero ? Z : 0) | (carry ? C : 0);
      this.a = t & 0xff;
      return;
    }
    const r = a + v + c;
    this.p = (this.p & ~(V | C)) | ((~(a ^ v) & (a ^ r) & 0x80) !== 0 ? V : 0) | (r > 0xff ? C : 0);
    this.a = this.setNZ(r & 0xff);
  }

  private sbc(v: number): void {
    const a = this.a;
    const borrow = (this.p & C) ^ 1;
    const r = a - v - borrow;
    // Flags are the binary subtraction's, in both modes (NMOS).
    this.p = (this.p & ~(V | C)) | (((a ^ v) & (a ^ r) & 0x80) !== 0 ? V : 0) | (r >= 0 ? C : 0);
    this.setNZ(r & 0xff);
    if (this.p & D) {
      const lo = (a & 0x0f) - (v & 0x0f) - borrow;
      let t = lo & 0x10 ? ((lo - 6) & 0x0f) | ((a & 0xf0) - (v & 0xf0) - 0x10) : (lo & 0x0f) | ((a & 0xf0) - (v & 0xf0));
      if (t & 0x100) t -= 0x60;
      this.a = t & 0xff;
      return;
    }
    this.a = r & 0xff;
  }

  private compare(reg: number, v: number): void {
    const r = reg - v;
    this.p = (this.p & ~C) | (r >= 0 ? C : 0);
    this.setNZ(r & 0xff);
  }

  private asl(v: number): number {
    this.p = (this.p & ~C) | (v >> 7);
    return this.setNZ((v << 1) & 0xff);
  }
  private lsr(v: number): number {
    this.p = (this.p & ~C) | (v & 1);
    return this.setNZ(v >> 1);
  }
  private rol(v: number): number {
    const r = ((v << 1) | (this.p & C)) & 0xff;
    this.p = (this.p & ~C) | (v >> 7);
    return this.setNZ(r);
  }
  private ror(v: number): number {
    const r = (v >> 1) | ((this.p & C) << 7);
    this.p = (this.p & ~C) | (v & 1);
    return this.setNZ(r);
  }

  /** Take the IRQ line: false (nothing done) while I is set. */
  irq(): boolean {
    if (this.p & I) return false;
    this.interrupt(0xfffe);
    return true;
  }

  /** Take an NMI (edge): always. */
  nmi(): void {
    this.interrupt(0xfffa);
  }

  private interrupt(vector: number): void {
    this.jammed = false;
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    this.push((this.p & ~B) | U);
    this.p |= I;
    this.pc = this.bus.read(vector) | (this.bus.read(vector + 1) << 8);
    this.cycles += 7;
  }

  /** Run one instruction; its cycles. A jammed CPU stays put (2 cycles a call, so time still passes). */
  step(): number {
    if (this.jammed) {
      this.cycles += 2;
      return 2;
    }
    const bus = this.bus;
    const opcode = bus.read(this.pc);
    let pc = (this.pc + 1) & 0xffff;
    let cycles = CYCLES[opcode]!;
    let addr = 0;
    // For SHA/SHX/SHY/TAS: the high byte of the base address, plus one.
    let high1 = 0;
    switch (MODE[opcode]) {
      case IMM:
        addr = pc;
        pc = (pc + 1) & 0xffff;
        break;
      case ZP:
        addr = bus.read(pc);
        pc = (pc + 1) & 0xffff;
        break;
      case ZPX:
        addr = (bus.read(pc) + this.x) & 0xff;
        pc = (pc + 1) & 0xffff;
        break;
      case ZPY:
        addr = (bus.read(pc) + this.y) & 0xff;
        pc = (pc + 1) & 0xffff;
        break;
      case ABS:
        addr = bus.read(pc) | (bus.read((pc + 1) & 0xffff) << 8);
        pc = (pc + 2) & 0xffff;
        break;
      case ABX: {
        const base = bus.read(pc) | (bus.read((pc + 1) & 0xffff) << 8);
        addr = (base + this.x) & 0xffff;
        if (PAGE[opcode] && (base ^ addr) & 0xff00) cycles++;
        high1 = ((base >> 8) + 1) & 0xff;
        pc = (pc + 2) & 0xffff;
        break;
      }
      case ABY: {
        const base = bus.read(pc) | (bus.read((pc + 1) & 0xffff) << 8);
        addr = (base + this.y) & 0xffff;
        if (PAGE[opcode] && (base ^ addr) & 0xff00) cycles++;
        high1 = ((base >> 8) + 1) & 0xff;
        pc = (pc + 2) & 0xffff;
        break;
      }
      case IND: {
        const ptr = bus.read(pc) | (bus.read((pc + 1) & 0xffff) << 8);
        // The NMOS page-wrap: the high byte comes from the same page.
        addr = bus.read(ptr) | (bus.read((ptr & 0xff00) | ((ptr + 1) & 0xff)) << 8);
        pc = (pc + 2) & 0xffff;
        break;
      }
      case IZX: {
        const zp = (bus.read(pc) + this.x) & 0xff;
        addr = bus.read(zp) | (bus.read((zp + 1) & 0xff) << 8);
        pc = (pc + 1) & 0xffff;
        break;
      }
      case IZY: {
        const zp = bus.read(pc);
        const base = bus.read(zp) | (bus.read((zp + 1) & 0xff) << 8);
        addr = (base + this.y) & 0xffff;
        if (PAGE[opcode] && (base ^ addr) & 0xff00) cycles++;
        high1 = ((base >> 8) + 1) & 0xff;
        pc = (pc + 1) & 0xffff;
        break;
      }
      case REL: {
        const d = bus.read(pc);
        pc = (pc + 1) & 0xffff;
        addr = (pc + (d < 0x80 ? d : d - 0x100)) & 0xffff;
        break;
      }
      default:
        break;
    }
    this.pc = pc;

    switch (KIND[opcode]) {
      case OP.LDA:
        this.a = this.setNZ(bus.read(addr));
        break;
      case OP.LDX:
        this.x = this.setNZ(bus.read(addr));
        break;
      case OP.LDY:
        this.y = this.setNZ(bus.read(addr));
        break;
      case OP.STA:
        bus.write(addr, this.a);
        break;
      case OP.STX:
        bus.write(addr, this.x);
        break;
      case OP.STY:
        bus.write(addr, this.y);
        break;
      case OP.ADC:
        this.adc(bus.read(addr));
        break;
      case OP.SBC:
        this.sbc(bus.read(addr));
        break;
      case OP.AND:
        this.a = this.setNZ(this.a & bus.read(addr));
        break;
      case OP.ORA:
        this.a = this.setNZ(this.a | bus.read(addr));
        break;
      case OP.EOR:
        this.a = this.setNZ(this.a ^ bus.read(addr));
        break;
      case OP.CMP:
        this.compare(this.a, bus.read(addr));
        break;
      case OP.CPX:
        this.compare(this.x, bus.read(addr));
        break;
      case OP.CPY:
        this.compare(this.y, bus.read(addr));
        break;
      case OP.BIT: {
        const v = bus.read(addr);
        this.p = (this.p & ~(N | V | Z)) | (v & (N | V)) | ((this.a & v) === 0 ? Z : 0);
        break;
      }
      case OP.ASL:
      case OP.LSR:
      case OP.ROL:
      case OP.ROR:
      case OP.INC:
      case OP.DEC: {
        const kind = KIND[opcode]!;
        if (MODE[opcode] === ACC) {
          this.a = this.shift(kind, this.a);
          break;
        }
        const v = bus.read(addr);
        bus.write(addr, v);
        bus.write(addr, this.shift(kind, v));
        break;
      }
      case OP.SLO: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = this.asl(v);
        bus.write(addr, r);
        this.a = this.setNZ(this.a | r);
        break;
      }
      case OP.RLA: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = this.rol(v);
        bus.write(addr, r);
        this.a = this.setNZ(this.a & r);
        break;
      }
      case OP.SRE: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = this.lsr(v);
        bus.write(addr, r);
        this.a = this.setNZ(this.a ^ r);
        break;
      }
      case OP.RRA: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = this.ror(v);
        bus.write(addr, r);
        this.adc(r);
        break;
      }
      case OP.DCP: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = (v - 1) & 0xff;
        bus.write(addr, r);
        this.compare(this.a, r);
        break;
      }
      case OP.ISC: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = (v + 1) & 0xff;
        bus.write(addr, r);
        this.sbc(r);
        break;
      }
      case OP.SAX:
        bus.write(addr, this.a & this.x);
        break;
      case OP.LAX:
        this.a = this.x = this.setNZ(bus.read(addr));
        break;
      case OP.LXA:
        this.a = this.x = this.setNZ((this.a | 0xee) & bus.read(addr));
        break;
      case OP.ANE:
        this.a = this.setNZ((this.a | 0xee) & this.x & bus.read(addr));
        break;
      case OP.ANC:
        this.a = this.setNZ(this.a & bus.read(addr));
        this.p = (this.p & ~C) | (this.a >> 7);
        break;
      case OP.ALR:
        this.a = this.lsr(this.a & bus.read(addr));
        break;
      case OP.ARR: {
        const t = this.a & bus.read(addr);
        const r = (t >> 1) | ((this.p & C) << 7);
        this.setNZ(r);
        this.p = (this.p & ~(C | V)) | ((r >> 6) & 1) | (((r >> 6) ^ (r >> 5)) & 1 ? V : 0);
        this.a = r;
        break;
      }
      case OP.SBX: {
        const t = (this.a & this.x) - bus.read(addr);
        this.p = (this.p & ~C) | (t >= 0 ? C : 0);
        this.x = this.setNZ(t & 0xff);
        break;
      }
      case OP.LAS:
        this.a = this.x = this.sp = this.setNZ(bus.read(addr) & this.sp);
        break;
      case OP.SHA:
        bus.write(addr, this.a & this.x & high1);
        break;
      case OP.SHX:
        bus.write(addr, this.x & high1);
        break;
      case OP.SHY:
        bus.write(addr, this.y & high1);
        break;
      case OP.TAS:
        this.sp = this.a & this.x;
        bus.write(addr, this.sp & high1);
        break;
      case OP.NOP:
        if (MODE[opcode] !== IMP && MODE[opcode] !== IMM) bus.read(addr);
        break;
      case OP.INX:
        this.x = this.setNZ((this.x + 1) & 0xff);
        break;
      case OP.INY:
        this.y = this.setNZ((this.y + 1) & 0xff);
        break;
      case OP.DEX:
        this.x = this.setNZ((this.x - 1) & 0xff);
        break;
      case OP.DEY:
        this.y = this.setNZ((this.y - 1) & 0xff);
        break;
      case OP.TAX:
        this.x = this.setNZ(this.a);
        break;
      case OP.TAY:
        this.y = this.setNZ(this.a);
        break;
      case OP.TXA:
        this.a = this.setNZ(this.x);
        break;
      case OP.TYA:
        this.a = this.setNZ(this.y);
        break;
      case OP.TSX:
        this.x = this.setNZ(this.sp);
        break;
      case OP.TXS:
        this.sp = this.x;
        break;
      case OP.PHA:
        this.push(this.a);
        break;
      case OP.PHP:
        this.push(this.p | B | U);
        break;
      case OP.PLA:
        this.a = this.setNZ(this.pull());
        break;
      case OP.PLP:
        this.p = (this.pull() & ~B) | U;
        break;
      case OP.CLC:
        this.p &= ~C;
        break;
      case OP.SEC:
        this.p |= C;
        break;
      case OP.CLI:
        this.p &= ~I;
        break;
      case OP.SEI:
        this.p |= I;
        break;
      case OP.CLV:
        this.p &= ~V;
        break;
      case OP.CLD:
        this.p &= ~D;
        break;
      case OP.SED:
        this.p |= D;
        break;
      case OP.BPL:
        cycles += this.branch(!(this.p & N), addr);
        break;
      case OP.BMI:
        cycles += this.branch((this.p & N) !== 0, addr);
        break;
      case OP.BVC:
        cycles += this.branch(!(this.p & V), addr);
        break;
      case OP.BVS:
        cycles += this.branch((this.p & V) !== 0, addr);
        break;
      case OP.BCC:
        cycles += this.branch(!(this.p & C), addr);
        break;
      case OP.BCS:
        cycles += this.branch((this.p & C) !== 0, addr);
        break;
      case OP.BNE:
        cycles += this.branch(!(this.p & Z), addr);
        break;
      case OP.BEQ:
        cycles += this.branch((this.p & Z) !== 0, addr);
        break;
      case OP.JMP:
        this.pc = addr;
        break;
      case OP.JSR: {
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret & 0xff);
        this.pc = addr;
        break;
      }
      case OP.RTS: {
        const lo = this.pull();
        this.pc = (((this.pull() << 8) | lo) + 1) & 0xffff;
        break;
      }
      case OP.RTI: {
        this.p = (this.pull() & ~B) | U;
        const lo = this.pull();
        this.pc = (this.pull() << 8) | lo;
        break;
      }
      case OP.BRK: {
        const ret = (this.pc + 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret & 0xff);
        this.push(this.p | B | U);
        this.p |= I;
        this.pc = bus.read(0xfffe) | (bus.read(0xffff) << 8);
        break;
      }
      case OP.JAM:
        this.jammed = true;
        this.pc = (this.pc - 1) & 0xffff;
        break;
      default:
        break;
    }
    this.cycles += cycles;
    return cycles;
  }

  private shift(kind: number, v: number): number {
    switch (kind) {
      case OP.ASL:
        return this.asl(v);
      case OP.LSR:
        return this.lsr(v);
      case OP.ROL:
        return this.rol(v);
      case OP.ROR:
        return this.ror(v);
      case OP.INC:
        return this.setNZ((v + 1) & 0xff);
      default:
        return this.setNZ((v - 1) & 0xff);
    }
  }

  /** A branch to `target` when `taken`: its extra cycles (1, or 2 across a page). */
  private branch(taken: boolean, target: number): number {
    if (!taken) return 0;
    const extra = (target & 0xff00) === (this.pc & 0xff00) ? 1 : 2;
    this.pc = target;
    return extra;
  }
}
