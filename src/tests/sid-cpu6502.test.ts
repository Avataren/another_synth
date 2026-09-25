import { describe, expect, it } from 'vitest';
import { assemble6502 } from 'src/audio/tracker/sid-export';
import { Cpu6502 } from './helpers/cpu6502';

/**
 * The test 6502 behind the `.sid` gates (plan-sid-authoring.md phase 4),
 * checked on the flag and addressing rules of the MOS data sheet, with
 * programs from our assembler.
 */

const run = (source: string, a = 0): Cpu6502 => {
  const r = assemble6502(`                .ORG ($1000)\n${source}\n                rts`);
  if (!r.ok) throw new Error(`line ${r.line}: ${r.reason}`);
  const cpu = new Cpu6502();
  cpu.mem.set(r.bytes, r.origin);
  cpu.call(r.origin, a);
  return cpu;
};
/** N, V, D, Z, C as set (I is set from reset on and never changes here). */
const flags = (cpu: Cpu6502): string =>
  ['N', 'V', '', '', 'D', '', 'Z', 'C'].map((f, i) => (f && cpu.p & (0x80 >> i) ? f : '')).join('');

describe('Cpu6502', () => {
  it('adds with carry and overflow as the data sheet does', () => {
    expect(flags(run('clc\n lda #$50\n adc #$50'))).toBe('NV');
    expect(run('clc\n lda #$50\n adc #$50').a).toBe(0xa0);
    const c = run('sec\n lda #$ff\n adc #$01');
    expect([c.a, flags(c)]).toEqual([0x01, 'C']);
    const z = run('clc\n lda #$80\n adc #$80');
    expect([z.a, flags(z)]).toEqual([0x00, 'VZC']);
  });

  it('subtracts with borrow (carry clear = borrow)', () => {
    const a = run('sec\n lda #$05\n sbc #$06');
    expect([a.a, flags(a)]).toEqual([0xff, 'N']);
    const b = run('clc\n lda #$05\n sbc #$04');
    expect([b.a, flags(b)]).toEqual([0x00, 'ZC']);
  });

  it('compares, shifts and rotates through carry', () => {
    expect(flags(run('lda #$10\n cmp #$10'))).toBe('ZC');
    expect(flags(run('ldx #$0f\n cpx #$10'))).toBe('N');
    const r = run('sec\n lda #$81\n ror');
    expect([r.a, flags(r)]).toEqual([0xc0, 'NC']);
    const l = run('clc\n lda #$81\n rol');
    expect([l.a, flags(l)]).toEqual([0x02, 'C']);
    const s = run('lda #$81\n lsr');
    expect([s.a, flags(s)]).toEqual([0x40, 'C']);
  });

  it('sets N and V from memory on BIT', () => {
    const cpu = run('lda #$c0\n sta $2000\n lda #$00\n bit $2000');
    expect(flags(cpu)).toBe('NVZ');
  });

  it('indexes zero page within page 0 and reads (zp),y pointers', () => {
    const cpu = run(`
                lda #$34
                sta <$ff
                lda #$12
                sta <$00
                lda #$77
                sta $1236
                ldy #$02
                lda ($ff),y
                ldx #$01
                sta <$ff,x`);
    expect(cpu.a).toBe(0x77);
    expect(cpu.mem[0x00]).toBe(0x77);
  });

  it("keeps JMP ($xxFF)'s page-wrap bug", () => {
    const cpu = new Cpu6502();
    cpu.mem.set([0x6c, 0xff, 0x20], 0x1000); // jmp ($20ff)
    cpu.mem[0x20ff] = 0x00;
    cpu.mem[0x2000] = 0x30; // the high byte comes from $2000, not $2100
    cpu.mem[0x2100] = 0x40;
    cpu.pc = 0x1000;
    cpu.step();
    expect(cpu.pc).toBe(0x3000);
  });

  it('calls subroutines through the stack and passes A to a routine', () => {
    const cpu = run(`
                jsr double
                jmp done
double:         asl
                rts
done:           tax`, 0x21);
    expect([cpu.a, cpu.x, cpu.sp]).toEqual([0x42, 0x42, 0xff]);
  });

  it('refuses decimal mode and stops a routine that never returns', () => {
    expect(() => run('sed\n adc #$01')).toThrow(/decimal-mode ADC/);
    const r = assemble6502('                .ORG ($1000)\nloop:           jmp loop');
    if (!r.ok) throw new Error(r.reason);
    const cpu = new Cpu6502();
    cpu.mem.set(r.bytes, 0x1000);
    expect(() => cpu.call(0x1000, 0, 1000)).toThrow(/did not return in 1000 instructions/);
  });
});
