/**
 * VBlank-vs-CIA timing detection for ProTracker modules.
 *
 * ProTracker's `Fxx` is two commands sharing one letter: parameters below
 * 0x20 set the speed (ticks per row), 0x20 and above set the CIA timer's
 * tempo in BPM. That split only exists on machines with the CIA timer
 * running the replayer. Modules written for -- or on -- a VBlank-timed
 * player have no tempo command at all: their tick rate is nailed to the
 * 50 Hz vertical blank, and *every* `Fxx` sets the speed, all the way up to
 * 0xFF.
 *
 * Nothing in the file says which kind it is. The two are byte-identical, so
 * the only way to tell them apart is what the module sounds like when you
 * assume one or the other. Reading a VBlank module as CIA turns a one-row
 * `F20` pause -- 32 ticks, about two thirds of a second -- into "play the
 * rest of the song at 32 BPM", the slowest tempo ProTracker can express.
 * KLISJE.MOD does exactly that at the end of its 32nd pattern, and the
 * remaining 50 patterns crawl.
 *
 * The heuristic is OpenMPT's (`Load_mod.cpp`, `kMODVBlankTiming`): if a
 * 4-channel ProTracker module uses only *low* tempo commands, and playing it
 * as CIA makes it absurdly long, it was meant to be VBlank-timed. Both
 * halves matter. A module that asks for 100 BPM or more is stating a real
 * tempo -- as a speed those values are nonsense -- so it is definitely CIA.
 * And a low tempo command is perfectly legitimate on its own; only when
 * honouring it stretches the song past eight minutes has the reading gone
 * visibly wrong.
 */

import type { ModPatternCell, ModSong } from './mod-parser';

/** Tempo commands at or above this really are tempos; nothing else fits. */
const DEFINITELY_CIA_BPM = 100;

/** Seconds of CIA-timed playback beyond which the reading is suspect. */
const IMPLAUSIBLE_SONG_SECONDS = 480;

/** Guard against a pathological order/jump structure looping forever. */
const MAX_SIMULATED_ROWS = 200_000;

const ROWS_PER_PATTERN = 64;

/**
 * Whether this module's `Fxx` commands should all be read as speed.
 *
 * Only ProTracker/NoiseTracker 4-channel modules are considered: the later
 * multi-channel formats were written on hardware that always had CIA timing,
 * and Soundtracker's own `Fxx` predates the tempo split entirely.
 */
export function usesVBlankTiming(song: ModSong): boolean {
  if (song.numChannels !== 4) return false;
  if (song.trackerFlavor !== 'ProTracker' && song.trackerFlavor !== 'NoiseTracker') {
    return false;
  }

  let hasLowTempoCommand = false;
  for (const cell of playedCells(song)) {
    if ((cell.effectCmd & 0x0f) !== 0x0f) continue;
    if (cell.effectParam >= DEFINITELY_CIA_BPM) return false;
    if (cell.effectParam >= 0x20) hasLowTempoCommand = true;
  }
  if (!hasLowTempoCommand) return false;

  const ciaSeconds = estimateDuration(song, false);
  if (ciaSeconds < IMPLAUSIBLE_SONG_SECONDS) return false;

  // If reading the commands as speed does not actually shorten the song,
  // there is nothing to gain and CIA stays the safer reading.
  return estimateDuration(song, true) < ciaSeconds;
}

/** Every cell of every pattern the order list actually plays. */
function* playedCells(song: ModSong): Generator<ModPatternCell> {
  const orderLength = song.songLength || song.orders.length;
  const seen = new Set<number>();
  for (let i = 0; i < orderLength; i++) {
    const index = song.orders[i] ?? 0;
    if (seen.has(index)) continue;
    seen.add(index);
    const pattern = song.patterns[index];
    if (!pattern) continue;
    for (const row of pattern.rows) {
      for (const cell of row) yield cell;
    }
  }
}

/**
 * Wall-clock length of the song in seconds, played through once.
 *
 * This is a timing estimate, not a replayer: it follows the order list and
 * the commands that change *when* rows happen -- speed/tempo, position jump,
 * pattern break, pattern loop and pattern delay -- and ignores everything
 * about the sound. Revisiting a row that has already played means the song
 * has looped, which ends the walk.
 */
function estimateDuration(song: ModSong, vblank: boolean): number {
  const orderLength = song.songLength || song.orders.length;
  let speed = 6;
  let bpm = 125;
  let seconds = 0;
  let order = 0;
  let row = 0;
  let loopStart = 0;
  let loopCount = 0;
  const visited = new Set<number>();

  for (let guard = 0; guard < MAX_SIMULATED_ROWS; guard++) {
    if (order >= orderLength) break;
    const key = order * ROWS_PER_PATTERN + row;
    if (visited.has(key)) break;
    visited.add(key);

    const pattern = song.patterns[song.orders[order] ?? 0];
    const cells = pattern?.rows[row] ?? [];

    let nextOrder = order;
    let nextRow = row + 1;
    let jumped = false;
    let rowRepeats = 1;
    let stopped = false;

    for (const cell of cells) {
      const param = cell.effectParam;
      switch (cell.effectCmd & 0x0f) {
        case 0xf:
          if (param === 0) stopped = true;
          else if (vblank || param < 0x20) speed = param;
          else bpm = param;
          break;
        case 0xb: // Bxx: position jump
          nextOrder = param;
          nextRow = 0;
          jumped = true;
          break;
        case 0xd: // Dxx: pattern break, to a *decimal* row
          nextOrder = order + 1;
          nextRow = (param >> 4) * 10 + (param & 0x0f);
          jumped = true;
          break;
        case 0xe:
          if ((param >> 4) === 0x6) {
            // E6x: pattern loop
            const count = param & 0x0f;
            if (count === 0) {
              loopStart = row;
            } else {
              loopCount = loopCount === 0 ? count : loopCount - 1;
              if (loopCount > 0) {
                nextOrder = order;
                nextRow = loopStart;
                jumped = true;
              }
            }
          } else if ((param >> 4) === 0xe) {
            // EEx: pattern delay, repeating the row x more times
            rowRepeats = 1 + (param & 0x0f);
          }
          break;
        default:
          break;
      }
    }

    seconds += (speed * rowRepeats * 2.5) / bpm;
    if (stopped) break;
    if (!jumped && nextRow >= ROWS_PER_PATTERN) {
      nextRow = 0;
      nextOrder = order + 1;
    }
    order = nextOrder;
    row = nextRow;
  }

  return seconds;
}
