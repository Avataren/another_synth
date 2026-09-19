import { describe, it, expect } from 'vitest';
import {
  INSTRUMENT_EDITOR_BY_FORMAT,
  INSTRUMENT_EDITOR_ROUTE,
  inferSlotTags,
  instrumentBadgeLabel,
  isSamplerInstrumentType,
  normalizeInstrumentType,
  resolveInstrumentEditor,
  resolveInstrumentEditorRoute,
} from 'src/audio/tracker/instrument-types';

describe('instrument type vocabulary', () => {
  it("reads the legacy 'mod' as 'sampler'", () => {
    expect(normalizeInstrumentType('mod')).toBe('sampler');
    expect(normalizeInstrumentType('sampler')).toBe('sampler');
    expect(normalizeInstrumentType('synth')).toBe('synth');
    expect(normalizeInstrumentType('ahx')).toBe('ahx');
    expect(normalizeInstrumentType('opl')).toBe('opl');
    expect(normalizeInstrumentType('bogus')).toBeUndefined();
    expect(normalizeInstrumentType(undefined)).toBeUndefined();
  });

  it("treats 'mod' and 'sampler' alike for playback keying", () => {
    expect(isSamplerInstrumentType('mod')).toBe(true);
    expect(isSamplerInstrumentType('sampler')).toBe(true);
    expect(isSamplerInstrumentType('synth')).toBe(false);
    expect(isSamplerInstrumentType(undefined)).toBe(false);
  });
});

describe('inferSlotTags', () => {
  it("maps a legacy 'mod' slot to the song's format", () => {
    const slot = { patchId: 'p', instrumentType: 'mod' as const };
    expect(inferSlotTags(slot, 'protracker')).toEqual({
      instrumentType: 'sampler',
      instrumentFormat: 'protracker',
    });
    // XM and S3M importers stamped 'mod' too, so it is not always MOD lineage.
    expect(inferSlotTags(slot, 'xm')).toEqual({
      instrumentType: 'sampler',
      instrumentFormat: 'xm',
    });
    expect(inferSlotTags(slot, 's3m')).toEqual({
      instrumentType: 'sampler',
      instrumentFormat: 's3m',
    });
  });

  it("falls back to protracker for a 'mod' slot in a native song", () => {
    expect(inferSlotTags({ patchId: 'p', instrumentType: 'mod' }, 'native')).toEqual({
      instrumentType: 'sampler',
      instrumentFormat: 'protracker',
    });
  });

  it('tags AdLib data as opl/s3m, whatever the stored type said', () => {
    expect(inferSlotTags({ instrumentType: 'mod', oplData: {} }, 's3m')).toEqual({
      instrumentType: 'opl',
      instrumentFormat: 's3m',
    });
  });

  it('tags a synth or untyped patch slot as synth/native', () => {
    const want = { instrumentType: 'synth', instrumentFormat: 'native' };
    expect(inferSlotTags({ patchId: 'p', instrumentType: 'synth' }, 'native')).toEqual(want);
    expect(inferSlotTags({ patchId: 'p' }, 'native')).toEqual(want);
    // A hand-picked synth patch in an imported song is still native lineage.
    expect(inferSlotTags({ patchId: 'p', instrumentType: 'synth' }, 'xm')).toEqual(want);
  });

  it('uses the patch type for an untyped slot and leaves empty slots alone', () => {
    expect(inferSlotTags({ patchId: 'p' }, 'native', 'mod')).toEqual({
      instrumentType: 'sampler',
      instrumentFormat: 'protracker',
    });
    expect(inferSlotTags({}, 'xm')).toEqual({});
  });

  it('keeps tags a v4 slot already has', () => {
    const slot = {
      patchId: 'p',
      instrumentType: 'sampler' as const,
      instrumentFormat: 'xm' as const,
    };
    expect(inferSlotTags(slot, 'protracker')).toEqual({
      instrumentType: 'sampler',
      instrumentFormat: 'xm',
    });
  });
});

describe('editor routing table', () => {
  it('routes by instrumentFormat', () => {
    expect(INSTRUMENT_EDITOR_BY_FORMAT).toEqual({
      native: 'synth-patch',
      protracker: 'sampler-patch',
      xm: 'sampler-patch',
      s3m: 'sampler-patch',
      ahx: 'ahx-display',
    });
  });

  it('resolves a slot to its editor', () => {
    expect(
      resolveInstrumentEditor({ patchId: 'p', instrumentType: 'synth', instrumentFormat: 'native' }),
    ).toBe('synth-patch');
    expect(
      resolveInstrumentEditor({ patchId: 'p', instrumentType: 'sampler', instrumentFormat: 'xm' }),
    ).toBe('sampler-patch');
    expect(
      resolveInstrumentEditor({ instrumentType: 'ahx', instrumentFormat: 'ahx' }),
    ).toBe('ahx-display');
    // Untagged patch slot: a plain synth patch.
    expect(resolveInstrumentEditor({ patchId: 'p' })).toBe('synth-patch');
    expect(resolveInstrumentEditor({})).toBeNull();
  });

  it('has no editor for an inactive OPL slot despite its s3m format', () => {
    expect(
      resolveInstrumentEditor({ instrumentType: 'opl', instrumentFormat: 's3m' }),
    ).toBeNull();
    expect(
      resolveInstrumentEditorRoute({ instrumentType: 'opl', instrumentFormat: 's3m' }),
    ).toBeNull();
  });

  it('maps every editor to a route (all the existing page for now)', () => {
    for (const editor of Object.values(INSTRUMENT_EDITOR_BY_FORMAT)) {
      expect(INSTRUMENT_EDITOR_ROUTE[editor]).toBe('patch-instrument-editor');
    }
    expect(
      resolveInstrumentEditorRoute({ patchId: 'p', instrumentType: 'sampler', instrumentFormat: 'xm' }),
    ).toBe('patch-instrument-editor');
  });
});

describe('instrumentBadgeLabel', () => {
  it('names the lineage of a module instrument', () => {
    const sampler = (instrumentFormat: 'protracker' | 'xm' | 's3m') => ({
      instrumentType: 'sampler' as const,
      instrumentFormat,
    });
    expect(instrumentBadgeLabel(sampler('protracker'))).toBe('MOD');
    expect(instrumentBadgeLabel(sampler('xm'))).toBe('XM');
    expect(instrumentBadgeLabel(sampler('s3m'))).toBe('S3M');
    expect(instrumentBadgeLabel({ instrumentType: 'opl', instrumentFormat: 's3m' })).toBe('OPL');
    expect(instrumentBadgeLabel({ instrumentType: 'synth', instrumentFormat: 'native' })).toBe('');
    expect(instrumentBadgeLabel({})).toBe('');
    expect(instrumentBadgeLabel({ instrumentType: 'mod' })).toBe('MOD');
  });
});
