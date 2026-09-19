<template>
  <q-page class="ahx-page" data-testid="ahx-instrument-display">
    <div class="ahx-banner">
      <div class="ahx-banner__info">
        <q-icon name="tune" size="sm" />
        <span class="ahx-banner__label">AHX Instrument Editor</span>
        <span v-if="slotNumber !== null" class="ahx-banner__slot"
          >Slot #{{ formatInstrumentId(slotNumber) }}</span
        >
        <span class="ahx-banner__name" data-testid="ahx-instrument-name">{{
          displayName
        }}</span>
        <span
          class="ahx-banner__mode"
          data-testid="ahx-editable-badge"
          title="Every change is made to the song's own instrument: the song plays it from its next trigger, the keyboard sounds it at once, and saving keeps it."
          >Edits the song</span
        >
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

    <div v-if="!instrument" class="ahx-empty" data-testid="ahx-instrument-missing">
      This slot has no AHX instrument. Load an AHX song in the tracker and open
      one of its instruments from the list.
    </div>

    <div v-else class="ahx-body">
      <section class="ahx-card ahx-card--wide" data-testid="ahx-audition">
        <h3>
          Audition
          <span class="ahx-dim"
            >Hold a note to hear this instrument as it is now. The song plays the
            same edit from its next trigger of this instrument; a note already
            sounding keeps its volume, vibrato and wave length until it is
            struck again.</span
          >
        </h3>
        <div class="ahx-audition">
          <button
            v-for="key in AUDITION_KEYS"
            :key="key.midi"
            type="button"
            class="ahx-audition__key"
            :data-testid="`ahx-audition-${key.midi}`"
            @pointerdown.prevent="auditionOn(key.midi)"
            @pointerup="auditionOff(key.midi)"
            @pointerleave="auditionOff(key.midi)"
            @pointercancel="auditionOff(key.midi)"
          >
            {{ key.label }}
          </button>
        </div>
      </section>

      <section class="ahx-card">
        <h3>Instrument</h3>
        <div class="ahx-fields" data-testid="ahx-params">
          <AhxNumberField
            label="Volume"
            :model-value="instrument.volume"
            :max="AHX_NUMBER_FIELDS.volume"
            suffix="/ 64"
            testid="ahx-field-volume"
            @update:model-value="setNumber('volume', $event)"
          />
          <AhxNumberField
            label="Wave length"
            :model-value="instrument.waveLength"
            :max="AHX_NUMBER_FIELDS.waveLength"
            :suffix="`(${cycleLength} samples)`"
            testid="ahx-field-waveLength"
            @update:model-value="setNumber('waveLength', $event)"
          />
          <AhxNumberField
            label="Vibrato delay"
            :model-value="instrument.vibratoDelay"
            :max="AHX_NUMBER_FIELDS.vibratoDelay"
            testid="ahx-field-vibratoDelay"
            @update:model-value="setNumber('vibratoDelay', $event)"
          />
          <AhxNumberField
            label="Vibrato speed"
            :model-value="instrument.vibratoSpeed"
            :max="AHX_NUMBER_FIELDS.vibratoSpeed"
            testid="ahx-field-vibratoSpeed"
            @update:model-value="setNumber('vibratoSpeed', $event)"
          />
          <AhxNumberField
            label="Vibrato depth"
            :model-value="instrument.vibratoDepth"
            :max="AHX_NUMBER_FIELDS.vibratoDepth"
            testid="ahx-field-vibratoDepth"
            @update:model-value="setNumber('vibratoDepth', $event)"
          />
          <AhxNumberField
            label="Square lower"
            :model-value="instrument.squareLowerLimit"
            :max="AHX_NUMBER_FIELDS.squareLowerLimit"
            testid="ahx-field-squareLowerLimit"
            @update:model-value="setNumber('squareLowerLimit', $event)"
          />
          <AhxNumberField
            label="Square upper"
            :model-value="instrument.squareUpperLimit"
            :max="AHX_NUMBER_FIELDS.squareUpperLimit"
            testid="ahx-field-squareUpperLimit"
            @update:model-value="setNumber('squareUpperLimit', $event)"
          />
          <AhxNumberField
            label="Square speed"
            :model-value="instrument.squareSpeed"
            :max="AHX_NUMBER_FIELDS.squareSpeed"
            testid="ahx-field-squareSpeed"
            @update:model-value="setNumber('squareSpeed', $event)"
          />
          <AhxNumberField
            label="Filter lower"
            :model-value="instrument.filterLowerLimit"
            :max="AHX_NUMBER_FIELDS.filterLowerLimit"
            testid="ahx-field-filterLowerLimit"
            @update:model-value="setNumber('filterLowerLimit', $event)"
          />
          <AhxNumberField
            label="Filter upper"
            :model-value="instrument.filterUpperLimit"
            :max="AHX_NUMBER_FIELDS.filterUpperLimit"
            testid="ahx-field-filterUpperLimit"
            @update:model-value="setNumber('filterUpperLimit', $event)"
          />
          <AhxNumberField
            label="Filter speed"
            :model-value="instrument.filterSpeed"
            :max="AHX_NUMBER_FIELDS.filterSpeed"
            testid="ahx-field-filterSpeed"
            @update:model-value="setNumber('filterSpeed', $event)"
          />
          <div class="ahx-field-row">
            <label class="ahx-check">
              <input
                type="checkbox"
                data-testid="ahx-field-hardCutRelease"
                :checked="instrument.hardCutRelease"
                @change="setHardCut(($event.target as HTMLInputElement).checked)"
              />
              Hard cut release
            </label>
            <AhxNumberField
              compact
              :model-value="instrument.hardCutReleaseFrames"
              :max="AHX_NUMBER_FIELDS.hardCutReleaseFrames"
              :disabled="!instrument.hardCutRelease"
              suffix="frames"
              testid="ahx-field-hardCutReleaseFrames"
              @update:model-value="setNumber('hardCutReleaseFrames', $event)"
            />
          </div>
        </div>
      </section>

      <section class="ahx-card">
        <h3>Volume envelope</h3>
        <svg
          class="ahx-envelope"
          data-testid="ahx-envelope"
          :viewBox="`0 0 ${ENV_W} ${ENV_H}`"
          preserveAspectRatio="none"
          role="img"
          aria-label="Volume envelope"
        >
          <line class="ahx-envelope__axis" :x1="0" :y1="ENV_H" :x2="ENV_W" :y2="ENV_H" />
          <polyline class="ahx-envelope__line" :points="envelopePolyline" />
        </svg>
        <table class="ahx-table ahx-table--compact" data-testid="ahx-envelope-table">
          <thead>
            <tr><th>Stage</th><th>Frames</th><th>Volume</th></tr>
          </thead>
          <tbody>
            <tr v-for="stage in ENVELOPE_STAGES" :key="stage.label">
              <td>{{ stage.label }}</td>
              <td>
                <AhxNumberField
                  compact
                  :model-value="instrument.envelope[stage.frames]"
                  :max="255"
                  :testid="`ahx-env-${stage.frames}`"
                  @update:model-value="setEnvelope(stage.frames, $event)"
                />
              </td>
              <td>
                <AhxNumberField
                  v-if="stage.volume"
                  compact
                  :model-value="instrument.envelope[stage.volume]"
                  :max="AHX_EDIT_MAX_VOLUME"
                  :testid="`ahx-env-${stage.volume}`"
                  @update:model-value="setEnvelope(stage.volume, $event)"
                />
                <span v-else class="ahx-dim">holds</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="envelopeNeverRises" class="ahx-warn" data-testid="ahx-envelope-never-rises">
          Attack and decay are both 0 frames: the envelope never rises, so the
          note is silent until its release, which then swings the volume
          unpredictably. Give the attack at least 1 frame.
        </p>
      </section>

      <section class="ahx-card">
        <h3>Waveform</h3>
        <p class="ahx-dim ahx-note">
          An AHX instrument has no waveform of its own: each PList row picks one.
          These edit what the first row (the note's starting timbre) picks.
        </p>
        <div class="ahx-fields">
          <label class="ahx-field">
            <span class="ahx-field__label">Starts with</span>
            <select
              class="ahx-select"
              data-testid="ahx-start-waveform"
              :value="startWaveform"
              @change="setStartWaveform(Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="wave in WAVEFORM_CHOICES" :key="wave.value" :value="wave.value">
                {{ wave.label }}
              </option>
            </select>
          </label>
          <AhxNumberField
            label="Filter position"
            :model-value="startFilterPosition"
            :min="0"
            :max="AHX_MAX_FILTER_POSITION"
            :disabled="!canSetFilter"
            :title="
              canSetFilter
                ? 'Sets the filter position on the first PList row (0 = leave it alone)'
                : 'The first PList row has no free command slot for a filter position'
            "
            testid="ahx-start-filter"
            @update:model-value="setStartFilter"
          />
        </div>
        <ul v-if="waveforms.length" class="ahx-waves" data-testid="ahx-waveforms">
          <li v-for="wave in waveforms" :key="wave.field" class="ahx-wave">
            <svg class="ahx-wave__glyph" viewBox="0 0 32 16" aria-hidden="true">
              <path :d="WAVE_GLYPH[wave.kind]" />
            </svg>
            <span class="ahx-wave__name">{{ waveLabel(wave.field) }}</span>
            <span class="ahx-dim"
              >first at row {{ hex2(wave.firstRow) }}, used {{ wave.count }}×</span
            >
          </li>
        </ul>
        <p v-else class="ahx-dim">The PList selects no waveform.</p>
      </section>

      <section class="ahx-card ahx-card--wide">
        <h3>
          PList
          <span class="ahx-dim" data-testid="ahx-plist-summary"
            >{{ instrument.plist.entries.length }} rows, speed
            {{ instrument.plist.speed }}</span
          >
        </h3>
        <div class="ahx-fields ahx-fields--inline">
          <AhxNumberField
            label="Speed"
            :model-value="instrument.plist.speed"
            :max="255"
            suffix="ticks per row"
            testid="ahx-plist-speed"
            @update:model-value="setPListSpeed"
          />
          <button
            type="button"
            class="ahx-btn"
            data-testid="ahx-plist-add"
            :disabled="instrument.plist.entries.length >= AHX_MAX_PLIST_ENTRIES"
            @click="addRow()"
          >
            Add row
          </button>
        </div>
        <div v-if="instrument.plist.entries.length" class="ahx-plist-scroll">
          <table class="ahx-table" data-testid="ahx-plist">
            <thead>
              <tr>
                <th>Row</th><th>Note</th><th>Waveform</th><th>Fixed</th>
                <th>FX 1</th><th>FX 2</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(entry, index) in instrument.plist.entries" :key="index">
                <td class="ahx-dim">{{ hex2(index) }}</td>
                <td>
                  <AhxNumberField
                    compact
                    :model-value="entry.note"
                    :max="AHX_PLIST_MAX_NOTE"
                    :title="`${ahxNoteName(entry.note)} (0 = keep the pitch)`"
                    :testid="`ahx-plist-${index}-note`"
                    @update:model-value="editEntry(index, { field: 'note', value: $event })"
                  />
                </td>
                <td>
                  <select
                    class="ahx-select"
                    :data-testid="`ahx-plist-${index}-waveform`"
                    :value="entry.waveform"
                    @change="editEntry(index, { field: 'waveform', value: Number(($event.target as HTMLSelectElement).value) })"
                  >
                    <option v-for="wave in WAVEFORM_CHOICES" :key="wave.value" :value="wave.value">
                      {{ wave.label }}
                    </option>
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    :data-testid="`ahx-plist-${index}-fixed`"
                    :checked="entry.fixed"
                    @change="editEntry(index, { field: 'fixed', value: ($event.target as HTMLInputElement).checked })"
                  />
                </td>
                <td v-for="slotIndex in FX_SLOTS" :key="slotIndex" class="ahx-plist-fx">
                  <select
                    class="ahx-select"
                    :data-testid="`ahx-plist-${index}-fx${slotIndex}`"
                    :title="ahxPListFxName(entry.fx[slotIndex] ?? 0, entry.fxParam[slotIndex] ?? 0)"
                    :value="entry.fx[slotIndex]"
                    @change="editEntry(index, { field: 'fx', slot: slotIndex, value: Number(($event.target as HTMLSelectElement).value) })"
                  >
                    <option v-for="fx in FX_CHOICES" :key="fx.value" :value="fx.value">
                      {{ fx.label }}
                    </option>
                  </select>
                  <AhxNumberField
                    compact
                    :model-value="entry.fxParam[slotIndex] ?? 0"
                    :max="255"
                    :testid="`ahx-plist-${index}-param${slotIndex}`"
                    @update:model-value="editEntry(index, { field: 'fxParam', slot: slotIndex, value: $event })"
                  />
                </td>
                <td class="ahx-plist-actions">
                  <button
                    type="button"
                    class="ahx-btn ahx-btn--small"
                    :data-testid="`ahx-plist-insert-${index}`"
                    :disabled="instrument.plist.entries.length >= AHX_MAX_PLIST_ENTRIES"
                    title="Insert an empty row after this one"
                    @click="addRow(index)"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    class="ahx-btn ahx-btn--small"
                    :data-testid="`ahx-plist-remove-${index}`"
                    title="Remove this row"
                    @click="removeRow(index)"
                  >
                    ×
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="ahx-dim">This instrument has no PList. Add a row to give it one.</p>
      </section>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  AHX_MAX_PLIST_ENTRIES,
  AHX_PLIST_MAX_NOTE,
  ahxPListCommandsFor,
  formatInstrumentId,
  type AhxEnvelope,
  type AhxInstrument,
} from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import {
  AHX_MAX_VOLUME,
  ahxEnvelopePoints,
  ahxNoteName,
  ahxPListFxName,
  ahxWaveCycleLength,
  ahxWaveformLabel,
  ahxWaveformList,
  type AhxWaveformKind,
} from 'src/audio/tracker/ahx-instrument-display';
import {
  AHX_EDIT_MAX_VOLUME,
  AHX_MAX_FILTER_POSITION,
  AHX_NUMBER_FIELDS,
  addAhxPListEntry,
  ahxEnvelopeNeverRises,
  ahxStartFilterPosition,
  ahxStartWaveform,
  canSetAhxStartFilterPosition,
  editAhxPListEntry,
  removeAhxPListEntry,
  setAhxEnvelope,
  setAhxHardCutRelease,
  setAhxNumber,
  setAhxPListSpeed,
  setAhxStartFilterPosition,
  setAhxStartWaveform,
  type AhxNumberFieldKey,
  type AhxPListEdit,
} from 'src/audio/tracker/ahx-instrument-edit';

const route = useRoute();
const router = useRouter();
const trackerStore = useTrackerStore();
const playbackStore = useTrackerPlaybackStore();

const ENV_W = 240;
const ENV_H = 80;

const slotNumber = computed<number | null>(() => {
  const raw = Array.isArray(route.params.slot) ? route.params.slot[0] : route.params.slot;
  const parsed = parseInt(String(raw ?? ''), 10);
  return Number.isNaN(parsed) ? null : parsed;
});

const slot = computed(() =>
  trackerStore.instrumentSlots.find((s) => s.slot === slotNumber.value),
);
const instrument = computed(() => slot.value?.ahxData ?? null);
const displayName = computed(
  () => slot.value?.instrumentName || slot.value?.patchName || 'Empty',
);

const cycleLength = computed(() =>
  instrument.value ? ahxWaveCycleLength(instrument.value.waveLength) : 0,
);
const waveforms = computed(() =>
  instrument.value ? ahxWaveformList(instrument.value) : [],
);
const envelopeNeverRises = computed(() =>
  instrument.value ? ahxEnvelopeNeverRises(instrument.value) : false,
);
const startWaveform = computed(() =>
  instrument.value ? ahxStartWaveform(instrument.value) : 0,
);
const startFilterPosition = computed(() =>
  instrument.value ? ahxStartFilterPosition(instrument.value) : 0,
);
const canSetFilter = computed(() =>
  instrument.value ? canSetAhxStartFilterPosition(instrument.value) : false,
);

/** Envelope scaled into the SVG box: time along x, volume 0..64 up y. */
const envelopePolyline = computed(() => {
  if (!instrument.value) return '';
  const points = ahxEnvelopePoints(instrument.value.envelope);
  const totalFrames = Math.max(1, points[points.length - 1]?.frame ?? 1);
  return points
    .map((p) => {
      const x = (p.frame / totalFrames) * ENV_W;
      const y = ENV_H - (p.volume / AHX_MAX_VOLUME) * ENV_H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

const WAVE_GLYPH: Record<AhxWaveformKind | 'unknown', string> = {
  triangle: 'M0 8 L8 1 L24 15 L32 8',
  sawtooth: 'M0 15 L16 1 L16 15 L32 1',
  square: 'M0 15 L0 2 L16 2 L16 14 L32 14 L32 2',
  noise: 'M0 8 L3 3 L5 13 L8 6 L11 14 L14 2 L17 11 L20 4 L23 13 L26 5 L29 12 L32 8',
  unknown: 'M0 8 L32 8',
};

/** What a PList row's waveform field can be: 0 keeps the voice's, 1..=4 the four waves. */
const WAVEFORM_CHOICES = [0, 1, 2, 3, 4].map((value) => ({
  value,
  label: value === 0 ? 'Keep' : ahxWaveformLabel(value),
}));

const ENVELOPE_STAGES: ReadonlyArray<{
  label: string;
  frames: keyof AhxEnvelope;
  volume?: keyof AhxEnvelope;
}> = [
  { label: 'Attack', frames: 'aFrames', volume: 'aVolume' },
  { label: 'Decay', frames: 'dFrames', volume: 'dVolume' },
  { label: 'Sustain', frames: 'sFrames' },
  { label: 'Release', frames: 'rFrames', volume: 'rVolume' },
];

const FX_SLOTS = [0, 1] as const;
const FX_CHOICES = ahxPListCommandsFor('ahx').map((value) => ({
  value,
  label: `${value.toString(16).toUpperCase()} ${ahxPListFxName(value, 1) || 'none'}`,
}));

const waveLabel = ahxWaveformLabel;
const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');

/**
 * Every control ends here: the edit is committed to the song (the slot's
 * `ahxData` and the instrument the worklets play), not to a copy.
 */
function commit(edit: (current: AhxInstrument) => AhxInstrument): void {
  const current = instrument.value;
  if (!current || slotNumber.value === null) return;
  trackerStore.updateAhxInstrument(slotNumber.value, edit(current));
}

const setNumber = (field: AhxNumberFieldKey, value: number) =>
  commit((ins) => setAhxNumber(ins, field, value));
const setHardCut = (on: boolean) => commit((ins) => setAhxHardCutRelease(ins, on));
const setEnvelope = (field: keyof AhxEnvelope, value: number) =>
  commit((ins) => setAhxEnvelope(ins, field, value));
const setStartWaveform = (value: number) => commit((ins) => setAhxStartWaveform(ins, value));
const setStartFilter = (value: number) => commit((ins) => setAhxStartFilterPosition(ins, value));
const setPListSpeed = (value: number) => commit((ins) => setAhxPListSpeed(ins, value));
const editEntry = (row: number, edit: AhxPListEdit) =>
  commit((ins) => editAhxPListEntry(ins, row, edit));
const addRow = (after?: number) => commit((ins) => addAhxPListEntry(ins, after));
const removeRow = (row: number) => commit((ins) => removeAhxPListEntry(ins, row));

/** Middle-of-the-keyboard notes to hold: C-2 .. C-5 as MIDI. */
const AUDITION_KEYS = [
  { midi: 48, label: 'C-3' },
  { midi: 60, label: 'C-4' },
  { midi: 72, label: 'C-5' },
];
const held = new Set<number>();

function auditionOn(midi: number): void {
  if (slotNumber.value === null || held.has(midi)) return;
  held.add(midi);
  void playbackStore.previewAhxNoteOn(slotNumber.value, midi, 100);
}

function auditionOff(midi: number): void {
  if (!held.delete(midi)) return;
  playbackStore.previewAhxNoteOff(midi);
}

function backToTracker() {
  void router.push('/tracker');
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    backToTracker();
  }
}

onMounted(() => window.addEventListener('keydown', handleKeyDown));
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
  for (const midi of [...held]) auditionOff(midi);
});
</script>

<style scoped>
.ahx-page {
  background: var(--app-background, #0b111a);
  color: var(--text-primary, #e8f3ff);
}

.ahx-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: linear-gradient(
    90deg,
    var(--tracker-active-bg, #14283d),
    var(--button-background, #1a2534)
  );
  border-bottom: 1px solid var(--tracker-accent-secondary, #3b82a0);
}

.ahx-banner__info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ahx-banner__label {
  font-weight: 600;
}

.ahx-banner__slot,
.ahx-dim {
  opacity: 0.65;
}

.ahx-banner__name {
  font-weight: 600;
}

.ahx-empty {
  padding: 32px 24px;
  opacity: 0.75;
}

.ahx-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  padding: 12px;
}

.ahx-card {
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}

.ahx-card--wide {
  grid-column: 1 / -1;
}

.ahx-card h3 {
  margin: 0 0 8px;
  font-size: 0.95rem;
  font-weight: 600;
}

.ahx-card h3 .ahx-dim {
  margin-left: 8px;
  font-size: 0.8rem;
  font-weight: 400;
}

.ahx-params {
  margin: 0;
  display: grid;
  gap: 4px;
}

.ahx-params > div {
  display: flex;
  gap: 12px;
}

.ahx-params dt {
  flex: 0 0 140px;
  opacity: 0.65;
}

.ahx-params dd {
  margin: 0;
}

.ahx-envelope {
  width: 100%;
  height: 90px;
  margin-bottom: 8px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
}

.ahx-envelope__axis {
  stroke: rgba(255, 255, 255, 0.2);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.ahx-envelope__line {
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.ahx-waves {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}

.ahx-wave {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ahx-wave__glyph {
  width: 40px;
  height: 20px;
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 1.5;
}

.ahx-wave__name {
  min-width: 70px;
}

.ahx-plist-scroll {
  max-height: 420px;
  overflow-y: auto;
}

.ahx-table {
  border-collapse: collapse;
  font-family: var(--tracker-font, monospace);
  font-size: 0.85rem;
}

.ahx-table th,
.ahx-table td {
  padding: 2px 14px 2px 0;
  text-align: left;
  white-space: nowrap;
}

.ahx-table th {
  position: sticky;
  top: 0;
  opacity: 0.65;
  font-weight: 500;
  background: var(--app-background, #0b111a);
}

.ahx-table--compact th {
  position: static;
}

.ahx-banner__mode {
  padding: 1px 8px;
  border: 1px solid currentColor;
  border-radius: 10px;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--tracker-accent-secondary, #5ec2e8);
}

.ahx-fields {
  display: grid;
  gap: 6px;
}

.ahx-fields--inline {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 8px;
}

.ahx-field-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ahx-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ahx-field__label {
  min-width: 110px;
  opacity: 0.65;
}

.ahx-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 110px;
}

.ahx-select {
  padding: 2px 4px;
  color: inherit;
  font: inherit;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 3px;
}

.ahx-btn {
  padding: 3px 12px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.ahx-btn:disabled {
  cursor: default;
  opacity: 0.4;
}

.ahx-btn--small {
  padding: 0 8px;
}

.ahx-note {
  margin: 0 0 8px;
  font-size: 0.8rem;
}

.ahx-warn {
  margin: 6px 0 0;
  color: #f0b25e;
  font-size: 0.8rem;
}

.ahx-audition {
  display: flex;
  gap: 8px;
}

.ahx-audition__key {
  min-width: 64px;
  padding: 10px 16px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  user-select: none;
  touch-action: none;
  background: var(--button-background, #1a2534);
  border: 1px solid var(--tracker-accent-secondary, #3b82a0);
  border-radius: 4px;
}

.ahx-audition__key:active {
  background: var(--tracker-active-bg, #14283d);
}

.ahx-plist-fx {
  white-space: nowrap;
}

.ahx-plist-fx .ahx-select {
  margin-right: 4px;
}

.ahx-plist-actions {
  white-space: nowrap;
}
</style>
