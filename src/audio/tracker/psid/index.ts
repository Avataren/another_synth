import type { SidDoc } from 'src/audio/tracker/sid-doc';
import { measureFidelity, type Fidelity } from './fidelity';
import { unpackGtSid } from './gt-unpack';
import { looksLikePsid, parsePsid, type PsidFile } from './psid-file';
import { captureSid } from './sid-capture';
import { transcribePsid, type SubsongReport, type TranscribeOptions } from './transcribe';

/**
 * `.sid` (PSID/RSID) import (plan-psid-import.md): a C64 SID file becomes a
 * GoatTracker song the tracker edits, plays and exports like any other.
 *
 * A file GoatTracker made (its player is GoatTracker 2's) is unpacked: its
 * song data read back into the song it was packed from (`gt-unpack/`),
 * checked by packing it again. Any other is run on an emulated C64 and what
 * its player plays is transcribed (`transcribe/`); how close that sounds is
 * measured on the start song (`fidelity.ts`).
 */

export { looksLikePsid, parsePsid, psidSongUsesCia, type PsidFile } from './psid-file';
export { captureSid, type SidCapture, type SidTrace } from './sid-capture';
export { compareFrames, measureFidelity, type Fidelity, type VoiceFidelity } from './fidelity';
export { transcribePsid, type PsidTranscription, type SubsongReport, type TranscribeOptions } from './transcribe';
export { unpackGtSid, type GtUnpack } from './gt-unpack';

export interface PsidImport {
  readonly ok: true;
  readonly file: PsidFile;
  readonly doc: SidDoc;
  /** How it was made: GoatTracker's song data in the file, unpacked; or what the tune's player plays, transcribed. */
  readonly method: 'unpacked' | 'transcribed';
  /** Unpacked, and packing the song again gives the file's bytes: the same song, byte for byte. */
  readonly exact: boolean;
  /** Per subsong, how the transcription went (none when unpacked). */
  readonly reports: readonly SubsongReport[];
  /** Things the user should know (speed, cut songs, subsongs left out). */
  readonly notes: readonly string[];
  /** The start song against the original, or null when it could not be measured. */
  readonly fidelity: Fidelity | null;
}

export type PsidImportResult = PsidImport | { readonly ok: false; readonly reason: string };

export interface PsidImportOptions extends TranscribeOptions {
  /** Measure the start song against the original (default true). */
  readonly measure?: boolean;
}

/** Subsong numbers (1-based) as runs: "3-20, 22". */
function runs(subsongs: readonly number[]): string {
  const sorted = [...subsongs].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** The subsongs left out, grouped by why: "Not imported: subsongs 3-20 (2x speed; the song plays at 1x)." */
function leftOutNote(left: readonly SubsongReport[]): string {
  const byReason = new Map<string, number[]>();
  for (const r of left) {
    const why = r.reason ?? 'left out';
    byReason.set(why, [...(byReason.get(why) ?? []), r.subsong + 1]);
  }
  const parts = [...byReason].map(([why, subsongs]) => `${runs(subsongs)} (${why})`);
  return `Not imported: subsong${left.length === 1 ? '' : 's'} ${parts.join('; ')}.`;
}

/** An unpacked song that packs to other bytes than the file's plays at least this like it, or it is transcribed instead. */
const UNPACKED_FIDELITY = 0.98;

/**
 * `file` unpacked from its GoatTracker data, or null when it is not a
 * GoatTracker file (or unpacks to something that does not play like it).
 */
function unpacked(file: PsidFile, options: PsidImportOptions): PsidImport | null {
  const u = unpackGtSid(file);
  if (!u.ok) return null;
  const notes = [...u.notes];
  let fidelity: Fidelity | null = null;
  if (!u.exact) {
    // Not the file's bytes again (an option GoatTracker's packer has and ours does not):
    // kept only when it plays like the file.
    const capture = captureSid(file, { subsong: 0, maxSeconds: 120 });
    if (!capture.ok) return null;
    const m = measureFidelity(capture.trace, u.doc, 0, 3000);
    if (typeof m === 'string' || m.score < UNPACKED_FIDELITY) return null;
    fidelity = options.measure === false ? null : m;
  }
  return { ok: true, file, doc: u.doc, method: 'unpacked', exact: u.exact, reports: [], notes, fidelity };
}

/** `bytes` (a `.sid`) as a GoatTracker song, or the true reason it cannot be one. Never throws for a tune's behaviour. */
export function importPsid(bytes: Uint8Array, options: PsidImportOptions = {}): PsidImportResult {
  if (!looksLikePsid(bytes)) return { ok: false, reason: 'it is not a SID file' };
  const parsed = parsePsid(bytes);
  if (!parsed.ok) return parsed;
  const file = parsed.file;
  const gt = unpacked(file, options);
  if (gt !== null) return gt;
  const t = transcribePsid(file, options);
  if (!t.ok) return { ok: false, reason: t.reason };
  const notes = [...t.notes];
  const left = t.reports.filter((r) => r.gtSubsong === null);
  if (left.length > 0) notes.push(leftOutNote(left));
  if (file.extraSids.length > 0) notes.push('The tune plays more SID chips; only the first was imported (GoatTracker has one).');
  const traces = t.reports.filter((r) => r.trace?.digi);
  if (traces.length > 0) notes.push('The tune plays samples through the volume register; GoatTracker cannot, so they are left out.');
  let fidelity: Fidelity | null = null;
  if (options.measure ?? true) {
    const start = t.reports.find((r) => r.gtSubsong === 0);
    if (start?.trace !== undefined) {
      const m = measureFidelity(start.trace, t.doc, 0, 3000);
      if (typeof m !== 'string') fidelity = m;
    }
  }
  return { ok: true, file, doc: t.doc, method: 'transcribed', exact: false, reports: t.reports, notes, fidelity };
}
