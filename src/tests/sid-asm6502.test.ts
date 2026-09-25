import { describe, expect, it } from 'vitest';
import { assemble6502, type AsmResult } from 'src/audio/tracker/sid-export';

/**
 * plan-sid-authoring.md phase 4: our assembler for GoatTracker's playroutine
 * dialect, against hand-assembled bytes (opcodes from the MOS 6502 data sheet).
 */

const asm = (source: string): AsmResult => {
  const r = assemble6502(source);
  if (!r.ok) throw new Error(`line ${r.line}: ${r.reason}`);
  return r;
};
const bytes = (source: string): number[] => Array.from(asm(`                .ORG ($1000)\n${source}`).bytes);
const error = (source: string): { line: number; reason: string } => {
  const r = assemble6502(source);
  if (r.ok) throw new Error('assembled');
  return { line: r.line, reason: r.reason };
};

describe('asm6502: addressing by syntax', () => {
  it('assembles every addressing mode as the data sheet encodes it', () => {
    expect(
      bytes(`
                lda #$12
                lda <$34
                lda <$34,x
                lda $1234
                lda $1234,x
                lda $1234,y
                lda ($34,x)
                lda ($34),y
                ldx <$34,y
                stx <$34,y
                jmp ($1234)
                jsr $1234
                lsr
                asl $1234,x
                inc <$34,x
                dec $1234
                cpx #$ff
                bit $d012
                rts`),
    ).toEqual([
      0xa9, 0x12, 0xa5, 0x34, 0xb5, 0x34, 0xad, 0x34, 0x12, 0xbd, 0x34, 0x12, 0xb9, 0x34, 0x12, 0xa1, 0x34, 0xb1,
      0x34, 0xb6, 0x34, 0x96, 0x34, 0x6c, 0x34, 0x12, 0x20, 0x34, 0x12, 0x4a, 0x1e, 0x34, 0x12, 0xf6, 0x34, 0xce,
      0x34, 0x12, 0xe0, 0xff, 0x2c, 0x12, 0xd0, 0x60,
    ]);
  });

  it('takes a bare address as absolute even when it is below 256, and <expr as zero page', () => {
    expect(bytes('                lda $34\n                sta <$34')).toEqual([0xad, 0x34, 0x00, 0x85, 0x34]);
  });

  it("assembles `ldy expr,y` as LDY abs,X ($BC), the dialect's spelling that player.s relies on", () => {
    expect(bytes('                ldy $1234,y\n                ldy $1234,x')).toEqual([0xbc, 0x34, 0x12, 0xbc, 0x34, 0x12]);
  });

  it('reads a parenthesised absolute operand as absolute, not indirect', () => {
    expect(bytes('                lda ($1200+$34)\n                lda ($1200+$34),x')).toEqual([0xad, 0x34, 0x12, 0xbd, 0x34, 0x12]);
  });

  it('branches backwards and forwards, and refuses a branch out of reach', () => {
    expect(
      bytes(`
loop:           dex
                bne loop
                beq skip
                nop
skip:           rts`),
    ).toEqual([0xca, 0xd0, 0xfd, 0xf0, 0x01, 0xea, 0x60]);
    const far = ['                .ORG ($1000)', 'start:', ...Array.from({ length: 130 }, () => '                nop'), '                bne start'];
    expect(error(far.join('\n'))).toEqual({ line: 133, reason: 'branch target is -132 bytes away (-128..127)' });
  });

  it('knows all 151 documented opcodes', () => {
    const codes = new Set<number>();
    const modes = ['#$01', '<$01', '<$01,x', '<$01,y', '$0101', '$0101,x', '$0101,y', '($01,x)', '($01),y', '($0101)', ''];
    const mnemonics =
      'adc and asl bcc bcs beq bit bmi bne bpl brk bvc bvs clc cld cli clv cmp cpx cpy dec dex dey eor inc inx iny jmp jsr lda ldx ldy lsr nop ora pha php pla plp rol ror rti rts sbc sec sed sei sta stx sty tax tay tsx txa txs tya';
    for (const m of mnemonics.split(' ')) {
      for (const mode of modes) {
        if (m === 'ldy' && mode === '$0101,y') continue; // the dialect's alias of ldy $0101,x
        const r = assemble6502(`                .ORG ($1000)\nt:\n                ${m} ${['bcc', 'bcs', 'beq', 'bmi', 'bne', 'bpl', 'bvc', 'bvs'].includes(m) ? (mode === '' ? 't' : '') : mode}`);
        if (r.ok && r.bytes.length > 0) codes.add(r.bytes[0]!);
      }
    }
    expect(codes.size).toBe(151);
  });
});

describe('asm6502: expressions, symbols and directives', () => {
  it('evaluates with C precedence, integer division and 0/1 comparisons', () => {
    expect(bytes('                .BYTE (1+2*3, (1+2)*3, 7/2, 7%2, -1, 5>3, 5<3, 5==5, 5!=5, 1&&0, 1||0, !0, !7)')).toEqual([
      7, 9, 3, 1, 0xff, 1, 0, 1, 0, 0, 1, 1, 0,
    ]);
  });

  it('takes the low and high byte of an address with % 256 and / 256, forward references included', () => {
    const r = asm(`                .ORG ($12fe)
                .BYTE (later % 256, later / 256)
later:          rts`);
    expect(Array.from(r.bytes)).toEqual([0x00, 0x13, 0x60]);
    expect(r.symbols.get('later')).toBe(0x1300);
  });

  it('evaluates `=` symbols when used, so they may name a later label', () => {
    const r = asm(`ptr             = target+1
                .ORG ($2000)
                lda ptr
target:         rts`);
    expect(Array.from(r.bytes)).toEqual([0xad, 0x04, 0x20, 0x60]);
    expect(r.symbols.get('ptr')).toBe(0x2004);
  });

  it('assembles only the branch an .IF chooses, nested and on one line, and never looks inside the other', () => {
    expect(
      bytes(`
A               = 1
              .IF (A == 1)
              .IF (A > 1)
                .BYTE (undefined_here)
              .ELSE
                .BYTE (2)
              .ENDIF
              .ELSE
                .BYTE (also_undefined)
              .ENDIF
              .IF (A != 0) .BYTE (3) .ENDIF
              .IF (A == 0) .BYTE (4) .ENDIF`),
    ).toEqual([2, 3]);
  });

  it('answers .DEFINED for what the assembled code has defined above it', () => {
    expect(
      bytes(`
              .IF (0)
hidden:         nop
              .ENDIF
shown:          nop
              .IF (.DEFINED(shown) && !.DEFINED(hidden))
                .BYTE (1)
              .ENDIF`),
    ).toEqual([0xea, 1]);
  });

  it('places the code at the first .ORG and reports its symbols', () => {
    const r = asm(`base            = $1000
                .ORG (base)
                jmp init
init:           rts`);
    expect(r.origin).toBe(0x1000);
    expect(Array.from(r.bytes)).toEqual([0x4c, 0x03, 0x10, 0x60]);
    expect(r.symbols.get('init')).toBe(0x1003);
  });
});

describe('asm6502: errors name the line', () => {
  it.each([
    ['                .ORG ($1000)\n                lda nowhere', 2, 'symbol "nowhere" is not defined'],
    ['                .ORG ($1000)\nx:\nx:', 3, 'symbol "x" is defined twice'],
    ['                .ORG ($1000)\n              .IF (1)', 2, '.IF without .ENDIF'],
    ['                .ORG ($1000)\n              .ENDIF', 2, '.ENDIF without .IF'],
    ['                .ORG ($1000)\n                sta #$12', 2, 'sta has no imm addressing mode'],
    ['                .ORG ($1000)\n                lda <$1234', 2, 'zero-page address 4660 is outside 0..255'],
    ['                .ORG ($1000)\n                lda #$123', 2, 'immediate value 291 does not fit a byte'],
    ['                lda #$12', 1, 'code before the first .ORG'],
    ['                .ORG ($1000)\n                ? 1', 2, 'unexpected character "?"'],
  ])('%j', (source, line, reason) => {
    expect(error(source)).toEqual({ line, reason });
  });
});
