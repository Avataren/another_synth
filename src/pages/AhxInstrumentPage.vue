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
          v-if="audible"
          class="ahx-banner__mode"
          data-testid="ahx-editable-badge"
          title="Every change is made to the song's own instrument for this session: the song plays it from its next trigger and the keyboard sounds it at once. AHX/HVL songs cannot be saved as .cmod yet, so the edits last until the song is replaced."
          >Edits this session</span
        >
        <span
          v-else
          class="ahx-banner__mode ahx-banner__mode--warn"
          data-testid="ahx-editable-badge"
          title="This song has no source file to play from, so edits are kept in the editor but cannot be heard."
          >Edits not audible</span
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

    <div v-if="!audible" class="ahx-notice" role="alert" data-testid="ahx-source-missing">
      This song's source file is not available (it was loaded from a saved
      song, which cannot carry it), so the instruments can be edited here but
      nothing can be heard. Open the .ahx/.hvl file again to audition and
      play.
    </div>
    <div
      v-for="notice in notices"
      :key="notice"
      class="ahx-notice"
      role="alert"
      data-testid="ahx-notice"
    >
      {{ notice }}
    </div>

    <div v-if="!instrument" class="ahx-empty" data-testid="ahx-instrument-missing">
      This slot has no AHX instrument. Load an AHX song in the tracker and open
      one of its instruments from the list.
    </div>

    <div v-else class="ahx-body">
      <section class="ahx-card ahx-card--wide ahx-audition-bar" data-testid="ahx-audition">
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
            @pointerdown.prevent="play.pointerDown(key.midi)"
            @pointerup="play.pointerUp(key.midi)"
            @pointerleave="play.pointerUp(key.midi)"
            @pointercancel="play.pointerUp(key.midi)"
          >
            {{ key.label }}
          </button>
          <AhxPianoStrip
            :start="stripStart"
            :held="heldKeys"
            :disabled="!audible"
            @down="play.pointerDown"
            @up="play.pointerUp"
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
              @click="play.setOctave(octave - 1)"
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
              @click="play.setOctave(octave + 1)"
            >
              +
            </button>
          </span>
          <button
            type="button"
            class="ahx-midi-chip"
            :class="`ahx-midi-chip--${play.midiStatus.value.state}`"
            :title="midiChip.title"
            data-testid="ahx-midi-chip"
            @click="play.toggleMidi()"
          >
            {{ midiChip.text }}
          </button>
          <label
            class="ahx-check ahx-check--bar"
            title="A tap holds the note until you tap the key again, so both hands are free to edit."
          >
            <input v-model="latch" type="checkbox" :disabled="!audible" data-testid="ahx-audition-latch" />
            Latch
          </label>
          <label
            class="ahx-check ahx-check--bar"
            title="Strike the held note again shortly after each edit. Volume, wave length, vibrato and the sweep setup are only read when a note is struck, so this is what makes them audible while you drag."
          >
            <input v-model="restrike" type="checkbox" :disabled="!audible" data-testid="ahx-audition-restrike" />
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

      <section class="ahx-card">
        <h3>Instrument</h3>
        <div class="ahx-fields" data-testid="ahx-params">
          <AhxSliderField
            label="Volume"
            :model-value="instrument.volume"
            :max="AHX_NUMBER_FIELDS.volume"
            suffix="/ 64"
            testid="ahx-field-volume"
            @update:model-value="setNumber('volume', $event)"
          />
          <div class="ahx-field-row ahx-field-row--wrap">
            <AhxSegmented
              label="Wave length"
              :model-value="instrument.waveLength"
              :options="WAVE_LENGTH_OPTIONS"
              testid="ahx-seg-waveLength"
              @update:model-value="setNumber('waveLength', $event)"
            />
            <AhxNumberField
              compact
              :model-value="instrument.waveLength"
              :max="AHX_NUMBER_FIELDS.waveLength"
              :suffix="`(${cycleLength} samples)`"
              testid="ahx-field-waveLength"
              @update:model-value="setNumber('waveLength', $event)"
            />
          </div>
          <AhxSliderField
            label="Vibrato delay"
            :model-value="instrument.vibratoDelay"
            :max="AHX_NUMBER_FIELDS.vibratoDelay"
            :throttle-ms="AHX_TABLE_THROTTLE_MS"
            testid="ahx-field-vibratoDelay"
            suffix="frames"
            @update:model-value="setNumber('vibratoDelay', $event)"
          />
          <AhxSliderField
            label="Vibrato speed"
            :model-value="instrument.vibratoSpeed"
            :max="AHX_NUMBER_FIELDS.vibratoSpeed"
            :throttle-ms="AHX_TABLE_THROTTLE_MS"
            testid="ahx-field-vibratoSpeed"
            @update:model-value="setNumber('vibratoSpeed', $event)"
          />
          <AhxSliderField
            stepper
            label="Vibrato depth"
            :model-value="instrument.vibratoDepth"
            :max="AHX_NUMBER_FIELDS.vibratoDepth"
            testid="ahx-field-vibratoDepth"
            @update:model-value="setNumber('vibratoDepth', $event)"
          />
          <AhxSliderField
            label="Square lower"
            :model-value="instrument.squareLowerLimit"
            :max="AHX_NUMBER_FIELDS.squareLowerLimit"
            :throttle-ms="AHX_TABLE_THROTTLE_MS"
            testid="ahx-field-squareLowerLimit"
            @update:model-value="setNumber('squareLowerLimit', $event)"
          />
          <AhxSliderField
            label="Square upper"
            :model-value="instrument.squareUpperLimit"
            :max="AHX_NUMBER_FIELDS.squareUpperLimit"
            :throttle-ms="AHX_TABLE_THROTTLE_MS"
            testid="ahx-field-squareUpperLimit"
            @update:model-value="setNumber('squareUpperLimit', $event)"
          />
          <AhxSliderField
            label="Square speed"
            :model-value="instrument.squareSpeed"
            :max="AHX_NUMBER_FIELDS.squareSpeed"
            :throttle-ms="AHX_TABLE_THROTTLE_MS"
            testid="ahx-field-squareSpeed"
            @update:model-value="setNumber('squareSpeed', $event)"
          />
          <AhxSliderField
            label="Filter lower"
            :model-value="instrument.filterLowerLimit"
            :max="AHX_NUMBER_FIELDS.filterLowerLimit"
            :throttle-ms="AHX_TABLE_THROTTLE_MS"
            :marker="AHX_FILTER_NEUTRAL"
            marker-title="32 is the neutral position: no filtering"
            :hint="filterLowerHint"
            testid="ahx-field-filterLowerLimit"
            @update:model-value="setNumber('filterLowerLimit', $event)"
          />
          <AhxSliderField
            label="Filter upper"
            :model-value="instrument.filterUpperLimit"
            :max="AHX_NUMBER_FIELDS.filterUpperLimit"
            :throttle-ms="AHX_TABLE_THROTTLE_MS"
            :marker="AHX_FILTER_NEUTRAL"
            marker-title="32 is the neutral position: no filtering"
            testid="ahx-field-filterUpperLimit"
            @update:model-value="setNumber('filterUpperLimit', $event)"
          />
          <AhxSliderField
            label="Filter speed"
            :model-value="instrument.filterSpeed"
            :max="AHX_NUMBER_FIELDS.filterSpeed"
            :throttle-ms="AHX_TABLE_THROTTLE_MS"
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
            <AhxSliderField
              stepper
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
        <AhxEnvelopeEditor
          :envelope="instrument.envelope"
          :volume="instrument.volume"
          :hard-cut-release="instrument.hardCutRelease"
          :hard-cut-frames="instrument.hardCutReleaseFrames"
          @change="setEnvelopeFields"
          @hard-cut-frames="setNumber('hardCutReleaseFrames', $event)"
          @focus-field="focusField"
        />
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
        <p
          v-for="warning in envelopeWarnings"
          :key="warning.id"
          class="ahx-warn"
          :data-testid="warning.id === 'never-rises' ? 'ahx-envelope-never-rises' : `ahx-envelope-warning-${warning.id}`"
        >
          {{ warning.text }}
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
          <AhxSliderField
            label="Filter position"
            :model-value="startFilterPosition"
            :min="0"
            :max="AHX_MAX_FILTER_POSITION"
            :throttle-ms="AHX_TABLE_THROTTLE_MS"
            :marker="AHX_FILTER_NEUTRAL"
            marker-title="32 is the neutral position: no filtering"
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
          <AhxSliderField
            stepper
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
                    :title="noteTitle(entry)"
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
                    :max="ahxFxParamMax(entry.fx[slotIndex] ?? 0, songFormat, sourceVersion)"
                    :title="paramTitle(entry.fx[slotIndex] ?? 0)"
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
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  AHX_MAX_PLIST_ENTRIES,
  AHX_PLIST_MAX_NOTE,
  ahxPListCommandsFor,
  formatInstrumentId,
  type AhxEnvelope,
  type AhxInstrument,
  type AhxPListEntry,
} from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import {
  AHX_DEFAULT_OCTAVE,
  AHX_MAX_OCTAVE,
  AHX_MIN_OCTAVE,
  useAhxPlayInput,
} from 'src/composables/useAhxPlayInput';
import AhxPianoStrip from 'src/components/ahx/AhxPianoStrip.vue';
import { ahxSourceInfo } from 'src/audio/tracker/ahx-source';
import { ahxNotices, reportAhxNotice } from 'src/audio/tracker/ahx-notices';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import AhxSliderField from 'src/components/ahx/AhxSliderField.vue';
import AhxSegmented from 'src/components/ahx/AhxSegmented.vue';
import AhxEnvelopeEditor from 'src/components/ahx/AhxEnvelopeEditor.vue';
import { AHX_TABLE_THROTTLE_MS } from 'src/composables/useAhxDrag';
import {
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
  ahxEnvelopeWarnings,
  ahxFxParamMax,
  ahxStartFilterPosition,
  ahxStartWaveform,
  canSetAhxStartFilterPosition,
  editAhxPListEntry,
  removeAhxPListEntry,
  setAhxEnvelope,
  setAhxEnvelopeFields,
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
const userSettings = useUserSettingsStore();

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
const envelopeWarnings = computed(() =>
  instrument.value ? ahxEnvelopeWarnings(instrument.value) : [],
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

/** The filter's neutral position: no filtering (`filter_sweep.rs:88`). */
const AHX_FILTER_NEUTRAL = 32;

/** The engine walks filter positions 1..=63; an imported lower limit can be up to 127. */
const filterLowerHint = computed(() =>
  (instrument.value?.filterLowerLimit ?? 0) > 63
    ? 'The engine clamps filter positions to 1-63, so this value is past its range.'
    : '',
);

/** Wave lengths 0..=5 as the samples a cycle has (4 << n). */
const WAVE_LENGTH_OPTIONS = [0, 1, 2, 3, 4, 5].map((value) => ({
  value,
  label: String(value),
  sub: String(ahxWaveCycleLength(value)),
  title: `${ahxWaveCycleLength(value)} samples per cycle`,
}));

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
/** The song's format decides which PList commands a row can hold (HVL has more than AHX). */
const songFormat = computed(() => ahxSourceInfo.value?.format ?? 'ahx');
const FX_CHOICES = computed(() =>
  ahxPListCommandsFor(songFormat.value).map((value) => ({
    value,
    label: `${value.toString(16).toUpperCase()} ${ahxPListFxName(value, 1) || 'none'}`,
  })),
);

/** Whether the song's source is there to play from: without it an edit is kept but never heard. */
const audible = computed(() => ahxSourceInfo.value !== null);
const notices = ahxNotices;

/** The header's version: a version-0 AHX file drops a filter toggle's high nibble at load. */
const sourceVersion = computed(() => ahxSourceInfo.value?.version ?? 1);

const paramTitle = (fx: number): string =>
  ahxFxParamMax(fx, songFormat.value, sourceVersion.value) < 255
    ? 'This is an AHX version 0 file: it ignores the high nibble of a filter toggle, so only the square toggle (0-15) plays.'
    : '';

/**
 * A PList note is relative to the key played unless the row is `fixed`
 * (`voice.rs:659-664`: `note + transpose + trackPeriod - 1`), so the absolute
 * name only applies to a fixed row.
 */
function noteTitle(entry: AhxPListEntry): string {
  if (entry.note === 0) return '--- (0 = keep the pitch)';
  const name = ahxNoteName(entry.note);
  return entry.fixed
    ? `${name}: a fixed pitch, whatever key is played`
    : `+${entry.note - 1} st above the played key (relative; tick Fixed to play ${name} itself)`;
}

const waveLabel = ahxWaveformLabel;
const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');

/**
 * Every control ends here: the edit is committed to the song (the slot's
 * `ahxData` and the instrument the worklets play), not to a copy.
 */
function commit(edit: (current: AhxInstrument) => AhxInstrument): void {
  const current = instrument.value;
  if (!current || slotNumber.value === null) return;
  const outcome = trackerStore.updateAhxInstrument(slotNumber.value, edit(current));
  // The value was not a valid instrument for this song: nothing changed, and
  // the field would otherwise just snap back with no word.
  if (outcome === 'rejected') reportAhxNotice('That change is not a valid instrument for this song and was not applied.');
}

const setNumber = (field: AhxNumberFieldKey, value: number) =>
  commit((ins) => setAhxNumber(ins, field, value));
const setHardCut = (on: boolean) => commit((ins) => setAhxHardCutRelease(ins, on));
const setEnvelope = (field: keyof AhxEnvelope, value: number) =>
  commit((ins) => setAhxEnvelope(ins, field, value));
/** A node drag or key press sets a stage's frames and level together: one commit. */
const setEnvelopeFields = (patch: Partial<AhxEnvelope>) =>
  commit((ins) => setAhxEnvelopeFields(ins, patch));
/** Double-click on an envelope node: the typed field for the same value. */
function focusField(testid: string): void {
  const el = document.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`);
  el?.focus();
  el?.select();
}
const setStartWaveform = (value: number) => commit((ins) => setAhxStartWaveform(ins, value));
const setStartFilter = (value: number) => commit((ins) => setAhxStartFilterPosition(ins, value));
const setPListSpeed = (value: number) => commit((ins) => setAhxPListSpeed(ins, value));
const editEntry = (row: number, edit: AhxPListEdit) =>
  commit((ins) => editAhxPListEntry(ins, row, edit, songFormat.value));
const addRow = (after?: number) => commit((ins) => addAhxPListEntry(ins, after));
const removeRow = (row: number) => commit((ins) => removeAhxPListEntry(ins, row));

/** Middle-of-the-keyboard notes to hold: C-2 .. C-5 as MIDI. */
const AUDITION_KEYS = [
  { midi: 48, label: 'C-3' },
  { midi: 60, label: 'C-4' },
  { midi: 72, label: 'C-5' },
];
const restrike = ref(false);

/**
 * The bar's keys, the computer keyboard and MIDI all play through one input
 * model (`useAhxPlayInput`), into the same preview voice.
 */
const play = useAhxPlayInput({
  slot: slotNumber,
  audible,
  sink: {
    noteOn: (slotNo, midi, velocity) => void playbackStore.previewAhxNoteOn(slotNo, midi, velocity),
    noteOff: (midi) => playbackStore.previewAhxNoteOff(midi),
  },
  autoMidi: computed(() => userSettings.settings.enableMidi),
});
const { heldKeys, latch, octave } = play;

/** The strip's lowest key follows the octave shift, so touch reaches the same range the keyboard does. */
const stripStart = computed(() => 48 + (octave.value - AHX_DEFAULT_OCTAVE) * 12);

const midiChip = computed(() => {
  const { state, devices } = play.midiStatus.value;
  switch (state) {
    case 'unsupported':
      return { text: 'MIDI: not supported', title: 'This browser has no Web MIDI.' };
    case 'requesting':
      return { text: 'MIDI: asking…', title: 'Waiting for the browser\u2019s permission prompt.' };
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

/**
 * Re-strike on edit: a committed edit strikes the held note again after a short
 * pause, so a field a sounding note does not re-read (volume, wave length,
 * vibrato, the sweep setup) is heard while it is being changed (editor plan E4).
 */
const RESTRIKE_DELAY_MS = 150;
let restrikeTimer: ReturnType<typeof setTimeout> | null = null;
watch(instrument, () => {
  if (!restrike.value || heldKeys.size === 0) return;
  if (restrikeTimer !== null) clearTimeout(restrikeTimer);
  restrikeTimer = setTimeout(() => {
    restrikeTimer = null;
    play.restrikeHeld();
  }, RESTRIKE_DELAY_MS);
});

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
  if (restrikeTimer !== null) clearTimeout(restrikeTimer);
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

.ahx-notice {
  margin: 8px 12px 0;
  padding: 8px 12px;
  border: 1px solid #d9a441;
  border-radius: 6px;
  background: rgba(217, 164, 65, 0.12);
  color: #f2d08a;
  font-size: 0.85rem;
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

.ahx-banner__mode--warn {
  color: #f2d08a;
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

.ahx-field-row--wrap {
  flex-wrap: wrap;
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
