import type { ModuleFormat } from '@another-synth/tracker-playback';
import type { ModOrigin } from 'src/audio/tracker/mod-origin';
import nativeMark from 'src/assets/format-brands/native-mark.svg?raw';
import nativeBadge from 'src/assets/format-brands/native-badge.svg?raw';
import nativeWordmark from 'src/assets/format-brands/native-wordmark.svg?raw';
import modMark from 'src/assets/format-brands/mod-mark.svg?raw';
import modBadge from 'src/assets/format-brands/mod-badge.svg?raw';
import modWordmark from 'src/assets/format-brands/mod-wordmark.svg?raw';
import ahxMark from 'src/assets/format-brands/ahx-mark.svg?raw';
import ahxBadge from 'src/assets/format-brands/ahx-badge.svg?raw';
import ahxWordmark from 'src/assets/format-brands/ahx-wordmark.svg?raw';
import hvlMark from 'src/assets/format-brands/hvl-mark.svg?raw';
import hvlBadge from 'src/assets/format-brands/hvl-badge.svg?raw';
import hvlWordmark from 'src/assets/format-brands/hvl-wordmark.svg?raw';
import xmMark from 'src/assets/format-brands/xm-mark.svg?raw';
import xmBadge from 'src/assets/format-brands/xm-badge.svg?raw';
import xmWordmark from 'src/assets/format-brands/xm-wordmark.svg?raw';
import s3mMark from 'src/assets/format-brands/s3m-mark.svg?raw';
import s3mBadge from 'src/assets/format-brands/s3m-badge.svg?raw';
import s3mWordmark from 'src/assets/format-brands/s3m-wordmark.svg?raw';
import goatMark from 'src/assets/format-brands/goat-mark.svg?raw';
import goatBadge from 'src/assets/format-brands/goat-badge.svg?raw';
import goatWordmark from 'src/assets/format-brands/goat-wordmark.svg?raw';

/**
 * Per-format branding: the only place a format's look is decided
 * (.ai/plan-format-branding.md). The tracker, the jukebox and the demo browser
 * read a brand from here; nothing else picks a format's name, art or colours.
 *
 * The art is our own (scripts/generate-format-brand-art.mjs): period tributes
 * to Amiga, PC DOS and C64 trackers, never their real logos.
 *
 * The palettes only colour chrome (badges, bands, labels). The pattern grid
 * stays on the user's theme, so pattern text contrast is the theme's.
 */

/** The tracker's own name, carried by the native brand. */
export const APP_NAME = 'FerroTracker';

export type FormatBrandId = 'native' | 'mod' | 'xm' | 's3m' | 'ahx' | 'hvl' | 'goat';

export const FORMAT_BRAND_IDS: readonly FormatBrandId[] = ['native', 'mod', 'xm', 's3m', 'ahx', 'hvl', 'goat'];

/** The look for a song whose format is missing or unknown: the app's own. */
export const FALLBACK_BRAND_ID: FormatBrandId = 'native';

export interface FormatPalette {
  /** Labels, bands and badge fills: at least 4.5:1 on the ground. */
  accent: string;
  /** Text drawn on the accent: at least 4.5:1 on it. */
  accentInk: string;
  /** A second colour for art and borders; never text. */
  accentAlt: string;
}

export type FormatThemeMode = 'dark' | 'light';

export interface FormatBrand {
  id: FormatBrandId;
  /** 'Amiga MOD' */
  name: string;
  /** 'MOD': what the badge says. */
  shortLabel: string;
  /** Where the format comes from, for tooltips. */
  platform: string;
  /** 48x48 tile with its own ground (SVG source). */
  mark: string;
  /** The badge's lettering, in `currentColor` (SVG source). */
  badge: string;
  /** Large lettering in `currentColor`, with the era's effects (SVG source). */
  wordmark: string;
  /**
   * Dark is what the app shows (it has no light theme yet); light is drawn for
   * a future light mode and the .prg demo (plan-sid-authoring.md phase 6).
   */
  palette: Record<FormatThemeMode, FormatPalette>;
}

export const FORMAT_BRANDS: Readonly<Record<FormatBrandId, FormatBrand>> = {
  native: {
    id: 'native',
    name: APP_NAME,
    shortLabel: 'FERRO',
    platform: `${APP_NAME} native song`,
    mark: nativeMark,
    badge: nativeBadge,
    wordmark: nativeWordmark,
    palette: {
      dark: { accent: '#b8f35a', accentInk: '#0b0f14', accentAlt: '#b5653a' },
      light: { accent: '#4d7809', accentInk: '#ffffff', accentAlt: '#b5653a' },
    },
  },
  mod: {
    id: 'mod',
    name: 'Amiga MOD',
    shortLabel: 'MOD',
    platform: 'Amiga: ProTracker, NoiseTracker, SoundTracker; PC trackers',
    mark: modMark,
    badge: modBadge,
    wordmark: modWordmark,
    palette: {
      dark: { accent: '#ff7a2e', accentInk: '#0b0f14', accentAlt: '#1f5fb8' },
      light: { accent: '#c24700', accentInk: '#ffffff', accentAlt: '#1f5fb8' },
    },
  },
  xm: {
    id: 'xm',
    name: 'FastTracker 2 XM',
    shortLabel: 'XM',
    platform: 'PC DOS',
    mark: xmMark,
    badge: xmBadge,
    wordmark: xmWordmark,
    palette: {
      dark: { accent: '#ffe14d', accentInk: '#0b0f14', accentAlt: '#2a3150' },
      light: { accent: '#806a00', accentInk: '#ffffff', accentAlt: '#2a3150' },
    },
  },
  s3m: {
    id: 's3m',
    name: 'Scream Tracker 3 S3M',
    shortLabel: 'S3M',
    platform: 'PC DOS',
    mark: s3mMark,
    badge: s3mBadge,
    wordmark: s3mWordmark,
    palette: {
      dark: { accent: '#55e6ff', accentInk: '#0b0f14', accentAlt: '#ff5fd7' },
      light: { accent: '#00788d', accentInk: '#ffffff', accentAlt: '#ff5fd7' },
    },
  },
  ahx: {
    id: 'ahx',
    name: 'AHX',
    shortLabel: 'AHX',
    platform: 'Amiga',
    mark: ahxMark,
    badge: ahxBadge,
    wordmark: ahxWordmark,
    palette: {
      dark: { accent: '#ff5f87', accentInk: '#0b0f14', accentAlt: '#c2366f' },
      light: { accent: '#de0038', accentInk: '#ffffff', accentAlt: '#c2366f' },
    },
  },
  hvl: {
    id: 'hvl',
    name: 'HivelyTracker HVL',
    shortLabel: 'HVL',
    platform: 'Amiga lineage',
    mark: hvlMark,
    badge: hvlBadge,
    wordmark: hvlWordmark,
    palette: {
      dark: { accent: '#4fe0b0', accentInk: '#0b0f14', accentAlt: '#062a24' },
      light: { accent: '#167b5a', accentInk: '#ffffff', accentAlt: '#062a24' },
    },
  },
  goat: {
    id: 'goat',
    name: 'GoatTracker (C64 SID)',
    shortLabel: 'SID',
    platform: 'Commodore 64',
    mark: goatMark,
    badge: goatBadge,
    wordmark: goatWordmark,
    palette: {
      dark: { accent: '#a59bff', accentInk: '#0b0f14', accentAlt: '#8a7fff' },
      light: { accent: '#604eff', accentInk: '#ffffff', accentAlt: '#8a7fff' },
    },
  },
};

export function formatBrand(id: FormatBrandId): FormatBrand {
  return FORMAT_BRANDS[id] ?? FORMAT_BRANDS[FALLBACK_BRAND_ID];
}

/**
 * The brand of a song. An AHX song is HVL when its variant says so (the doc's
 * `format`, else the source header's: see `useActiveFormatBrand`). The switch
 * is exhaustive: a new `ModuleFormat` fails to compile until it is branded.
 * A value outside the union (an old or foreign file) gets the fallback.
 */
export function brandIdForSong(
  format: ModuleFormat | null | undefined,
  ahxVariant: 'ahx' | 'hvl' | null | undefined,
): FormatBrandId {
  if (format === null || format === undefined) return FALLBACK_BRAND_ID;
  switch (format) {
    case 'native':
      return 'native';
    case 'protracker':
      return 'mod';
    case 'xm':
      return 'xm';
    case 's3m':
      return 's3m';
    case 'ahx':
      return ahxVariant === 'hvl' ? 'hvl' : 'ahx';
    case 'sid':
      return 'goat';
    default: {
      const unbranded: never = format;
      void unbranded;
      return FALLBACK_BRAND_ID;
    }
  }
}

const DEMO_LABEL_BRANDS: Readonly<Record<string, FormatBrandId>> = {
  MOD: 'mod',
  XM: 'xm',
  S3M: 's3m',
  AHX: 'ahx',
  HVL: 'hvl',
  GT1: 'goat',
  GT2: 'goat',
  // A C64 .sid opens as the GoatTracker song it is transcribed into.
  PSID: 'goat',
  RSID: 'goat',
};

/** The brand of a demo index entry, from its `format` label (MOD, XM, S3M, AHX, HVL, GT1, GT2, PSID, RSID). */
export function brandIdForDemoLabel(label: string | null | undefined): FormatBrandId {
  return DEMO_LABEL_BRANDS[(label ?? '').toUpperCase()] ?? FALLBACK_BRAND_ID;
}

const PROTRACKER_SIGNATURES = new Set(['M.K.', 'M!K!', 'M&K!']);
const EIGHT_CHANNEL_SIGNATURES = new Set(['CD81', 'OKTA', 'OCTA']);
/** `<n>CHN`, `<nn>CH`/`<nn>CN` and TakeTracker's `TDZ<n>`: written by a PC tracker. */
const PC_SIGNATURE = /^(\dCHN|\d\dC[HN]|TDZ\d)$/;

/**
 * Which kind of `.mod` a song is, for the MOD brand's sub-label: null when the
 * song does not say (saved before this was kept, or an unknown layout). A
 * four-channel `M.K.` file saved by OpenMPT cannot be told from a ProTracker
 * one, so it reads as ProTracker.
 */
export function modVariantLabel(origin: ModOrigin | null | undefined): string | null {
  if (!origin) return null;
  const { flavor, signature } = origin;
  switch (flavor) {
    case 'Soundtracker':
      return 'SoundTracker · 15 samples';
    case 'UltimateSoundtracker':
      return 'Ultimate SoundTracker';
    case 'NoiseTracker':
      return `NoiseTracker · ${signature || 'N.T.'}`;
    case 'ProTracker':
      if (PROTRACKER_SIGNATURES.has(signature)) return `ProTracker · ${signature}`;
      if (signature === 'FLT4') return 'StarTrekker · FLT4';
      if (EIGHT_CHANNEL_SIGNATURES.has(signature)) return `8-channel MOD · ${signature}`;
      if (PC_SIGNATURE.test(signature)) return `PC MOD · ${signature}`;
      return 'ProTracker';
    default:
      return null;
  }
}

export type FormatBrandVar = '--format-accent' | '--format-accent-ink' | '--format-accent-alt';

/** A brand's CSS variables: for the root (`applyFormatBrand`) or scoped inline on one element. */
export function formatBrandVars(id: FormatBrandId, mode: FormatThemeMode = 'dark'): Record<FormatBrandVar, string> {
  const palette = formatBrand(id).palette[mode];
  return {
    '--format-accent': palette.accent,
    '--format-accent-ink': palette.accentInk,
    '--format-accent-alt': palette.accentAlt,
  };
}
