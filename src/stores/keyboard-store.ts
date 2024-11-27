import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

interface NoteEvent {
  note: number; // MIDI note number
  velocity: number;
  timestamp: number;
}

export const useKeyboardStore = defineStore('keyboard', () => {
  const activeNotes = ref(new Set<number>());
  const noteEvents = ref<NoteEvent[]>([]);

  const isNoteActive = computed(
    () => (note: number) => activeNotes.value.has(note),
  );

  function noteOn(note: number, velocity = 127) {
    if (!activeNotes.value.has(note)) {
      activeNotes.value.add(note);
      noteEvents.value.push({
        note,
        velocity,
        timestamp: performance.now(),
      });
    }
  }

  function noteOff(note: number) {
    activeNotes.value.delete(note);
    noteEvents.value.push({
      note,
      velocity: 0,
      timestamp: performance.now(),
    });
  }

  function clearAllNotes() {
    activeNotes.value.clear();
  }

  return {
    activeNotes,
    noteEvents,
    isNoteActive,
    noteOn,
    noteOff,
    clearAllNotes,
  };
});
