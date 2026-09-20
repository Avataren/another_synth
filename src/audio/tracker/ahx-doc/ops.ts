import { BLANK_STEP, blankTrack, isBlankStep, isBlankTrack, makeAhxDoc, stepsEqual, tracksEqual } from './doc';
import { toLatin1 } from './latin1';
import { sizeRefusal } from './size-budget';
import {
  AHX_CHANNELS,
  AHX_MAX_POSITIONS,
  AHX_MAX_TRACKS,
  AHX_MAX_TRACK_LENGTH,
  type AhxDoc,
  type AhxDocPosition,
  type AhxDocStep,
  type AhxDocTrack,
  type AhxOpContext,
  type AhxOpResult,
  type AhxPositionMap,
} from './types';

/**
 * The edits an AHX doc takes, as pure functions: `op(doc, ...) -> { ok: true,
 * doc, ... } | { ok: false, reason }`. A refusal changes nothing and gives a
 * reason fit to show the user; an op that would change nothing returns the
 * very same doc. Refusals are decided before anything is built, and an op that
 * grows the file is refused when the file would no longer fit the 16-bit
 * `nameOffset` (so a doc reached through ops always serializes).
 *
 * Track 0 is the track every blank cell points at; while it is blank it never
 * takes content here (the editor gives the cell a track of its own first).
 */

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function positionAt(doc: AhxDoc, position: number, channel?: number): string | null {
  if (!isInt(position, 0, doc.positions.length - 1)) return `There is no position ${position} (the song has ${doc.positions.length}).`;
  if (channel !== undefined && !isInt(channel, 0, AHX_CHANNELS - 1)) return `AHX has channels 0 to ${AHX_CHANNELS - 1}, not ${channel}.`;
  return null;
}

/** A step the file can hold: a note 0..63, an instrument 0..63, an effect nibble, one effect column. */
function stepProblem(step: AhxDocStep): string | null {
  if (typeof step !== 'object' || step === null) return 'That is not a step.';
  if (!isInt(step.note, 0, 63)) return `A note is 0 to 63 (got ${String(step.note)}).`;
  if (!isInt(step.instrument, 0, 63)) return `AHX instruments go up to 63 (got ${String(step.instrument)}).`;
  if (!isInt(step.fx, 0, 15)) return `An effect command is one hex digit (got ${String(step.fx)}).`;
  if (!isInt(step.fxParam, 0, 255)) return `An effect parameter is 0 to 255 (got ${String(step.fxParam)}).`;
  if (step.fxb !== 0 || step.fxbParam !== 0) return 'AHX steps have one effect column.';
  return null;
}

const TRACK_0_REASON =
  'Track 0 is the blank track every empty cell points at; give the channel a track of its own before writing into it.';

/** How many (position, channel) cells use each track. */
export function trackUsage(doc: AhxDoc): number[] {
  const usage = new Array<number>(doc.tracks.length).fill(0);
  for (const position of doc.positions) for (const track of position.track) usage[track] = (usage[track] ?? 0) + 1;
  return usage;
}

/** The cells (`[position, channel]`) that use `track`. */
export function cellsUsingTrack(doc: AhxDoc, track: number): [number, number][] {
  const cells: [number, number][] = [];
  doc.positions.forEach((position, p) => position.track.forEach((t, ch) => t === track && cells.push([p, ch])));
  return cells;
}

const withTracks = (doc: AhxDoc, tracks: readonly AhxDocTrack[]): AhxDoc => makeAhxDoc({ ...doc, tracks });
const withPositions = (doc: AhxDoc, positions: readonly AhxDocPosition[]): AhxDoc => makeAhxDoc({ ...doc, positions });

// ---------------------------------------------------------------------------
// Steps and tracks
// ---------------------------------------------------------------------------

function replaceTrack(doc: AhxDoc, track: number, next: AhxDocTrack): AhxOpResult {
  const current = doc.tracks[track] as AhxDocTrack;
  if (tracksEqual(current, next)) return { ok: true, doc };
  if (track === 0 && isBlankTrack(current) && !isBlankTrack(next)) return refuse(TRACK_0_REASON);
  const tracks = doc.tracks.slice();
  tracks[track] = next;
  return { ok: true, doc: withTracks(doc, tracks) };
}

export function setStep(doc: AhxDoc, track: number, row: number, step: AhxDocStep): AhxOpResult {
  if (!isInt(track, 0, doc.tracks.length - 1)) return refuse(`There is no track ${track} (the song has ${doc.tracks.length}).`);
  if (!isInt(row, 0, doc.trackLength - 1)) return refuse(`Row ${row} is outside this song's tracks (${doc.trackLength} rows).`);
  const problem = stepProblem(step);
  if (problem !== null) return refuse(problem);
  const current = doc.tracks[track] as AhxDocTrack;
  if (stepsEqual(current[row] as AhxDocStep, step)) return { ok: true, doc };
  const next = current.slice();
  next[row] = { ...step };
  return replaceTrack(doc, track, next);
}

/** Replaces a whole track (what the grid's write-back does). `steps` must have `trackLength` steps. */
export function setTrack(doc: AhxDoc, track: number, steps: AhxDocTrack): AhxOpResult {
  if (!isInt(track, 0, doc.tracks.length - 1)) return refuse(`There is no track ${track} (the song has ${doc.tracks.length}).`);
  if (!Array.isArray(steps) || steps.length !== doc.trackLength) {
    return refuse(`A track has ${doc.trackLength} steps (got ${Array.isArray(steps) ? steps.length : 'none'}).`);
  }
  for (let row = 0; row < steps.length; row++) {
    const problem = stepProblem(steps[row] as AhxDocStep);
    if (problem !== null) return refuse(`Row ${row}: ${problem}`);
  }
  return replaceTrack(doc, track, steps.map((step) => (isBlankStep(step) ? BLANK_STEP : { ...step })));
}

/**
 * A track for a channel that needs one of its own: the first track from 1 that
 * no position uses and that is all blank (its slot is reused, so the file does
 * not grow), else a new one at the end. `copyOf` gives it that track's steps;
 * `append` skips the reuse and always adds one. Refused at 256 tracks and when
 * the file would no longer fit.
 */
export function allocTrack(
  doc: AhxDoc,
  options: { copyOf?: number; append?: boolean } = {},
  context: AhxOpContext = {},
): AhxOpResult<{ track: number }> {
  const { copyOf, append = false } = options;
  if (copyOf !== undefined && !isInt(copyOf, 0, doc.tracks.length - 1)) return refuse(`There is no track ${copyOf} to copy.`);
  const content = copyOf === undefined ? blankTrack(doc.trackLength) : (doc.tracks[copyOf] as AhxDocTrack);

  if (!append) {
    const usage = trackUsage(doc);
    for (let t = 1; t < doc.tracks.length; t++) {
      if (usage[t] === 0 && isBlankTrack(doc.tracks[t] as AhxDocTrack)) {
        if (copyOf === undefined) return { ok: true, doc, track: t };
        const tracks = doc.tracks.slice();
        tracks[t] = content;
        return { ok: true, doc: withTracks(doc, tracks), track: t };
      }
    }
  }
  if (doc.tracks.length >= AHX_MAX_TRACKS) return refuse(`A song holds at most ${AHX_MAX_TRACKS} tracks.`);
  const next = withTracks(doc, [...doc.tracks, content]);
  const tooBig = sizeRefusal(doc, next, context.instrumentBytes ?? 0, 'a new track');
  if (tooBig !== null) return refuse(tooBig);
  return { ok: true, doc: next, track: doc.tracks.length };
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export function assignTrack(doc: AhxDoc, position: number, channel: number, track: number): AhxOpResult {
  const where = positionAt(doc, position, channel);
  if (where !== null) return refuse(where);
  if (!isInt(track, 0, doc.tracks.length - 1)) return refuse(`There is no track ${track} (the song has ${doc.tracks.length}).`);
  const current = doc.positions[position] as AhxDocPosition;
  if (current.track[channel] === track) return { ok: true, doc };
  const nextTrack = current.track.slice();
  nextTrack[channel] = track;
  const positions = doc.positions.slice();
  positions[position] = { track: nextTrack, transpose: current.transpose };
  return { ok: true, doc: withPositions(doc, positions) };
}

export function setTranspose(doc: AhxDoc, position: number, channel: number, value: number): AhxOpResult {
  const where = positionAt(doc, position, channel);
  if (where !== null) return refuse(where);
  if (!isInt(value, -128, 127)) return refuse(`A transpose is -128 to 127 (got ${String(value)}).`);
  const current = doc.positions[position] as AhxDocPosition;
  if (current.transpose[channel] === value) return { ok: true, doc };
  const transpose = current.transpose.slice();
  transpose[channel] = value;
  const positions = doc.positions.slice();
  positions[position] = { track: current.track, transpose };
  return { ok: true, doc: withPositions(doc, positions) };
}

/**
 * Gives the cell a track of its own: when other cells use its track, a copy of
 * it is assigned to this one (`track` is the number the cell now has; the
 * original when it was already alone).
 */
export function makeUnique(doc: AhxDoc, position: number, channel: number, context: AhxOpContext = {}): AhxOpResult<{ track: number }> {
  const where = positionAt(doc, position, channel);
  if (where !== null) return refuse(where);
  const current = (doc.positions[position] as AhxDocPosition).track[channel] as number;
  if ((trackUsage(doc)[current] ?? 0) <= 1) return { ok: true, doc, track: current };
  const copy = allocTrack(doc, { copyOf: current }, context);
  if (!copy.ok) return copy;
  const assigned = assignTrack(copy.doc, position, channel, copy.track);
  if (!assigned.ok) return assigned;
  return { ok: true, doc: assigned.doc, track: copy.track };
}

/** The map of an insert at `at`: everything from `at` on moves one down. */
const insertMap = (at: number): AhxPositionMap => (old) => (old >= at ? old + 1 : old);
/** The map of a delete at `at`: the position itself is gone. */
const deleteMap = (at: number): AhxPositionMap => (old) => (old < at ? old : old === at ? null : old - 1);
const moveMap = (from: number, to: number): AhxPositionMap => (old) => {
  if (old === from) return to;
  if (from < to && old > from && old <= to) return old - 1;
  if (from > to && old >= to && old < from) return old + 1;
  return old;
};

/** `restart` and the subsong starts through `map`; a deleted one falls to `fallback`. */
function remapped(doc: AhxDoc, positions: readonly AhxDocPosition[], map: AhxPositionMap, fallback: number): AhxDoc {
  const last = positions.length - 1;
  const through = (old: number): number => Math.min(last, map(old) ?? fallback);
  return makeAhxDoc({ ...doc, positions, restart: through(doc.restart), subsongs: doc.subsongs.map(through) });
}

export type AhxInsertKind = { kind: 'blank' } | { kind: 'duplicate' | 'duplicateUnique'; of: number };

/**
 * A new position at index `at` (0..positions.length; the old `at` moves down).
 * `blank` points every channel at the blank track; `duplicate` reuses the
 * tracks of position `of` (shared), `duplicateUnique` gives each channel a copy
 * of its own. `mapPosition` carries old indexes to new ones.
 */
export function insertPosition(
  doc: AhxDoc,
  at: number,
  what: AhxInsertKind = { kind: 'blank' },
  context: AhxOpContext = {},
): AhxOpResult<{ mapPosition: AhxPositionMap }> {
  if (!isInt(at, 0, doc.positions.length)) return refuse(`A position cannot be inserted at ${at}.`);
  if (doc.positions.length >= AHX_MAX_POSITIONS) return refuse(`A song holds at most ${AHX_MAX_POSITIONS} positions.`);
  if (what.kind !== 'blank') {
    const missing = positionAt(doc, what.of);
    if (missing !== null) return refuse(missing);
  }

  // Insert the entry first, then give channels tracks of their own one at a
  // time: a track is only "unreferenced" (and so reusable) until it is assigned.
  const blankRefs = new Array<number>(AHX_CHANNELS).fill(0);
  const source = what.kind === 'blank' ? undefined : (doc.positions[what.of] as AhxDocPosition);
  const entry: AhxDocPosition = source
    ? { track: source.track.slice(), transpose: source.transpose.slice() }
    : { track: blankRefs, transpose: new Array<number>(AHX_CHANNELS).fill(0) };
  const positions = doc.positions.slice();
  positions.splice(at, 0, entry);
  const map = insertMap(at);
  let working = remapped(doc, positions, map, at);

  const own: { channel: number; copyOf?: number }[] = [];
  if (what.kind === 'blank') {
    // Track 0 is the blank track, unless it holds content.
    if (!isBlankTrack(working.tracks[0] as AhxDocTrack)) for (let ch = 0; ch < AHX_CHANNELS; ch++) own.push({ channel: ch });
  } else if (what.kind === 'duplicateUnique') {
    const track0Blank = isBlankTrack(working.tracks[0] as AhxDocTrack);
    for (let ch = 0; ch < AHX_CHANNELS; ch++) {
      const t = entry.track[ch] as number;
      // A copy of the shared blank track 0 would only waste a track.
      if (!(t === 0 && track0Blank)) own.push({ channel: ch, copyOf: t });
    }
  }
  for (const { channel, copyOf } of own) {
    const fresh = allocTrack(working, copyOf === undefined ? {} : { copyOf }, context);
    if (!fresh.ok) return fresh;
    const assigned = assignTrack(fresh.doc, at, channel, fresh.track);
    if (!assigned.ok) return assigned;
    working = assigned.doc;
  }

  const tooBig = sizeRefusal(doc, working, context.instrumentBytes ?? 0, 'a new position');
  if (tooBig !== null) return refuse(tooBig);
  return { ok: true, doc: working, mapPosition: map };
}

/**
 * Removes position `at`. The last position cannot go: the engine refuses a song
 * with none. Its tracks stay in the table (unreferenced), never compacted.
 */
export function deletePosition(doc: AhxDoc, at: number): AhxOpResult<{ mapPosition: AhxPositionMap }> {
  const where = positionAt(doc, at);
  if (where !== null) return refuse(where);
  if (doc.positions.length === 1) return refuse('A song needs at least one position.');
  const positions = doc.positions.slice();
  positions.splice(at, 1);
  const map = deleteMap(at);
  return { ok: true, doc: remapped(doc, positions, map, at), mapPosition: map };
}

/** Moves position `from` so that it ends up at index `to`. */
export function movePosition(doc: AhxDoc, from: number, to: number): AhxOpResult<{ mapPosition: AhxPositionMap }> {
  const a = positionAt(doc, from);
  if (a !== null) return refuse(a);
  const b = positionAt(doc, to);
  if (b !== null) return refuse(b);
  const map = moveMap(from, to);
  if (from === to) return { ok: true, doc, mapPosition: map };
  const positions = doc.positions.slice();
  const [moved] = positions.splice(from, 1);
  positions.splice(to, 0, moved as AhxDocPosition);
  return { ok: true, doc: remapped(doc, positions, map, to), mapPosition: map };
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function setSpeedMultiplier(doc: AhxDoc, value: number): AhxOpResult {
  if (!isInt(value, 1, 4)) return refuse(`The speed multiplier is 1 to 4 (got ${String(value)}).`);
  return value === doc.speedMultiplier ? { ok: true, doc } : { ok: true, doc: makeAhxDoc({ ...doc, speedMultiplier: value }) };
}

export function setRestart(doc: AhxDoc, value: number): AhxOpResult {
  if (!isInt(value, 0, doc.positions.length - 1)) return refuse(`The restart position is 0 to ${doc.positions.length - 1} (got ${String(value)}).`);
  return value === doc.restart ? { ok: true, doc } : { ok: true, doc: makeAhxDoc({ ...doc, restart: value }) };
}

/** Rows per track for the whole song: longer adds blank rows, shorter cuts rows off every track. */
export function setTrackLength(doc: AhxDoc, value: number, context: AhxOpContext = {}): AhxOpResult {
  if (!isInt(value, 1, AHX_MAX_TRACK_LENGTH)) return refuse(`Rows per track is 1 to ${AHX_MAX_TRACK_LENGTH} (got ${String(value)}).`);
  if (value === doc.trackLength) return { ok: true, doc };
  const tracks = doc.tracks.map((track) =>
    value < track.length ? track.slice(0, value) : [...track, ...blankTrack(value - track.length)],
  );
  const next = makeAhxDoc({ ...doc, trackLength: value, tracks });
  const tooBig = sizeRefusal(doc, next, context.instrumentBytes ?? 0, `${value} rows per track`);
  if (tooBig !== null) return refuse(tooBig);
  return { ok: true, doc: next };
}

/** The song name as the file will hold it (NUL removed, above U+00FF as `?`); `altered` says it changed. */
export function setSongName(doc: AhxDoc, name: string): AhxOpResult<{ altered: boolean }> {
  const { text, altered } = toLatin1(name);
  return { ok: true, doc: text === doc.songName ? doc : makeAhxDoc({ ...doc, songName: text }), altered };
}
