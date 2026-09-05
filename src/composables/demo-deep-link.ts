import type { DemoCollection, DemoSong } from './useDemoManifest';

/**
 * Demo-song deep links.
 *
 * A link points at the app's base document with the song named by its
 * manifest path in the query string — `https://host/synth/?demo=amiga/x.mod`
 * — which is the form a hash-mode router (this app's `vueRouterMode: 'hash'`)
 * keeps: the pathname is already the router base, so the initial navigation
 * only writes the `#/tracker` hash and the search string survives for the
 * tracker page to read. A path-style URL would be normalized away (or 404
 * on the static host). The `file` path is the one identity every surface
 * already agrees on: the demo browser keys its buttons by `file`, the
 * jukebox dedupes and pins entries by `file`, and neither survives a title
 * edit. The manifest itself is regenerated on every deploy, so an index
 * position or a title would rot; the relative path is as stable as the
 * published file it names.
 */

/** The query parameter a demo link carries its manifest path in. */
export const DEMO_LINK_QUERY_KEY = 'demo';

export interface DemoLinkUrlParts {
  origin?: string;
  /** The app's public path, e.g. "/synth/". Defaults to the build's base. */
  base?: string;
}

/** A shareable URL that loads the named demo song on open. */
export function buildDemoLink(
  file: string,
  parts: DemoLinkUrlParts = {},
): string {
  const origin = parts.origin ?? window.location.origin;
  const base = parts.base ?? import.meta.env.BASE_URL;
  const withTrailingSlash = base.endsWith('/') ? base : `${base}/`;
  const params = new URLSearchParams({ [DEMO_LINK_QUERY_KEY]: file });
  return `${origin}${withTrailingSlash}?${params.toString()}`;
}

/** The demo path a location search string carries, or null when absent. */
export function readDemoLinkParam(search: string): string | null {
  const value = new URLSearchParams(search).get(DEMO_LINK_QUERY_KEY);
  return value && value.length > 0 ? value : null;
}

/** The manifest entry a demo link names, or null when it is not published. */
export function findDemoSongByFile(
  collections: readonly DemoCollection[],
  file: string,
): DemoSong | null {
  for (const collection of collections) {
    for (const song of collection.songs) {
      if (song.file === file) return song;
    }
  }
  return null;
}
