/**
 * Copy text to the clipboard, with the legacy fallback for the contexts the
 * async Clipboard API does not reach (insecure origins, older browsers,
 * denied permission). Returns whether anything actually worked, so the
 * caller can say one honest thing instead of guessing.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied, failed, or unavailable: the legacy path still gets a say.
    }
  }
  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  // execCommand only copies from a selection, so the text rides through an
  // off-screen textarea. `readonly` keeps mobile keyboards from popping up.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  // select() alone is unreliable on iOS Safari; the explicit range pins
  // what gets copied there too.
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  // Whatever the user had selected is not ours to destroy.
  const selection = document.getSelection();
  const restore =
    selection && selection.rangeCount > 0
      ? selection.getRangeAt(0).cloneRange()
      : null;
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    if (restore && selection) {
      selection.removeAllRanges();
      selection.addRange(restore);
    }
  }
  return copied;
}
