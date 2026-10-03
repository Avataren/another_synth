<template>
  <q-page class="a2m-page" data-testid="a2m-instrument-editor">
    <div class="a2m-banner">
      <div class="a2m-banner__info">
        <FormatBadge data-testid="a2m-format-badge" brand="a2m" />
        <span class="a2m-banner__label">Instrument Editor</span>
        <span v-if="slotNumber !== null" class="a2m-banner__slot">Slot #{{ formatInstrumentId(slotNumber) }}</span>
        <span class="a2m-banner__name" data-testid="a2m-instrument-title">{{ nameText || '(unnamed)' }}</span>
      </div>
      <q-btn flat dense color="white" icon="arrow_back" label="Back to Tracker" title="Press Escape to return" @click="backToTracker" />
    </div>

    <div v-if="!slotValid" class="a2m-empty" data-testid="a2m-instrument-missing">
      This module holds {{ instrumentCount }} instruments. Open one from the instrument list in the tracker.
    </div>

    <template v-else>
      <div class="a2m-sound-band">
        <AhxAuditionBar
          :audible="true"
          :held-keys="heldKeys"
          v-model:latch="latch"
          v-model:restrike="restrike"
          :octave="octave"
          :strip-start="stripStart"
          :midi-status="play.midiStatus.value"
          hint="Play the FM voice with the keyboard (Z-M, Q-P), MIDI or the keys. Macros play in the song, not here."
          restrike-title="Strike the held note again shortly after each edit."
          @pointer-down="play.pointerDown"
          @pointer-up="play.pointerUp"
          @set-octave="play.setOctave"
          @toggle-midi="play.toggleMidi"
        />
      </div>

      <div class="a2m-body">
        <div class="a2m-left">
          <section class="a2m-card" data-testid="a2m-card-instrument">
            <h3>Instrument</h3>
            <label class="a2m-field">
              <span class="a2m-field__label">Name</span>
              <input
                class="a2m-text"
                type="text"
                :maxlength="nameLimit"
                :value="nameText"
                data-testid="a2m-name"
                @input="onName(($event.target as HTMLInputElement).value)"
              />
            </label>
            <label class="a2m-field">
              <span class="a2m-field__label">Panning</span>
              <select class="a2m-select" :value="draft.panning" data-testid="a2m-panning" @change="onPanning(($event.target as HTMLSelectElement).value)">
                <option :value="0">Centre</option>
                <option :value="1">Left</option>
                <option :value="2">Right</option>
              </select>
            </label>
            <AhxSliderField
              label="Fine-tune"
              :model-value="draft.finetune"
              :min="-128"
              :max="127"
              testid="a2m-finetune"
              title="Added to the note's F-number."
              @update:model-value="(v: number) => commit({ ...draft, finetune: v })"
            />
            <label class="a2m-field">
              <span class="a2m-field__label">Voice</span>
              <select class="a2m-select" :value="draft.voice_type" data-testid="a2m-voice-type" title="Percussion voices play on the rhythm channels of a song in percussion mode." @change="onVoiceType(($event.target as HTMLSelectElement).value)">
                <option v-for="(label, i) in VOICE_TYPES" :key="i" :value="i">{{ label }}</option>
              </select>
            </label>
          </section>

          <section class="a2m-card" data-testid="a2m-card-voice">
            <h3>Channel</h3>
            <AhxSliderField
              label="Feedback"
              :model-value="voice.feedback"
              :min="0"
              :max="7"
              testid="a2m-feedback"
              title="How much of the modulator's output feeds back into itself."
              @update:model-value="(v: number) => setVoice({ ...voice, feedback: v })"
            />
            <label class="a2m-field">
              <span class="a2m-field__label">Connection</span>
              <select class="a2m-select" :value="voice.connection" data-testid="a2m-connection" @change="onConnection(($event.target as HTMLSelectElement).value)">
                <option value="fm">FM: modulator drives carrier</option>
                <option value="additive">Additive: both are heard</option>
              </select>
            </label>
            <div class="a2m-tools">
              <button type="button" class="a2m-btn" data-testid="a2m-reset" title="A plain sine voice" @click="onReset">Reset</button>
              <button type="button" class="a2m-btn" data-testid="a2m-swap" title="Swap the two operators" @click="onSwap">Swap operators</button>
              <button type="button" class="a2m-btn a2m-btn--danger" data-testid="a2m-clear" title="Empty the instrument" @click="onClear">Clear</button>
            </div>
          </section>
        </div>

        <div class="a2m-right">
          <section v-for="op in OPERATORS" :key="op.key" class="a2m-card" :data-testid="`a2m-card-${op.key}`">
            <h3>{{ op.label }}</h3>
            <svg class="a2m-envelope" viewBox="0 0 200 48" preserveAspectRatio="none" role="img" :aria-label="`${op.label} envelope`" :data-testid="`a2m-${op.key}-envelope`">
              <polyline :points="envelopePoints(voice[op.key])" />
            </svg>
            <div class="a2m-grid">
              <AhxSliderField label="Attack" :model-value="voice[op.key].attack" :min="0" :max="15" :testid="`a2m-${op.key}-attack`" title="15 is instant." @update:model-value="(v: number) => setOperator(op.key, { attack: v })" />
              <AhxSliderField label="Decay" :model-value="voice[op.key].decay" :min="0" :max="15" :testid="`a2m-${op.key}-decay`" title="15 is fastest." @update:model-value="(v: number) => setOperator(op.key, { decay: v })" />
              <AhxSliderField label="Sustain" :model-value="voice[op.key].sustainLevel" :min="0" :max="15" :testid="`a2m-${op.key}-sustain-level`" title="0 is loudest, 15 is silent." @update:model-value="(v: number) => setOperator(op.key, { sustainLevel: v })" />
              <AhxSliderField label="Release" :model-value="voice[op.key].release" :min="0" :max="15" :testid="`a2m-${op.key}-release`" title="15 is fastest." @update:model-value="(v: number) => setOperator(op.key, { release: v })" />
              <AhxSliderField label="Level" :model-value="63 - voice[op.key].totalLevel" :min="0" :max="63" :testid="`a2m-${op.key}-level`" title="63 is loudest (the chip's total level is the other way round)." @update:model-value="(v: number) => setOperator(op.key, { totalLevel: 63 - v })" />
              <AhxSliderField label="Key scale" :model-value="voice[op.key].keyScaleLevel" :min="0" :max="3" :testid="`a2m-${op.key}-ksl`" title="Quieter towards the high notes." @update:model-value="(v: number) => setOperator(op.key, { keyScaleLevel: v })" />
              <AhxSliderField label="Multiple" :model-value="voice[op.key].multiplier" :min="0" :max="15" :testid="`a2m-${op.key}-multiplier`" title="Frequency multiplier (0 is half the note's pitch)." @update:model-value="(v: number) => setOperator(op.key, { multiplier: v })" />
            </div>
            <label class="a2m-field">
              <span class="a2m-field__label">Waveform</span>
              <select class="a2m-select" :value="voice[op.key].waveform" :data-testid="`a2m-${op.key}-waveform`" @change="setOperator(op.key, { waveform: Number(($event.target as HTMLSelectElement).value) })">
                <option v-for="(label, i) in A2M_WAVEFORM_NAMES" :key="i" :value="i">{{ i }}: {{ label }}</option>
              </select>
            </label>
            <div class="a2m-flags">
              <label class="a2m-check" title="The operator's level follows the tremolo LFO.">
                <input type="checkbox" :checked="voice[op.key].tremolo" :data-testid="`a2m-${op.key}-tremolo`" @change="setOperator(op.key, { tremolo: ($event.target as HTMLInputElement).checked })" />
                Tremolo
              </label>
              <label class="a2m-check" title="The operator's pitch follows the vibrato LFO.">
                <input type="checkbox" :checked="voice[op.key].vibrato" :data-testid="`a2m-${op.key}-vibrato`" @change="setOperator(op.key, { vibrato: ($event.target as HTMLInputElement).checked })" />
                Vibrato
              </label>
              <label class="a2m-check" title="Hold at the sustain level until key-off.">
                <input type="checkbox" :checked="voice[op.key].sustain" :data-testid="`a2m-${op.key}-sustain`" @change="setOperator(op.key, { sustain: ($event.target as HTMLInputElement).checked })" />
                Sustain
              </label>
              <label class="a2m-check" title="The envelope speeds up with pitch.">
                <input type="checkbox" :checked="voice[op.key].ksr" :data-testid="`a2m-${op.key}-ksr`" @change="setOperator(op.key, { ksr: ($event.target as HTMLInputElement).checked })" />
                Key scale rate
              </label>
            </div>
          </section>
        </div>
      </div>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { formatInstrumentId } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerAudioStore } from 'src/stores/tracker-audio-store';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import { AHX_DEFAULT_OCTAVE, useAhxPlayInput } from 'src/composables/useAhxPlayInput';
import { slotOf } from 'src/router/ahx-slot-guard';
import { a2mText, a2mTextBytes, type A2mInstrumentJson } from 'src/audio/tracker/a2m-codec';
import {
  A2M_WAVEFORM_NAMES,
  a2mInstrumentNameLimit,
  decodeA2mFm,
  defaultA2mInstrument,
  encodeA2mFm,
  type A2mFmVoice,
  type A2mOperator,
} from 'src/audio/tracker/a2m-instrument';
import { A2mAudition } from 'src/audio/tracker/a2m-audition';
import AhxAuditionBar from 'src/components/ahx/AhxAuditionBar.vue';
import AhxSliderField from 'src/components/ahx/AhxSliderField.vue';
import FormatBadge from 'src/components/FormatBadge.vue';

const route = useRoute();
const router = useRouter();
const trackerStore = useTrackerStore();
const audioStore = useTrackerAudioStore();
const userSettings = useUserSettingsStore();

const VOICE_TYPES = ['Melodic', 'Bass drum', 'Snare', 'Tom-tom', 'Cymbal', 'Hi-hat'];
const OPERATORS = [
  { key: 'modulator', label: 'Modulator' },
  { key: 'carrier', label: 'Carrier' },
] as const;

const slotNumber = computed(() => slotOf(route.params.slot));
const instrumentCount = computed(() => trackerStore.a2mDoc?.instruments.length ?? 0);
const slotValid = computed(
  () => slotNumber.value !== null && slotNumber.value >= 1 && slotNumber.value <= instrumentCount.value,
);
const nameLimit = computed(() => a2mInstrumentNameLimit(trackerStore.a2mDoc?.version ?? 14));

const draft = ref<A2mInstrumentJson>(defaultA2mInstrument());
const voice = computed(() => decodeA2mFm(draft.value.fm));
const nameText = computed(() => a2mText(draft.value.name));

function load(): void {
  const n = slotNumber.value;
  const stored = n === null ? undefined : trackerStore.a2mDoc?.instruments[n - 1];
  draft.value = stored ? (JSON.parse(JSON.stringify(stored)) as A2mInstrumentJson) : defaultA2mInstrument();
}

// Edits reach the song after a short pause, so dragging a slider is one write, not hundreds.
const APPLY_DELAY_MS = 120;
let applyTimer: ReturnType<typeof setTimeout> | null = null;
let restrikeTimer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (applyTimer !== null) clearTimeout(applyTimer);
  applyTimer = setTimeout(apply, APPLY_DELAY_MS);
}

function apply(): void {
  if (applyTimer !== null) {
    clearTimeout(applyTimer);
    applyTimer = null;
  }
  const n = slotNumber.value;
  if (n === null || !slotValid.value) return;
  trackerStore.setA2mInstrument(n, draft.value);
  const held = audition?.current;
  if (restrike.value && held) {
    if (restrikeTimer !== null) clearTimeout(restrikeTimer);
    const midi = held.midi;
    restrikeTimer = setTimeout(() => {
      audition?.noteOff();
      void audition?.noteOn(draft.value, midi);
    }, 150);
  }
}

function commit(next: A2mInstrumentJson): void {
  draft.value = next;
  schedule();
}

function setVoice(next: A2mFmVoice): void {
  commit({ ...draft.value, fm: encodeA2mFm(next, draft.value.fm) });
}

function setOperator(key: 'modulator' | 'carrier', change: Partial<A2mOperator>): void {
  setVoice({ ...voice.value, [key]: { ...voice.value[key], ...change } });
}

const onName = (value: string): void => commit({ ...draft.value, name: a2mTextBytes(value, nameLimit.value) });
const onPanning = (value: string): void => commit({ ...draft.value, panning: Number(value) });
const onVoiceType = (value: string): void => commit({ ...draft.value, voice_type: Number(value) });
const onConnection = (value: string): void => setVoice({ ...voice.value, connection: value === 'additive' ? 'additive' : 'fm' });

function onReset(): void {
  const fresh = defaultA2mInstrument('', trackerStore.a2mDoc?.version ?? 14);
  commit({ ...fresh, name: draft.value.name });
}

function onClear(): void {
  commit({ name: draft.value.name, fm: new Array<number>(11).fill(0), panning: 0, finetune: 0, voice_type: 0 });
}

function onSwap(): void {
  const v = voice.value;
  setVoice({ ...v, modulator: v.carrier, carrier: v.modulator });
}

/** A schematic of the envelope: attack, decay to the sustain level, a hold (or a slow fall), release. */
function envelopePoints(op: A2mOperator): string {
  const W = 200;
  const H = 48;
  const rate = (r: number) => (r === 0 ? 1 : (16 - r) / 16);
  const attack = 6 + rate(op.attack) * 50;
  const decay = 6 + rate(op.decay) * 50;
  const hold = 40;
  const release = 6 + rate(op.release) * 50;
  const level = H - 4 - (1 - op.sustainLevel / 15) * (H - 8);
  const top = 4;
  const points: Array<[number, number]> = [[0, H - 2]];
  let x = attack;
  points.push([x, top]);
  x += decay;
  points.push([x, level]);
  x += hold;
  points.push([x, op.sustain ? level : Math.min(H - 2, level + (H - level) * 0.4)]);
  x += release;
  points.push([Math.min(W, x), H - 2]);
  return points.map(([px, py]) => `${Math.round(px)},${Math.round(py)}`).join(' ');
}

// Playing: the chip itself, loaded with the draft at each note-on.
const restrike = ref(false);
let audition: A2mAudition | null = null;
function ensureAudition(): A2mAudition {
  audition ??= new A2mAudition(audioStore.songBank.audioContext, audioStore.songBank.output);
  return audition;
}
const play = useAhxPlayInput({
  slot: slotNumber,
  audible: ref(true),
  sink: {
    noteOn: (_n, midi) => {
      void audioStore.songBank.ensureAudioContextRunning().then(() => ensureAudition().noteOn(draft.value, midi));
    },
    noteOff: () => audition?.noteOff(),
  },
  autoMidi: computed(() => userSettings.settings.enableMidi),
});
const { heldKeys, latch, octave } = play;
const stripStart = computed(() => 48 + (octave.value - AHX_DEFAULT_OCTAVE) * 12);

function backToTracker(): void {
  apply();
  void router.push('/tracker');
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    backToTracker();
  }
}

watch(slotNumber, load);
onMounted(() => {
  load();
  window.addEventListener('keydown', onKeyDown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  if (restrikeTimer !== null) clearTimeout(restrikeTimer);
  if (applyTimer !== null) apply();
  play.releaseAll();
  audition?.dispose();
  audition = null;
});
</script>

<style scoped>
.a2m-page {
  background: var(--app-background, #0b111a);
  color: var(--text-primary, #e8f3ff);
}

.a2m-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: linear-gradient(90deg, var(--tracker-active-bg, #14283d), var(--button-background, #1a2534));
  border-bottom: 1px solid var(--tracker-accent-secondary, #3b82a0);
}

.a2m-banner__info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.a2m-banner__label,
.a2m-banner__name {
  font-weight: 600;
}

.a2m-banner__slot {
  opacity: 0.65;
}

.a2m-empty {
  padding: 32px 24px;
  opacity: 0.75;
}

.a2m-body {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: 12px;
  padding: 12px;
}

.a2m-left {
  display: grid;
  gap: 12px;
  align-content: start;
  min-width: 0;
}

.a2m-right {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-content: start;
  min-width: 0;
}

.a2m-card {
  margin: 0;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  display: grid;
  gap: 10px;
  align-content: start;
}

.a2m-card h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.a2m-grid {
  display: grid;
  gap: 6px;
}

.a2m-field {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.a2m-field__label {
  opacity: 0.8;
}

.a2m-text,
.a2m-select {
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  color: inherit;
  font-family: var(--tracker-font, monospace);
}

.a2m-flags {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
}

.a2m-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.a2m-envelope {
  width: 100%;
  height: 56px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
}

.a2m-envelope polyline {
  fill: none;
  stroke: var(--tracker-accent-secondary, #3b82a0);
  stroke-width: 2;
  stroke-linejoin: round;
}

.a2m-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.a2m-btn {
  padding: 4px 12px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
  background: var(--button-background, #1a2534);
  color: inherit;
  cursor: pointer;
}

.a2m-btn--danger:hover {
  border-color: #e05a5a;
}

@media (max-width: 900px) {
  .a2m-body,
  .a2m-right {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
