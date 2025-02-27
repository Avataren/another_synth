// src/stores/keyboard-store.ts
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
        this.noteEvents.push({
          note,
          velocity,
          timestamp: performance.now(),
        });
      }
    },

    noteOff(note: number) {
      this.activeNotes.delete(note);
      this.noteEvents.push({
        note,
        velocity: 0,
        timestamp: performance.now(),
      });
    },

    clearAllNotes() {
      this.activeNotes.clear();
    },

    // --- Keyboard-only listeners (original code) ---
    setupGlobalKeyboardListeners() {
      const handleKeyDown = (event: KeyboardEvent) => {
        // Ignore if we're in an input element or keyboard is disabled
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
      if (!element || !(element instanceof HTMLElement)) {
        return false;
      }
      const tagName = element.tagName.toLowerCase();
      return (
        tagName === 'input' ||
        tagName === 'textarea' ||
        element.isContentEditable
      );
    },

    // --- MIDI listeners using WebMidi.js (npm-installed) ---
    setupMidiListeners() {
      console.log('# setupMidiListeners');
      WebMidi.enable({ sysex: false })
        .then(() => {
          console.log('# WebMidi enabled!');
          this.midiEnabled = true;

          // Log total number of MIDI inputs detected
          console.log('# Total MIDI inputs:', WebMidi.inputs.length);

          // Iterate over available MIDI inputs
          WebMidi.inputs.forEach((input) => {
            console.log('# MIDI Input:', input.name);

            // Attach a generic listener for all MIDI messages (for debugging)
            // input.addListener('midimessage', (e) => {
            //   console.log('# Generic MIDI message received:', e);
            // });

            // Attach a noteon listener
            input.addListener('noteon', (e) => {
              if (!e.data || e.data.length < 3) {
                console.error('# Incomplete MIDI noteon message received:', e.data);
                return;
              }
              const status = e.data[0];
              const note = e.data[1];
              const velocity = e.data[2];

              if (status === undefined || note === undefined || velocity === undefined) {
                console.error('# MIDI noteon values undefined:', { status, note, velocity });
                return;
              }

              // console.log(`# MIDI noteon - Status: 0x${status.toString(16)} | Note: ${note} | Velocity: ${velocity}`);

              // Treat a noteon with velocity 0 as noteoff
              if (velocity > 0) {
                this.noteOn(note, velocity);
              } else {
                this.noteOff(note);
              }
            });

            // Attach a noteoff listener
            input.addListener('noteoff', (e) => {
              if (!e.data || e.data.length < 3) {
                console.error('# Incomplete MIDI noteoff message received:', e.data);
                return;
              }
              const status = e.data[0];
              const note = e.data[1];
              if (status === undefined || note === undefined) {
                console.error('# MIDI noteoff values undefined:', { status, note });
                return;
              }

              // console.log(`# MIDI noteoff - Status: 0x${status.toString(16)} | Note: ${note}`);
              this.noteOff(note);
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
