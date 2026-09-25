/**
 * A small 6502 assembler for the dialect GoatTracker's playroutine
 * (`gt2/player.s`) is written in: the assembler Magnus Lind wrote for
 * Exomizer, which GoatTracker's relocator bundles (plan-sid-authoring.md D2).
 * Our own code, written from the dialect's rules as `player.s` uses them;
 * none of that assembler's source is copied.
 *
 * The dialect, as far as this implements it:
 *  - one statement or more per line, `;` starts a comment;
 *  - `label:` defines a label at the current address, `name = expr` a symbol
 *    (evaluated when used, so it may name a later label);
 *  - `.ORG (expr)`, `.BYTE (expr, ...)`, `.IF (expr)` / `.ELSE` / `.ENDIF`
 *    (nested, and on one line: `.IF (x) .BYTE (0) .ENDIF`);
 *  - expressions: numbers (`$hex`, decimal), symbols, `.DEFINED(sym)`,
 *    `( )`, unary `-` `!`, `* / %`, `+ -`, `< > == !=`, `&&`, `||`
 *    (C precedence, all integer, comparisons give 0/1);
 *  - addressing is chosen by SYNTAX, not by value: `<expr` is zero page
 *    (`lda <temp,x`), a bare `expr` is always absolute, `#expr` immediate,
 *    `(expr),y` / `(expr,x)` indirect, `(expr)` indirect for `jmp` (absolute
 *    for any other instruction, and `(expr),x` is absolute,X), no
 *    operand is implied or accumulator. So every instruction's size is known
 *    before any label is, and two passes place everything;
 *  - one quirk kept on purpose: `ldy expr,y` assembles as LDY abs,X ($BC),
 *    as that assembler does (see `OPCODES.ldy`).
 *
 * `.IF` must be decidable where it stands: its expression may use only
 * symbols defined above it (that is how `player.s` uses it), and
 * `.DEFINED(sym)` asks whether `sym` has been defined above it, in the code
 * that is assembled.
 */

export interface AsmResult {
  readonly ok: true;
  /** The address of the first byte (the first `.ORG`). */
  readonly origin: number;
  readonly bytes: Uint8Array;
  /** Every label and `=` symbol of the assembled code, by name. */
  readonly symbols: ReadonlyMap<string, number>;
}

export interface AsmError {
  readonly ok: false;
  /** 1-based line of the source, 0 when no line is to blame. */
  readonly line: number;
  readonly reason: string;
}

type Mode =
  | 'imp'
  | 'acc'
  | 'imm'
  | 'zp'
  | 'zpx'
  | 'zpy'
  | 'abs'
  | 'absx'
  | 'absy'
  | 'ind'
  | 'indx'
  | 'indy'
  | 'rel';

/** Every documented 6502 opcode: mnemonic -> addressing mode -> opcode byte. */
const OPCODES: Readonly<Record<string, Partial<Record<Mode, number>>>> = {
  adc: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, absx: 0x7d, absy: 0x79, indx: 0x61, indy: 0x71 },
  and: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, absx: 0x3d, absy: 0x39, indx: 0x21, indy: 0x31 },
  asl: { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, absx: 0x1e },
  bcc: { rel: 0x90 },
  bcs: { rel: 0xb0 },
  beq: { rel: 0xf0 },
  bit: { zp: 0x24, abs: 0x2c },
  bmi: { rel: 0x30 },
  bne: { rel: 0xd0 },
  bpl: { rel: 0x10 },
  brk: { imp: 0x00 },
  bvc: { rel: 0x50 },
  bvs: { rel: 0x70 },
  clc: { imp: 0x18 },
  cld: { imp: 0xd8 },
  cli: { imp: 0x58 },
  clv: { imp: 0xb8 },
  cmp: { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, absx: 0xdd, absy: 0xd9, indx: 0xc1, indy: 0xd1 },
  cpx: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  cpy: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  dec: { zp: 0xc6, zpx: 0xd6, abs: 0xce, absx: 0xde },
  dex: { imp: 0xca },
  dey: { imp: 0x88 },
  eor: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, absx: 0x5d, absy: 0x59, indx: 0x41, indy: 0x51 },
  inc: { zp: 0xe6, zpx: 0xf6, abs: 0xee, absx: 0xfe },
  inx: { imp: 0xe8 },
  iny: { imp: 0xc8 },
  jmp: { abs: 0x4c, ind: 0x6c },
  jsr: { abs: 0x20 },
  lda: { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, absx: 0xbd, absy: 0xb9, indx: 0xa1, indy: 0xb1 },
  ldx: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, absy: 0xbe },
  // `ldy expr,y` is the dialect's spelling of LDY abs,X ($BC; the 6502 has no
  // LDY abs,Y): its grammar maps that form to $BC, and `player.s` relies on
  // it (`ldy mt_chnnote,y` indexes by channel, X). `ldy expr,x` is $BC too.
  ldy: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, absx: 0xbc, absy: 0xbc },
  lsr: { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, absx: 0x5e },
  nop: { imp: 0xea },
  ora: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, absx: 0x1d, absy: 0x19, indx: 0x01, indy: 0x11 },
  pha: { imp: 0x48 },
  php: { imp: 0x08 },
  pla: { imp: 0x68 },
  plp: { imp: 0x28 },
  rol: { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, absx: 0x3e },
  ror: { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, absx: 0x7e },
  rti: { imp: 0x40 },
  rts: { imp: 0x60 },
  sbc: { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, absx: 0xfd, absy: 0xf9, indx: 0xe1, indy: 0xf1 },
  sec: { imp: 0x38 },
  sed: { imp: 0xf8 },
  sei: { imp: 0x78 },
  sta: { zp: 0x85, zpx: 0x95, abs: 0x8d, absx: 0x9d, absy: 0x99, indx: 0x81, indy: 0x91 },
  stx: { zp: 0x86, zpy: 0x96, abs: 0x8e },
  sty: { zp: 0x84, zpx: 0x94, abs: 0x8c },
  tax: { imp: 0xaa },
  tay: { imp: 0xa8 },
  tsx: { imp: 0xba },
  txa: { imp: 0x8a },
  txs: { imp: 0x9a },
  tya: { imp: 0x98 },
};

/** Bytes an instruction takes, by mode. */
const MODE_SIZE: Readonly<Record<Mode, number>> = {
  imp: 1,
  acc: 1,
  imm: 2,
  zp: 2,
  zpx: 2,
  zpy: 2,
  abs: 3,
  absx: 3,
  absy: 3,
  ind: 3,
  indx: 2,
  indy: 2,
  rel: 2,
};

// ---------------------------------------------------------------- tokens

type Token =
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'sym'; readonly v: string }
  | { readonly t: 'dir'; readonly v: string }
  | { readonly t: 'op'; readonly v: string };

class AsmFail extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

const OPERATORS = ['&&', '||', '==', '!=', '(', ')', ',', ':', '#', '+', '-', '*', '/', '%', '<', '>', '!', '='];

function tokenize(text: string, line: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === ';') break;
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '$') {
      const m = /^\$([0-9a-fA-F]+)/.exec(text.slice(i));
      if (!m) throw new AsmFail(line, '"$" without a hex number');
      out.push({ t: 'num', v: parseInt(m[1]!, 16) });
      i += m[0].length;
      continue;
    }
    if (c >= '0' && c <= '9') {
      const m = /^[0-9]+/.exec(text.slice(i))!;
      out.push({ t: 'num', v: parseInt(m[0], 10) });
      i += m[0].length;
      continue;
    }
    if (c === '.') {
      const m = /^\.([A-Za-z]+)/.exec(text.slice(i));
      if (!m) throw new AsmFail(line, '"." without a directive name');
      out.push({ t: 'dir', v: m[1]!.toUpperCase() });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(i))!;
      out.push({ t: 'sym', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op === undefined) throw new AsmFail(line, `unexpected character "${c}"`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

// ---------------------------------------------------------------- expressions

type Expr =
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'sym'; readonly name: string }
  | { readonly k: 'defined'; readonly name: string }
  | { readonly k: 'un'; readonly op: string; readonly a: Expr }
  | { readonly k: 'bin'; readonly op: string; readonly a: Expr; readonly b: Expr };

/** Binary operators by precedence level, loosest first. */
const LEVELS: readonly (readonly string[])[] = [['||'], ['&&'], ['==', '!='], ['<', '>'], ['+', '-'], ['*', '/', '%']];

class Parser {
  pos = 0;
  constructor(
    readonly toks: readonly Token[],
    readonly line: number,
  ) {}

  peek(): Token | undefined {
    return this.toks[this.pos];
  }

  isOp(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === 'op' && t.v === v;
  }

  expectOp(v: string): void {
    if (!this.isOp(v)) throw new AsmFail(this.line, `expected "${v}"`);
    this.pos++;
  }

  expr(level = 0): Expr {
    if (level === LEVELS.length) return this.unary();
    let a = this.expr(level + 1);
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.t !== 'op' || !LEVELS[level]!.includes(t.v)) return a;
      this.pos++;
      a = { k: 'bin', op: t.v, a, b: this.expr(level + 1) };
    }
  }

  unary(): Expr {
    if (this.isOp('-') || this.isOp('!')) {
      const op = (this.toks[this.pos++] as { v: string }).v;
      return { k: 'un', op, a: this.unary() };
    }
    const t = this.peek();
    if (t === undefined) throw new AsmFail(this.line, 'expression expected');
    if (t.t === 'num') {
      this.pos++;
      return { k: 'num', v: t.v };
    }
    if (t.t === 'sym') {
      this.pos++;
      return { k: 'sym', name: t.v };
    }
    if (t.t === 'dir' && t.v === 'DEFINED') {
      this.pos++;
      this.expectOp('(');
      const s = this.peek();
      if (s === undefined || s.t !== 'sym') throw new AsmFail(this.line, '.DEFINED needs a symbol');
      this.pos++;
      this.expectOp(')');
      return { k: 'defined', name: s.v };
    }
    if (this.isOp('(')) {
      this.pos++;
      const e = this.expr();
      this.expectOp(')');
      return e;
    }
    throw new AsmFail(this.line, 'expression expected');
  }
}

type Lookup = (name: string) => number | undefined;

function evaluate(e: Expr, lookup: Lookup, defined: (name: string) => boolean, line: number): number {
  const ev = (x: Expr): number => evaluate(x, lookup, defined, line);
  switch (e.k) {
    case 'num':
      return e.v;
    case 'sym': {
      const v = lookup(e.name);
      if (v === undefined) throw new AsmFail(line, `symbol "${e.name}" is not defined`);
      return v;
    }
    case 'defined':
      return defined(e.name) ? 1 : 0;
    case 'un':
      return e.op === '-' ? -ev(e.a) : ev(e.a) === 0 ? 1 : 0;
    case 'bin': {
      const a = ev(e.a);
      if (e.op === '&&') return a !== 0 && ev(e.b) !== 0 ? 1 : 0;
      if (e.op === '||') return a !== 0 || ev(e.b) !== 0 ? 1 : 0;
      const b = ev(e.b);
      switch (e.op) {
        case '==':
          return a === b ? 1 : 0;
        case '!=':
          return a !== b ? 1 : 0;
        case '<':
          return a < b ? 1 : 0;
        case '>':
          return a > b ? 1 : 0;
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
        case '%':
          if (b === 0) throw new AsmFail(line, 'division by zero');
          return e.op === '/' ? Math.trunc(a / b) : a % b;
      }
      throw new AsmFail(line, `unknown operator "${e.op}"`);
    }
  }
}

// ---------------------------------------------------------------- statements

/** What pass 1 laid out, for pass 2 to encode. */
type Item =
  | { readonly k: 'op'; readonly line: number; readonly pc: number; readonly code: number; readonly mode: Mode; readonly arg?: Expr }
  | { readonly k: 'bytes'; readonly line: number; readonly pc: number; readonly args: readonly Expr[] };

/** Parse an instruction's operand (the tokens after the mnemonic) into a mode and an expression. */
function operand(p: Parser, mnemonic: string): { mode: Mode; arg?: Expr } {
  const modes = OPCODES[mnemonic]!;
  const end = p.peek() === undefined || p.peek()!.t === 'dir';
  if (end) {
    if (modes.imp !== undefined) return { mode: 'imp' };
    if (modes.acc !== undefined) return { mode: 'acc' };
    throw new AsmFail(p.line, `${mnemonic} needs an operand`);
  }
  if (modes.rel !== undefined) return { mode: 'rel', arg: p.expr() };
  if (p.isOp('#')) {
    p.pos++;
    return { mode: 'imm', arg: p.expr() };
  }
  const indexed = (base: 'zp' | 'abs', arg: Expr): { mode: Mode; arg: Expr } => {
    if (!p.isOp(',')) return { mode: base, arg };
    p.pos++;
    const r = p.peek();
    if (r?.t === 'sym' && /^[xX]$/.test(r.v)) {
      p.pos++;
      return { mode: base === 'zp' ? 'zpx' : 'absx', arg };
    }
    if (r?.t === 'sym' && /^[yY]$/.test(r.v)) {
      p.pos++;
      return { mode: base === 'zp' ? 'zpy' : 'absy', arg };
    }
    throw new AsmFail(p.line, 'index register x or y expected');
  };
  if (p.isOp('<')) {
    p.pos++;
    return indexed('zp', p.expr());
  }
  if (p.isOp('(')) {
    // `(e),y`, `(e,x)` or `jmp (e)`; anything else is a parenthesised absolute.
    const save = p.pos;
    p.pos++;
    const arg = p.expr();
    if (p.isOp(',')) {
      p.pos++;
      const r = p.peek();
      if (r?.t !== 'sym' || !/^[xX]$/.test(r.v)) throw new AsmFail(p.line, '"(expr,x)" expected');
      p.pos++;
      p.expectOp(')');
      return { mode: 'indx', arg };
    }
    p.expectOp(')');
    if (p.isOp(',')) {
      p.pos++;
      const r = p.peek();
      if (r?.t === 'sym' && /^[yY]$/.test(r.v)) {
        p.pos++;
        return { mode: 'indy', arg };
      }
      if (r?.t === 'sym' && /^[xX]$/.test(r.v)) {
        // `(expr),x` is a parenthesised absolute, indexed.
        p.pos++;
        return { mode: 'absx', arg };
      }
      throw new AsmFail(p.line, 'index register x or y expected');
    }
    if (p.peek() === undefined || p.peek()!.t === 'dir') {
      if (mnemonic === 'jmp') return { mode: 'ind', arg };
    }
    p.pos = save;
  }
  return indexed('abs', p.expr());
}

/**
 * Assemble `source`. Never throws: an error names its line and a reason.
 * `source` is `player.s` with the relocator's defines above it and the song
 * data below, as GoatTracker's relocator hands its assembler.
 */
export function assemble6502(source: string): AsmResult | AsmError {
  try {
    return run(source);
  } catch (e) {
    if (e instanceof AsmFail) return { ok: false, line: e.line, reason: e.message };
    throw e;
  }
}

function run(source: string): AsmResult {
  const lines = source.split('\n');
  const labels = new Map<string, number>();
  const assigns = new Map<string, { expr: Expr; line: number }>();
  const items: Item[] = [];
  let pc: number | undefined;
  let origin: number | undefined;
  // Each open .IF: is this branch assembled, was the enclosing code, has an .ELSE come.
  const conds: { active: boolean; parent: boolean; sawElse: boolean }[] = [];
  const active = (): boolean => conds.length === 0 || conds[conds.length - 1]!.active;

  const resolving = new Set<string>();
  const lookup: Lookup = (name) => {
    const l = labels.get(name);
    if (l !== undefined) return l;
    const a = assigns.get(name);
    if (a === undefined) return undefined;
    if (resolving.has(name)) throw new AsmFail(a.line, `symbol "${name}" is defined by itself`);
    resolving.add(name);
    try {
      return evaluate(a.expr, lookup, defined, a.line);
    } finally {
      resolving.delete(name);
    }
  };
  const defined = (name: string): boolean => labels.has(name) || assigns.has(name);
  const define = (name: string, line: number): void => {
    if (defined(name)) throw new AsmFail(line, `symbol "${name}" is defined twice`);
  };
  const needPc = (line: number): number => {
    if (pc === undefined) throw new AsmFail(line, 'code before the first .ORG');
    return pc;
  };

  // Pass 1: conditionals, symbols, layout.
  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const p = new Parser(tokenize(text, line), line);
    while (p.peek() !== undefined) {
      const t = p.peek()!;
      if (t.t === 'dir' && (t.v === 'IF' || t.v === 'ELSE' || t.v === 'ENDIF')) {
        p.pos++;
        if (t.v === 'IF') {
          const e = p.expr();
          const parent = active();
          conds.push({ active: parent && evaluate(e, lookup, defined, line) !== 0, parent, sawElse: false });
        } else if (t.v === 'ELSE') {
          const c = conds[conds.length - 1];
          if (c === undefined || c.sawElse) throw new AsmFail(line, '.ELSE without .IF');
          c.sawElse = true;
          c.active = c.parent && !c.active;
        } else {
          if (conds.pop() === undefined) throw new AsmFail(line, '.ENDIF without .IF');
        }
        continue;
      }
      if (!active()) {
        // Skip to the next directive on the line (it may close this branch).
        p.pos++;
        while (p.peek() !== undefined && p.peek()!.t !== 'dir') p.pos++;
        continue;
      }
      if (t.t === 'sym' && p.toks[p.pos + 1]?.t === 'op' && (p.toks[p.pos + 1] as { v: string }).v === ':') {
        define(t.v, line);
        labels.set(t.v, needPc(line));
        p.pos += 2;
        continue;
      }
      if (t.t === 'sym' && p.toks[p.pos + 1]?.t === 'op' && (p.toks[p.pos + 1] as { v: string }).v === '=') {
        define(t.v, line);
        p.pos += 2;
        assigns.set(t.v, { expr: p.expr(), line });
        continue;
      }
      if (t.t === 'dir' && t.v === 'ORG') {
        p.pos++;
        const at = evaluate(p.expr(), lookup, defined, line);
        if (at < 0 || at > 0xffff) throw new AsmFail(line, `.ORG ${at} is outside 0..65535`);
        if (origin === undefined) origin = at;
        else if (at !== pc) throw new AsmFail(line, '.ORG may only continue at the current address');
        pc = at;
        continue;
      }
      if (t.t === 'dir' && t.v === 'BYTE') {
        p.pos++;
        p.expectOp('(');
        const args = [p.expr()];
        while (p.isOp(',')) {
          p.pos++;
          args.push(p.expr());
        }
        p.expectOp(')');
        items.push({ k: 'bytes', line, pc: needPc(line), args });
        pc = needPc(line) + args.length;
        continue;
      }
      if (t.t === 'sym' && OPCODES[t.v.toLowerCase()] !== undefined) {
        const mnemonic = t.v.toLowerCase();
        p.pos++;
        const { mode, arg } = operand(p, mnemonic);
        const code = OPCODES[mnemonic]![mode];
        if (code === undefined) throw new AsmFail(line, `${mnemonic} has no ${mode} addressing mode`);
        items.push({ k: 'op', line, pc: needPc(line), code, mode, ...(arg ? { arg } : {}) });
        pc = needPc(line) + MODE_SIZE[mode];
        continue;
      }
      throw new AsmFail(line, `can't read "${t.t === 'op' ? t.v : t.v}" here`);
    }
    if (pc !== undefined && pc > 0x10000) throw new AsmFail(line, 'the code runs past $FFFF');
  }
  if (conds.length > 0) throw new AsmFail(lines.length, '.IF without .ENDIF');
  if (origin === undefined || pc === undefined) throw new AsmFail(0, 'nothing to assemble (no .ORG)');

  // Pass 2: encode.
  const bytes = new Uint8Array(pc - origin);
  const put = (at: number, v: number): void => {
    bytes[at - origin!] = v & 0xff;
  };
  for (const it of items) {
    const ev = (e: Expr): number => evaluate(e, lookup, defined, it.line);
    if (it.k === 'bytes') {
      it.args.forEach((a, i) => {
        const v = ev(a);
        if (v < -128 || v > 255) throw new AsmFail(it.line, `.BYTE value ${v} does not fit a byte`);
        put(it.pc + i, v);
      });
      continue;
    }
    put(it.pc, it.code);
    if (it.arg === undefined) continue;
    const v = ev(it.arg);
    switch (MODE_SIZE[it.mode]) {
      case 2:
        if (it.mode === 'rel') {
          const d = v - (it.pc + 2);
          if (d < -128 || d > 127) throw new AsmFail(it.line, `branch target is ${d} bytes away (-128..127)`);
          put(it.pc + 1, d);
        } else if (it.mode === 'imm') {
          if (v < -128 || v > 255) throw new AsmFail(it.line, `immediate value ${v} does not fit a byte`);
          put(it.pc + 1, v);
        } else {
          if (v < 0 || v > 255) throw new AsmFail(it.line, `zero-page address ${v} is outside 0..255`);
          put(it.pc + 1, v);
        }
        break;
      case 3:
        if (v < 0 || v > 0xffff) throw new AsmFail(it.line, `address ${v} is outside 0..65535`);
        put(it.pc + 1, v);
        put(it.pc + 2, v >> 8);
        break;
    }
  }

  const symbols = new Map<string, number>(labels);
  for (const name of assigns.keys()) {
    try {
      const v = lookup(name);
      if (v !== undefined) symbols.set(name, v);
    } catch {
      // A symbol nothing uses may name one only a skipped branch defines.
    }
  }
  return { ok: true, origin, bytes, symbols };
}
