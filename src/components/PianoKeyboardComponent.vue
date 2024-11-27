<template>
  <div class="piano-keyboard">
    <div class="keys-container">
      <div
        v-for="note in keyboardNotes"
        :key="note.midiNote"
        :class="[
          'piano-key',
          note.type,
          { active: keyboardStore.isNoteActive(note.midiNote) },
        ]"
        @mousedown="handleNoteOn(note.midiNote)"
        @mouseup="handleNoteOff(note.midiNote)"
        @mouseleave="handleNoteOff(note.midiNote)"
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

interface PianoKey {
  midiNote: number;
  label: string;
  type: 'white' | 'black';
}

const keyboardStore = useKeyboardStore();

// Define piano keyboard layout
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

function handleNoteOn(note: number) {
  keyboardStore.noteOn(note);
}

function handleNoteOff(note: number) {
  keyboardStore.noteOff(note);
}

onMounted(() => {
  keyboardStore.setupGlobalKeyboardListeners();
});

onUnmounted(() => {
  keyboardStore.cleanup();
  keyboardStore.clearAllNotes();
});
</script>

<style scoped>
.piano-keyboard {
  width: 100%;
  max-width: 800px;
  height: 200px;
  position: relative;
  margin: 20px auto;
  user-select: none;
}

.keys-container {
  display: flex;
  position: relative;
  height: 100%;
  background: #f0f0f0;
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
}

.piano-key {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 1rem;
  box-sizing: border-box;
  cursor: pointer;
  transition: background-color 0.1s;
}

.white {
  background: white;
  border: 1px solid #ccc;
  border-radius: 0 0 4px 4px;
  flex: 1;
  z-index: 1;
}

.black {
  background: #333;
  width: 30px;
  height: 60%;
  margin: 0 -15px;
  z-index: 2;
  border-radius: 0 0 4px 4px;
}

.white.active {
  background: #e0e0e0;
}

.black.active {
  background: #666;
}

.note-label {
  font-size: 12px;
  color: #666;
  pointer-events: none;
}

.black .note-label {
  color: white;
}

/* Add hover effects */
.white:hover {
  background: #f5f5f5;
}

.black:hover {
  background: #444;
}

/* Prevent text selection */
.piano-key,
.note-label {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}
</style>
