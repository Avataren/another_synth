/**
 * TrackerEntry's cell formatting, as a pure function.
 *
 * Extracted verbatim from TrackerEntry.vue so the canvas renderer formats
 * cells identically to the DOM grid -- same padding of short volume/macro
 * strings, same `###` release handling. Any change here changes what the
 * canvas draws; any change to the DOM's copy has to land here instead.
 */

import type { TrackerEntryData } from '../tracker-types';

export interface EntryCell {
  display: string;
  className: string;
}

export interface EntryCells {
  note: EntryCell;
  instrument: EntryCell;
  volumeHi: EntryCell;
  volumeLo: EntryCell;
  macroDigits: string[];
  macro2Digits: string[];
}

/**
 * TrackerEntry.vue's DEFAULT_CELLS: what an empty row draws.
 *
 * Shared and frozen rather than built per cell. Most cells of a real pattern
 * are empty, so a full-grid paint was allocating this object graph thousands
 * of times over to draw the same six dots. Callers only read it.
 */
export const EMPTY_CELLS: EntryCells = Object.freeze({
  note: Object.freeze({ display: '---', className: 'note' }),
  instrument: Object.freeze({ display: '..', className: 'instrument' }),
  volumeHi: Object.freeze({ display: '.', className: 'volume volume-high' }),
  volumeLo: Object.freeze({ display: '.', className: 'volume volume-low' }),
  macroDigits: Object.freeze(['.', '.', '.']),
  macro2Digits: Object.freeze(['.', '.', '.']),
}) as EntryCells;

/** Process cells only when entry exists - optimized to avoid unnecessary string operations */
export function formatEntryCells(entry: TrackerEntryData): EntryCells {
  const volume = entry.volume ?? '..';
  const volPadded = volume.length >= 2 ? volume : (volume + '..').slice(0, 2);
  const macro = entry.macro ?? '...';
  const macroPadded = macro.length >= 3 ? macro : (macro + '...').slice(0, 3);
  const macro2 = entry.macro2 ?? '...';
  const macro2Padded = macro2.length >= 3 ? macro2 : (macro2 + '...').slice(0, 3);

  let noteDisplay = '---';
  if (entry.note) {
    const normalized = entry.note.trim().toUpperCase();
    const isRelease = normalized === '--' || normalized === '---' || normalized === '###';
    noteDisplay = isRelease ? '###' : entry.note;
  }

  return {
    note: { display: noteDisplay, className: 'note' },
    instrument: { display: entry.instrument ?? '..', className: 'instrument' },
    volumeHi: { display: volPadded[0] ?? '.', className: 'volume volume-high' },
    volumeLo: { display: volPadded[1] ?? '.', className: 'volume volume-low' },
    macroDigits: [macroPadded[0] ?? '.', macroPadded[1] ?? '.', macroPadded[2] ?? '.'],
    macro2Digits: [macro2Padded[0] ?? '.', macro2Padded[1] ?? '.', macro2Padded[2] ?? '.']
  };
}
