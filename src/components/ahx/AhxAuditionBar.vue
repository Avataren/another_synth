<template>
  <section class="ahx-card ahx-audition-bar" data-testid="ahx-audition">
    <div class="ahx-audition">
      <span class="ahx-audition__title">Audition</span>
      <button
        v-for="key in AUDITION_KEYS"
        :key="key.midi"
        type="button"
        class="ahx-audition__key"
        :class="{ 'ahx-audition__key--held': latch && heldKeys.has(key.midi) }"
        :disabled="!audible"
        :data-testid="`ahx-audition-${key.midi}`"
        @pointerdown.prevent="emit('pointer-down', key.midi)"
        @pointerup="emit('pointer-up', key.midi)"
        @pointerleave="emit('pointer-up', key.midi)"
        @pointercancel="emit('pointer-up', key.midi)"
      >
        {{ key.label }}
      </button>
      <AhxPianoStrip
        :start="stripStart"
        :held="heldKeys"
        :disabled="!audible"
        @down="(midi: number) => emit('pointer-down', midi)"
        @up="(midi: number) => emit('pointer-up', midi)"
      />
      <span
        class="ahx-octave"
        title="Shifts the computer keyboard and the on-screen piano by an octave (Shift+PageUp / Shift+PageDown, as in the tracker)."
      >
        <button
          type="button"
          class="ahx-octave__btn"
          :disabled="octave <= AHX_MIN_OCTAVE"
          aria-label="Octave down"
          data-testid="ahx-octave-down"
          @click="emit('set-octave', octave - 1)"
        >
          −
        </button>
        <span class="ahx-octave__value" data-testid="ahx-octave">Oct {{ octave }}</span>
        <button
          type="button"
          class="ahx-octave__btn"
          :disabled="octave >= AHX_MAX_OCTAVE"
          aria-label="Octave up"
          data-testid="ahx-octave-up"
          @click="emit('set-octave', octave + 1)"
        >
          +
        </button>
      </span>
      <button
        type="button"
        class="ahx-midi-chip"
        :class="`ahx-midi-chip--${midiStatus.state}`"
        :title="midiChip.title"
        data-testid="ahx-midi-chip"
        @click="emit('toggle-midi')"
      >
        {{ midiChip.text }}
      </button>
      <label
        class="ahx-check ahx-check--bar"
        title="A tap holds the note until you tap the key again, so both hands are free to edit."
      >
        <input
          type="checkbox"
          :checked="latch"
          :disabled="!audible"
          data-testid="ahx-audition-latch"
          @change="emit('update:latch', ($event.target as HTMLInputElement).checked)"
        />
        Latch
      </label>
      <label
        class="ahx-check ahx-check--bar"
        title="Strike the held note again shortly after each edit. Volume, wave length, vibrato and the sweep setup are only read when a note is struck, so this is what makes them audible while you drag."
      >
        <input
          type="checkbox"
          :checked="restrike"
          :disabled="!audible"
          data-testid="ahx-audition-restrike"
          @change="emit('update:restrike', ($event.target as HTMLInputElement).checked)"
        />
        Re-strike on edit
      </label>
      <span
        v-if="audible"
        class="ahx-dim ahx-audition__hint"
        title="Hold a note to hear this instrument as it is now. The song plays the same edit from its next trigger of this instrument; a note already sounding keeps its volume, vibrato and wave length until it is struck again."
        >Play with the keyboard (Z-M, Q-P), MIDI or the keys; edits sound at once.</span
      >
      <span v-else class="ahx-dim" data-testid="ahx-audition-off"
        >Unavailable: there is no source file to play this instrument from (keyboard, MIDI and keys are off).</span
      >
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AhxPianoStrip from 'src/components/ahx/AhxPianoStrip.vue';
import { AHX_MAX_OCTAVE, AHX_MIN_OCTAVE } from 'src/composables/useAhxPlayInput';
import type { MidiInputStatus } from 'src/audio/midi-input';

interface Props {
  audible: boolean;
  heldKeys: ReadonlySet<number>;
  latch: boolean;
  restrike: boolean;
  octave: number;
  stripStart: number;
  midiStatus: MidiInputStatus;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'pointer-down': [midi: number];
  'pointer-up': [midi: number];
  'set-octave': [value: number];
  'toggle-midi': [];
  'update:latch': [value: boolean];
  'update:restrike': [value: boolean];
}>();

/** Middle-of-the-keyboard notes to hold: C-2 .. C-5 as MIDI. */
const AUDITION_KEYS = [
  { midi: 48, label: 'C-3' },
  { midi: 60, label: 'C-4' },
  { midi: 72, label: 'C-5' },
];

const midiChip = computed(() => {
  const { state, devices } = props.midiStatus;
  switch (state) {
    case 'unsupported':
      return { text: 'MIDI: not supported', title: 'This browser has no Web MIDI.' };
    case 'requesting':
      return { text: 'MIDI: asking…', title: 'Waiting for the browser’s permission prompt.' };
    case 'denied':
      return {
        text: 'MIDI: denied',
        title: 'The browser refused MIDI access. Allow it for this site, then click to try again.',
      };
    case 'ready':
      return devices.length === 0
        ? { text: 'MIDI: no device', title: 'MIDI is on; plug a controller in and it is picked up. Click to turn it off.' }
        : {
            text: devices.length === 1 ? `MIDI: ${devices[0]}` : `MIDI: ${devices[0]} +${devices.length - 1}`,
            title: `${devices.join(', ')}. Click to turn MIDI off.`,
          };
    default:
      return { text: 'MIDI: off', title: 'Click to play this instrument from a MIDI keyboard.' };
  }
});
</script>

<style scoped>
.ahx-audition-bar {
  /* The page (q-page) is its own scroll container, below the app header, so 0 is just under it. */
  position: sticky;
  top: 0;
  z-index: 6;
  padding: 6px 12px;
  background: var(--app-background, #0b111a);
  border-color: var(--tracker-accent-secondary, #3b82a0);
}

.ahx-audition {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  flex: 1 1 320px;
}

.ahx-audition__title {
  font-weight: 600;
}

.ahx-audition__hint {
  font-size: 0.8rem;
}

.ahx-check--bar {
  min-width: 0;
  font-size: 0.85rem;
  cursor: pointer;
}

.ahx-octave {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.ahx-octave__btn,
.ahx-midi-chip {
  color: inherit;
  font: inherit;
  cursor: pointer;
  background: var(--button-background, #1a2534);
  border: 1px solid var(--tracker-accent-secondary, #3b82a0);
  border-radius: 4px;
}

.ahx-octave__btn {
  width: 26px;
  padding: 2px 0;
}

.ahx-octave__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ahx-octave__value {
  min-width: 44px;
  font-size: 0.85rem;
  text-align: center;
}

.ahx-midi-chip {
  padding: 2px 10px;
  font-size: 0.8rem;
  border-radius: 999px;
}

.ahx-midi-chip--ready {
  border-color: var(--tracker-accent-primary, #f0b25e);
}

.ahx-midi-chip--denied,
.ahx-midi-chip--unsupported {
  opacity: 0.65;
}

.ahx-audition__key--held {
  background: var(--tracker-active-bg, #14283d);
  outline: 2px solid var(--tracker-accent-primary, #f0b25e);
}

.ahx-audition__key {
  min-width: 64px;
  padding: 6px 16px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  user-select: none;
  touch-action: none;
  background: var(--button-background, #1a2534);
  border: 1px solid var(--tracker-accent-secondary, #3b82a0);
  border-radius: 4px;
}

.ahx-audition__key:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ahx-audition__key:active {
  background: var(--tracker-active-bg, #14283d);
}
</style>
