<template>
  <q-page class="mod-page" data-testid="mod-sample-editor">
    <div class="mod-banner">
      <div class="mod-banner__info">
        <FormatBadge data-testid="mod-format-badge" brand="mod" :variant="activeBrand.variant" />
        <span class="mod-banner__label">Sample Editor</span>
        <span v-if="slotNumber !== null" class="mod-banner__slot">Slot #{{ formatInstrumentId(slotNumber) }}</span>
        <span class="mod-banner__name" data-testid="mod-sample-title">{{ draft.name || '(unnamed)' }}</span>
      </div>
      <q-btn
        flat
        dense
        color="white"
        icon="arrow_back"
        label="Back to Tracker"
        title="Press Escape to return"
        @click="backToTracker"
      />
    </div>

    <div v-if="!slotValid" class="mod-empty" data-testid="mod-sample-missing">
      A module holds samples 1-31. Open one from the instrument list in the tracker.
    </div>

    <template v-else>
      <div class="mod-sound-band">
        <AhxAuditionBar
          :audible="true"
          :held-keys="heldKeys"
          v-model:latch="latch"
          v-model:restrike="restrike"
          :octave="octave"
          :strip-start="stripStart"
          :midi-status="play.midiStatus.value"
          hint="Play with the keyboard (Z-M, Q-P), MIDI or the keys. C-2 plays the sample at its recorded rate."
          restrike-title="Strike the held note again shortly after each edit."
          @pointer-down="play.pointerDown"
          @pointer-up="play.pointerUp"
          @set-octave="play.setOctave"
          @toggle-midi="play.toggleMidi"
        />
      </div>

      <div class="mod-body">
        <div class="mod-left">
          <section class="mod-card" data-testid="mod-card-sample">
            <h3>Sample</h3>
            <label class="mod-field">
              <span class="mod-field__label">Name</span>
              <input
                class="mod-text"
                type="text"
                :maxlength="MOD_NAME_LENGTH"
                :value="draft.name"
                data-testid="mod-name"
                @input="onName(($event.target as HTMLInputElement).value)"
              />
            </label>
            <AhxSliderField
              label="Volume"
              :model-value="draft.volume"
              :min="0"
              :max="64"
              testid="mod-volume"
              @update:model-value="onVolume"
            />
            <AhxSliderField
              label="Finetune"
              :model-value="draft.finetune"
              :min="-8"
              :max="7"
              testid="mod-finetune"
              @update:model-value="onFinetune"
            />
            <div class="mod-readout" data-testid="mod-length">
              {{ draft.data.length }} bytes
              <span class="mod-dim">of {{ MOD_MAX_SAMPLE_BYTES }}</span>
            </div>
          </section>

          <section class="mod-card" data-testid="mod-card-new">
            <h3>New sample</h3>
            <label class="mod-field">
              <span class="mod-field__label">Wave</span>
              <select v-model="waveKind" class="mod-select" data-testid="mod-new-wave">
                <option v-for="k in MOD_WAVE_KINDS" :key="k" :value="k">{{ k }}</option>
              </select>
            </label>
            <label class="mod-field">
              <span class="mod-field__label">Length</span>
              <select v-model.number="waveLength" class="mod-select" data-testid="mod-new-length">
                <option v-for="n in MOD_WAVE_LENGTHS" :key="n" :value="n">{{ n }}</option>
              </select>
            </label>
            <button type="button" class="mod-btn" data-testid="mod-new-create" @click="edit((s) => generateWave(s, waveKind, waveLength))">
              {{ empty ? 'Create' : 'Replace with new' }}
            </button>
          </section>

          <section class="mod-card" data-testid="mod-card-loop">
            <h3>Loop</h3>
            <label class="mod-check">
              <input type="checkbox" :checked="looping" :disabled="draft.data.length < 4" data-testid="mod-loop-on" @change="onLoopToggle" />
              Loop
            </label>
            <template v-if="looping">
              <AhxNumberField
                label="Start"
                :model-value="draft.loopStart"
                :min="0"
                :max="draft.data.length - 2"
                testid="mod-loop-start"
                @update:model-value="(v: number) => onLoop(v, draft.loopLength)"
              />
              <AhxNumberField
                label="Length"
                :model-value="draft.loopLength"
                :min="4"
                :max="draft.data.length - draft.loopStart"
                testid="mod-loop-length"
                @update:model-value="(v: number) => onLoop(draft.loopStart, v)"
              />
            </template>
          </section>
        </div>

        <div class="mod-right">
          <section class="mod-card" data-testid="mod-card-wave">
            <h3>Waveform</h3>
            <ModWaveform
              :data="draft.data"
              :loop-start="draft.loopStart"
              :loop-length="draft.loopLength"
              :draw="drawMode"
              @update:loop="onLoop"
              @update:data="(d: Int8Array) => commit(withData(draft, d))"
            />
            <div class="mod-tools" data-testid="mod-tools">
              <label class="mod-check" title="Drag on the waveform to draw it by hand">
                <input v-model="drawMode" type="checkbox" :disabled="empty" data-testid="mod-draw" />
                Draw
              </label>
              <button type="button" class="mod-btn" data-testid="mod-load" title="IFF 8SVX, AIFF, raw 8-bit, WAV or any audio file" @click="fileEl?.click()">Import…</button>
              <label class="mod-field mod-field--inline" title="The note the loaded file sounds at its own pitch on">
                <span class="mod-field__label">Plays at</span>
                <select v-model.number="loadPeriod" class="mod-select" data-testid="mod-load-note">
                  <option v-for="n in MOD_LOAD_NOTES" :key="n.period" :value="n.period">{{ n.label }}</option>
                </select>
              </label>
              <label class="mod-field mod-field--inline">
                <span class="mod-field__label">Export</span>
                <select v-model="exportFormat" class="mod-select" data-testid="mod-export-format">
                  <option v-for="f in MOD_SAMPLE_FORMATS" :key="f.id" :value="f.id">{{ f.label }}</option>
                </select>
              </label>
              <button type="button" class="mod-btn" :disabled="empty" data-testid="mod-export" @click="exportSample">Export</button>
              <button type="button" class="mod-btn" :disabled="empty" data-testid="mod-normalize" @click="edit(normalize)">Normalize</button>
              <button type="button" class="mod-btn" :disabled="empty" data-testid="mod-reverse" @click="edit(reverse)">Reverse</button>
              <button type="button" class="mod-btn" :disabled="empty" data-testid="mod-halve" @click="edit(halve)">Half length</button>
              <button type="button" class="mod-btn mod-btn--danger" :disabled="empty" data-testid="mod-clear" @click="clear">Clear</button>
              <input ref="fileEl" type="file" accept=".iff,.8svx,.aif,.aiff,.raw,.sam,.smp,.snd,.sample,.pcm,.wav,audio/*" hidden data-testid="mod-file" @change="onFile" />
            </div>
            <p v-if="error" class="mod-error" role="alert" data-testid="mod-error">{{ error }}</p>
          </section>
        </div>
      </div>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { formatInstrumentId, type ModSample } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerAudioStore } from 'src/stores/tracker-audio-store';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import { AHX_DEFAULT_OCTAVE, useAhxPlayInput } from 'src/composables/useAhxPlayInput';
import { useActiveFormatBrand } from 'src/composables/useFormatBrand';
import { slotOf } from 'src/router/ahx-slot-guard';
import { downloadBytes } from 'src/audio/tracker/song-export/download';
import {
  emptyModSample,
  modSampleOfSlot,
  MOD_MAX_SAMPLE_BYTES,
  MOD_NAME_LENGTH,
  patchFromModSample,
} from 'src/audio/tracker/mod-sample-codec';
import {
  clampModName,
  fromPcm,
  generateWave,
  MOD_WAVE_KINDS,
  MOD_WAVE_LENGTHS,
  type ModWaveKind,
  halve,
  MOD_LOAD_NOTES,
  normalize,
  reverse,
  toWav,
  withData,
  withLoop,
} from 'src/audio/tracker/mod-sample-ops';
import AhxAuditionBar from 'src/components/ahx/AhxAuditionBar.vue';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import AhxSliderField from 'src/components/ahx/AhxSliderField.vue';
import FormatBadge from 'src/components/FormatBadge.vue';
import ModWaveform from 'src/components/mod/ModWaveform.vue';
import {
  amigaFormatOf,
  MOD_SAMPLE_FORMATS,
  parse8svx,
  parseAiff,
  parseRaw,
  write8svx,
  writeAiff,
  writeRaw,
  type ModSampleFormatId,
} from 'src/audio/tracker/mod-sample-formats';
import { exportFileName } from 'src/audio/tracker/song-export/file-name';

const route = useRoute();
const router = useRouter();
const trackerStore = useTrackerStore();
const audioStore = useTrackerAudioStore();
const userSettings = useUserSettingsStore();
const activeBrand = useActiveFormatBrand();

const slotNumber = computed(() => slotOf(route.params.slot));
const slotValid = computed(() => slotNumber.value !== null && slotNumber.value >= 1 && slotNumber.value <= 31);
const slot = computed(() => trackerStore.instrumentSlots.find((s) => s.slot === slotNumber.value));

const draft = ref<ModSample>(emptyModSample());
const looping = computed(() => draft.value.loopLength > 2);
const empty = computed(() => draft.value.data.length === 0);
const loadPeriod = ref(214);
const drawMode = ref(false);
const waveKind = ref<ModWaveKind>('square');
const waveLength = ref(64);
const fileEl = ref<HTMLInputElement | null>(null);
const error = ref('');

function load(): void {
  const s = slot.value;
  if (!s) {
    draft.value = emptyModSample();
    return;
  }
  draft.value = modSampleOfSlot(s, s.patchId ? trackerStore.songPatches[s.patchId] : undefined);
}

// Edits reach the song after a short pause, so dragging a slider is one rebuild, not hundreds.
const APPLY_DELAY_MS = 120;
let applyTimer: ReturnType<typeof setTimeout> | null = null;
let restrikeTimer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (applyTimer !== null) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => void apply(), APPLY_DELAY_MS);
}

async function apply(): Promise<void> {
  if (applyTimer !== null) {
    clearTimeout(applyTimer);
    applyTimer = null;
  }
  const n = slotNumber.value;
  if (n === null || !slotValid.value) return;
  const sample = draft.value;
  const current = trackerStore.instrumentSlots.find((s) => s.slot === n);
  const existing = current?.patchId ? trackerStore.songPatches[current.patchId] : undefined;
  const voices = existing?.synthState.layout?.voiceCount ?? 4;
  const patch = sample.data.length > 0 ? patchFromModSample(n, sample, existing, voices) : null;
  trackerStore.setModSample(n, patch, { name: sample.name, volume: sample.volume });
  if (patch) {
    await audioStore.songBank.rebuildInstrument(formatInstrumentId(n), patch);
  }
  if (restrike.value && heldKeys.size > 0) {
    if (restrikeTimer !== null) clearTimeout(restrikeTimer);
    restrikeTimer = setTimeout(() => {
      for (const midi of [...heldKeys]) {
        audioStore.songBank.previewNoteOff(formatInstrumentId(n), midi);
        audioStore.songBank.previewNoteOn(formatInstrumentId(n), midi, 100);
      }
    }, 150);
  }
}

function commit(next: ModSample): void {
  draft.value = next;
  schedule();
}

const edit = (op: (s: ModSample) => ModSample): void => commit(op(draft.value));
const onName = (value: string): void => commit({ ...draft.value, name: clampModName(value) });
const onVolume = (value: number): void => commit({ ...draft.value, volume: value });
const onFinetune = (value: number): void => commit({ ...draft.value, finetune: value });
const onLoop = (start: number, length: number): void => commit(withLoop(draft.value, start, length));
function onLoopToggle(event: Event): void {
  const on = (event.target as HTMLInputElement).checked;
  commit(on ? withLoop(draft.value, 0, draft.value.data.length) : { ...draft.value, loopStart: 0, loopLength: 0 });
}
function clear(): void {
  commit({ ...emptyModSample(draft.value.volume), name: draft.value.name });
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  error.value = '';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stem = clampModName(file.name.replace(/\.[^.]+$/, ''));
    const kind = amigaFormatOf(bytes, file.name);
    if (kind === 'aiff') {
      const aiff = parseAiff(bytes);
      const named: ModSample = { ...draft.value, name: aiff.name ?? (draft.value.name || stem), loopStart: 0, loopLength: 0 };
      if (aiff.data8) {
        // Already 8-bit mono: taken as it is, like the other Amiga formats.
        const next = withData(named, aiff.data8);
        commit(aiff.loopLength ? withLoop(next, aiff.loopStart ?? 0, aiff.loopLength) : next);
      } else {
        commit(fromPcm(named, aiff.pcm, aiff.rate, loadPeriod.value));
      }
      return;
    }
    if (kind) {
      // Amiga formats are already 8-bit mono at module rates: taken as they are.
      const loaded = kind === '8svx' ? parse8svx(bytes) : parseRaw(bytes);
      const base: ModSample = { ...draft.value, name: loaded.name ?? (draft.value.name || stem), volume: loaded.volume ?? draft.value.volume };
      const next = withData({ ...base, loopStart: 0, loopLength: 0 }, loaded.data);
      commit(loaded.loopLength ? withLoop(next, loaded.loopStart ?? 0, loaded.loopLength) : next);
      return;
    }
    const buffer = await audioStore.audioContext.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / buffer.numberOfChannels;
    }
    const name = draft.value.name || stem;
    commit({ ...fromPcm({ ...draft.value, name }, mono, buffer.sampleRate, loadPeriod.value) });
  } catch (caught) {
    error.value = `Could not read ${file.name}: ${(caught as Error).message}`;
  }
}

const exportFormat = ref<ModSampleFormatId>('8svx');
function exportSample(): void {
  const format = MOD_SAMPLE_FORMATS.find((f) => f.id === exportFormat.value)!;
  const sample = draft.value;
  const bytes =
    format.id === '8svx' ? write8svx(sample) : format.id === 'aiff' ? writeAiff(sample) : format.id === 'raw' ? writeRaw(sample) : toWav(sample);
  const mime = format.id === 'wav' ? 'audio/wav' : 'application/octet-stream';
  downloadBytes(bytes, exportFileName(sample.name || `sample_${slotNumber.value}`, format.extension), mime);
}

// Playing: the song bank's own instrument for this slot, so what is heard is what the song plays.
const restrike = ref(false);
const play = useAhxPlayInput({
  slot: slotNumber,
  audible: ref(true),
  sink: {
    noteOn: (n, midi, velocity) => {
      void audioStore.songBank.ensureAudioContextRunning().then(() => {
        audioStore.songBank.previewNoteOn(formatInstrumentId(n), midi, velocity);
      });
    },
    noteOff: (midi) => {
      if (slotNumber.value !== null) audioStore.songBank.previewNoteOff(formatInstrumentId(slotNumber.value), midi);
    },
  },
  autoMidi: computed(() => userSettings.settings.enableMidi),
});
const { heldKeys, latch, octave } = play;
const stripStart = computed(() => 48 + (octave.value - AHX_DEFAULT_OCTAVE) * 12);

async function backToTracker(): Promise<void> {
  await apply();
  void router.push('/tracker');
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    void backToTracker();
  }
}

watch(slotNumber, load);
onMounted(() => {
  load();
  window.addEventListener('keydown', onKeyDown);
  const n = slotNumber.value;
  if (n !== null && slot.value?.patchId && !audioStore.hasActiveInstrument(n)) {
    void audioStore.songBank.prepareInstrument(formatInstrumentId(n));
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  if (restrikeTimer !== null) clearTimeout(restrikeTimer);
  if (applyTimer !== null) void apply();
  play.releaseAll();
});
</script>

<style scoped>
.mod-page {
  background: var(--app-background, #0b111a);
  color: var(--text-primary, #e8f3ff);
}

.mod-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: linear-gradient(90deg, var(--tracker-active-bg, #14283d), var(--button-background, #1a2534));
  border-bottom: 1px solid var(--tracker-accent-secondary, #3b82a0);
}

.mod-banner__info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mod-banner__label,
.mod-banner__name {
  font-weight: 600;
}

.mod-banner__slot,
.mod-dim {
  opacity: 0.65;
}

.mod-empty {
  padding: 32px 24px;
  opacity: 0.75;
}

.mod-body {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: 12px;
  padding: 12px;
}

.mod-left,
.mod-right {
  display: grid;
  gap: 12px;
  align-content: start;
  min-width: 0;
}

.mod-card {
  margin: 0;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  display: grid;
  gap: 10px;
}

.mod-card h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.mod-field {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.mod-field--inline {
  display: inline-flex;
}

.mod-field__label {
  opacity: 0.8;
}

.mod-text,
.mod-select {
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  color: inherit;
  font-family: var(--tracker-font, monospace);
}

.mod-readout {
  font-family: var(--tracker-font, monospace);
}

.mod-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.mod-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mod-btn {
  padding: 4px 12px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
  background: var(--button-background, #1a2534);
  color: inherit;
  cursor: pointer;
}

.mod-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.mod-btn--danger:not(:disabled):hover {
  border-color: #e05a5a;
}

.mod-error {
  margin: 0;
  color: #ff8a8a;
}

@media (max-width: 900px) {
  .mod-body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
