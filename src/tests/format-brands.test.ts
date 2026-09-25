import { describe, expect, it } from 'vitest';
import { MODULE_FORMATS, type ModuleFormat } from '@another-synth/tracker-playback';
import {
  APP_NAME,
  FALLBACK_BRAND_ID,
  FORMAT_BRAND_IDS,
  FORMAT_BRANDS,
  brandIdForDemoLabel,
  brandIdForSong,
  formatBrandVars,
  modVariantLabel,
  type FormatBrandId,
} from 'src/branding/format-brands';
import { themePresets } from 'src/stores/theme-store';

/**
 * The format-branding registry (.ai/plan-format-branding.md): every format a
 * song can have is branded, HVL apart from AHX, and every palette is readable
 * on every built-in theme.
 */

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** The light ground the light palettes are drawn for (the app ships no light theme yet). */
const LIGHT_GROUND = '#f5f6f8';
const AA = 4.5;

describe('format brand registry', () => {
  it('names the app FerroTracker, and falls back to its own look', () => {
    expect(APP_NAME).toBe('FerroTracker');
    expect(FALLBACK_BRAND_ID).toBe('native');
    expect(FORMAT_BRANDS.native.name).toBe('FerroTracker');
  });

  it('has a complete entry for every brand id', () => {
    expect([...FORMAT_BRAND_IDS].sort()).toEqual(Object.keys(FORMAT_BRANDS).sort());
    for (const id of FORMAT_BRAND_IDS) {
      const brand = FORMAT_BRANDS[id];
      expect(brand.id).toBe(id);
      expect(brand.name.length).toBeGreaterThan(0);
      expect(brand.shortLabel).toMatch(/^[A-Z0-9]{2,6}$/);
      expect(brand.platform.length).toBeGreaterThan(0);
      for (const art of [brand.mark, brand.badge, brand.wordmark]) expect(art).toContain('<svg');
      for (const mode of ['dark', 'light'] as const) {
        for (const colour of Object.values(brand.palette[mode])) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('brands every module format the library knows', () => {
    for (const format of MODULE_FORMATS) {
      expect(FORMAT_BRAND_IDS).toContain(brandIdForSong(format, null));
    }
    const expected: Record<ModuleFormat, FormatBrandId> = {
      native: 'native',
      protracker: 'mod',
      xm: 'xm',
      s3m: 's3m',
      ahx: 'ahx',
      sid: 'goat',
    };
    for (const format of MODULE_FORMATS) expect(brandIdForSong(format, null)).toBe(expected[format]);
  });

  it('tells an HVL song from an AHX one by its variant', () => {
    expect(brandIdForSong('ahx', 'hvl')).toBe('hvl');
    expect(brandIdForSong('ahx', 'ahx')).toBe('ahx');
    expect(brandIdForSong('ahx', null)).toBe('ahx');
    // The variant means nothing for any other format.
    expect(brandIdForSong('xm', 'hvl')).toBe('xm');
  });

  it('falls back to the native look for a missing or unknown format', () => {
    expect(brandIdForSong(undefined, null)).toBe('native');
    expect(brandIdForSong(null, null)).toBe('native');
    expect(brandIdForSong('it' as ModuleFormat, null)).toBe('native');
  });

  it('brands demo index entries from their format label, both GoatTracker versions as one', () => {
    expect(brandIdForDemoLabel('MOD')).toBe('mod');
    expect(brandIdForDemoLabel('XM')).toBe('xm');
    expect(brandIdForDemoLabel('S3M')).toBe('s3m');
    expect(brandIdForDemoLabel('AHX')).toBe('ahx');
    expect(brandIdForDemoLabel('HVL')).toBe('hvl');
    expect(brandIdForDemoLabel('GT1')).toBe('goat');
    expect(brandIdForDemoLabel('GT2')).toBe('goat');
    expect(brandIdForDemoLabel('hvl')).toBe('hvl');
    expect(brandIdForDemoLabel('IT')).toBe('native');
    expect(brandIdForDemoLabel(undefined)).toBe('native');
  });

  it('names a MOD variant from what the parser found', () => {
    expect(modVariantLabel({ flavor: 'ProTracker', signature: 'M.K.' })).toBe('ProTracker · M.K.');
    expect(modVariantLabel({ flavor: 'ProTracker', signature: 'M!K!' })).toBe('ProTracker · M!K!');
    expect(modVariantLabel({ flavor: 'NoiseTracker', signature: 'N.T.' })).toBe('NoiseTracker · N.T.');
    expect(modVariantLabel({ flavor: 'Soundtracker', signature: '' })).toBe('SoundTracker · 15 samples');
    expect(modVariantLabel({ flavor: 'UltimateSoundtracker', signature: '' })).toBe('Ultimate SoundTracker');
    expect(modVariantLabel({ flavor: 'ProTracker', signature: 'FLT4' })).toBe('StarTrekker · FLT4');
    expect(modVariantLabel({ flavor: 'ProTracker', signature: '8CHN' })).toBe('PC MOD · 8CHN');
    expect(modVariantLabel({ flavor: 'ProTracker', signature: '16CH' })).toBe('PC MOD · 16CH');
    expect(modVariantLabel({ flavor: 'ProTracker', signature: '4CHN' })).toBe('PC MOD · 4CHN');
    expect(modVariantLabel({ flavor: 'ProTracker', signature: 'OKTA' })).toBe('8-channel MOD · OKTA');
    expect(modVariantLabel(null)).toBeNull();
    expect(modVariantLabel(undefined)).toBeNull();
    expect(modVariantLabel({ flavor: 'Unknown', signature: '' })).toBeNull();
  });

  it('keeps every dark accent at AA on every built-in theme, and its ink on it', () => {
    for (const id of FORMAT_BRAND_IDS) {
      const { accent, accentInk } = FORMAT_BRANDS[id].palette.dark;
      expect(contrast(accentInk, accent), `${id} ink`).toBeGreaterThanOrEqual(AA);
      for (const theme of themePresets) {
        expect(contrast(accent, theme.colors.appBackground), `${id} on ${theme.id}`).toBeGreaterThanOrEqual(AA);
        expect(contrast(accent, theme.colors.headerBackground), `${id} on ${theme.id} header`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('keeps every light accent at AA on the light ground, and its ink on it', () => {
    for (const id of FORMAT_BRAND_IDS) {
      const { accent, accentInk } = FORMAT_BRANDS[id].palette.light;
      expect(contrast(accent, LIGHT_GROUND), id).toBeGreaterThanOrEqual(AA);
      expect(contrast(accentInk, accent), `${id} ink`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('gives the CSS variables of a brand, and only format ones', () => {
    const vars = formatBrandVars('hvl');
    expect(Object.keys(vars).sort()).toEqual(['--format-accent', '--format-accent-alt', '--format-accent-ink']);
    expect(vars['--format-accent']).toBe(FORMAT_BRANDS.hvl.palette.dark.accent);
    expect(formatBrandVars('hvl', 'light')['--format-accent']).toBe(FORMAT_BRANDS.hvl.palette.light.accent);
  });
});

describe('format brand art', () => {
  const art = FORMAT_BRAND_IDS.flatMap((id) =>
    (['mark', 'badge', 'wordmark'] as const).map((kind) => ({ name: `${id} ${kind}`, source: FORMAT_BRANDS[id][kind] })),
  );

  it.each(art)('$name is valid SVG with a viewBox and a label', ({ source }) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const root = doc.documentElement;
    expect(root.nodeName).toBe('svg');
    expect(root.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(root.getAttribute('viewBox')).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
    expect(root.getAttribute('role')).toBe('img');
    expect(root.getAttribute('aria-label')?.length).toBeGreaterThan(0);
  });

  it.each(art)('$name has no external reference, script or id', ({ source }) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
      expect(['script', 'image', 'use', 'foreignObject', 'style', 'a']).not.toContain(el.nodeName);
      for (const attr of Array.from(el.attributes)) {
        // The namespace is a name, never fetched (its value is checked above).
        if (attr.name === 'xmlns') continue;
        // An id would collide when the same art is inlined twice on a page.
        expect(attr.name).not.toBe('id');
        expect(attr.name).not.toMatch(/^on/i);
        expect(attr.name).not.toMatch(/href$/i);
        expect(attr.value).not.toMatch(/url\(|https?:|data:|javascript:/i);
      }
    }
  });

  it('draws badge labels in currentColor, so one file serves every theme', () => {
    for (const id of FORMAT_BRAND_IDS) expect(FORMAT_BRANDS[id].badge, id).toContain('currentColor');
  });
});
