<template>
  <div
    class="piano-keyboard"
    @mouseup="handleMouseUp"
    @mouseleave="handleMouseUp"
    tabindex="0"
    @keydown.prevent="handleKeyDown"
    @keyup.prevent="handleKeyUp"
  >
    <div class="keys-container">
      <div
        v-for="note in keyboardNotes"
        :key="note.midiNote"
        :class="[
          'piano-key',
          note.type,
          { active: isNoteActive(note.midiNote) },
        ]"
        @mousedown="handleNoteOn(note.midiNote)"
        @mouseup="handleNoteOff(note.midiNote)"
        :data-note="note.midiNote"
      >
        <span class="note-label">{{ note.label }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useKeyboardStore } from '../stores/keyboard-store';

const keyboardStore = useKeyboardStore();

// Define piano key mapping (computer keyboard to MIDI notes)
const keyMap: Record<string, number> = {
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
};

interface PianoKey {
  midiNote: number;
  label: string;
  type: 'white' | 'black';
}

// Generate one octave of notes (customize as needed)
const keyboardNotes: PianoKey[] = [
  { midiNote: 60, label: 'C', type: 'white' },
  { midiNote: 61, label: 'C#', type: 'black' },
  { midiNote: 62, label: 'D', type: 'white' },
  { midiNote: 63, label: 'D#', type: 'black' },
  { midiNote: 64, label: 'E', type: 'white' },
  { midiNote: 65, label: 'F', type: 'white' },
  { midiNote: 66, label: 'F#', type: 'black' },
  { midiNote: 67, label: 'G', type: 'white' },
  { midiNote: 68, label: 'G#', type: 'black' },
  { midiNote: 69, label: 'A', type: 'white' },
  { midiNote: 70, label: 'A#', type: 'black' },
  { midiNote: 71, label: 'B', type: 'white' },
  { midiNote: 72, label: 'C', type: 'white' },
];

const { isNoteActive } = keyboardStore;

function handleNoteOn(note: number) {
  keyboardStore.noteOn(note);
}

function handleNoteOff(note: number) {
  keyboardStore.noteOff(note);
}

function handleKeyDown(event: KeyboardEvent) {
  const note = keyMap[event.key];
  if (note !== undefined) {
    handleNoteOn(note);
  }
}

function handleKeyUp(event: KeyboardEvent) {
  const note = keyMap[event.key];
  if (note !== undefined) {
    handleNoteOff(note);
  }
}

function handleMouseUp() {
  keyboardStore.clearAllNotes();
}

onMounted(() => {
  // Ensure the component can receive keyboard events
  const element = document.querySelector('.piano-keyboard') as HTMLElement;
  if (element) {
    element.focus();
  }
});

onUnmounted(() => {
  keyboardStore.clearAllNotes();
});
</script>

<style scoped>
.piano-keyboard {
  width: 100%;
  max-width: 800px;
  height: 200px;
  position: relative;
  outline: none;
}

.keys-container {
  display: flex;
  position: relative;
  height: 100%;
}

.piano-key {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 1rem;
  box-sizing: border-box;
  cursor: pointer;
  user-select: none;
}

.white {
  background: white;
  border: 1px solid #ccc;
  flex: 1;
  z-index: 1;
}

.black {
  background: black;
  width: 30px;
  height: 60%;
  margin: 0 -15px;
  z-index: 2;
}

.white.active {
  background: #e0e0e0;
}

.black.active {
  background: #333;
}

.note-label {
  font-size: 12px;
  color: #666;
}

.black .note-label {
  color: white;
}
</style>
