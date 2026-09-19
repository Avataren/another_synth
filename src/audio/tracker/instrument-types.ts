/**
 * The two orthogonal tags every filled instrument slot carries (Task 10).
 *
 * `instrumentType` is the RENDERING path -- which engine plays the slot.
 * `instrumentFormat` is the DATA LINEAGE -- which format's data model the
 * slot's payload follows, and therefore which editor opens it and which
 * exporter can write it back out. The two vary independently: an S3M
 * import produces `sampler`/`s3m` for a PCM instrument and `opl`/`s3m` for an
 * AdLib one; a hand-built patch is `synth`/`native`.
 *
 * Playback keys on `instrumentType` only. `instrumentFormat` is never read on
 * the audio path.
 */
import type { ModuleFormat } from '@another-synth/tracker-playback';

export type InstrumentType = 'synth' | 'sampler' | 'ahx' | 'opl';

/** Same value set as `ModuleFormat`. */
export type InstrumentFormat = ModuleFormat;

/**
 * What a saved song or patch may still hold: `'mod'` is the pre-Task-10 name
 * for `'sampler'`. It is accepted on read and rewritten by
 * `normalizeInstrumentType`; nothing writes it any more.
 */
export type LegacyInstrumentType = InstrumentType | 'mod';

const INSTRUMENT_TYPES: readonly InstrumentType[] = ['synth', 'sampler', 'ahx', 'opl'];
const INSTRUMENT_FORMATS: readonly InstrumentFormat[] = [
  'native',
  'protracker',
  'xm',
  's3m',
  'ahx',
];

export interface InstrumentTags {
  instrumentType?: InstrumentType | undefined;
  instrumentFormat?: InstrumentFormat | undefined;
}

/** The slice of a slot the tag logic reads. */
export interface TaggableSlot {
  patchId?: string | undefined;
  instrumentType?: LegacyInstrumentType | undefined;
  instrumentFormat?: InstrumentFormat | undefined;
  oplData?: unknown;
}

/** Map any stored type value onto the current vocabulary; unknown -> undefined. */
export function normalizeInstrumentType(raw: unknown): InstrumentType | undefined {
  if (raw === 'mod') return 'sampler';
  return INSTRUMENT_TYPES.includes(raw as InstrumentType)
    ? (raw as InstrumentType)
    : undefined;
}

export function normalizeInstrumentFormat(raw: unknown): InstrumentFormat | undefined {
  return INSTRUMENT_FORMATS.includes(raw as InstrumentFormat)
    ? (raw as InstrumentFormat)
    : undefined;
}

/** True for `'sampler'` and its legacy alias `'mod'`. */
export function isSamplerInstrumentType(raw: unknown): boolean {
  return normalizeInstrumentType(raw) === 'sampler';
}

/**
 * Tags for a slot read from an older song or session.
 *
 * Already-tagged slots keep what they have. An untagged one is inferred:
 *   - `oplData`         -> opl / s3m (only S3M AdLib instruments carry it)
 *   - legacy `'mod'`    -> sampler / the song's format. Until Task 10 the MOD,
 *                          XM and S3M importers ALL stamped `'mod'`, so the
 *                          lineage is the song's `moduleFormat`; only a
 *                          `'native'` song (which cannot have imported
 *                          anything) falls back to protracker.
 *   - a patch, no type  -> synth / native
 *   - empty slot        -> untagged: there is no instrument to describe.
 *
 * `patchType` is the referenced patch's own `metadata.instrumentType`, when
 * known; a sampler patch in a slot without a tag is still a sampler.
 */
export function inferSlotTags(
  slot: TaggableSlot,
  moduleFormat: ModuleFormat,
  patchType?: unknown,
): InstrumentTags {
  const type = normalizeInstrumentType(slot.instrumentType);
  const format = normalizeInstrumentFormat(slot.instrumentFormat);
  if (type && format) return { instrumentType: type, instrumentFormat: format };

  // Only S3M AdLib instruments carry `oplData`, and the old importer stamped
  // them 'mod' along with everything else -- so the payload wins over the type.
  if (slot.oplData) {
    return { instrumentType: 'opl', instrumentFormat: format ?? 's3m' };
  }

  const resolvedType =
    type ?? (slot.patchId ? normalizeInstrumentType(patchType) ?? 'synth' : undefined);
  if (!resolvedType) return {};

  if (format) return { instrumentType: resolvedType, instrumentFormat: format };

  if (resolvedType === 'sampler') {
    // Legacy 'mod' slots always came from an importer.
    const legacyLineage = slot.instrumentType === 'mod' || patchType === 'mod';
    const lineage: InstrumentFormat =
      moduleFormat !== 'native' && moduleFormat !== 'ahx'
        ? moduleFormat
        : legacyLineage
          ? 'protracker'
          : 'native';
    return { instrumentType: 'sampler', instrumentFormat: lineage };
  }
  if (resolvedType === 'ahx') {
    return { instrumentType: 'ahx', instrumentFormat: 'ahx' };
  }
  return { instrumentType: resolvedType, instrumentFormat: 'native' };
}

// ---------------------------------------------------------------------------
// Editor routing
// ---------------------------------------------------------------------------

/**
 * Which editor owns an instrument's data model.
 *
 *   'synth-patch'   the full synth patch editor (native patches)
 *   'sampler-patch' the sampler view of that page, for module-imported PCM
 *                   instruments (MOD / XM / S3M); today it is the same page
 *                   with the synth-only sections hidden
 *   'ahx-display'   the read-only AHX/HVL instrument display. Task 5 builds
 *                   the real editor behind this id; until then AHX songs carry
 *                   no editable slots, so nothing can open it.
 */
export type InstrumentEditorId = 'synth-patch' | 'sampler-patch' | 'ahx-display';

/** Editor by `instrumentFormat`: the format decides whose data model it is. */
export const INSTRUMENT_EDITOR_BY_FORMAT: Readonly<Record<InstrumentFormat, InstrumentEditorId>> = {
  native: 'synth-patch',
  protracker: 'sampler-patch',
  xm: 'sampler-patch',
  s3m: 'sampler-patch',
  ahx: 'ahx-display',
};

/**
 * Router route per editor. Every editor still resolves to the one existing
 * page; a dedicated route per editor lands with each editor.
 */
export const INSTRUMENT_EDITOR_ROUTE: Readonly<Record<InstrumentEditorId, string>> = {
  'synth-patch': 'patch-instrument-editor',
  'sampler-patch': 'patch-instrument-editor',
  'ahx-display': 'patch-instrument-editor',
};

/**
 * The editor that opens for a slot, or null when there is none.
 *
 * Keyed on `instrumentFormat`, with one refinement: `instrumentType: 'opl'`
 * has no editor at all (inactive, no playback path), even though its format
 * (s3m) otherwise routes to the sampler editor. An untagged slot with a patch
 * is a plain synth patch.
 */
export function resolveInstrumentEditor(slot: TaggableSlot): InstrumentEditorId | null {
  if (normalizeInstrumentType(slot.instrumentType) === 'opl') return null;
  const format = normalizeInstrumentFormat(slot.instrumentFormat);
  if (format) return INSTRUMENT_EDITOR_BY_FORMAT[format];
  return slot.patchId ? 'synth-patch' : null;
}

/** Router route name for a slot's editor, or null. */
export function resolveInstrumentEditorRoute(slot: TaggableSlot): string | null {
  const editor = resolveInstrumentEditor(slot);
  return editor ? INSTRUMENT_EDITOR_ROUTE[editor] : null;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const FORMAT_BADGE: Readonly<Record<InstrumentFormat, string>> = {
  native: '',
  protracker: 'MOD',
  xm: 'XM',
  s3m: 'S3M',
  ahx: 'AHX',
};

/** Short list badge: the lineage for a module instrument, 'OPL' for AdLib, '' for native. */
export function instrumentBadgeLabel(slot: TaggableSlot): string {
  if (normalizeInstrumentType(slot.instrumentType) === 'opl') return 'OPL';
  const format = normalizeInstrumentFormat(slot.instrumentFormat);
  if (format) return FORMAT_BADGE[format];
  return isSamplerInstrumentType(slot.instrumentType) ? 'MOD' : '';
}
