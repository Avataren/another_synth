<template>
  <q-page class="sid-page" data-testid="sid-instrument-editor">
    <div class="sid-banner">
      <div class="sid-banner__info">
        <q-icon name="memory" size="sm" />
        <span class="sid-banner__label">SID Instrument Editor</span>
        <span v-if="slotNumber !== null" class="sid-dim">Slot #{{ formatInstrumentId(slotNumber) }}</span>
        <span class="sid-banner__name" data-testid="sid-instrument-name">{{ displayName }}</span>
        <span
          v-if="doc"
          class="sid-chip"
          data-testid="sid-chip-model"
          :title="`The song plays on a MOS ${doc.chipModel}: its filter, combined waveforms and output stage.`"
          >MOS {{ doc.chipModel }}</span
        >
        <AhxSegmented
          v-if="doc"
          label="Chip"
          :model-value="doc.chipModel === '8580' ? 0 : 1"
          :options="CHIP_OPTIONS"
          testid="sid-seg-chip"
          title="The chip the whole song plays on (a per-song setting)."
          @update:model-value="setChip($event === 0 ? '8580' : '6581')"
        />
      </div>
      <div class="sid-banner__actions">
        <q-btn
          v-if="doc"
          flat
          dense
          color="white"
          icon="add"
          label="New instrument"
          data-testid="sid-new-instrument"
          :disable="doc.instruments.length >= SID_MAX_INSTRUMENTS"
          @click="addInstrument"
        />
        <q-btn flat dense color="white" icon="arrow_back" label="Back to Tracker" title="Press Escape to return" @click="backToTracker" />
      </div>
    </div>

    <div v-if="editNotice" class="sid-notice" role="alert" data-testid="sid-notice">{{ editNotice.message }}</div>

    <div v-if="!instrument || !doc" class="sid-empty" data-testid="sid-instrument-missing">
      This slot has no SID instrument. Open a SID song in the tracker and edit one of its instruments from the list.
    </div>

    <template v-else>
      <div class="sid-sound-band" data-testid="sid-sound-band">
        <div class="sid-keys">
          <q-btn flat dense icon="remove" :disable="octave <= 0" title="Octave down" @click="octave -= 1" />
          <span class="sid-dim">Octave {{ octave }}</span>
          <q-btn flat dense icon="add" :disable="octave >= 6" title="Octave up" @click="octave += 1" />
          <AhxPianoStrip :start="12 * (octave + 1)" :held="heldKeys" @down="keyDown" @up="keyUp" />
        </div>
        <div class="sid-analyzer" data-testid="sid-analyzer-row">
          <figure class="sid-analyzer__slot">
            <OscilloscopeComponent :node="previewNode" :mono="true" data-testid="sid-analyzer-oscilloscope" />
            <figcaption class="sid-dim">Wave</figcaption>
          </figure>
          <figure class="sid-analyzer__slot">
            <FrequencyAnalyzerComponent :node="previewNode" data-testid="sid-analyzer-frequency" />
            <figcaption class="sid-dim">Spectrum</figcaption>
          </figure>
          <span v-if="!previewNode" class="sid-dim" data-testid="sid-analyzer-idle">Play a note to see it here.</span>
        </div>
      </div>

      <div class="sid-body">
        <div class="sid-col">
          <fieldset class="sid-card">
            <legend>Name &amp; waveform</legend>
            <label class="sid-field">
              <span>Name</span>
              <input
                class="sid-text"
                maxlength="16"
                :value="instrument.name"
                data-testid="sid-field-name"
                @change="edit({ name: ($event.target as HTMLInputElement).value })"
              />
            </label>
            <div class="sid-toggles" data-testid="sid-waveform-bits">
              <label v-for="bit in CONTROL_BITS" :key="bit.bit" :title="bit.title">
                <input
                  type="checkbox"
                  :checked="(instrument.waveform & bit.bit) !== 0"
                  :data-testid="`sid-bit-${bit.name}`"
                  @change="commit(toggleSidControlBit(doc, instrumentNumber, bit.bit))"
                />
                {{ bit.label }}
              </label>
            </div>
            <svg class="sid-lane" viewBox="0 0 256 64" preserveAspectRatio="none" data-testid="sid-wave-shape">
              <path v-if="waveCycle" :d="sidStepPath(waveCycle, 256, 64)" />
            </svg>
            <p class="sid-dim sid-note">{{ waveCaption }}</p>
          </fieldset>

          <fieldset class="sid-card">
            <legend>Envelope</legend>
            <AhxSliderField
              v-for="key in ADSR"
              :key="key"
              :label="ADSR_LABELS[key]"
              :model-value="instrument[key]"
              :max="15"
              :suffix="adsrSuffix(key)"
              :testid="`sid-field-${key}`"
              @update:model-value="edit({ [key]: $event })"
            />
            <svg class="sid-lane" viewBox="0 0 256 64" preserveAspectRatio="none" data-testid="sid-envelope-curve">
              <path :d="sidStepPath(envelope, 256, 64, 255)" />
            </svg>
            <p class="sid-dim sid-note">Level over 2 s at 50 Hz, the gate released after 1 s (the chip's own rates).</p>
          </fieldset>

          <fieldset class="sid-card">
            <legend>Pulse</legend>
            <AhxSliderField
              label="Pulse width"
              :model-value="instrument.pulseWidth"
              :max="0xfff"
              :suffix="`(${((instrument.pulseWidth / 4096) * 100).toFixed(1)} %)`"
              testid="sid-field-pulseWidth"
              @update:model-value="edit({ pulseWidth: $event })"
            />
            <AhxNumberField
              label="Pulse table row"
              :model-value="instrument.pulsePtr"
              :max="doc.tables.pulse.length"
              suffix="(0 = none)"
              testid="sid-field-pulsePtr"
              @update:model-value="edit({ pulsePtr: $event })"
            />
            <svg class="sid-lane" viewBox="0 0 256 48" preserveAspectRatio="none" data-testid="sid-pulse-lane">
              <path :d="sidStepPath(frames.map((f) => f[1]), 256, 48)" />
            </svg>
            <p class="sid-dim sid-note">Pulse width over the first {{ LANE_FRAMES }} frames of a note.</p>
          </fieldset>
        </div>

        <div class="sid-col">
          <fieldset class="sid-card">
            <legend>Filter</legend>
            <label class="sid-toggles">
              <input
                type="checkbox"
                :checked="instrument.filter.enabled"
                data-testid="sid-filter-enabled"
                @change="edit({ filter: { enabled: !instrument.filter.enabled } })"
              />
              Route this voice through the filter
            </label>
            <AhxSliderField
              label="Cutoff"
              :model-value="instrument.filter.cutoff"
              :max="0x7ff"
              :suffix="`(${Math.round(sidCutoffHz(doc.chipModel, instrument.filter.cutoff))} Hz on the ${doc.chipModel})`"
              testid="sid-field-cutoff"
              @update:model-value="edit({ filter: { cutoff: $event } })"
            />
            <AhxSliderField
              label="Resonance"
              :model-value="instrument.filter.resonance"
              :max="15"
              testid="sid-field-resonance"
              @update:model-value="edit({ filter: { resonance: $event } })"
            />
            <div class="sid-toggles">
              <label v-for="mode in FILTER_MODES" :key="mode.bit">
                <input
                  type="checkbox"
                  :checked="(instrument.filter.mode & mode.bit) !== 0"
                  :data-testid="`sid-filter-${mode.label}`"
                  @change="commit(toggleSidFilterMode(doc, instrumentNumber, mode.bit))"
                />
                {{ mode.label }}
              </label>
            </div>
            <AhxNumberField
              label="Filter table row"
              :model-value="instrument.filterPtr"
              :max="doc.tables.filter.length"
              suffix="(0 = the settings above)"
              testid="sid-field-filterPtr"
              @update:model-value="edit({ filterPtr: $event })"
            />
            <svg class="sid-lane" viewBox="0 0 256 48" preserveAspectRatio="none" data-testid="sid-filter-response">
              <path :d="filterPath" />
            </svg>
            <p class="sid-dim sid-note">The filter's ideal response, 30 Hz to 18 kHz (the 6581's saturation is not drawn).</p>
            <svg class="sid-lane" viewBox="0 0 256 48" preserveAspectRatio="none" data-testid="sid-cutoff-lane">
              <path :d="sidStepPath(frames.map((f) => f[3]), 256, 48, 0x7ff)" />
            </svg>
            <p class="sid-dim sid-note">Cutoff over the first {{ LANE_FRAMES }} frames of a note.</p>
          </fieldset>

          <fieldset class="sid-card">
            <legend>Tables &amp; timing</legend>
            <AhxNumberField
              label="Wave table row"
              :model-value="instrument.wavePtr"
              :max="doc.tables.wave.length"
              suffix="(0 = the waveform above)"
              testid="sid-field-wavePtr"
              @update:model-value="edit({ wavePtr: $event })"
            />
            <AhxNumberField
              label="Vibrato (speed table row)"
              :model-value="instrument.speedPtr"
              :max="doc.tables.speed.length"
              suffix="(0 = none)"
              testid="sid-field-speedPtr"
              @update:model-value="edit({ speedPtr: $event })"
            />
            <AhxNumberField
              v-for="key in TIMING_FIELDS"
              :key="key"
              :label="TIMING_LABELS[key]"
              :model-value="instrument[key]"
              :max="SID_INSTRUMENT_NUMBER_FIELDS[key]"
              :testid="`sid-field-${key}`"
              @update:model-value="edit({ [key]: $event })"
            />
            <label class="sid-toggles">
              <input type="checkbox" :checked="instrument.hardRestart" data-testid="sid-hard-restart" @change="edit({ hardRestart: !instrument.hardRestart })" />
              Hard restart (the early gate-off also zeroes the envelope)
            </label>
            <label class="sid-toggles">
              <input type="checkbox" :checked="instrument.noGateOff" data-testid="sid-no-gate-off" @change="edit({ noGateOff: !instrument.noGateOff })" />
              No gate-off (a note of this instrument skips the early gate-off and hard restart)
            </label>
            <svg class="sid-lane" viewBox="0 0 256 48" preserveAspectRatio="none" data-testid="sid-pitch-lane">
              <path :d="pitchPath" />
            </svg>
            <p class="sid-dim sid-note">Pitch over the first {{ LANE_FRAMES }} frames (arpeggio from the wave table, vibrato).</p>
          </fieldset>
        </div>

        <div class="sid-col sid-col--tables">
          <fieldset v-for="table in SID_TABLE_NAMES" :key="table" class="sid-card" :data-testid="`sid-table-${table}`">
            <legend>{{ TABLE_LABELS[table] }} table</legend>
            <table class="sid-table">
              <tbody>
                <tr
                  v-for="(row, index) in doc.tables[table]"
                  :key="index"
                  :class="{ 'sid-table__mine': reached[table].includes(index + 1) }"
                >
                  <td class="sid-dim">{{ hexByte(index + 1) }}</td>
                  <td v-for="side in SIDES" :key="side">
                    <input
                      class="sid-hex"
                      maxlength="2"
                      :value="hexByte(row[side])"
                      :data-testid="`sid-${table}-${index + 1}-${side}`"
                      @change="setTableByte(table, index, side, $event)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
            <q-btn
              flat
              dense
              size="sm"
              icon="add"
              label="Row"
              :disable="doc.tables[table].length >= SID_MAX_TABLE_ROWS"
              :data-testid="`sid-${table}-add`"
              @click="commit(editSidTableByte(doc, table, doc.tables[table].length, 'left', 0))"
            />
          </fieldset>
          <p class="sid-dim sid-note">
            The tables are the song's, shared by every instrument: a row edited here changes every instrument that
            reaches it. Rows this instrument reaches are marked. Left <code>FF</code> jumps to the row on the right
            (<code>00</code> stops).
          </p>
        </div>
      </div>
    </template>
  </q-page>
</template>

<script setup lang="ts">
/**
 * The SID instrument editor (plan-sid-tracking.md S4), on the AHX instrument
 * page's pattern: a sound band (keys + the preview voice's scope and
 * spectrum), cards per part of the sound with a drawing each, and the tables.
 *
 * It edits the song's doc, never a slot's copy: every change is a doc op
 * (`sid-instrument-edit.ts`) committed with an undo step (`editSidDoc`), and
 * the slots (names), the grid, the save and both SID worklets follow the doc.
 * The drawings are the Rust's own behaviour (`sid-instrument-visuals.ts`, held
 * to a fixture dumped from the Rust).
 *
 * The AHX PList canvas does not carry over: a PList is one instrument's own
 * rows of note/waveform/two effects, while a SID instrument points into four
 * shared two-byte tables, so the tables are edited as byte rows here.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { formatInstrumentId } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import {
  SID_MAX_INSTRUMENTS,
  SID_MAX_TABLE_ROWS,
  SID_TABLE_NAMES,
  setSidChipModel,
  type SidChipModel,
  type SidOpResult,
  type SidTableName,
} from 'src/audio/tracker/sid-doc';
import {
  SID_INSTRUMENT_NUMBER_FIELDS,
  editSidInstrument,
  editSidTableByte,
  hexByte,
  newSidInstrument,
  sidTableRowsFrom,
  toggleSidControlBit,
  toggleSidFilterMode,
  type SidInstrumentPatch,
} from 'src/audio/tracker/sid-instrument-edit';
import {
  SID_ATTACK_MS,
  sidCutoffHz,
  sidEnvelopeLevels,
  sidFilterResponseDb,
  sidStepPath,
  sidWaveCycle,
  simulateSidInstrument,
} from 'src/audio/tracker/sid-instrument-visuals';
import { ahxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import AhxSliderField from 'src/components/ahx/AhxSliderField.vue';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import AhxSegmented from 'src/components/ahx/AhxSegmented.vue';
import AhxPianoStrip from 'src/components/ahx/AhxPianoStrip.vue';
import OscilloscopeComponent from 'src/components/OscilloscopeComponent.vue';
import FrequencyAnalyzerComponent from 'src/components/FrequencyAnalyzerComponent.vue';

const route = useRoute();
const router = useRouter();
const trackerStore = useTrackerStore();
const playbackStore = useTrackerPlaybackStore();

const CHIP_OPTIONS = [
  { value: 0, label: '8580' },
  { value: 1, label: '6581' },
];
const CONTROL_BITS = [
  { bit: 0x10, name: 'triangle', label: 'Triangle', title: 'Triangle waveform' },
  { bit: 0x20, name: 'saw', label: 'Saw', title: 'Sawtooth waveform' },
  { bit: 0x40, name: 'pulse', label: 'Pulse', title: 'Pulse waveform (its width below)' },
  { bit: 0x80, name: 'noise', label: 'Noise', title: 'Noise' },
  { bit: 0x04, name: 'ring', label: 'Ring', title: 'Ring modulation by the previous voice (triangle)' },
  { bit: 0x02, name: 'sync', label: 'Sync', title: 'Hard sync to the previous voice' },
  { bit: 0x08, name: 'test', label: 'Test', title: 'Test bit: holds the oscillator at zero' },
] as const;
const FILTER_MODES = [
  { bit: 1, label: 'LP' },
  { bit: 2, label: 'BP' },
  { bit: 4, label: 'HP' },
] as const;
const ADSR = ['attack', 'decay', 'sustain', 'release'] as const;
const ADSR_LABELS = { attack: 'Attack', decay: 'Decay', sustain: 'Sustain', release: 'Release' } as const;
const TIMING_FIELDS = ['vibratoDelay', 'firstWave', 'gateTimer'] as const;
const TIMING_LABELS = { vibratoDelay: 'Vibrato delay (frames)', firstWave: 'First-frame control byte', gateTimer: 'Gate timer (frames)' } as const;
const TABLE_LABELS: Record<SidTableName, string> = { wave: 'Wave / arpeggio', pulse: 'Pulse', filter: 'Filter', speed: 'Speed (vibrato, portamento)' };
const SIDES = ['left', 'right'] as const;
const LANE_FRAMES = 96;

const slotNumber = computed<number | null>(() => {
  const raw = Array.isArray(route.params.slot) ? route.params.slot[0] : route.params.slot;
  const parsed = parseInt(String(raw ?? ''), 10);
  return Number.isNaN(parsed) ? null : parsed;
});
const doc = computed(() => (trackerStore.isSidSong ? trackerStore.sidDoc : null));
/** The instrument is the doc's `n - 1`: slot `n` lists instrument `n` (`showSidDoc`). */
const instrumentNumber = computed(() => slotNumber.value ?? 0);
const instrument = computed(() => doc.value?.instruments[instrumentNumber.value - 1] ?? null);
const displayName = computed(() => instrument.value?.name || (instrument.value ? `Instrument ${formatInstrumentId(instrumentNumber.value)}` : 'Empty'));
const editNotice = computed(() => ahxEditNotice.value);

function commit(result: SidOpResult): void {
  trackerStore.editSidDoc(result);
}
function edit(patch: SidInstrumentPatch): void {
  if (doc.value) commit(editSidInstrument(doc.value, instrumentNumber.value, patch));
}
function setChip(model: SidChipModel): void {
  if (doc.value) commit(setSidChipModel(doc.value, model));
}
function addInstrument(): void {
  if (!doc.value) return;
  if (trackerStore.editSidDoc(newSidInstrument(doc.value))) {
    void router.push({ name: 'sid-instrument-editor', params: { slot: String(trackerStore.sidDoc?.instruments.length ?? 1) } });
  }
}
function setTableByte(table: SidTableName, index: number, side: 'left' | 'right', event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = /^[0-9a-fA-F]{1,2}$/.test(input.value.trim()) ? parseInt(input.value.trim(), 16) : NaN;
  if (doc.value) commit(editSidTableByte(doc.value, table, index, side, value));
  // A refused edit leaves the doc as it was: show its byte again.
  const row = doc.value?.tables[table][index];
  if (row) input.value = hexByte(row[side]);
}

const adsrSuffix = (key: (typeof ADSR)[number]): string => {
  if (key === 'sustain') return `(${Math.round(((instrument.value?.sustain ?? 0) / 15) * 100)} %)`;
  const ms = SID_ATTACK_MS[instrument.value?.[key] ?? 0] ?? 0;
  return `(${key === 'attack' ? ms : ms * 3} ms)`;
};

// Drawings: the Rust's behaviour, ported (`sid-instrument-visuals.ts`).
const waveCycle = computed(() => (instrument.value && doc.value ? sidWaveCycle(doc.value.chipModel, instrument.value.waveform, instrument.value.pulseWidth, 256) : null));
const waveCaption = computed(() => {
  const w = instrument.value?.waveform ?? 0;
  if ((w & 0xf0) === 0) return 'No waveform: the voice holds its last level (silent).';
  if (w & 0x80) return 'Noise has no cycle to draw.';
  return `One cycle of the ${doc.value?.chipModel ?? ''} waveform, before the filter.`;
});
const envelope = computed(() => {
  const ins = instrument.value;
  if (!ins) return [];
  return sidEnvelopeLevels((ins.attack << 4) | ins.decay, (ins.sustain << 4) | ins.release, 50, 100);
});
const frames = computed(() => (doc.value && instrument.value ? simulateSidInstrument(doc.value, instrumentNumber.value, 48, LANE_FRAMES) : []));
const pitchPath = computed(() => {
  const regs = frames.value.map((f) => f[0]);
  if (regs.length === 0) return '';
  const lo = Math.min(...regs);
  const hi = Math.max(...regs);
  const span = Math.max(1, hi - lo);
  return sidStepPath(regs.map((r) => ((r - lo) / span) * 0xfff * (hi === lo ? 0.5 : 1) + (hi === lo ? 0x800 : 0)), 256, 48);
});
const filterPath = computed(() => {
  const ins = instrument.value;
  if (!ins || !doc.value) return '';
  const points = Array.from({ length: 128 }, (_, i) => {
    const hz = 30 * (18_000 / 30) ** (i / 127);
    const db = sidFilterResponseDb(doc.value!.chipModel, ins.filter.cutoff, ins.filter.resonance, ins.filter.mode, hz);
    return Math.max(0, Math.min(0xfff, ((db + 48) / 72) * 0xfff));
  });
  return sidStepPath(points, 256, 48);
});
const reached = computed(() => {
  const ins = instrument.value;
  const d = doc.value;
  const from = (table: SidTableName, ptr: number) => (d && ptr ? sidTableRowsFrom(d, table, ptr) : []);
  return {
    wave: from('wave', ins?.wavePtr ?? 0),
    pulse: from('pulse', ins?.pulsePtr ?? 0),
    filter: from('filter', ins?.filterPtr ?? 0),
    speed: from('speed', ins?.speedPtr ?? 0),
  };
});

// Audition: the preview voice (its own SID worklet), and its output for the analyzer.
const octave = ref(3);
const heldKeys = ref<Set<number>>(new Set());
const previewNode = shallowRef<AudioNode | null>(playbackStore.sidPreviewOutput());
const stopPreviewWatch = playbackStore.onSidPreviewOutput((node) => {
  previewNode.value = node;
});
function keyDown(midi: number): void {
  heldKeys.value = new Set([midi]);
  void playbackStore.previewSidNoteOn(instrumentNumber.value, midi);
}
function keyUp(midi: number): void {
  if (!heldKeys.value.has(midi)) return;
  heldKeys.value = new Set();
  playbackStore.previewSidNoteOff();
}

function backToTracker(): void {
  void router.push('/tracker');
}
function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  backToTracker();
}
onMounted(() => window.addEventListener('keydown', handleKeyDown));
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
  stopPreviewWatch();
  playbackStore.previewSidNoteOff();
});
</script>

<style scoped>
.sid-page {
  background: var(--app-background, #0b111a);
  color: var(--text-primary, #e8f3ff);
}
.sid-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: linear-gradient(90deg, var(--tracker-active-bg, #14283d), var(--button-background, #1a2534));
  border-bottom: 1px solid var(--tracker-accent-secondary, #3b82a0);
}
.sid-banner__info,
.sid-banner__actions,
.sid-keys,
.sid-toggles {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.sid-banner__label,
.sid-banner__name {
  font-weight: 600;
}
.sid-chip {
  padding: 2px 8px;
  border: 1px solid var(--tracker-accent-secondary, #3b82a0);
  border-radius: 4px;
  font-family: monospace;
}
.sid-dim {
  opacity: 0.65;
}
.sid-empty,
.sid-notice {
  padding: 16px 24px;
}
.sid-notice {
  background: rgba(255, 170, 60, 0.12);
}
.sid-sound-band {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--app-background, #0b111a);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.sid-analyzer {
  display: flex;
  align-items: center;
  gap: 12px;
}
.sid-analyzer__slot {
  margin: 0;
  width: 220px;
  height: 72px;
}
.sid-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  padding: 12px;
}
.sid-col {
  display: grid;
  gap: 12px;
  align-content: start;
}
.sid-card {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 8px 12px 12px;
  display: grid;
  gap: 8px;
}
.sid-field {
  display: flex;
  gap: 8px;
  align-items: center;
}
.sid-text,
.sid-hex {
  background: rgba(0, 0, 0, 0.3);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  padding: 2px 6px;
  font-family: monospace;
}
.sid-hex {
  width: 3em;
  text-align: center;
}
.sid-lane {
  width: 100%;
  height: 56px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
}
.sid-lane path {
  fill: none;
  stroke: var(--tracker-accent-primary, #4df2c5);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}
.sid-note {
  margin: 0;
  font-size: 0.85em;
}
.sid-table {
  border-collapse: collapse;
  font-family: monospace;
}
.sid-table td {
  padding: 1px 4px;
}
.sid-table__mine {
  background: rgba(77, 242, 197, 0.12);
}
</style>
