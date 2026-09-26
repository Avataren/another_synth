import { MODE_SIZE, type AsmStmt, type Expr } from 'src/audio/tracker/sid-export/asm6502';

/**
 * GoatTracker's player source matched against a `.sid`'s code
 * (plan-psid-import.md phase 4): the build the file's player is, recovered
 * from its bytes. GoatTracker's relocator assembles `player.s` under defines
 * it computes from the song (a feature the song does not use is left out:
 * `NOPULSE`, `FIXEDPARAMS`, the instrument-type boundaries, the first note of
 * the frequency table...), then appends the song data, which the code reads
 * at absolute addresses. None of that is stored as such; all of it is in the
 * code.
 *
 * So the source is walked statement by statement against the file's bytes,
 * as an assembler would lay it out, with the defines unknown:
 *
 *  - an instruction's opcode must be the byte at its address; its operand,
 *    evaluated, the bytes after it. An operand with one unknown in it
 *    (`cpy #FIRSTNOHRINSTR`, `lda mt_insad-1,y`, a forward branch) fixes that
 *    unknown; one with more waits until the others are fixed;
 *  - a label is its address (checked against what an earlier operand said);
 *  - an `.IF` on unknown defines takes the branch the bytes agree with,
 *    narrowing what those defines can be (each is a flag 0/1, or a count in
 *    its range), and comes back for the other when the bytes later disagree:
 *    a depth-first search with backtracking, over far fewer choices than
 *    the defines have combinations, because the bytes decide nearly all at
 *    once;
 *  - the author info GoatTracker writes into the assembled player
 *    (`mt_author`'s 32 bytes) is taken as it is.
 *
 * The result is every define the code shows, the player's end (where the
 * song data starts) and the address of every song-data label the code reads.
 */

type Val =
  | { readonly k: 'n'; readonly v: number }
  /** `c * x + o` for the unknown `x`. */
  | { readonly k: 'a'; readonly x: string; readonly c: number; readonly o: number }
  | { readonly k: 'u' };

const num = (v: number): Val => ({ k: 'n', v });
const UNKNOWN: Val = { k: 'u' };

interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/** A condition an unknown must meet: an operand's bytes, or the side an `.IF` was taken. */
type Constraint =
  | { readonly k: 'eq'; readonly expr: Expr; readonly value: number; readonly bits: 8 | 16 | 0 }
  | { readonly k: 'bool'; readonly expr: Expr; readonly truth: boolean };

/** The defines GoatTracker's relocator writes as 0/1. */
const FLAG_DEFINES = new Set([
  'SOUNDSUPPORT',
  'VOLSUPPORT',
  'BUFFEREDWRITES',
  'GHOSTREGS',
  'ZPGHOSTREGS',
  'FIXEDPARAMS',
  'SIMPLEPULSE',
  'PULSEOPTIMIZATION',
  'REALTIMEOPTIMIZATION',
]);

/** What each define can be, as the relocator writes them. Anything else is an address. */
function domainOf(name: string): Interval {
  if (FLAG_DEFINES.has(name) || /^NO[A-Z]+$/.test(name)) return { lo: 0, hi: 1 };
  switch (name) {
    case 'NUMCHANNELS':
      return { lo: 1, hi: 3 };
    case 'NUMSONGS':
      return { lo: 1, hi: 32 };
    case 'FIRSTNOTE':
      return { lo: 0, hi: 95 };
    case 'NUMHRINSTR':
    case 'NUMNOHRINSTR':
    case 'NUMLEGATOINSTR':
      return { lo: 0, hi: 64 };
    case 'FIRSTNOHRINSTR':
    case 'FIRSTLEGATOINSTR':
      return { lo: 1, hi: 65 };
    case 'GATETIMERPARAM':
      return { lo: 0, hi: 63 };
    case 'ADPARAM':
    case 'SRPARAM':
    case 'FIRSTWAVEPARAM':
    case 'DEFAULTTEMPO':
    case 'zpbase':
      return { lo: 0, hi: 255 };
    default:
      return { lo: 0, hi: 0xffff };
  }
}

export interface PlayerMatch {
  /** The address after the player's code: where the song data starts. */
  readonly end: number;
  /** Every value the match fixed: the player's labels, the defines its code shows, the song-data labels it reads. */
  readonly symbols: ReadonlyMap<string, number>;
  /** What the defines not fixed can still be, where an `.IF` narrowed them (`NUMHRINSTR` > 0, say). */
  readonly ranges: ReadonlyMap<string, { readonly lo: number; readonly hi: number }>;
  /** The author info GoatTracker wrote into the player, when the build has it. */
  readonly authorInfo: Uint8Array | null;
}

/** Where the relocator writes the author info, and how long it is. */
const AUTHOR_LABEL = 'mt_author';
const AUTHOR_BYTES = 32;
/** Search effort before giving up (statements processed, backtracking included). */
const MAX_STEPS = 400_000;

interface Frame {
  readonly list: readonly AsmStmt[];
  index: number;
}

interface Choice {
  readonly cursor: Frame[];
  readonly pc: number;
  readonly trail: number;
  /** The branch to take instead, with the narrowing it brings. */
  readonly alternative: () => boolean;
}

/**
 * Match `stmts` (a player source, `parseAsmTree`) against `mem` (the file's
 * bytes by address; undefined outside it), with `known` values (at least
 * `base`). Null when no build of the source is these bytes.
 */
export function matchPlayer(
  stmts: readonly AsmStmt[],
  mem: (addr: number) => number | undefined,
  known: ReadonlyMap<string, number>,
  /** The label the data appended after the player starts with (GoatTracker's relocator: the frequency table). */
  dataLabel?: string,
): PlayerMatch | null {
  const labels = new Map<string, number>();
  const assigns = new Map<string, Expr>();
  const solved = new Map<string, number>();
  const domains = new Map<string, Interval>();
  const pending: Constraint[] = [];
  const trail: (() => void)[] = [];
  let authorInfo: Uint8Array | null = null;

  const undoTo = (n: number): void => {
    while (trail.length > n) trail.pop()!();
  };
  const setIn = <K, V>(map: Map<K, V>, key: K, value: V): void => {
    const had = map.has(key);
    const old = map.get(key);
    map.set(key, value);
    trail.push(() => {
      if (had) map.set(key, old as V);
      else map.delete(key);
    });
  };
  const pushPending = (c: Constraint): void => {
    pending.push(c);
    trail.push(() => void pending.pop());
  };

  // --- values -------------------------------------------------------------

  const resolving = new Set<string>();
  const valueOf = (name: string, overlay?: ReadonlyMap<string, number>): Val => {
    const l = labels.get(name);
    if (l !== undefined) return num(l);
    const a = assigns.get(name);
    if (a !== undefined) {
      if (resolving.has(name)) return UNKNOWN;
      resolving.add(name);
      try {
        return evalExpr(a, overlay);
      } finally {
        resolving.delete(name);
      }
    }
    const s = solved.get(name) ?? known.get(name) ?? overlay?.get(name);
    if (s !== undefined) return num(s);
    return { k: 'a', x: name, c: 1, o: 0 };
  };
  const defined = (name: string): boolean => labels.has(name) || assigns.has(name);

  const affine = (x: string, c: number, o: number): Val => (c === 0 ? num(o) : { k: 'a', x, c, o });
  const evalExpr = (e: Expr, overlay?: ReadonlyMap<string, number>): Val => {
    switch (e.k) {
      case 'num':
        return num(e.v);
      case 'sym':
        return valueOf(e.name, overlay);
      case 'defined':
        return num(defined(e.name) ? 1 : 0);
      case 'un': {
        const a = evalExpr(e.a, overlay);
        if (e.op === '-') return a.k === 'n' ? num(-a.v) : a.k === 'a' ? affine(a.x, -a.c, -a.o) : UNKNOWN;
        return a.k === 'n' ? num(a.v === 0 ? 1 : 0) : UNKNOWN;
      }
      case 'bin': {
        const a = evalExpr(e.a, overlay);
        const b = evalExpr(e.b, overlay);
        if (e.op === '&&') {
          if ((a.k === 'n' && a.v === 0) || (b.k === 'n' && b.v === 0)) return num(0);
          return a.k === 'n' && b.k === 'n' ? num(1) : UNKNOWN;
        }
        if (e.op === '||') {
          if ((a.k === 'n' && a.v !== 0) || (b.k === 'n' && b.v !== 0)) return num(1);
          return a.k === 'n' && b.k === 'n' ? num(0) : UNKNOWN;
        }
        if (a.k === 'n' && b.k === 'n') {
          switch (e.op) {
            case '==':
              return num(a.v === b.v ? 1 : 0);
            case '!=':
              return num(a.v !== b.v ? 1 : 0);
            case '<':
              return num(a.v < b.v ? 1 : 0);
            case '>':
              return num(a.v > b.v ? 1 : 0);
            case '+':
              return num(a.v + b.v);
            case '-':
              return num(a.v - b.v);
            case '*':
              return num(a.v * b.v);
            case '/':
              return b.v === 0 ? UNKNOWN : num(Math.trunc(a.v / b.v));
            case '%':
              return b.v === 0 ? UNKNOWN : num(a.v % b.v);
          }
          return UNKNOWN;
        }
        if (e.op === '+') {
          if (a.k === 'a' && b.k === 'n') return affine(a.x, a.c, a.o + b.v);
          if (a.k === 'n' && b.k === 'a') return affine(b.x, b.c, b.o + a.v);
          if (a.k === 'a' && b.k === 'a' && a.x === b.x) return affine(a.x, a.c + b.c, a.o + b.o);
        } else if (e.op === '-') {
          if (a.k === 'a' && b.k === 'n') return affine(a.x, a.c, a.o - b.v);
          if (a.k === 'n' && b.k === 'a') return affine(b.x, -b.c, a.v - b.o);
          if (a.k === 'a' && b.k === 'a' && a.x === b.x) return affine(a.x, a.c - b.c, a.o - b.o);
        } else if (e.op === '*') {
          if (a.k === 'a' && b.k === 'n') return affine(a.x, a.c * b.v, a.o * b.v);
          if (a.k === 'n' && b.k === 'a') return affine(b.x, b.c * a.v, b.o * a.v);
        }
        return UNKNOWN;
      }
    }
  };

  /** The unknowns `e` depends on now. */
  const unknownsOf = (e: Expr, out = new Set<string>()): Set<string> => {
    switch (e.k) {
      case 'sym': {
        if (labels.has(e.name) || solved.has(e.name) || known.has(e.name)) break;
        const a = assigns.get(e.name);
        if (a !== undefined) {
          if (!resolving.has(e.name)) {
            resolving.add(e.name);
            unknownsOf(a, out);
            resolving.delete(e.name);
          }
        } else out.add(e.name);
        break;
      }
      case 'un':
        unknownsOf(e.a, out);
        break;
      case 'bin':
        unknownsOf(e.a, out);
        unknownsOf(e.b, out);
        break;
      default:
        break;
    }
    return out;
  };

  const domain = (x: string): Interval => domains.get(x) ?? domainOf(x);

  // --- fixing unknowns ----------------------------------------------------

  /** Fix unknown `x` to `v`, then every constraint that now decides: false when that contradicts. */
  const bind = (x: string, v: number): boolean => {
    const d = domain(x);
    if (v < d.lo || v > d.hi) return false;
    setIn(solved, x, v);
    return recheck();
  };

  /** Solve `c * x + o` == `value` (mod 2^bits, or exactly for 0): 'wait' while the domain leaves several. */
  const solve = (val: Extract<Val, { k: 'a' }>, value: number, bits: 8 | 16 | 0): 'bound' | 'wait' | 'fail' => {
    const d = domain(val.x);
    const m = bits === 0 ? 0 : 2 ** bits;
    const holds = (t: number): boolean => {
      const r = val.c * t + val.o;
      return m === 0 ? r === value : ((r % m) + m) % m === value;
    };
    const found: number[] = [];
    if (d.hi - d.lo <= 4096) {
      for (let t = d.lo; t <= d.hi && found.length < 2; t++) if (holds(t)) found.push(t);
    } else if (Math.abs(val.c) === 1) {
      if (m === 0) {
        const t = (value - val.o) * val.c;
        if (t >= d.lo && t <= d.hi) found.push(t);
      } else {
        const first = ((((value - val.o) * val.c) % m) + m) % m;
        for (let t = first; t <= d.hi && found.length < 2; t += m) if (t >= d.lo) found.push(t);
      }
    } else return 'wait';
    if (found.length === 0) return 'fail';
    if (found.length > 1) return 'wait';
    return bind(val.x, found[0]!) ? 'bound' : 'fail';
  };

  /** Every pending constraint that can be decided now; false when one fails. */
  const recheck = (): boolean => {
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]!;
      const v = evalExpr(c.expr);
      if (c.k === 'bool') {
        if (v.k === 'n' && (v.v !== 0) !== c.truth) return false;
        continue;
      }
      if (v.k === 'n') {
        if (!fits(v.v, c.value, c.bits)) return false;
        continue;
      }
      if (v.k === 'a') {
        const r = solve(v, c.value, c.bits);
        if (r === 'fail') return false;
        if (r === 'bound') i = -1;
      }
    }
    return true;
  };

  const fits = (v: number, value: number, bits: 8 | 16 | 0): boolean => (bits === 0 ? v === value : (v & (2 ** bits - 1)) === value);

  /** `e` must come to `value`: checked, solved, or kept for later. */
  const require = (e: Expr, value: number, bits: 8 | 16 | 0): boolean => {
    const v = evalExpr(e);
    if (v.k === 'n') return fits(v.v, value, bits);
    if (v.k === 'a') {
      const r = solve(v, value, bits);
      if (r === 'fail') return false;
      if (r === 'bound') return true;
    }
    pushPending({ k: 'eq', expr: e, value, bits });
    return true;
  };

  /**
   * The assignments of `cond`'s unknowns (when they are few) under which it is
   * `truth`, as narrowed domains; null when none. Undefined: too many to try.
   */
  const narrowings = (cond: Expr, truth: boolean): Map<string, Interval> | null | undefined => {
    const xs = [...unknownsOf(cond)];
    let size = 1;
    for (const x of xs) {
      const d = domain(x);
      size *= d.hi - d.lo + 1;
      if (size > 4096) return undefined;
    }
    const lo = new Map<string, number>();
    const hi = new Map<string, number>();
    const overlay = new Map<string, number>();
    let any = false;
    const walk = (i: number): void => {
      if (i === xs.length) {
        const v = evalExpr(cond, overlay);
        if (v.k !== 'n' || (v.v !== 0) !== truth) return;
        any = true;
        for (const x of xs) {
          const t = overlay.get(x)!;
          lo.set(x, Math.min(lo.get(x) ?? t, t));
          hi.set(x, Math.max(hi.get(x) ?? t, t));
        }
        return;
      }
      const x = xs[i]!;
      const d = domain(x);
      for (let t = d.lo; t <= d.hi; t++) {
        overlay.set(x, t);
        walk(i + 1);
      }
      overlay.delete(x);
    };
    walk(0);
    if (!any) return null;
    return new Map(xs.map((x) => [x, { lo: lo.get(x)!, hi: hi.get(x)! }]));
  };

  /** Take `cond` as `truth`: narrow, fix what that fixes, keep it to check. False when impossible. */
  const assume = (cond: Expr, truth: boolean, narrowed: Map<string, Interval> | undefined): boolean => {
    pushPending({ k: 'bool', expr: cond, truth });
    if (narrowed !== undefined) {
      for (const [x, d] of narrowed) {
        if (d.lo === d.hi) {
          if (!bind(x, d.lo)) return false;
        } else setIn(domains, x, d);
      }
    }
    return recheck();
  };

  // --- the walk -----------------------------------------------------------

  let cursor: Frame[] = [{ list: stmts, index: 0 }];
  let pc = -1;
  const choices: Choice[] = [];

  /** The first byte a statement list would lay down, when it is plain. */
  const firstByte = (list: readonly AsmStmt[]): number | null => {
    for (const s of list) {
      if (s.k === 'label' || s.k === 'assign') continue;
      if (s.k === 'op') return s.code;
      if (s.k === 'bytes') {
        const v = evalExpr(s.args[0]!);
        return v.k === 'n' ? v.v & 0xff : null;
      }
      return null;
    }
    return null;
  };

  const enter = (list: readonly AsmStmt[]): void => {
    cursor.push({ list, index: 0 });
  };
  const snapshot = (): Frame[] => cursor.map((f) => ({ list: f.list, index: f.index }));

  const takeIf = (s: Extract<AsmStmt, { k: 'if' }>): boolean => {
    const v = evalExpr(s.cond);
    if (v.k === 'n') {
      enter(v.v !== 0 ? s.then : s.else);
      return true;
    }
    const onTrue = narrowings(s.cond, true);
    const onFalse = narrowings(s.cond, false);
    if (onTrue === null && onFalse === null) return false;
    if (onTrue === null) {
      enter(s.else);
      return assume(s.cond, false, onFalse ?? undefined);
    }
    if (onFalse === null) {
      enter(s.then);
      return assume(s.cond, true, onTrue);
    }
    // Both possible: first the side whose first byte can be the one here, the other on backtracking.
    const here = mem(pc);
    const thenFirst = firstByte(s.then);
    const elseFirst = firstByte(s.else);
    const thenFits = thenFirst === null || thenFirst === here;
    const elseFits = elseFirst === null || elseFirst === here;
    const trueFirst = thenFits || !elseFits;
    const sides: [boolean, Map<string, Interval> | undefined][] = trueFirst
      ? [
          [true, onTrue],
          [false, onFalse],
        ]
      : [
          [false, onFalse],
          [true, onTrue],
        ];
    const [first, second] = sides as [[boolean, Map<string, Interval> | undefined], [boolean, Map<string, Interval> | undefined]];
    const saved = snapshot();
    const savedPc = pc;
    const mark = trail.length;
    choices.push({
      cursor: saved,
      pc: savedPc,
      trail: mark,
      alternative: () => {
        enter(second[0] ? s.then : s.else);
        return assume(s.cond, second[0], second[1]);
      },
    });
    enter(first[0] ? s.then : s.else);
    return assume(s.cond, first[0], first[1]);
  };

  const step = (s: AsmStmt): boolean => {
    switch (s.k) {
      case 'if':
        return takeIf(s);
      case 'assign': {
        if (defined(s.name)) return false;
        // A symbol an earlier operand used before this defined it: it must come to what that said.
        const earlier = solved.get(s.name);
        if (earlier !== undefined && !require(s.expr, earlier, 0)) return false;
        setIn(assigns, s.name, s.expr);
        return recheck();
      }
      case 'label': {
        if (defined(s.name)) return false;
        const earlier = solved.get(s.name);
        if (earlier !== undefined && earlier !== pc) return false;
        setIn(labels, s.name, pc);
        return recheck();
      }
      case 'org': {
        const v = evalExpr(s.expr);
        if (v.k !== 'n') return false;
        if (pc >= 0 && v.v !== pc) return false;
        pc = v.v;
        return true;
      }
      case 'bytes': {
        const author = labels.get(AUTHOR_LABEL) ?? -1;
        for (const a of s.args) {
          const b = mem(pc);
          if (b === undefined) return false;
          // The author info: whatever the relocator wrote there.
          if (!(author >= 0 && pc >= author && pc < author + AUTHOR_BYTES) && !require(a, b, 8)) return false;
          pc++;
        }
        return true;
      }
      case 'op': {
        if (mem(pc) !== s.code) return false;
        const size = MODE_SIZE[s.mode];
        if (s.arg !== undefined) {
          const lo = mem(pc + 1);
          const hi = size === 3 ? mem(pc + 2) : 0;
          if (lo === undefined || hi === undefined) return false;
          let ok: boolean;
          if (s.mode === 'rel') ok = require(s.arg, (pc + 2 + (lo < 0x80 ? lo : lo - 0x100)) & 0xffff, 0);
          else if (size === 3) ok = require(s.arg, lo | (hi << 8), 16);
          else ok = require(s.arg, lo, 8);
          if (!ok) return false;
        }
        pc += size;
        return true;
      }
    }
  };

  const backtrack = (): boolean => {
    for (;;) {
      const c = choices.pop();
      if (c === undefined) return false;
      undoTo(c.trail);
      cursor = c.cursor.map((f) => ({ list: f.list, index: f.index }));
      pc = c.pc;
      if (c.alternative()) return true;
    }
  };

  for (let steps = 0; ; steps++) {
    if (steps > MAX_STEPS) return null;
    // The next statement.
    let s: AsmStmt | undefined;
    while (cursor.length > 0) {
      const top = cursor[cursor.length - 1]!;
      if (top.index < top.list.length) {
        s = top.list[top.index++]!;
        break;
      }
      cursor.pop();
    }
    if (s === undefined) {
      // The end of the source: the data starts here, which fixes what only its label and a
      // define together said (`mt_freqtbllo-FIRSTNOTE`). A contradiction sends the search back.
      if (dataLabel === undefined || labels.has(dataLabel)) break;
      const at = solved.get(dataLabel);
      if (at === pc || (at === undefined && bind(dataLabel, pc))) break;
      if (!backtrack()) return null;
      continue;
    }
    if (!step(s) && !backtrack()) return null;
  }

  const author = labels.get(AUTHOR_LABEL);
  if (author !== undefined) {
    authorInfo = new Uint8Array(AUTHOR_BYTES);
    for (let i = 0; i < AUTHOR_BYTES; i++) authorInfo[i] = mem(author + i) ?? 0;
  }
  const symbols = new Map<string, number>([...known, ...solved, ...labels]);
  for (const name of assigns.keys()) {
    const v = valueOf(name);
    if (v.k === 'n') symbols.set(name, v.v);
  }
  return { end: pc, symbols, ranges: new Map(domains), authorInfo };
}
