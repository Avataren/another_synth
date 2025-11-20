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
import { onMounted, onUnmounted, watch } from 'vue';
import { useKeyboardStore } from '../stores/keyboard-store';
import { useInstrumentStore } from 'src/stores/instrument-store';

interface PianoKey {
  midiNote: number;
  label: string;
  type: 'white' | 'black';
}

const { currentInstrument } = useInstrumentStore();
const keyboardStore = useKeyboardStore();

const keyboardNotes: PianoKey[] = [
  { midiNote: 48, label: 'C3', type: 'white' },
  { midiNote: 49, label: 'C#3', type: 'black' },
  { midiNote: 50, label: 'D3', type: 'white' },
  { midiNote: 51, label: 'D#3', type: 'black' },
  { midiNote: 52, label: 'E3', type: 'white' },
  { midiNote: 53, label: 'F3', type: 'white' },
  { midiNote: 54, label: 'F#3', type: 'black' },
  { midiNote: 55, label: 'G3', type: 'white' },
  { midiNote: 56, label: 'G#3', type: 'black' },
  { midiNote: 57, label: 'A3', type: 'white' },
  { midiNote: 58, label: 'A#3', type: 'black' },
  { midiNote: 59, label: 'B3', type: 'white' },
  { midiNote: 60, label: 'C4', type: 'white' },
  { midiNote: 61, label: 'C#4', type: 'black' },
  { midiNote: 62, label: 'D4', type: 'white' },
  { midiNote: 63, label: 'D#4', type: 'black' },
  { midiNote: 64, label: 'E4', type: 'white' },
  { midiNote: 65, label: 'F4', type: 'white' },
  { midiNote: 66, label: 'F#4', type: 'black' },
  { midiNote: 67, label: 'G4', type: 'white' },
  { midiNote: 68, label: 'G#4', type: 'black' },
  { midiNote: 69, label: 'A4', type: 'white' },
  { midiNote: 70, label: 'A#4', type: 'black' },
  { midiNote: 71, label: 'B4', type: 'white' },
  { midiNote: 72, label: 'C5', type: 'white' },
  { midiNote: 73, label: 'C#5', type: 'black' },
  { midiNote: 74, label: 'D5', type: 'white' },
  { midiNote: 75, label: 'D#5', type: 'black' },
  { midiNote: 76, label: 'E5', type: 'white' },
  { midiNote: 77, label: 'F5', type: 'white' },
  { midiNote: 78, label: 'F#5', type: 'black' },
  { midiNote: 79, label: 'G5', type: 'white' },
  { midiNote: 80, label: 'G#5', type: 'black' },
  { midiNote: 81, label: 'A5', type: 'white' },
];

watch(
  () => keyboardStore.latestEvent,
  (event) => {
    if (!event) return;
    if (event.velocity < 0.0001) {
      currentInstrument?.note_off(event.note);
    } else {
      currentInstrument?.note_on(event.note, event.velocity);
    }
  },
);

function handleNoteOn(note: number) {
  keyboardStore.noteOn(note);
}

function handleNoteOff(note: number) {
  keyboardStore.noteOff(note);
}

onMounted(() => {
  console.log('Component mounted, setting up listeners.');
  keyboardStore.setupGlobalKeyboardListeners();
  keyboardStore.setupMidiListeners();
});

onUnmounted(() => {
  keyboardStore.cleanup();
  keyboardStore.clearAllNotes();
});
</script>

<style scoped>
.piano-keyboard {
  width: 100%;
  max-width: 600px;
  height: 180px;
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
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding-bottom: 0.5rem;
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
  width: 24px;
  height: 60%;
  margin: 0 -12px;
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
  font-size: 10px;
  color: #666;
  pointer-events: none;
  margin-bottom: 2px;
}

.key-binding {
  font-size: 9px;
  color: #999;
  pointer-events: none;
  margin-bottom: 4px;
}

.black .note-label,
.black .key-binding {
  color: white;
}

.white:hover {
  background: #f5f5f5;
}

.black:hover {
  background: #444;
}

.piano-key,
.note-label,
key-binding {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}
</style>
