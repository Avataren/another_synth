import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mos6510, mos6510Mnemonic, type CpuBus } from 'src/audio/tracker/psid/mos6510';
import { parsePsid } from 'src/audio/tracker/psid';
import { captureSid } from 'src/audio/tracker/psid/sid-capture';
import { readPsidHeader, runPsid } from './helpers/cpu6502';

/**
 * plan-psid-import.md D2: the 6510 `.sid` players run on. Decimal mode as the
 * NMOS part computes it, the undocumented opcodes players use, the
 * read-modify-write double write, cycle counts and interrupts; then the whole
 * CPU against the tests' own 6502 (`helpers/cpu6502.ts`) on GoatTracker's
 * player, frame by frame, and the C64 around it (`captureSid`) likewise.
 */

class FlatRam implements CpuBus {
  readonly mem = new Uint8Array(0x10000);
  readonly writes: (readonly [number, number])[] = [];
  read(addr: number): number {
    return this.mem[addr]!;
  }
  write(addr: number, value: number): void {
    this.writes.push([addr, value]);
    this.mem[addr] = value;
  }
}

const C = 0x01;
const Z = 0x02;
const I = 0x04;
const D = 0x08;
const B = 0x10;
const V = 0x40;
const N = 0x80;

/** A CPU over flat RAM with `code` at $0200 and PC there. */
function machine(code: readonly number[], at = 0x0200): { cpu: Mos6510; ram: FlatRam } {
  const ram = new FlatRam();
  ram.mem.set(code, at);
  const cpu = new Mos6510(ram);
  cpu.pc = at;
  return { cpu, ram };
}

/** Run `n` instructions; the cycles each took. */
const steps = (cpu: Mos6510, n: number): number[] => Array.from({ length: n }, () => cpu.step());

describe('Mos6510: arithmetic', () => {
  it('binary ADC/SBC: carry and overflow', () => {
    // CLC; LDA #$50; ADC #$50
    const { cpu } = machine([0x18, 0xa9, 0x50, 0x69, 0x50]);
    steps(cpu, 3);
    expect(cpu.a).toBe(0xa0);
    expect(cpu.p & (N | V | Z | C)).toBe(N | V);
    // SEC; LDA #$00; SBC #$01
    const m = machine([0x38, 0xa9, 0x00, 0xe9, 0x01]);
    steps(m.cpu, 3);
    expect(m.cpu.a).toBe(0xff);
    expect(m.cpu.p & (N | V | Z | C)).toBe(N);
  });

  it('decimal ADC as the NMOS part adds: $58 + $46 = $04 carry, N and V from the unadjusted sum, Z from the binary one', () => {
    // SED; CLC; LDA #$58; ADC #$46
    const { cpu } = machine([0xf8, 0x18, 0xa9, 0x58, 0x69, 0x46]);
    steps(cpu, 4);
    expect(cpu.a).toBe(0x04);
    expect(cpu.p & (N | V | Z | C)).toBe(N | V | C);
    // $12 + $34 = $46; $99 + $01 = $00 with carry, yet Z clear ($9A in binary).
    const a = machine([0xf8, 0x18, 0xa9, 0x12, 0x69, 0x34]);
    steps(a.cpu, 4);
    expect(a.cpu.a).toBe(0x46);
    expect(a.cpu.p & C).toBe(0);
    const b = machine([0xf8, 0x18, 0xa9, 0x99, 0x69, 0x01]);
    steps(b.cpu, 4);
    expect(b.cpu.a).toBe(0x00);
    expect(b.cpu.p & (Z | C)).toBe(C);
  });

  it('decimal SBC: $46 - $12 = $34; $12 - $21 = $91 with a borrow; flags from the binary difference', () => {
    // SED; SEC; LDA #$46; SBC #$12
    const { cpu } = machine([0xf8, 0x38, 0xa9, 0x46, 0xe9, 0x12]);
    steps(cpu, 4);
    expect(cpu.a).toBe(0x34);
    expect(cpu.p & C).toBe(C);
    const b = machine([0xf8, 0x38, 0xa9, 0x12, 0xe9, 0x21]);
    steps(b.cpu, 4);
    expect(b.cpu.a).toBe(0x91);
    expect(b.cpu.p & (N | C)).toBe(N);
    // $EB is SBC #imm too.
    const c = machine([0xf8, 0x38, 0xa9, 0x46, 0xeb, 0x12]);
    steps(c.cpu, 4);
    expect(c.cpu.a).toBe(0x34);
  });
});

describe('Mos6510: the undocumented opcodes players use', () => {
  it('LAX, SAX', () => {
    // LAX $10; LDX #$0F; SAX $11
    const { cpu, ram } = machine([0xa7, 0x10, 0xa2, 0x0f, 0x87, 0x11]);
    ram.mem[0x10] = 0x3c;
    steps(cpu, 1);
    expect([cpu.a, cpu.x]).toEqual([0x3c, 0x3c]);
    steps(cpu, 2);
    expect(ram.mem[0x11]).toBe(0x0c);
  });

  it('DCP, ISC, SLO, RLA, SRE, RRA: the memory result, then the ALU operation on it', () => {
    const run = (op: number, mem: number, a: number, p = 0x24): { mem: number; a: number; p: number } => {
      // LDA #a; op $10
      const { cpu, ram } = machine([0xa9, a, op, 0x10]);
      cpu.p = p;
      ram.mem[0x10] = mem;
      steps(cpu, 2);
      return { mem: ram.mem[0x10]!, a: cpu.a, p: cpu.p };
    };
    // DCP: dec, then CMP: $41 - 1 = $40, A = $40: equal.
    expect(run(0xc7, 0x41, 0x40)).toMatchObject({ mem: 0x40, a: 0x40 });
    expect(run(0xc7, 0x41, 0x40).p & (Z | C)).toBe(Z | C);
    // ISC: inc, then SBC (carry set: no borrow): $10 - $05 = $0B.
    expect(run(0xe7, 0x04, 0x10, 0x25)).toMatchObject({ mem: 0x05, a: 0x0b });
    // SLO: ASL, then ORA: $81 -> $02 (carry 1), $02 | $10.
    const slo = run(0x07, 0x81, 0x10);
    expect(slo).toMatchObject({ mem: 0x02, a: 0x12 });
    expect(slo.p & C).toBe(C);
    // RLA: ROL (carry in 1), then AND.
    expect(run(0x27, 0x40, 0xff, 0x25)).toMatchObject({ mem: 0x81, a: 0x81 });
    // SRE: LSR, then EOR.
    expect(run(0x47, 0x03, 0xff)).toMatchObject({ mem: 0x01, a: 0xfe });
    // RRA: ROR (carry in 1), then ADC with the carry ROR shifted out (1).
    expect(run(0x67, 0x03, 0x10, 0x25)).toMatchObject({ mem: 0x81, a: 0x92 });
  });

  it('ANC, ALR, ARR, SBX', () => {
    // LDA #$F0; ANC #$81: A = $80, C = N.
    const anc = machine([0xa9, 0xf0, 0x0b, 0x81]);
    steps(anc.cpu, 2);
    expect(anc.cpu.a).toBe(0x80);
    expect(anc.cpu.p & (N | C)).toBe(N | C);
    // LDA #$FF; ALR #$03: ($FF & 3) >> 1 = 1, C = 1.
    const alr = machine([0xa9, 0xff, 0x4b, 0x03]);
    steps(alr.cpu, 2);
    expect(alr.cpu.a).toBe(0x01);
    expect(alr.cpu.p & C).toBe(C);
    // SEC; LDA #$FF; ARR #$C0: ($C0 >> 1) | $80 = $E0; C = bit 6, V = bit 6 ^ bit 5.
    const arr = machine([0x38, 0xa9, 0xff, 0x6b, 0xc0]);
    steps(arr.cpu, 3);
    expect(arr.cpu.a).toBe(0xe0);
    expect(arr.cpu.p & (C | V | N)).toBe(C | N);
    // LDA #$3C; LDX #$0F; SBX #$02: X = ($3C & $0F) - 2 = $0A, C set (no borrow).
    const sbx = machine([0xa9, 0x3c, 0xa2, 0x0f, 0xcb, 0x02]);
    steps(sbx.cpu, 3);
    expect(sbx.cpu.x).toBe(0x0a);
    expect(sbx.cpu.p & C).toBe(C);
  });

  it('the NOPs of every length skip their operands', () => {
    // NOP ($1A), NOP #imm ($80), NOP zp ($04), NOP zp,X ($14), NOP abs ($0C), NOP abs,X ($1C)
    const { cpu } = machine([0x1a, 0x80, 0xff, 0x04, 0xff, 0x14, 0xff, 0x0c, 0xff, 0xff, 0x1c, 0xff, 0xff]);
    const pcs: number[] = [];
    for (let i = 0; i < 6; i++) {
      cpu.step();
      pcs.push(cpu.pc);
    }
    expect(pcs).toEqual([0x201, 0x203, 0x205, 0x207, 0x20a, 0x20d]);
  });

  it('a JAM opcode stops the CPU where it is; time still passes', () => {
    const { cpu } = machine([0xea, 0x02, 0xea]);
    steps(cpu, 2);
    expect(cpu.jammed).toBe(true);
    expect(cpu.pc).toBe(0x201);
    const before = cpu.cycles;
    steps(cpu, 3);
    expect(cpu.pc).toBe(0x201);
    expect(cpu.cycles).toBe(before + 6);
    for (const op of [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2]) expect(mos6510Mnemonic(op)).toBe('jam');
    expect([0xa7, 0xeb, 0xcb, 0x9f].map(mos6510Mnemonic)).toEqual(['lax', 'sbc', 'sbx', 'sha']);
  });
});

describe('Mos6510: bus, cycles, interrupts', () => {
  it('a read-modify-write writes the old value, then the new: `inc $d019` acknowledges the VIC with the first', () => {
    const { cpu, ram } = machine([0xee, 0x19, 0xd0]);
    ram.mem[0xd019] = 0x81;
    steps(cpu, 1);
    expect(ram.writes).toEqual([
      [0xd019, 0x81],
      [0xd019, 0x82],
    ]);
  });

  it('JMP ($xxFF) takes its high byte from the same page', () => {
    const { cpu, ram } = machine([0x6c, 0xff, 0x10]);
    ram.mem[0x10ff] = 0x34;
    ram.mem[0x1000] = 0x12;
    ram.mem[0x1100] = 0x99;
    steps(cpu, 1);
    expect(cpu.pc).toBe(0x1234);
  });

  it('counts the documented cycles, with the page-crossing and branch penalties', () => {
    // LDX #$20; LDA $10F0,X (crosses); LDA $1000,X (0: Z); STA $1000,X; BEQ +0 (taken); CLC; BCC to the next page
    const code = [0xa2, 0x20, 0xbd, 0xf0, 0x10, 0xbd, 0x00, 0x10, 0x9d, 0x00, 0x10, 0xf0, 0x00, 0x18];
    const { cpu } = machine(code, 0x02e0);
    // BCC at $02EE: +$10 lands on $0300, the next page.
    const ram = (cpu as unknown as { bus: FlatRam }).bus;
    ram.mem.set([0x90, 0x10], 0x02ee);
    expect(steps(cpu, 7)).toEqual([2, 5, 4, 5, 3, 2, 4]);
    // A branch not taken: 2.
    const m = machine([0xa9, 0x00, 0xd0, 0x10]);
    expect(steps(m.cpu, 2)).toEqual([2, 2]);
  });

  it('IRQ waits while I is set; taken, it pushes PC and P (B clear) and jumps through $FFFE; RTI returns', () => {
    const { cpu, ram } = machine([0xea, 0xea]);
    ram.mem.set([0x00, 0x30], 0xfffe);
    ram.mem[0x3000] = 0x40;
    cpu.p = 0x24 | C;
    expect(cpu.irq()).toBe(false);
    cpu.p = 0x20 | C;
    cpu.sp = 0xff;
    expect(cpu.irq()).toBe(true);
    expect(cpu.pc).toBe(0x3000);
    expect(cpu.p & I).toBe(I);
    expect([ram.mem[0x1ff], ram.mem[0x1fe], ram.mem[0x1fd]! & (B | C)]).toEqual([0x02, 0x00, C]);
    steps(cpu, 1);
    expect(cpu.pc).toBe(0x200);
    expect(cpu.p & (I | C)).toBe(C);
  });

  it('NMI is taken whatever I says; BRK pushes PC + 2 with B set', () => {
    const { cpu, ram } = machine([0x00, 0xff, 0xea]);
    ram.mem.set([0x00, 0x40], 0xfffa);
    ram.mem.set([0x00, 0x30], 0xfffe);
    cpu.p = 0x24;
    cpu.nmi();
    expect(cpu.pc).toBe(0x4000);
    const b = machine([0x00, 0xff, 0xea]);
    b.ram.mem.set([0x00, 0x30], 0xfffe);
    b.cpu.sp = 0xff;
    steps(b.cpu, 1);
    expect(b.cpu.pc).toBe(0x3000);
    expect([b.ram.mem[0x1ff], b.ram.mem[0x1fe], b.ram.mem[0x1fd]! & B]).toEqual([0x02, 0x02, B]);
  });

  it('decimal mode survives an interrupt (P is pushed and pulled whole)', () => {
    // SED; PHP; CLD; PLP
    const { cpu } = machine([0xf8, 0x08, 0xd8, 0x28]);
    steps(cpu, 4);
    expect(cpu.p & D).toBe(D);
  });
});

/** GoatTracker-made `.sid` files: the app's own export fixtures and ChiptuneSAK's NTSC one. */
const GT_SIDS: readonly string[] = [
  resolve(__dirname, 'fixtures/gt-sids/alien_funk.sid'),
  resolve(__dirname, 'fixtures/gt-sids/alien_funk.opt.sid'),
  resolve(__dirname, 'fixtures/gt-sids/mw_title_remix_2x_speed.sid'),
  resolve(__dirname, 'fixtures/gt-sids/sniff.8580.sid'),
  resolve(__dirname, 'fixtures/psid/chiptunesak/vibratotest.sid'),
];
const FRAMES = 1500;
const TRAP = 0xfff0;

/** `runPsid`'s protocol on `Mos6510` over flat RAM: init with the subsong in A, then play per frame. */
function runOnMos6510(bytes: Uint8Array, subsong: number, frames: number): Uint8Array[] {
  const h = readPsidHeader(bytes);
  const ram = new FlatRam();
  ram.mem.set(bytes.slice(h.dataOffset + (bytes[8]! | bytes[9]! ? 0 : 2)), h.load);
  const cpu = new Mos6510(ram);
  const call = (addr: number, a: number): void => {
    cpu.a = a;
    cpu.sp = 0xfd;
    ram.mem[0x1fe] = (TRAP - 1) & 0xff;
    ram.mem[0x1ff] = (TRAP - 1) >> 8;
    cpu.pc = addr;
    for (let i = 0; i < 1_000_000 && cpu.pc !== TRAP; i++) cpu.step();
    if (cpu.pc !== TRAP) throw new Error(`call to ${addr.toString(16)} did not return`);
  };
  call(h.init, subsong);
  const regs: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    call(h.play, 0);
    regs.push(ram.mem.slice(0xd400, 0xd419));
  }
  return regs;
}

describe("Mos6510 against the tests' 6502, on GoatTracker's player", () => {
  it.each(GT_SIDS.map((p) => [p.replace(/^.*\/fixtures\//, ''), p] as const))(
    '%s: the same SID registers after every play call, and the same on the C64 (captureSid)',
    (_name, path) => {
      const bytes = new Uint8Array(readFileSync(path));
      const reference = runPsid(bytes, 0, FRAMES).regs;
      expect(runOnMos6510(bytes, 0, FRAMES)).toEqual(reference);
      const parsed = parsePsid(bytes);
      if (!parsed.ok) throw new Error(parsed.reason);
      const capture = captureSid(parsed.file, { subsong: 0, maxTicks: FRAMES });
      if (!capture.ok) throw new Error(capture.reason);
      const t = capture.trace;
      expect(t.mode).toBe('play');
      // A 2x song ticks twice per frame (its CIA timer); the rest once.
      const perFrame = Math.round(t.frameCycles / t.tickCycles);
      expect(perFrame).toBe(path.includes('2x_speed') ? 2 : 1);
      for (let i = 0; i < t.ticks; i++) expect(t.regs.subarray(i * 25, i * 25 + 25), `tick ${i}`).toEqual(reference[i]);
    },
  );
});
