import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue';
import { isTextEntryTarget, TRACKER_NOTE_KEY_MAP } from 'src/composables/keyboard/note-key-map';
import {
  MidiInput,
  type MidiInputStatus,
  type RequestMidiAccess,
} from 'src/audio/midi-input';

/** The tracker's default base octave: the note map is written for it. */
export const AHX_DEFAULT_OCTAVE = 4;
export const AHX_MIN_OCTAVE = 0;
export const AHX_MAX_OCTAVE = 8;
/** What the keyboard and the on-screen keys strike with (the tracker's preview velocity). */
export const AHX_KEY_VELOCITY = 100;

export interface AhxPlaySink {
  /** Strike `midi` on instrument `slot`. */
  noteOn(slot: number, midi: number, velocity: number): void;
  noteOff(midi: number): void;
}

export interface AhxPlayInputOptions {
  /** The instrument (1-based slot) being edited. */
  slot: Ref<number | null>;
  /** Whether there is anything to play it with: without the song's source bytes nothing can sound. */
  audible: Ref<boolean>;
  sink: AhxPlaySink;
  /** Stand-in for `navigator.requestMIDIAccess`, for tests. */
  requestMidi?: RequestMidiAccess;
  /** Start listening for MIDI as soon as the page is up (the user's "Enable MIDI input" setting). */
  autoMidi?: Ref<boolean> | boolean;
}

interface Holding {
  /** Who is holding the note down: `kbd:KeyQ`, `ptr:60`, `midi`, `latch`. */
  sources: Set<string>;
  velocity: number;
}

const clampMidi = (n: number): number => Math.max(0, Math.min(127, Math.round(n)));

/**
 * Playing the edited AHX instrument by hand: the computer keyboard, MIDI and
 * the on-screen keys all end here, and from here in the preview voice.
 *
 * One model for all three so they agree: a note is held by a set of sources
 * (Q and , are both C-4; a key and a MIDI note can overlap), sounds while any
 * holds it and is released with the last. With Latch on a press toggles the
 * note instead and a release is ignored. The preview voice is monophonic, last
 * key wins, so letting go of the sounding key while an earlier one is still
 * down strikes that one again, so what is held is what is heard.
 */
export function useAhxPlayInput(options: AhxPlayInputOptions) {
  const { slot, audible, sink } = options;
  const holdings = new Map<number, Holding>();
  /** `holdings`' keys, visible to a template. */
  const heldKeys = reactive(new Set<number>());
  /** The key sounding now: only its release needs a note-off. */
  let sounding: number | null = null;
  /** The note each physical key struck, so its release lets go of that one whatever the octave is by then. */
  const keyNotes = new Map<string, number>();

  const latch = ref(false);
  const octave = ref(AHX_DEFAULT_OCTAVE);
  const transpose = computed(() => (octave.value - AHX_DEFAULT_OCTAVE) * 12);
  const midiStatus = ref<MidiInputStatus>({ state: 'idle', devices: [] });

  function strike(midi: number, velocity: number): void {
    if (slot.value === null) return;
    sounding = midi;
    sink.noteOn(slot.value, midi, velocity);
  }

  function silence(midi: number): void {
    holdings.delete(midi);
    heldKeys.delete(midi);
    sink.noteOff(midi);
    if (sounding !== midi) return;
    sounding = null;
    // Mono, last key wins: fall back to the newest key still down.
    const last = [...holdings.entries()].pop();
    if (last) strike(last[0], last[1].velocity);
  }

  function hold(midi: number, velocity: number, source: string): void {
    const existing = holdings.get(midi);
    if (existing) {
      existing.sources.add(source);
      return;
    }
    holdings.set(midi, { sources: new Set([source]), velocity });
    heldKeys.add(midi);
    strike(midi, velocity);
  }

  /** A key goes down (any source). With Latch it toggles the note instead. */
  function press(midi: number, velocity: number, source: string): void {
    if (!audible.value || slot.value === null) return;
    if (latch.value) {
      if (holdings.has(midi)) {
        silence(midi);
        return;
      }
      // One voice sounds at a time: latching a key lets go of the last one.
      dropAll();
      hold(midi, velocity, 'latch');
      return;
    }
    hold(midi, velocity, source);
  }

  /** A key comes up. A latched note keeps sounding. */
  function release(midi: number, source: string): void {
    if (latch.value) return;
    const holding = holdings.get(midi);
    if (!holding?.sources.delete(source)) return;
    if (holding.sources.size === 0) silence(midi);
  }

  /** Everything off, with no fall-back to a key that is about to go too. */
  function dropAll(): void {
    const all = [...holdings.keys()];
    holdings.clear();
    heldKeys.clear();
    sounding = null;
    for (const midi of all) sink.noteOff(midi);
  }

  function releaseAll(): void {
    keyNotes.clear();
    dropAll();
  }

  /** Let go of what one source holds (every MIDI note when a device goes). */
  function releaseSource(prefix: string): void {
    for (const [midi, holding] of [...holdings]) {
      for (const source of [...holding.sources]) {
        if (source.startsWith(prefix)) holding.sources.delete(source);
      }
      if (holding.sources.size === 0) silence(midi);
    }
  }

  /** Re-strike what is held (the page's "re-strike on edit"). */
  function restrikeHeld(): void {
    for (const [midi, holding] of [...holdings]) {
      sink.noteOff(midi);
      strike(midi, holding.velocity);
    }
  }

  // --- on-screen keys -------------------------------------------------------
  const pointerDown = (midi: number): void => press(midi, AHX_KEY_VELOCITY, `ptr:${midi}`);
  const pointerUp = (midi: number): void => release(midi, `ptr:${midi}`);

  // --- computer keyboard ----------------------------------------------------
  function setOctave(value: number): void {
    octave.value = Math.max(AHX_MIN_OCTAVE, Math.min(AHX_MAX_OCTAVE, Math.round(value)));
  }

  /** Returns whether the key was a play key (and so was consumed). */
  function onKeyDown(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (isTextEntryTarget(event.target)) return false;
    // The tracker's octave keys.
    if (event.shiftKey && (event.key === 'PageUp' || event.key === 'PageDown')) {
      event.preventDefault();
      setOctave(octave.value + (event.key === 'PageUp' ? 1 : -1));
      return true;
    }
    const base = TRACKER_NOTE_KEY_MAP[event.code];
    if (base === undefined) return false;
    if (!audible.value) return false;
    event.preventDefault();
    // Auto-repeat is the same key still down, not another press.
    if (event.repeat) return true;
    // A key already down (a missed key-up) is released before it is struck again.
    const before = keyNotes.get(event.code);
    if (before !== undefined) release(before, `kbd:${event.code}`);
    const midi = clampMidi(base + transpose.value);
    keyNotes.set(event.code, midi);
    press(midi, AHX_KEY_VELOCITY, `kbd:${event.code}`);
    return true;
  }

  /** Key-up is honoured wherever focus is: the key went down in the page. */
  function onKeyUp(event: KeyboardEvent): void {
    const midi = keyNotes.get(event.code);
    if (midi === undefined) return;
    keyNotes.delete(event.code);
    release(midi, `kbd:${event.code}`);
  }

  // --- MIDI -----------------------------------------------------------------
  const midiInput = new MidiInput(
    {
      noteOn: (note, velocity) => press(note, velocity, 'midi'),
      noteOff: (note) => release(note, 'midi'),
      allNotesOff: () => releaseSource('midi'),
      onStatus: (status) => {
        midiStatus.value = status;
      },
    },
    options.requestMidi,
  );
  const midiOn = computed(
    () => midiStatus.value.state === 'ready' || midiStatus.value.state === 'requesting',
  );

  async function enableMidi(): Promise<void> {
    await midiInput.start();
  }
  function disableMidi(): void {
    releaseSource('midi');
    midiInput.stop();
  }
  /** The chip: off/denied -> try to start; on -> stop. */
  async function toggleMidi(): Promise<void> {
    if (midiOn.value) disableMidi();
    else await enableMidi();
  }

  // Held notes belong to the instrument they were struck on, and to being audible.
  watch(latch, (on) => {
    if (!on) releaseAll();
  });
  watch(slot, releaseAll);
  watch(audible, (on) => {
    if (!on) releaseAll();
  });

  // A latched note is meant to outlast the hands; anything else would hang.
  const onBlur = (): void => {
    if (!latch.value) releaseAll();
  };
  onMounted(() => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    const auto = options.autoMidi;
    if (typeof auto === 'boolean' ? auto : auto?.value) void enableMidi();
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    midiInput.stop();
    releaseAll();
  });

  return {
    heldKeys,
    latch,
    octave,
    setOctave,
    midiStatus,
    midiOn,
    toggleMidi,
    enableMidi,
    disableMidi,
    pointerDown,
    pointerUp,
    press,
    release,
    releaseAll,
    restrikeHeld,
    onKeyDown,
    onKeyUp,
  };
}
