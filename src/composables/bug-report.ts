/**
 * The bug-report report builder: pure text in, pure text out.
 *
 * The report is DATA. Everything the machine knows is laid out one field per
 * line; everything the user typed lives in exactly two fields, and no line of
 * user text is ever allowed to start at column zero -- continuation lines get
 * a `  | ` prefix, so hostile or accidental input ("build: fake",
 * "[another_synth bug report]", a whole pasted log) cannot forge or break the
 * report's structure.
 *
 * Channels are reported 1-based, matching what the UI shows the user
 * (scope labels, the tracker's own numbering), not the engine's 0-based
 * track index.
 */

/** A point in the song, anchored by playback position, not pattern number. */
export interface BugReportPosition {
  /** Sequence (order) index, 0-based. */
  order: number;
  /** Row within the pattern at that order. */
  row: number;
  /**
   * The pattern id at that order, when the position source provides one.
   * Ids are opaque internal strings, so they are carried for callers that
   * want them but never printed into the report.
   */
  patternId?: string;
}

export interface BugReportInstrument {
  /** Zero-padded slot id, e.g. "05". */
  id: string;
  /** Human name from the instrument slot, when one exists. */
  name?: string;
}

export interface BugReportSongIdentity {
  /** File name of the loaded module, e.g. "satellite_one.s3m". */
  name: string;
  /** Short format label, e.g. "S3M", "XM", "MOD". */
  formatLabel?: string;
  /** sha256 hex of the loaded module bytes; absent for native songs. */
  sha256?: string;
}

export interface BugReportInput {
  songIdentity: BugReportSongIdentity;
  /** Song title as the tracker shows it. */
  title?: string;
  /** Build identity, e.g. "v0.2.0 (000592a)". */
  build: string;
  startPosition: BugReportPosition;
  /** Second mark; without it the report is a single point. */
  endPosition?: BugReportPosition;
  /** 1-based channel numbers active in the captured range. */
  channels?: number[];
  /** The one instrument used in the captured range, when there is exactly one. */
  instrument?: BugReportInstrument;
  heard?: string;
  expected?: string;
}

const KEY_COLUMN = 11;

/** Collapse anything that could turn one field into two lines. */
function singleLine(text: string): string {
  return text
    .replace(/[\u2028\u2029\u0085\u000B\u000C]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** Emit `key:` padded to the shared value column, then the value. */
function field(key: string, value: string): string {
  return `${(`${key}:`).padEnd(KEY_COLUMN)}${value}`;
}

/**
 * User free text: the first line rides on the field line, every later line is
 * prefixed so it can never be mistaken for a field. Unicode line terminators
 * (U+0085, U+000B, U+000C, U+2028, U+2029) are normalized to \n first — some
 * paste targets render them as breaks, which would otherwise let a hostile
 * line visually forge an unprefixed field line.
 */
function freeTextField(key: string, text: string | undefined): string {
  const lines = (text ?? '')
    .replace(/[\u2028\u2029\u0085\u000B\u000C]/g, '\n')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const trimmed = lines.map((line) => line.trimEnd());
  while (trimmed.length > 1 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  const [first = '', ...rest] = trimmed;
  return [
    field(key, first),
    ...rest.map((line) => `  | ${line}`.trimEnd()),
  ].join('\n');
}

function positionText(position: BugReportPosition): string {
  return `order ${position.order} row ${position.row}`;
}

/**
 * Build the copy-pasteable report. The exact shape is part of the contract
 * with whatever pastes it: one field per line, keys first, free text last.
 */
export function buildBugReport(input: BugReportInput): string {
  const { songIdentity } = input;

  const lines: string[] = ['[another_synth bug report]'];

  if (songIdentity.sha256) {
    const parts = [
      songIdentity.formatLabel ? singleLine(songIdentity.formatLabel) : null,
      `sha256: ${songIdentity.sha256}`,
    ].filter((part): part is string => part !== null);
    lines.push(field('song', `${singleLine(songIdentity.name)}  (${parts.join(', ')})`));
  } else {
    lines.push(field('song', `${singleLine(songIdentity.name)} (native song, no file hash)`));
  }

  const title = singleLine(input.title ?? '');
  // A module with no title has nothing useful to say on the title line;
  // an empty `title: ""` is noise, so the line is left out entirely.
  if (title !== '') lines.push(field('title', `"${title}"`));
  lines.push(field('build', singleLine(input.build)));

  let lo = input.startPosition;
  let hi = input.endPosition;
  // Printed ascending, so the text agrees with the scanned channels and
  // instrument even when the marks were captured in reverse.
  if (hi && (lo.order > hi.order || (lo.order === hi.order && lo.row > hi.row))) {
    const swap = lo;
    lo = hi;
    hi = swap;
  }
  const position = hi
    ? `${positionText(lo)} -> ${positionText(hi)}`
    : positionText(input.startPosition);
  lines.push(field('position', position));

  if (input.channels && input.channels.length > 0) {
    lines.push(field('channels', [...input.channels].sort((a, b) => a - b).join(', ')));
  }

  if (input.instrument) {
    const name = input.instrument.name ? ` "${singleLine(input.instrument.name).replace(/"/g, "'")}"` : '';
    lines.push(field('instr', `${singleLine(input.instrument.id)}${name}`));
  }

  lines.push(freeTextField('heard', input.heard));
  lines.push(freeTextField('expected', input.expected));

  return `${lines.join('\n')}\n`;
}

/** sha256 of raw module bytes, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle is unavailable');
  }
  // A copy: the ArrayBuffer a caller hands over may be detached by later code.
  const copy = new Uint8Array(bytes);
  const digest = await subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The slice of tracker song shape the range scan needs. Structural only, so
 * this module stays free of the store and component types.
 */
export interface BugReportPatternData {
  id: string;
  rows: number;
  tracks: ReadonlyArray<{
    entries: ReadonlyArray<{ row: number; note?: string; instrument?: string }>;
  }>;
}

export interface BugReportRangeScan {
  /** 1-based channel numbers with any played note in the range. */
  channels: number[];
  /**
   * Instrument ids (zero-padded form) with notes in the range; only single
   * use becomes the report's instr line, more than one is left out.
   */
  instrumentIds: string[];
}

/**
 * Scan the patterns covered by a captured range for the channels and the
 * instrument that actually play there. A range is covered by whole patterns
 * from the start order through the end order (the start's rows before
 * start.row are part of the surrounding listen just the same), and a note
 * column that is empty ("---") counts as silence; a note-off ("###") does
 * not, it releases rather than sounds.
 */
export function scanRangeForReport(
  sequence: readonly string[],
  patterns: readonly BugReportPatternData[],
  startPosition: BugReportPosition,
  endPosition?: BugReportPosition,
): BugReportRangeScan {
  const endOrder = endPosition?.order ?? startPosition.order;
  const lo = Math.min(startPosition.order, endOrder);
  const hi = Math.max(startPosition.order, endOrder);
  const channels = new Set<number>();
  const instrumentIds = new Set<string>();

  for (let order = lo; order <= hi; order++) {
    const patternId = sequence[order];
    const pattern = patterns.find((candidate) => candidate.id === patternId);
    if (!pattern) continue;
    pattern.tracks.forEach((track, trackIndex) => {
      for (const entry of track.entries) {
        if (entry.row >= pattern.rows) continue;
        const note = entry.note?.trim() ?? '';
        if (note === '' || note === '---') continue;
        channels.add(trackIndex + 1);
        // Canonical zero-padded form, so "5" and "05" are one instrument.
        const instrument = entry.instrument?.trim() ?? '';
        if (instrument !== '') {
          instrumentIds.add(/^\d+$/.test(instrument)
            ? instrument.padStart(2, '0')
            : instrument);
        }
      }
    });
  }

  return {
    channels: [...channels].sort((a, b) => a - b),
    instrumentIds: [...instrumentIds],
  };
}
