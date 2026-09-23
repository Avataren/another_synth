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
  'sid',
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
  ahxData?: unknown;
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
 * known. Where an untagged slot's own type and its patch's disagree (a pre-v4
 * `'mod'` slot whose patch was since replaced by a synth patch), the patch
 * wins: it is what actually plays, and `assignPatchToSlot` never rewrote the
 * old slot type. Fully tagged (v4) slots are trusted as they are.
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

  const patchResolved = slot.patchId ? normalizeInstrumentType(patchType) : undefined;
  const resolvedType =
    patchResolved ?? type ?? (slot.patchId ? 'synth' : undefined);
  if (!resolvedType) return {};

  if (format) return { instrumentType: resolvedType, instrumentFormat: format };

  if (resolvedType === 'sampler') {
    // Legacy 'mod' slots always came from an importer.
    const legacyLineage = slot.instrumentType === 'mod' || patchType === 'mod';
    const lineage: InstrumentFormat =
      moduleFormat !== 'native' && moduleFormat !== 'ahx' && moduleFormat !== 'sid'
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
 *   'ahx-display'   the read-only AHX instrument display (waveforms,
 *                   envelope, PList) on its own page. Task 5 builds the real
 *                   editor behind this id. It never shares a page with the
 *                   synth patch editor: an AHX instrument is not a `Patch`.
 *   'sid-editor'    the SID instrument editor (plan-sid-tracking.md S4): the
 *                   song doc's instrument (`SidDoc.instruments`), its own page,
 *                   for the same reason.
 */
export type InstrumentEditorId = 'synth-patch' | 'sampler-patch' | 'ahx-display' | 'sid-editor';

/**
 * Editor by `instrumentFormat`: the format decides whose data model it is.
 * A SID instrument opens the SID editor (S4), which edits the song's doc.
 */
export const INSTRUMENT_EDITOR_BY_FORMAT: Readonly<Record<InstrumentFormat, InstrumentEditorId | null>> = {
  native: 'synth-patch',
  protracker: 'sampler-patch',
  xm: 'sampler-patch',
  s3m: 'sampler-patch',
  ahx: 'ahx-display',
  sid: 'sid-editor',
};

/**
 * Router route per editor. The synth and sampler editors are still the one
 * existing page; the AHX display has its own, since it edits no `Patch`. A
 * dedicated route per editor lands with each editor.
 */
export const INSTRUMENT_EDITOR_ROUTE: Readonly<Record<InstrumentEditorId, string>> = {
  'synth-patch': 'patch-instrument-editor',
  'sampler-patch': 'patch-instrument-editor',
  'ahx-display': 'ahx-instrument-display',
  'sid-editor': 'sid-instrument-editor',
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

/**
 * True when the slot holds an instrument the Edit button can open: a patch
 * for the patch editors, the preserved AHX instrument for the AHX display
 * (an AHX slot has no patch by design).
 */
export function canEditSlot(slot: TaggableSlot): boolean {
  const editor = resolveInstrumentEditor(slot);
  if (!editor) return false;
  // A SID slot is tagged only for an instrument the song's doc holds (`showSidDoc`).
  if (editor === 'sid-editor') return true;
  return editor === 'ahx-display' ? !!slot.ahxData : !!slot.patchId;
}

/** True for an AHX-imported slot: it lists an instrument but has no patch. */
export function isAhxSlot(slot: TaggableSlot): boolean {
  return normalizeInstrumentType(slot.instrumentType) === 'ahx';
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
  sid: 'SID',
};

/** Short list badge: the lineage for a module instrument, 'OPL' for AdLib, '' for native. */
export function instrumentBadgeLabel(slot: TaggableSlot): string {
  if (normalizeInstrumentType(slot.instrumentType) === 'opl') return 'OPL';
  const format = normalizeInstrumentFormat(slot.instrumentFormat);
  if (format) return FORMAT_BADGE[format];
  return isSamplerInstrumentType(slot.instrumentType) ? 'MOD' : '';
}
