import { describe, expect, it } from 'vitest';
import { monospaceFonts, resolveFont, uiFonts } from 'src/stores/theme-store';
import {
  PREVIEW_CURSOR,
  PREVIEW_LAYOUT,
  PREVIEW_PLAYBACK_ROW,
  PREVIEW_TRACKS,
} from 'src/components/settings/tracker-font-preview-data';

describe('font picker lists', () => {
  it.each([
    ['tracker', monospaceFonts],
    ['interface', uiFonts],
  ])('offers exactly six %s fonts, each with a unique id and a style', (_name, fonts) => {
    expect(fonts).toHaveLength(6);
    expect(new Set(fonts.map((f) => f.id)).size).toBe(6);
    for (const font of fonts) {
      expect(font.style.length).toBeGreaterThan(0);
      expect(font.googleFont.length).toBeGreaterThan(0);
    }
  });

  it('keeps the shipped defaults first', () => {
    expect(monospaceFonts[0]!.id).toBe('JetBrains Mono');
    expect(uiFonts[0]!.id).toBe('Inter');
  });
});

describe('resolveFont', () => {
  it('returns the font a saved id names', () => {
    expect(resolveFont(monospaceFonts, 'Space Mono').id).toBe('Space Mono');
  });

  it('falls back to the default for a font that was dropped from the list', () => {
    expect(resolveFont(monospaceFonts, 'Fira Code').id).toBe('JetBrains Mono');
    expect(resolveFont(uiFonts, 'Poppins').id).toBe('Inter');
  });
});

describe('tracker font preview sample', () => {
  it('keeps every entry, the playback row and the cursor inside the pattern', () => {
    const { rowCount, trackCount } = PREVIEW_LAYOUT;
    expect(PREVIEW_TRACKS).toHaveLength(trackCount);
    for (const track of PREVIEW_TRACKS) {
      for (const entry of track.entries) {
        expect(entry.row).toBeGreaterThanOrEqual(0);
        expect(entry.row).toBeLessThan(rowCount);
      }
    }
    expect(PREVIEW_PLAYBACK_ROW).toBeLessThan(rowCount);
    expect(PREVIEW_CURSOR.row).toBeLessThan(rowCount);
    expect(PREVIEW_CURSOR.trackIndex).toBeLessThan(trackCount);
  });
});
