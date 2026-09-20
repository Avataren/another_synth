/** How long the object URL lives after the click: the browser has to start reading it first. */
const REVOKE_DELAY_MS = 10_000;

/**
 * Hand `bytes` to the browser as a download named `filename`: a Blob behind an
 * object URL on an `a[download]` that is clicked while attached to the page.
 * The URL is revoked later, not at once (Firefox can still be reading it).
 */
export function downloadBytes(bytes: Uint8Array, filename: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
