import { defineStore } from 'pinia';
import { WebMidi } from 'webmidi';

interface NoteEvent {
  note: number;
  velocity: number;
  timestamp: number;
}

export const useKeyboardStore = defineStore('keyboard', {
  state: () => ({
    activeNotes: new Set<number>(),
    noteEvents: [] as NoteEvent[],
    // New property to track only the latest event (for performance)
    latestEvent: null as NoteEvent | null,
    keyMap: {
      // Lower octave - white keys
      'KeyZ': 48, // C3
      'KeyX': 50, // D3
      'KeyC': 52, // E3
      'KeyV': 53, // F3
      'KeyB': 55, // G3
      'KeyN': 57, // A3
      'KeyM': 59, // B3
      'Comma': 60, // C4
      'Period': 62, // D4
      'Slash': 64, // E4

      // Lower octave - black keys
      'KeyS': 49, // C#3
      'KeyD': 51, // D#3
      'KeyG': 54, // F#3
      'KeyH': 56, // G#3
      'KeyJ': 58, // A#3
      'KeyL': 61, // C#4
      'Semicolon': 63, // D#4
      'Quote': 66, // F#4

      // Upper octave - white keys
      'KeyQ': 60, // C4 (same as Comma)
      'KeyW': 62, // D4 (same as Period)
      'KeyE': 64, // E4 (same as Slash)
      'KeyR': 65, // F4
      'KeyT': 67, // G4
      'KeyY': 69, // A4
      'KeyU': 71, // B4
      'KeyI': 72, // C5
      'KeyO': 74, // D5
      'KeyP': 76, // E5
      'BracketLeft': 77, // F5
      'BracketRight': 79, // G5
      'Backslash': 81, // A5

      // Upper octave - black keys
      'Digit2': 61, // C#4 (same as KeyL)
      'Digit3': 63, // D#4 (same as Semicolon)
      'Digit5': 66, // F#4 (same as Quote)
      'Digit6': 68, // G#4
      'Digit7': 70, // A#4
      'Digit9': 73, // C#5
      'Digit0': 75, // D#5
      'Equal': 78, // F#5 (the \ key on Norwegian keyboard)
      'Backspace': 80, // G#5
    } as Record<string, number>,
    isEnabled: true,
    midiEnabled: false,
  }),

  getters: {
    isNoteActive: (state) => {
      return (note: number) => state.activeNotes.has(note);
    },
  },

  actions: {
    // --- Core note handling ---
    noteOn(note: number, velocity = 127) {
      if (!this.activeNotes.has(note)) {
        this.activeNotes.add(note);
        const event: NoteEvent = {
          note,
          velocity,
          timestamp: performance.now(),
        };
        this.noteEvents.push(event);
        this.latestEvent = event; // update only the latest event
      }
    },

    noteOff(note: number) {
      this.activeNotes.delete(note);
      const event: NoteEvent = {
        note,
        velocity: 0,
        timestamp: performance.now(),
      };
      this.noteEvents.push(event);
      this.latestEvent = event; // update only the latest event
    },

    clearAllNotes() {
      this.activeNotes.clear();
    },

    // --- Keyboard-only listeners ---
    setupGlobalKeyboardListeners() {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (!this.isEnabled || this.isInputElement(event.target)) {
          return;
        }
        const note = this.keyMap[event.code];
        if (note !== undefined && !event.repeat) {
          event.preventDefault();
          this.noteOn(note);
        }
      };

      const handleKeyUp = (event: KeyboardEvent) => {
        if (!this.isEnabled) return;
        const note = this.keyMap[event.code];
        if (note !== undefined) {
          event.preventDefault();
          this.noteOff(note);
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);

      // Store cleanup function for keyboard listeners
      this.cleanup = () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
      };
    },

    // Placeholder cleanup function (will be replaced by actual cleanup when listeners are set up)
    cleanup() {
      // Will be replaced by actual cleanup function when listeners are set up
    },

    isInputElement(element: EventTarget | null): boolean {
      if (!element || !(element instanceof HTMLElement)) return false;
      const tagName = element.tagName.toLowerCase();
      return (
        tagName === 'input' ||
        tagName === 'textarea' ||
        element.isContentEditable
      );
    },

    // --- MIDI listeners using WebMidi.js ---
    setupMidiListeners() {
      console.log('# setupMidiListeners');
      WebMidi.enable({ sysex: true })
        .then(() => {
          console.log('# WebMidi enabled!');
          this.midiEnabled = true;
          console.log('# Total MIDI inputs:', WebMidi.inputs.length);

          WebMidi.inputs.forEach((input) => {
            console.log('# MIDI Input:', input.name);

            input.addListener('noteon', (e) => {
              if (!e.data || e.data.length < 3) {
                console.error(
                  '# Incomplete MIDI noteon message received:',
                  e.data
                );
                return;
              }
              // Destructure and ignore the first byte (status)
              const [, note, velocity] = e.data;
              if (velocity && velocity > 0) {
                this.noteOn(note!, velocity);
              } else {
                this.noteOff(note!);
              }
            });

            input.addListener('noteoff', (e) => {
              if (!e.data || e.data.length < 3) {
                console.error(
                  '# Incomplete MIDI noteoff message received:',
                  e.data
                );
                return;
              }
              // Destructure with status and note
              const [, note] = e.data;
              this.noteOff(note!);
            });
          });
        })
        .catch((err) => {
          console.error('# Failed to enable WebMidi:', err);
        });
    },

    cleanupMidiListeners() {
      if (this.midiEnabled) {
        WebMidi.inputs.forEach((input) => {
          input.removeListener('noteon');
          input.removeListener('noteoff');
          input.removeListener('midimessage');
        });
      }
    },
  },
});
