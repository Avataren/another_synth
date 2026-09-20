import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AhxInstrument, AhxSong } from '@another-synth/tracker-playback';
import { AHX_IMPORT_FALLBACK_TITLE, type AhxDoc, type AhxFileSlot } from 'src/audio/tracker/ahx-doc';
import { buildAhxSlots } from 'src/audio/tracker/instrument-slots';

const DEMOS = resolve(__dirname, '../../../public/demos/ahx');

export interface CorpusFile {
  name: string;
  bytes: Uint8Array;
}

/** The 62 `.ahx` demos (the 7 `.hvl` are not editable and are covered elsewhere). */
export function ahxCorpus(): CorpusFile[] {
  return readdirSync(DEMOS)
    .filter((name) => name.endsWith('.ahx'))
    .sort()
    .map((name) => ({ name, bytes: new Uint8Array(readFileSync(resolve(DEMOS, name))) }));
}

/** The slots the importer builds: instrument `n` in slot `n`. */
export const slotsOf = (song: AhxSong): AhxFileSlot[] =>
  buildAhxSlots(song).map((slot) => ({ ahxData: slot.ahxData }));

/** The title the importer gives the song, which is what leaves the file's own name alone. */
export const importTitleOf = (song: AhxSong): string => song.name.trim() || AHX_IMPORT_FALLBACK_TITLE;

/** The doc's data as plain JSON, for deep equality without the `base` bytes. */
export function plainDoc(doc: AhxDoc): unknown {
  return JSON.parse(JSON.stringify(doc, (key, value: unknown) => (key === 'base' ? undefined : value)));
}

export const instrumentsOf = (slots: readonly AhxFileSlot[]): AhxInstrument[] =>
  slots.flatMap((slot) => (slot.ahxData === undefined ? [] : [slot.ahxData]));

/**
 * What a listener would hear from the structure, written independently of the
 * ops: for every position, channel and row, the step with its position's
 * transpose and whether its instrument exists.
 */
export function resolvedPlayback(song: AhxSong): string {
  const out: string[] = [];
  song.positions.forEach((position, p) => {
    for (let ch = 0; ch < 4; ch++) {
      const steps = song.tracks[position.track[ch] as number] as AhxSong['tracks'][number];
      for (let row = 0; row < song.trackLength; row++) {
        const s = steps[row] as AhxSong['tracks'][number][number];
        if (s.note === 0 && s.instrument === 0 && s.fx === 0 && s.fxParam === 0) continue;
        const exists = s.instrument === 0 || s.instrument <= song.instrumentNr ? 1 : 0;
        out.push(`${p}.${ch}.${row}:${s.note}/${s.instrument}/${s.fx}/${s.fxParam}@${position.transpose[ch]}#${exists}`);
      }
    }
  });
  return `${song.restart}|${song.subsongs.join(',')}|${song.speedMultiplier}|${song.trackLength}|${out.join(';')}`;
}

/** Steps in referenced tracks that name instrument `n` (the dormant references of plan section 4.4). */
export function dormantReferences(song: AhxSong, n: number): number {
  let count = 0;
  const used = new Set(song.positions.flatMap((p) => p.track));
  for (const t of used) for (const step of song.tracks[t] as AhxSong['tracks'][number]) if (step.instrument === n) count++;
  return count;
}

