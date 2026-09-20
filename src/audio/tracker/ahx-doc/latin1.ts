/**
 * `text` as the format can hold it: NUL removed, anything above U+00FF replaced
 * by `?`. (The exporter's own copy of this rule; `buildAhxFile` replaces the
 * exporter's overlay, so it is the one that stays.)
 */
export function toLatin1(text: string): { text: string; altered: boolean } {
  let out = '';
  let altered = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0) altered = true;
    else if (code > 0xff) {
      out += '?';
      altered = true;
    } else out += char;
  }
  return { text: out, altered };
}
