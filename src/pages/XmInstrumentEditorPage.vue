<template>
  <q-page class="xm-page" data-testid="xm-instrument-editor">
    <div class="xm-banner">
      <div class="xm-banner__info">
        <FormatBadge data-testid="xm-format-badge" brand="xm" />
        <span class="xm-banner__label">Instrument Editor</span>
        <span v-if="slotNumber !== null" class="xm-banner__slot">Slot #{{ formatInstrumentId(slotNumber) }}</span>
        <span class="xm-banner__name" data-testid="xm-instrument-title">{{ draft.name || '(unnamed)' }}</span>
      </div>
      <q-btn flat dense color="white" icon="arrow_back" label="Back to Tracker" title="Press Escape to return" @click="backToTracker" />
    </div>

    <div v-if="!slotValid" class="xm-empty" data-testid="xm-instrument-missing">
      A module holds instruments 1-128. Open one from the instrument list in the tracker.
    </div>

    <template v-else>
      <div class="xm-sound-band">
        <AhxAuditionBar
          :audible="true"
          :held-keys="heldKeys"
          v-model:latch="latch"
          v-model:restrike="restrike"
          :octave="octave"
          :strip-start="stripStart"
          :midi-status="play.midiStatus.value"
          hint="Play with the keyboard (Z-M, Q-P), MIDI or the keys. The keymap decides which sample each key plays."
          restrike-title="Strike the held note again shortly after each edit."
          @pointer-down="play.pointerDown"
          @pointer-up="play.pointerUp"
          @set-octave="play.setOctave"
          @toggle-midi="play.toggleMidi"
        />
      </div>

      <div class="xm-body">
        <div class="xm-left">
          <section class="xm-card" data-testid="xm-card-instrument">
            <h3>Instrument</h3>
            <label class="xm-field">
              <span class="xm-field__label">Name</span>
              <input class="xm-text" type="text" :maxlength="XM_NAME_LENGTH" :value="draft.name" data-testid="xm-name" @input="onName(($event.target as HTMLInputElement).value)" />
            </label>
            <AhxSliderField label="Fadeout" :model-value="draft.volumeFadeout" :min="0" :max="4095" testid="xm-fadeout" title="How fast the note dies away after key-off (needs the volume envelope on)." @update:model-value="(v: number) => commit({ ...draft, volumeFadeout: v })" />
            <h4>Autovibrato</h4>
            <label class="xm-field">
              <span class="xm-field__label">Type</span>
              <select class="xm-select" :value="draft.vibratoType" data-testid="xm-vib-type" @change="onVibType(($event.target as HTMLSelectElement).value)">
                <option v-for="(label, i) in VIBRATO_TYPES" :key="i" :value="i">{{ label }}</option>
              </select>
            </label>
            <AhxSliderField label="Sweep" :model-value="draft.vibratoSweep" :min="0" :max="255" testid="xm-vib-sweep" @update:model-value="(v: number) => commit({ ...draft, vibratoSweep: v })" />
            <AhxSliderField label="Depth" :model-value="draft.vibratoDepth" :min="0" :max="15" testid="xm-vib-depth" @update:model-value="(v: number) => commit({ ...draft, vibratoDepth: v })" />
            <AhxSliderField label="Rate" :model-value="draft.vibratoRate" :min="0" :max="63" testid="xm-vib-rate" @update:model-value="(v: number) => commit({ ...draft, vibratoRate: v })" />
          </section>

          <section class="xm-card" data-testid="xm-card-samples">
            <h3>Samples <span class="xm-dim">{{ draft.samples.length }}/{{ XM_MAX_SAMPLES_PER_INSTRUMENT }}</span></h3>
            <ol class="xm-samples" data-testid="xm-sample-list">
              <li v-for="(s, i) in draft.samples" :key="i">
                <button type="button" class="xm-sample" :class="{ 'xm-sample--selected': i === selected }" :style="{ '--xm-sample-hue': (i * 47 + 200) % 360 }" :data-testid="`xm-sample-${i}`" @click="selected = i">
                  <span class="xm-sample__no">{{ i + 1 }}</span>
                  <span class="xm-sample__name">{{ s.name || '(unnamed)' }}</span>
                  <span class="xm-dim">{{ s.data.length }}</span>
                </button>
              </li>
            </ol>
            <div class="xm-tools">
              <button type="button" class="xm-btn" :disabled="draft.samples.length >= XM_MAX_SAMPLES_PER_INSTRUMENT" data-testid="xm-sample-add" @click="onAddSample">Add</button>
              <button type="button" class="xm-btn" :disabled="!sample || draft.samples.length >= XM_MAX_SAMPLES_PER_INSTRUMENT" data-testid="xm-sample-duplicate" @click="onDuplicate">Duplicate</button>
              <button type="button" class="xm-btn xm-btn--danger" :disabled="!sample" data-testid="xm-sample-remove" @click="onRemoveSample">Remove</button>
            </div>
          </section>

          <section v-if="sample" class="xm-card" data-testid="xm-card-sample">
            <h3>Sample {{ selected + 1 }}</h3>
            <label class="xm-field">
              <span class="xm-field__label">Name</span>
              <input class="xm-text" type="text" :maxlength="XM_NAME_LENGTH" :value="sample.name" data-testid="xm-sample-name" @input="editSample({ name: clampXmName(($event.target as HTMLInputElement).value) })" />
            </label>
            <AhxSliderField label="Volume" :model-value="sample.volume" :min="0" :max="64" testid="xm-volume" @update:model-value="(v: number) => editSample({ volume: v })" />
            <AhxSliderField label="Panning" :model-value="sample.panning" :min="0" :max="255" testid="xm-panning" title="128 is the centre." @update:model-value="(v: number) => editSample({ panning: v })" />
            <AhxSliderField label="Relative note" :model-value="sample.relativeNote" :min="-96" :max="95" testid="xm-relnote" title="Semitones the sample is transposed by." @update:model-value="(v: number) => editSample({ relativeNote: v })" />
            <AhxSliderField label="Finetune" :model-value="sample.finetune" :min="-128" :max="127" testid="xm-finetune" @update:model-value="(v: number) => editSample({ finetune: v })" />
            <label class="xm-field">
              <span class="xm-field__label">Bits</span>
              <select class="xm-select" :value="sample.bits" data-testid="xm-bits" @change="onBits(($event.target as HTMLSelectElement).value)">
                <option value="8">8-bit</option>
                <option value="16">16-bit</option>
              </select>
            </label>
            <div class="xm-readout" data-testid="xm-length">{{ sample.data.length }} frames <span class="xm-dim">{{ sample.data.length * (sample.bits / 8) }} bytes</span></div>
          </section>

          <section v-if="sample" class="xm-card" data-testid="xm-card-new">
            <h3>New sample</h3>
            <label class="xm-field">
              <span class="xm-field__label">Wave</span>
              <select v-model="waveKind" class="xm-select" data-testid="xm-new-wave">
                <option v-for="k in XM_WAVE_KINDS" :key="k" :value="k">{{ k }}</option>
              </select>
            </label>
            <label class="xm-field">
              <span class="xm-field__label">{{ waveKind === 'pulse' ? 'Cycle' : 'Length' }}</span>
              <select v-model.number="waveLength" class="xm-select" data-testid="xm-new-length">
                <option v-for="n in XM_WAVE_LENGTHS" :key="n" :value="n">{{ n }}</option>
              </select>
            </label>
            <template v-if="waveKind === 'pulse'">
              <AhxSliderField label="Duty from" suffix="%" :model-value="pulse.dutyStart" :min="1" :max="99" testid="xm-pulse-from" @update:model-value="(v: number) => (pulse.dutyStart = v)" />
              <AhxSliderField label="Duty to" suffix="%" :model-value="pulse.dutyEnd" :min="1" :max="99" testid="xm-pulse-to" @update:model-value="(v: number) => (pulse.dutyEnd = v)" />
              <label class="xm-field">
                <span class="xm-field__label">Cycles</span>
                <select v-model.number="pulse.cycles" class="xm-select" data-testid="xm-pulse-cycles">
                  <option v-for="n in PULSE_CYCLES" :key="n" :value="n">{{ n }}</option>
                </select>
              </label>
              <label class="xm-field">
                <span class="xm-field__label">Sweep</span>
                <select v-model="pulse.sweep" class="xm-select" data-testid="xm-pulse-sweep">
                  <option value="pingpong">there and back</option>
                  <option value="up">one way</option>
                </select>
              </label>
            </template>
            <button type="button" class="xm-btn" data-testid="xm-new-create" @click="createWave">{{ empty ? 'Create' : 'Replace with new' }}</button>
          </section>

          <section v-if="sample" class="xm-card" data-testid="xm-card-drum">
            <h3>Drum</h3>
            <label class="xm-field">
              <span class="xm-field__label">Kind</span>
              <select :value="drumKind" class="xm-select" data-testid="xm-drum-kind" @change="onDrumKind(($event.target as HTMLSelectElement).value as DrumKind)">
                <option v-for="k in DRUM_KINDS" :key="k" :value="k">{{ k }}</option>
              </select>
            </label>
            <label class="xm-field">
              <span class="xm-field__label">Rate</span>
              <select v-model.number="drumPeriod" class="xm-select" data-testid="xm-drum-rate" @change="regenDrum">
                <option v-for="r in DRUM_RATES" :key="r.period" :value="r.period">{{ r.label }}</option>
              </select>
            </label>
            <AhxSliderField v-if="drumKind !== 'clap'" label="Pitch" suffix="Hz" :model-value="drum.pitch" :min="DRUM_RANGES.pitch.min" :max="DRUM_RANGES.pitch.max" testid="xm-drum-pitch" @update:model-value="(v: number) => setDrum('pitch', v)" />
            <AhxSliderField label="Decay" suffix="ms" :model-value="drum.decay" :min="DRUM_RANGES.decay.min" :max="DRUM_RANGES.decay.max" testid="xm-drum-decay" @update:model-value="(v: number) => setDrum('decay', v)" />
            <AhxSliderField label="Noise" suffix="%" :model-value="drum.noise" :min="0" :max="100" testid="xm-drum-noise" @update:model-value="(v: number) => setDrum('noise', v)" />
            <AhxSliderField label="Filter" suffix="Hz" :model-value="drum.cutoff" :min="DRUM_RANGES.cutoff.min" :max="DRUM_RANGES.cutoff.max" testid="xm-drum-cutoff" @update:model-value="(v: number) => setDrum('cutoff', v)" />
            <AhxSliderField label="Snap" suffix="%" :model-value="drum.snap" :min="0" :max="100" testid="xm-drum-snap" @update:model-value="(v: number) => setDrum('snap', v)" />
            <div class="xm-tools">
              <button type="button" class="xm-btn" data-testid="xm-drum-create" @click="createDrum">{{ empty || !drumLive ? 'Create' : 'Re-roll' }}</button>
            </div>
          </section>

          <section v-if="sample" class="xm-card" data-testid="xm-card-loop">
            <h3>Loop</h3>
            <label class="xm-field">
              <span class="xm-field__label">Type</span>
              <select class="xm-select" :value="sample.loopType" :disabled="sample.data.length < 2" data-testid="xm-loop-type" @change="onLoopType(($event.target as HTMLSelectElement).value)">
                <option value="none">Off</option>
                <option value="forward">Forward</option>
                <option value="pingpong">Ping-pong</option>
              </select>
            </label>
            <template v-if="sample.loopType !== 'none'">
              <AhxNumberField label="Start" :model-value="sample.loopStart" :min="0" :max="Math.max(0, sample.data.length - 1)" testid="xm-loop-start" @update:model-value="(v: number) => onLoop(v, sample!.loopLength)" />
              <AhxNumberField label="Length" :model-value="sample.loopLength" :min="2" :max="Math.max(2, sample.data.length - sample.loopStart)" testid="xm-loop-length" @update:model-value="(v: number) => onLoop(sample!.loopStart, v)" />
            </template>
          </section>
        </div>

        <div class="xm-right">
          <section class="xm-card" data-testid="xm-card-wave">
            <h3>Waveform</h3>
            <XmWaveform :data="sample?.data ?? EMPTY" :loop-start="sample?.loopStart ?? 0" :loop-length="sample && sample.loopType !== 'none' ? sample.loopLength : 0" :draw="drawMode" @update:loop="onLoop" @update:data="onDraw" />
            <div class="xm-tools" data-testid="xm-tools">
              <label class="xm-check" title="Drag on the waveform to draw it by hand">
                <input v-model="drawMode" type="checkbox" :disabled="empty" data-testid="xm-draw" />
                Draw
              </label>
              <button type="button" class="xm-btn" :disabled="!sample" data-testid="xm-load" title="WAV, AIFF, IFF 8SVX, raw PCM or any audio file" @click="fileEl?.click()">Import…</button>
              <label class="xm-field xm-field--inline" title="How a raw file is read">
                <span class="xm-field__label">Raw is</span>
                <select v-model.number="rawBits" class="xm-select" data-testid="xm-raw-bits">
                  <option :value="8">8-bit</option>
                  <option :value="16">16-bit</option>
                </select>
              </label>
              <label class="xm-field xm-field--inline">
                <span class="xm-field__label">Export</span>
                <select v-model="exportFormat" class="xm-select" data-testid="xm-export-format">
                  <option v-for="f in XM_SAMPLE_FORMATS" :key="f.id" :value="f.id">{{ f.label }}</option>
                </select>
              </label>
              <button type="button" class="xm-btn" :disabled="empty" data-testid="xm-export" @click="exportSample">Export</button>
              <button type="button" class="xm-btn" :disabled="empty" data-testid="xm-normalize" @click="edit(normalize)">Normalize</button>
              <button type="button" class="xm-btn" :disabled="empty" data-testid="xm-reverse" @click="edit(reverse)">Reverse</button>
              <button type="button" class="xm-btn" :disabled="empty" data-testid="xm-halve" @click="edit(halve)">Half length</button>
              <button type="button" class="xm-btn xm-btn--danger" :disabled="empty" data-testid="xm-clear" @click="clear">Clear</button>
              <input ref="fileEl" type="file" accept=".wav,.iff,.8svx,.aif,.aiff,.raw,.sam,.smp,.snd,.sample,.pcm,audio/*" hidden data-testid="xm-file" @change="onFile" />
            </div>
            <p v-if="error" class="xm-error" role="alert" data-testid="xm-error">{{ error }}</p>
          </section>

          <section class="xm-card" data-testid="xm-card-keymap">
            <h3>Keymap</h3>
            <XmKeymap :keymap="draft.keymap" :selected="selected" @paint="onPaint" />
            <p class="xm-dim">Drag across the keys to point them at sample {{ selected + 1 }}.</p>
          </section>

          <section class="xm-card" data-testid="xm-card-volume-env">
            <h3>Volume envelope</h3>
            <XmEnvelopeEditor kind="volume" :envelope="draft.volumeEnvelope" @update:envelope="(e, preset) => onEnvelope('volumeEnvelope', e, preset)" />
          </section>

          <section class="xm-card" data-testid="xm-card-panning-env">
            <h3>Panning envelope</h3>
            <XmEnvelopeEditor kind="panning" :envelope="draft.panningEnvelope" @update:envelope="(e) => onEnvelope('panningEnvelope', e)" />
          </section>
        </div>
      </div>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  XM_MAX_SAMPLES_PER_INSTRUMENT,
  formatInstrumentId,
  xmMetaOf,
  type XmEnvelope,
  type XmInstrument,
  type XmSample,
} from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerAudioStore } from 'src/stores/tracker-audio-store';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import { AHX_DEFAULT_OCTAVE, useAhxPlayInput } from 'src/composables/useAhxPlayInput';
import { slotOf } from 'src/router/ahx-slot-guard';
import { downloadBytes } from 'src/audio/tracker/song-export/download';
import { exportFileName } from 'src/audio/tracker/song-export/file-name';
import { patchFromXmInstrument, xmInstrumentOfSlot } from 'src/audio/tracker/xm-instrument-codec';
import {
  XM_NAME_LENGTH,
  XM_WAVE_KINDS,
  XM_WAVE_LENGTHS,
  type XmPulseParams,
  type XmWaveKind,
  addSample,
  clampXmName,
  duplicateSample,
  emptyXmInstrument,
  emptyXmSample,
  fromPcm,
  generatePulse,
  generateWave,
  halve,
  normalize,
  paintKeymap,
  removeSample,
  reverse,
  setBits,
  withData,
  withLoop,
  withoutLoop,
  withSample,
} from 'src/audio/tracker/xm-sample-ops';
import { XM_SAMPLE_FORMATS, readXmSampleFile, sampleNameFromFile, writeXmSampleFile, type XmSampleFormatId } from 'src/audio/tracker/xm-sample-formats';
import { DRUM_KINDS, DRUM_PRESETS, DRUM_RANGES, DRUM_RATES, generateDrum, type DrumKind, type DrumParams } from 'src/audio/tracker/mod-drum-synth';
import AhxAuditionBar from 'src/components/ahx/AhxAuditionBar.vue';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import AhxSliderField from 'src/components/ahx/AhxSliderField.vue';
import FormatBadge from 'src/components/FormatBadge.vue';
import XmEnvelopeEditor from 'src/components/xm/XmEnvelopeEditor.vue';
import XmKeymap from 'src/components/xm/XmKeymap.vue';
import XmWaveform from 'src/components/xm/XmWaveform.vue';

const route = useRoute();
const router = useRouter();
const trackerStore = useTrackerStore();
const audioStore = useTrackerAudioStore();
const userSettings = useUserSettingsStore();

const EMPTY = new Float32Array(0);
const VIBRATO_TYPES = ['Sine', 'Square', 'Ramp up', 'Ramp down'];
const PULSE_CYCLES = [4, 8, 16, 32, 64];

const slotNumber = computed(() => slotOf(route.params.slot));
const slotValid = computed(() => slotNumber.value !== null && slotNumber.value >= 1 && slotNumber.value <= 128);
const slot = computed(() => trackerStore.instrumentSlots.find((s) => s.slot === slotNumber.value));

const draft = ref<XmInstrument>(emptyXmInstrument());
const selected = ref(0);
const sample = computed<XmSample | undefined>(() => draft.value.samples[selected.value]);
const empty = computed(() => !sample.value || sample.value.data.length === 0);
const drawMode = ref(false);
const waveKind = ref<XmWaveKind>('square');
const waveLength = ref(64);
const pulse = reactive<Pick<XmPulseParams, 'dutyStart' | 'dutyEnd' | 'cycles' | 'sweep'>>({ dutyStart: 12, dutyEnd: 50, cycles: 16, sweep: 'pingpong' });
const rawBits = ref<8 | 16>(8);
const fileEl = ref<HTMLInputElement | null>(null);
const error = ref('');

// A drum stays editable ("live") until something else changes the audio.
const drumKind = ref<DrumKind>('kick');
const drum = reactive<DrumParams>({ ...DRUM_PRESETS.kick });
const drumPeriod = ref(428);
const drumLive = ref(false);
let drumSeed = 1;

function load(): void {
  const s = slot.value;
  const loaded = s ? xmInstrumentOfSlot(s, s.patchId ? trackerStore.songPatches[s.patchId] : undefined) : undefined;
  draft.value = loaded ?? emptyXmInstrument();
  selected.value = 0;
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
  const instrument = draft.value;
  const current = trackerStore.instrumentSlots.find((s) => s.slot === n);
  const existing = current?.patchId ? trackerStore.songPatches[current.patchId] : undefined;
  const voices = existing?.synthState.layout?.voiceCount ?? trackerStore.patterns[0]?.tracks.length ?? 8;
  const patch = patchFromXmInstrument(n, instrument, existing, voices);
  const named = instrument.name !== '' || instrument.samples.length > 0;
  trackerStore.setXmInstrument(n, patch, named ? xmMetaOf(instrument) : null);
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

function commit(next: XmInstrument): void {
  draft.value = next;
  schedule();
}

function editSample(change: Partial<XmSample>): void {
  const s = sample.value;
  if (!s) return;
  commit(withSample(draft.value, selected.value, { ...s, ...change }));
}

/** Replace the selected sample with `next` (an audio edit: a drum stops being live). */
function commitSample(next: XmSample): void {
  commit(withSample(draft.value, selected.value, next));
}

const edit = (op: (s: XmSample) => XmSample): void => {
  const s = sample.value;
  if (!s) return;
  drumLive.value = false;
  commitSample(op(s));
};

const onName = (value: string): void => commit({ ...draft.value, name: clampXmName(value) });
function onVibType(value: string): void {
  commit({ ...draft.value, vibratoType: Number(value) });
}
function onBits(value: string): void {
  edit((s) => setBits(s, value === '16' ? 16 : 8));
}
function onLoop(start: number, length: number): void {
  const s = sample.value;
  if (!s) return;
  commitSample(withLoop(s, start, length));
}
function onLoopType(value: string): void {
  const s = sample.value;
  if (!s) return;
  if (value === 'none') commitSample(withoutLoop(s));
  else commitSample(s.loopLength >= 2 ? { ...s, loopType: value as XmSample['loopType'] } : withLoop(s, 0, s.data.length, value as XmSample['loopType']));
}
function onDraw(d: Float32Array): void {
  drumLive.value = false;
  const s = sample.value;
  if (s) commitSample(withData(s, d));
}
function clear(): void {
  drumLive.value = false;
  const s = sample.value;
  if (s) commitSample({ ...emptyXmSample(s.name, s.bits), volume: s.volume, panning: s.panning });
}

function onAddSample(): void {
  const next = addSample(draft.value, emptyXmSample());
  if (!next) return;
  selected.value = next.samples.length - 1;
  drumLive.value = false;
  commit(next);
}
function onDuplicate(): void {
  const next = duplicateSample(draft.value, selected.value);
  if (!next) return;
  selected.value = next.samples.length - 1;
  commit(next);
}
function onRemoveSample(): void {
  if (!sample.value) return;
  const next = removeSample(draft.value, selected.value);
  selected.value = Math.max(0, Math.min(selected.value, next.samples.length - 1));
  drumLive.value = false;
  commit(next);
}
function onPaint(from: number, to: number): void {
  if (!sample.value) return;
  commit(paintKeymap(draft.value, from, to, selected.value));
}
function onEnvelope(key: 'volumeEnvelope' | 'panningEnvelope', envelope: XmEnvelope, preset?: { fadeout?: number }): void {
  commit({ ...draft.value, [key]: envelope, ...(preset?.fadeout !== undefined ? { volumeFadeout: preset.fadeout } : {}) });
}

/** A first sample makes an empty instrument playable: generating one adds it. */
function ensureSample(): void {
  if (draft.value.samples.length > 0) return;
  const next = addSample(draft.value, emptyXmSample());
  if (next) {
    draft.value = next;
    selected.value = 0;
  }
}

function renderDrum(): void {
  ensureSample();
  const s = sample.value;
  if (!s) return;
  const int8 = generateDrum(drumKind.value, drum, drumPeriod.value, drumSeed);
  const pcm = Float32Array.from(int8, (v) => v / 128);
  commitSample(fromPcm({ ...s, name: s.name || drumKind.value }, pcm, 3546895 / drumPeriod.value, 8));
}
function createDrum(): void {
  drumSeed = (drumSeed * 1103515245 + 12345) >>> 0;
  drumLive.value = true;
  renderDrum();
}
function regenDrum(): void {
  if (drumLive.value) renderDrum();
}
function setDrum(key: keyof DrumParams, value: number): void {
  drum[key] = value;
  regenDrum();
}
function onDrumKind(kind: DrumKind): void {
  drumKind.value = kind;
  Object.assign(drum, DRUM_PRESETS[kind]);
  regenDrum();
}
function createWave(): void {
  ensureSample();
  const s = sample.value;
  if (!s) return;
  drumLive.value = false;
  commitSample(
    waveKind.value === 'pulse'
      ? generatePulse(s, { ...pulse, cycleLength: waveLength.value })
      : generateWave(s, waveKind.value, waveLength.value),
  );
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  error.value = '';
  drumLive.value = false;
  ensureSample();
  const s = sample.value;
  if (!s) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stem = sampleNameFromFile(file.name);
    const loaded = readXmSampleFile(bytes, file.name, rawBits.value);
    if (loaded) {
      // Formats with no rate play at their own pitch on C-4 (relative note 0).
      const base = { ...s, name: loaded.name ?? (s.name || stem), volume: loaded.volume ?? s.volume };
      const next = loaded.rate !== undefined ? fromPcm(base, loaded.pcm, loaded.rate, loaded.bits) : withData({ ...base, bits: loaded.bits, relativeNote: 0, finetune: 0, loopType: 'none', loopStart: 0, loopLength: 0 }, loaded.pcm);
      commitSample(loaded.loopLength ? withLoop(next, loaded.loopStart ?? 0, loaded.loopLength) : next);
      return;
    }
    const buffer = await audioStore.audioContext.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / buffer.numberOfChannels;
    }
    commitSample(fromPcm({ ...s, name: s.name || stem }, mono, buffer.sampleRate, 16));
  } catch (caught) {
    error.value = `Could not read ${file.name}: ${(caught as Error).message}`;
  }
}

const exportFormat = ref<XmSampleFormatId>('wav');
function exportSample(): void {
  const s = sample.value;
  if (!s) return;
  const format = XM_SAMPLE_FORMATS.find((f) => f.id === exportFormat.value)!;
  const bytes = writeXmSampleFile(format.id, s);
  const mime = format.id === 'wav' ? 'audio/wav' : 'application/octet-stream';
  downloadBytes(bytes, exportFileName(s.name || `sample_${slotNumber.value}_${selected.value + 1}`, format.extension), mime);
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
.xm-page {
  background: var(--app-background, #0b111a);
  color: var(--text-primary, #e8f3ff);
}

.xm-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: linear-gradient(90deg, var(--tracker-active-bg, #14283d), var(--button-background, #1a2534));
  border-bottom: 1px solid var(--tracker-accent-secondary, #3b82a0);
}

.xm-banner__info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.xm-banner__label,
.xm-banner__name {
  font-weight: 600;
}

.xm-banner__slot,
.xm-dim {
  opacity: 0.65;
}

.xm-empty {
  padding: 32px 24px;
  opacity: 0.75;
}

.xm-body {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: 12px;
  padding: 12px;
}

.xm-left,
.xm-right {
  display: grid;
  gap: 12px;
  align-content: start;
  min-width: 0;
}

.xm-card {
  margin: 0;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  display: grid;
  gap: 10px;
}

.xm-card h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.xm-field {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.xm-field--inline {
  display: inline-flex;
}

.xm-field__label {
  opacity: 0.8;
}

.xm-text,
.xm-select {
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  color: inherit;
  font-family: var(--tracker-font, monospace);
}

.xm-readout {
  font-family: var(--tracker-font, monospace);
}

.xm-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.xm-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.xm-btn {
  padding: 4px 12px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
  background: var(--button-background, #1a2534);
  color: inherit;
  cursor: pointer;
}

.xm-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.xm-btn--danger:not(:disabled):hover {
  border-color: #e05a5a;
}

.xm-error {
  margin: 0;
  color: #ff8a8a;
}

/* Drum decay and filter run to four and five digits. */
.xm-card :deep(.ahx-field--compact .ahx-field__input) {
  width: 68px;
}

@media (max-width: 900px) {
  .xm-body {
    grid-template-columns: minmax(0, 1fr);
  }
}

.xm-samples {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.xm-sample {
  width: 100%;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-left: 4px solid hsl(var(--xm-sample-hue) 55% 50%);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.2);
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.xm-sample--selected {
  border-color: var(--tracker-accent-secondary, #5ec2e8);
  border-left-color: hsl(var(--xm-sample-hue) 55% 50%);
  background: rgba(94, 194, 232, 0.12);
}

.xm-sample__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.xm-card h4 {
  margin: 4px 0 0;
  font-size: 0.85rem;
  opacity: 0.8;
}
</style>
