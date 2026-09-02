/**
 * Theme extraction for the canvas pattern renderer.
 *
 * The DOM grid colors its cells through CSS custom properties
 * (`--tracker-entry-base`, `--tracker-entry-filled`, …, see
 * TrackerEntry.vue's scoped styles, TrackerPattern.vue's row-number /
 * playback-bar styles, and src/css/). The canvas has no cascade, so every
 * color the draw ops need is read here, once, via `getComputedStyle` and
 * cached.
 *
 * Cache invalidation mirrors TrackerSpectrumAnalyzer.vue / TrackWaveform.vue:
 * a `MutationObserver` on `document.documentElement` watching `style` and
 * `class` attributes (theme-store.ts writes its palette via
 * `root.style.setProperty`, so a theme flip always touches one of those) →
 * `refresh()`. The observer is opt-in for components (`startObserving()` /
 * `stopObserving()`); tests drive `refresh()` directly and can point
 * `resolveVars` at any element (or a stub) — `null` leaves the last cache
 * untouched, so jsdom runs never accidentally blank the palette.
 */

export interface PatternTheme {
  /** Empty entry background (`--tracker-entry-base`). */
  entryBase: string;
  /** Filled entry background (`--tracker-entry-filled`). */
  entryFilled: string;
  /** Row % 2 background (`--tracker-entry-row-sub`). */
  rowSub: string;
  /** Row % 4 background (`--tracker-entry-row-beat`). */
  rowBeat: string;
  /** Row % 16 background (`--tracker-entry-row-bar`). */
  rowBar: string;
  /** Entry border (`--tracker-border-default`). */
  borderDefault: string;
  /** Beat-row border (`--tracker-border-beat`). */
  borderBeat: string;
  /** Bar-row border (`--tracker-border-bar`). */
  borderBar: string;
  /** Selected-entry/row background (`--tracker-selected-bg`). */
  selectedBg: string;
  /** Selected border (`--tracker-selected-border`). */
  selectedBorder: string;
  /** Active (cursor) entry background (`--tracker-active-bg`). */
  activeBg: string;
  /** Active border fallback (`--tracker-active-border` → track accent). */
  activeBorder: string;
  /** Pattern-mode playback bar border (`--tracker-accent-primary`). */
  accentPrimary: string;
  /** Song-mode playback bar border (`--tracker-accent-secondary`). */
  accentSecondary: string;
  /** Note text (`--tracker-note-text`). */
  noteText: string;
  /** Instrument text (`--tracker-instrument-text`). */
  instrumentText: string;
  /** Volume text (`--tracker-volume-text`). */
  volumeText: string;
  /** Effect/macro text (`--tracker-effect-text`). */
  effectText: string;
  /** Default text (`--tracker-default-text`). */
  defaultText: string;
  /** Row-number text (`--text-muted`). */
  rowNumberText: string;
  /** Effect cell tinted for linear interpolation (`rgba(77,242,197,.08)`). */
  interpolatedLinear: string;
  /** Effect cell tinted for exponential interpolation (`rgba(158,197,255,.1)`). */
  interpolatedExponential: string;
  /** Pattern canvas backdrop (`--panel-background`). */
  panelBackground: string;
  /** Tracker font stack (`--font-tracker`). */
  fontTracker: string;
}

/**
 * Every CSS custom property the theme reads, with the fallback the DOM
 * stylesheets hard-code. Fallbacks come from TrackerEntry.vue,
 * TrackerPattern.vue and TrackerTrack.vue so a canvas drawn before any
 * stylesheet applies is still visually identical to the DOM grid.
 */
const VARS: Array<{ key: keyof PatternTheme; varName: string; fallback: string }> = [
  { key: 'entryBase', varName: '--tracker-entry-base', fallback: 'rgba(13, 18, 29, 0.85)' },
  { key: 'entryFilled', varName: '--tracker-entry-filled', fallback: 'rgba(21, 31, 48, 0.95)' },
  { key: 'rowSub', varName: '--tracker-entry-row-sub', fallback: 'rgba(13, 18, 29, 0.9)' },
  { key: 'rowBeat', varName: '--tracker-entry-row-beat', fallback: 'rgba(18, 24, 37, 0.95)' },
  { key: 'rowBar', varName: '--tracker-entry-row-bar', fallback: 'rgba(20, 28, 44, 0.98)' },
  { key: 'borderDefault', varName: '--tracker-border-default', fallback: 'rgba(255, 255, 255, 0.05)' },
  { key: 'borderBeat', varName: '--tracker-border-beat', fallback: 'rgba(255, 255, 255, 0.08)' },
  { key: 'borderBar', varName: '--tracker-border-bar', fallback: 'rgba(77, 242, 197, 0.35)' },
  { key: 'selectedBg', varName: '--tracker-selected-bg', fallback: 'rgba(77, 242, 197, 0.12)' },
  { key: 'selectedBorder', varName: '--tracker-selected-border', fallback: 'rgba(77, 242, 197, 0.9)' },
  { key: 'activeBg', varName: '--tracker-active-bg', fallback: 'rgba(77, 242, 197, 0.08)' },
  { key: 'activeBorder', varName: '--tracker-active-border', fallback: 'var(--tracker-accent, rgb(77, 242, 197))' },
  { key: 'accentPrimary', varName: '--tracker-accent-primary', fallback: 'rgb(77, 242, 197)' },
  { key: 'accentSecondary', varName: '--tracker-accent-secondary', fallback: 'rgb(88, 176, 255)' },
  { key: 'noteText', varName: '--tracker-note-text', fallback: '#ffffff' },
  { key: 'instrumentText', varName: '--tracker-instrument-text', fallback: 'rgba(255, 255, 255, 0.82)' },
  { key: 'volumeText', varName: '--tracker-volume-text', fallback: '#85b7ff' },
  { key: 'effectText', varName: '--tracker-effect-text', fallback: '#8ef5c5' },
  { key: 'defaultText', varName: '--tracker-default-text', fallback: '#d8e7ff' },
  { key: 'rowNumberText', varName: '--text-muted', fallback: '#a7bcd8' },
  { key: 'interpolatedLinear', varName: '--tracker-interpolated-linear', fallback: 'rgba(77, 242, 197, 0.08)' },
  { key: 'interpolatedExponential', varName: '--tracker-interpolated-exponential', fallback: 'rgba(158, 197, 255, 0.1)' },
  { key: 'panelBackground', varName: '--panel-background', fallback: '#0a0e16' },
  { key: 'fontTracker', varName: '--font-tracker', fallback: "'JetBrains Mono', monospace" },
];

let cache: PatternTheme | null = null;
let themeObserver: MutationObserver | null = null;

/**
 * Read one custom property off a computed style, trimmed, with the
 * stylesheet's own fallback when unset (jsdom returns '' for everything).
 */
function readVar(style: CSSStyleDeclaration, varName: string, fallback: string): string {
  const value = style.getPropertyValue(varName).trim();
  return value !== '' ? value : fallback;
}

/**
 * Extract the theme from `document.documentElement`. Accepts a custom
 * `element` (or a stand-in object with a `getPropertyValue` method) so tests
 * can inject values without a real cascade.
 */
export function resolveVars(
  element?: Element | { getPropertyValue: (name: string) => string },
): PatternTheme {
  const style =
    element && typeof (element as Element).getAttribute === 'function'
      ? getComputedStyle(element as Element)
      : ((element as { getPropertyValue?: unknown } | undefined)?.getPropertyValue
          ? (element as unknown as CSSStyleDeclaration)
          : getComputedStyle(document.documentElement));
  const result = {} as Record<keyof PatternTheme, string>;
  for (const { key, varName, fallback } of VARS) {
    result[key] = readVar(style, varName, fallback);
  }
  return result as unknown as PatternTheme;
}

/**
 * The cached theme, reading and caching on first call. In environments with
 * no DOM at all (plain node) this throws — tests inject via
 * `resolveVars`/`setCache` instead of calling into jsdom-less ground.
 */
export function getTheme(): PatternTheme {
  if (cache === null) {
    cache = resolveVars();
  }
  return cache;
}

/** Overwrite the cache (tests, or a component that resolved early). */
export function setCache(theme: PatternTheme | null): void {
  cache = theme;
}

/**
 * Re-read the CSS custom properties. Called by the MutationObserver on every
 * theme flip; returns the fresh theme so callers can redraw immediately.
 */
export function refresh(): PatternTheme {
  cache = resolveVars();
  return cache;
}

/**
 * Watch `document.documentElement`'s `style`/`class` attributes and refresh
 * the cache whenever the theme store rewrites the palette. Idempotent; the
 * hook is documented here so the component (step 3) wires `stopObserving()`
 * into its unmount.
 */
export function startObserving(): void {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => refresh());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
}

/** Drop the observer (component unmount / test teardown). */
export function stopObserving(): void {
  themeObserver?.disconnect();
  themeObserver = null;
}