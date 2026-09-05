/**
 * What the *device* can afford, as opposed to what the window looks like.
 *
 * `useMobileLayout` deliberately follows the viewport -- narrow a desktop
 * browser and it reports mobile -- which is right for layout and wrong for
 * every decision here. These are audio-engine settings that are read once,
 * at context construction or at sample load, and a desktop user who happened
 * to start with a narrow window must not be stuck with a phone's audio path.
 *
 * The signal is the same one `preferredLatencyHint` uses: a coarse pointer
 * with no hover is the device itself. Phones and tablets match; a touchscreen
 * laptop does not, because it also has a mouse. Unknown (jsdom, SSR) means
 * desktop, so tests and the dev server get the settings the app has always
 * used.
 */

/** Whether this is a phone or tablet rather than a desktop machine. */
export function isTouchAudioDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(pointer: coarse) and (hover: none)').matches;
  } catch {
    return false;
  }
}

/**
 * The rate the audio engine should ask for when the user has not chosen one.
 *
 * 96 kHz buys headroom above the audible band, so what does alias lands
 * further out of the way. It also doubles the cost of every node in the
 * graph -- every buffer read, every filter, the whole mix -- and then adds an
 * output resample, because no phone runs its hardware at 96 kHz. Handheld
 * devices run at 48 kHz, which is what their hardware is at, so the graph
 * costs half as much and the resampler drops out of the path entirely.
 */
export function defaultAudioSampleRate(): number {
  return isTouchAudioDevice() ? 48000 : 96000;
}

/**
 * Oversampling applied to every tracker sample at load, by default.
 *
 * Oversampling trades memory and audio-thread read bandwidth for a cleaner
 * interpolator: at 4x, every sample is held as four times as many float
 * frames and every voice reads four source frames per output frame. The
 * anti-alias mip stack keeps its own copies of that, so the resident cost is
 * roughly 64 bytes of AudioBuffer per byte of 8-bit sample data -- tens of
 * megabytes for an ordinary module, and 467 MB for the largest in the demo
 * corpus.
 *
 * A phone pays that twice over: the memory itself, and 32 voices streaming
 * through buffers far too large for its caches, on the render thread, where
 * missing the deadline is an audible dropout. 1 disables it there.
 */
export function defaultSampleOversampleFactor(): number {
  return isTouchAudioDevice() ? 1 : 4;
}

/**
 * How far ahead of the audio clock the playback engine queues rows.
 *
 * The scheduling loop runs on the main thread, so the window has to cover the
 * longest task that can get between two of its wake-ups. On a desktop half a
 * second is ample. A phone renders the same UI on a slower thread and is far
 * more likely to lose a frame budget to layout, GC or a scroll, and every
 * overrun there is a row scheduled late -- heard as a stutter. A wider window
 * costs nothing but automation events queued slightly earlier.
 */
export function defaultLookaheadSeconds(): number {
  return isTouchAudioDevice() ? 1.5 : 0.5;
}
