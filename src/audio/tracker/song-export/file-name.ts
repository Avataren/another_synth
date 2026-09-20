const MAX_BASE_LENGTH = 64;

/**
 * The download's file name: the song title under the `.cmod` save's character
 * policy (anything but letters, digits, `-` and `_` becomes `_`), runs of `_`
 * collapsed and trimmed from both ends, at most 64 characters, `song` when
 * nothing is left. `extension` includes its dot.
 */
export function exportFileName(title: string, extension: string): string {
  const base = title
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/_+$/, '');
  return `${base || 'song'}${extension}`;
}
