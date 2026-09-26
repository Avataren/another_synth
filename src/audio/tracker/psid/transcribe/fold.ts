import type { SidDocRow, SidInstrument } from 'src/audio/tracker/sid-doc';
import type { SubsongRows } from './song';

/**
 * Instruments folded into row commands: the accents of a sound (a louder
 * attack, another start of the pulse sweep, a drum on another wave program)
 * as a command on the notes of one instrument, not an instrument each.
 *
 * GoatTracker runs a row's tick-0 command after its note's instrument init
 * (player.s `mt_tick0jump1`, player.rs `tick0`), so a note of instrument B
 * plays exactly as one of A with `5xx` (attack/decay), `6xx` (sustain/
 * release), `8xx` (wave pointer), `9xx` (pulse pointer) or `Axx` (filter
 * pointer) when A and B differ in that one thing. B folds into A when every
 * row naming B has its command column free; instruments that differ in
 * nothing (a wave program cut to fit the tables can make two so) merge.
 */

interface Field {
  readonly command: number;
  /** B's value as the command's parameter, or null when no command sets it (a zero pointer: GoatTracker keeps the running one). */
  readonly param: (ins: SidInstrument) => number | null;
  /** B's instrument with A's value here: equal to A when this is all they differ in. */
  readonly as: (ins: SidInstrument, host: SidInstrument) => SidInstrument;
}

const FIELDS: readonly Field[] = [
  { command: 0x5, param: (i) => (i.attack << 4) | i.decay, as: (i, h) => ({ ...i, attack: h.attack, decay: h.decay }) },
  { command: 0x6, param: (i) => (i.sustain << 4) | i.release, as: (i, h) => ({ ...i, sustain: h.sustain, release: h.release }) },
  { command: 0x8, param: (i) => i.wavePtr || null, as: (i, h) => ({ ...i, wavePtr: h.wavePtr }) },
  { command: 0x9, param: (i) => i.pulsePtr || null, as: (i, h) => ({ ...i, pulsePtr: h.pulsePtr }) },
  { command: 0xa, param: (i) => i.filterPtr || null, as: (i, h) => ({ ...i, filterPtr: h.filterPtr }) },
];

/** What makes an instrument sound as it does (its name aside). */
const soundKey = (i: SidInstrument): string =>
  [
    i.attack,
    i.decay,
    i.sustain,
    i.release,
    i.firstWave,
    i.gateTimer,
    i.hardRestart,
    i.noGateOff,
    i.vibratoDelay,
    i.wavePtr,
    i.pulsePtr,
    i.filterPtr,
    i.speedPtr,
  ].join(',');

/** How `ins` plays as `host`: nothing to add, one command, or null (it differs in more). */
function asHost(ins: SidInstrument, host: SidInstrument): { command: number; param: number } | 'same' | null {
  const hostKey = soundKey(host);
  if (soundKey(ins) === hostKey) return 'same';
  for (const f of FIELDS) {
    const param = f.param(ins);
    if (param !== null && soundKey(f.as(ins, host)) === hostKey) return { command: f.command, param };
  }
  return null;
}

export interface Folded {
  readonly instruments: SidInstrument[];
  readonly songs: SubsongRows[];
}

/**
 * `instruments` (1-based in `songs`' rows) with every one that plays as
 * another plus a command folded into it, the most used first as hosts; the
 * rows renumbered.
 */
export function foldInstruments(instruments: readonly SidInstrument[], songs: readonly SubsongRows[]): Folded {
  const uses = new Array<number>(instruments.length + 1).fill(0);
  // Instruments with a note whose command column is taken (a pitch effect, a tempo): they fold only when nothing needs adding.
  const busy = new Set<number>();
  for (const s of songs) {
    for (const v of s.voices) {
      for (const r of v) {
        if (r.instrument === 0) continue;
        uses[r.instrument]!++;
        if (r.command !== 0) busy.add(r.instrument);
      }
    }
  }
  const order = instruments.map((_, i) => i + 1).sort((a, b) => uses[b]! - uses[a]! || a - b);
  const hosts: number[] = [];
  // Per instrument: its host and the command its notes take.
  const fold = new Map<number, { host: number; command: number; param: number }>();
  for (const n of order) {
    const ins = instruments[n - 1]!;
    let found: { host: number; command: number; param: number } | null = null;
    for (const h of hosts) {
      const how = asHost(ins, instruments[h - 1]!);
      if (how === 'same') {
        found = { host: h, command: 0, param: 0 };
        break;
      }
      if (how !== null && !busy.has(n) && found === null) found = { host: h, ...how };
    }
    if (found !== null) fold.set(n, found);
    else hosts.push(n);
  }
  if (fold.size === 0) return { instruments: instruments.slice(), songs: songs.slice() };
  hosts.sort((a, b) => a - b);
  const number = new Map(hosts.map((h, i) => [h, i + 1]));
  const row = (r: SidDocRow): SidDocRow => {
    if (r.instrument === 0) return r;
    const f = fold.get(r.instrument);
    if (f === undefined) return { ...r, instrument: number.get(r.instrument)! };
    return f.command === 0 ? { ...r, instrument: number.get(f.host)! } : { ...r, instrument: number.get(f.host)!, command: f.command, param: f.param };
  };
  return {
    instruments: hosts.map((h) => instruments[h - 1]!),
    songs: songs.map((s) => ({ ...s, voices: s.voices.map((v) => v.map(row)) })),
  };
}
