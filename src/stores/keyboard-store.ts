// src/stores/keyboard-store.ts
import { defineStore } from 'pinia';

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
      a: 60, // Middle C
      w: 61,
      s: 62,
      e: 63,
      d: 64,
      f: 65,
      t: 66,
      g: 67,
      y: 68,
      h: 69,
      u: 70,
      j: 71,
      k: 72,
    } as Record<string, number>,
    isEnabled: true,
  }),

  getters: {
    isNoteActive: (state) => {
      return (note: number) => state.activeNotes.has(note);
    },
  },

  actions: {
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

    setupGlobalKeyboardListeners() {
      const handleKeyDown = (event: KeyboardEvent) => {
        // Ignore if we're in an input element or keyboard is disabled
        if (!this.isEnabled || this.isInputElement(event.target)) {
          return;
        }

        const note = this.keyMap[event.key];
        if (note !== undefined && !event.repeat) {
          event.preventDefault();
          this.noteOn(note);
        }
      };

      const handleKeyUp = (event: KeyboardEvent) => {
        // Still check disabled state but allow event in input elements
        // so we don't get stuck notes when leaving an input
        if (!this.isEnabled) return;

        const note = this.keyMap[event.key];
        if (note !== undefined) {
          event.preventDefault();
          this.noteOff(note);
        }
      };

      // When window loses focus, clear all notes to prevent stuck notes
      const handleBlur = () => {
        this.clearAllNotes();
      };

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      window.addEventListener('blur', handleBlur);

      // Store cleanup function for use in component
      this.cleanup = () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
        window.removeEventListener('blur', handleBlur);
      };
    },

    cleanup() {
      // Will be replaced by actual cleanup function when listeners are setup
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

    setEnabled(enabled: boolean) {
      this.isEnabled = enabled;
      if (!enabled) {
        this.clearAllNotes();
      }
    },
  },
});
