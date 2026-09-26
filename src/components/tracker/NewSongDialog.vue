<template>
  <div
    v-if="open"
    class="new-song-backdrop"
    data-testid="new-song-dialog"
    @click.self="emit('close')"
    @keydown="onKeydown"
  >
    <form
      ref="dialogEl"
      class="new-song-dialog"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :aria-labelledby="headingId"
      @submit.prevent="create"
    >
      <h2 :id="headingId" class="new-song-heading">New song</h2>
      <p class="new-song-warning">The current song is replaced. Unsaved changes are lost.</p>

      <fieldset class="new-song-formats">
        <legend class="new-song-legend">Format</legend>
        <label class="new-song-format">
          <input v-model="format" type="radio" value="native" data-testid="new-song-format-native" />
          <span class="new-song-format-name">Native</span>
          <span class="new-song-format-note">This app's synth and sampler instruments.</span>
        </label>
        <label class="new-song-format">
          <input v-model="format" type="radio" value="sid" data-testid="new-song-format-sid" />
          <span class="new-song-format-name">SID (GoatTracker)</span>
          <span class="new-song-format-note">Three C64 voices; saves as a GoatTracker 2 .sng.</span>
        </label>
        <label class="new-song-format">
          <input v-model="format" type="radio" value="ahx" data-testid="new-song-format-ahx" />
          <span class="new-song-format-name">AHX</span>
          <span class="new-song-format-note">Four Amiga synth channels; exports as an .ahx.</span>
        </label>
        <label class="new-song-format">
          <input v-model="format" type="radio" value="hvl" data-testid="new-song-format-hvl" />
          <span class="new-song-format-name">HVL (HivelyTracker)</span>
          <span class="new-song-format-note">AHX with up to 16 channels, ring modulation and panning; exports as an .hvl.</span>
        </label>
      </fieldset>

      <div v-if="format === 'sid'" class="new-song-options" data-testid="new-song-sid-options">
        <label class="new-song-field">
          <span>Chip</span>
          <select v-model="chipModel" data-testid="new-song-chip">
            <option value="6581">6581</option>
            <option value="8580">8580</option>
          </select>
        </label>
        <label class="new-song-field">
          <span>Speed</span>
          <select v-model.number="speedMultiplier" data-testid="new-song-multispeed">
            <option v-for="m in SPEEDS" :key="m" :value="m">{{ m === 1 ? '1x (50 Hz)' : `${m}x` }}</option>
          </select>
        </label>
        <label class="new-song-field">
          <span>Tempo</span>
          <input
            v-model.number="tempo"
            type="number"
            :min="minTempo"
            :max="SID_MAX_TEMPO"
            data-testid="new-song-tempo"
            @input="tempoEdited = true"
          />
          <span class="new-song-hint">frames per row</span>
        </label>
        <label class="new-song-field">
          <span>Pattern rows</span>
          <input
            v-model.number="patternRows"
            type="number"
            :min="SID_MIN_PATTERN_ROWS"
            :max="SID_MAX_PATTERN_ROWS"
            data-testid="new-song-rows"
          />
        </label>
        <p v-if="tempoNote" class="new-song-note" data-testid="new-song-tempo-note">{{ tempoNote }}</p>
        <p v-if="sidProblem" class="new-song-problem" role="alert" data-testid="new-song-problem">{{ sidProblem }}</p>
      </div>

      <div v-if="format === 'ahx' || format === 'hvl'" class="new-song-options" data-testid="new-song-ahx-options">
        <label class="new-song-field">
          <span>Speed</span>
          <select v-model.number="ahxSpeedMultiplier" data-testid="new-song-ahx-speed">
            <option v-for="m in NEW_AHX_SPEED_MULTIPLIERS" :key="m" :value="m">{{ m === 1 ? '1x (50 Hz)' : `${m}x` }}</option>
          </select>
        </label>
        <label class="new-song-field">
          <span>Track rows</span>
          <select v-model.number="trackLength" data-testid="new-song-ahx-rows">
            <option v-for="n in NEW_AHX_TRACK_LENGTHS" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <label v-if="format === 'hvl'" class="new-song-field">
          <span>Channels</span>
          <select v-model.number="channels" data-testid="new-song-hvl-channels">
            <option v-for="n in HVL_CHANNEL_COUNTS" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <p class="new-song-note" data-testid="new-song-ahx-note">
          Starts with one plain instrument. Add more with "Add from preset" in the instrument list.
        </p>
      </div>

      <div class="new-song-actions">
        <button type="button" class="new-song-cancel" data-testid="new-song-cancel" @click="emit('close')">Cancel</button>
        <button type="submit" class="new-song-create" data-testid="new-song-create" :disabled="sidProblem !== null">
          New song
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  SID_DEFAULT_CHIP_MODEL,
  SID_DEFAULT_TEMPO,
  SID_MAX_PATTERN_ROWS,
  SID_MAX_SPEED_MULTIPLIER,
  SID_MAX_TEMPO,
  SID_MIN_NEW_TEMPO,
  SID_MIN_PATTERN_ROWS,
  createNewSidDoc,
  newSidGateTimer,
  type NewSidDocOptions,
  type SidChipModel,
} from 'src/audio/tracker/sid-doc';
import {
  HVL_MAX_CHANNELS,
  HVL_MIN_CHANNELS,
  NEW_AHX_SPEED_MULTIPLIERS,
  NEW_AHX_TRACK_LENGTHS,
  type NewAhxDocOptions,
} from 'src/audio/tracker/ahx-doc';

/** A new AHX or HVL song's options (`resetToNewAhxSong`); `channels` is HVL's only. */
export type NewAhxSongChoiceOptions = Required<Pick<NewAhxDocOptions, 'trackLength' | 'speedMultiplier'>> & { channels?: number };

/**
 * What the user chose: a native song, a SID song with its options
 * (`resetToNewSidSong`), or an AHX or HVL song with its options
 * (`resetToNewAhxSong`).
 */
export type NewSongChoice =
  | { format: 'native' }
  | { format: 'sid'; options: NewSidDocOptions }
  | { format: 'ahx' | 'hvl'; options: NewAhxSongChoiceOptions };

interface Props {
  open: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'create', choice: NewSongChoice): void }>();

const SPEEDS = Array.from({ length: SID_MAX_SPEED_MULTIPLIER }, (_, i) => i + 1);

const headingId = 'new-song-heading';
const dialogEl = ref<HTMLElement | null>(null);
const format = ref<NewSongChoice['format']>('native');
const chipModel = ref<SidChipModel>(SID_DEFAULT_CHIP_MODEL);
const speedMultiplier = ref(1);
const tempo = ref(SID_DEFAULT_TEMPO);
const tempoEdited = ref(false);
const patternRows = ref(64);
const HVL_CHANNEL_COUNTS = Array.from({ length: HVL_MAX_CHANNELS - HVL_MIN_CHANNELS + 1 }, (_, i) => HVL_MIN_CHANNELS + i);
const ahxSpeedMultiplier = ref<NewAhxSongChoiceOptions['speedMultiplier']>(1);
const trackLength = ref<NewAhxSongChoiceOptions['trackLength']>(64);
const channels = ref(HVL_MIN_CHANNELS);
let opener: HTMLElement | null = null;

// GoatTracker's start tempo follows the multispeed (6 frames per row per 1x) until the user sets one.
watch(speedMultiplier, (m) => {
  if (!tempoEdited.value) tempo.value = Math.min(SID_MAX_TEMPO, SID_DEFAULT_TEMPO * m);
});

/** GoatTracker's F range, above the new instrument's gate timer (`createNewSidDoc`). */
const minTempo = computed(() => Math.max(SID_MIN_NEW_TEMPO, newSidGateTimer(speedMultiplier.value) + 1));

const sidOptions = computed<NewSidDocOptions>(() => ({
  chipModel: chipModel.value,
  speedMultiplier: speedMultiplier.value,
  tempo: tempo.value,
  patternRows: patternRows.value,
}));

/** The true reason the options make no song (`createNewSidDoc`'s refusal), or null. */
const sidProblem = computed<string | null>(() => {
  if (format.value !== 'sid') return null;
  try {
    createNewSidDoc(sidOptions.value);
    return null;
  } catch (caught) {
    return (caught as Error).message;
  }
});

const tempoNote = computed(() =>
  sidProblem.value === null && (tempo.value !== SID_DEFAULT_TEMPO || speedMultiplier.value !== 1)
    ? `Set by an F${tempo.value.toString(16).toUpperCase().padStart(2, '0')} command on voice 1's first row, as GoatTracker does.`
    : '',
);

const focusables = (): HTMLElement[] =>
  Array.from(dialogEl.value?.querySelectorAll<HTMLElement>('input, select, button:not([disabled])') ?? []);

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      opener?.focus?.();
      opener = null;
      return;
    }
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    dialogEl.value?.querySelector<HTMLElement>('input[type="radio"]:checked')?.focus();
  },
  { immediate: true },
);

function choice(): NewSongChoice {
  switch (format.value) {
    case 'sid':
      return { format: 'sid', options: { ...sidOptions.value } };
    case 'ahx':
      return { format: 'ahx', options: { trackLength: trackLength.value, speedMultiplier: ahxSpeedMultiplier.value } };
    case 'hvl':
      return {
        format: 'hvl',
        options: { trackLength: trackLength.value, speedMultiplier: ahxSpeedMultiplier.value, channels: channels.value },
      };
    default:
      return { format: 'native' };
  }
}

function create(): void {
  if (sidProblem.value !== null) return;
  emit('create', choice());
}

/** Esc closes; Tab stays inside; no key reaches the tracker's shortcuts underneath. */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusables();
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialogEl.value?.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialogEl.value?.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<style scoped>
.new-song-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2500;
}
.new-song-dialog {
  background: var(--panel-background, #0b111a);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  padding: 18px 20px;
  width: min(460px, 92vw);
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
  color: var(--text-secondary, rgba(255, 255, 255, 0.85));
}
.new-song-heading {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #fff);
}
.new-song-warning {
  margin: 0 0 12px;
  font-size: 13px;
  color: #ffd28a;
}
.new-song-formats {
  border: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.new-song-legend {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--text-primary, #fff);
}
.new-song-format {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  cursor: pointer;
}
.new-song-format input {
  grid-row: span 2;
  align-self: center;
}
.new-song-format-name {
  font-weight: 600;
  color: var(--text-primary, #fff);
}
.new-song-format-note {
  font-size: 13px;
  opacity: 0.8;
}
.new-song-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
  margin: 0 0 12px;
}
.new-song-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.new-song-field select,
.new-song-field input {
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.2));
  background: transparent;
  color: var(--text-primary, #fff);
  font-variant-numeric: tabular-nums;
}
.new-song-field option {
  background: var(--panel-background, #0b111a);
}
.new-song-hint {
  font-size: 12px;
  opacity: 0.7;
}
.new-song-note,
.new-song-problem {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 13px;
}
.new-song-note {
  opacity: 0.8;
}
.new-song-problem {
  color: #ff9db5;
}
.new-song-actions {
  display: flex;
  gap: 10px;
}
.new-song-actions button {
  flex: 1;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.new-song-cancel {
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.2));
  background: transparent;
  color: var(--text-primary, #fff);
}
.new-song-create {
  border: 1px solid #ff9db5;
  background: transparent;
  color: #ff9db5;
}
.new-song-create:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
