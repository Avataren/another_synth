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
          title="Every change is made to the song's own instrument: the song plays it from its next trigger and the keyboard sounds it at once. Saving the song as a .cmod keeps the edits."
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
      This song's source file is not available (it was loaded from a song
      saved before .cmod files could carry AHX songs), so the instruments can
      be edited here but nothing can be heard. Open the .ahx/.hvl file again
      to audition and play.
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
      <div class="ahx-left">
        <fieldset class="ahx-card">
          <legend>Level &amp; wave</legend>
          <div class="ahx-fields">
            <AhxSliderField
              label="Volume"
              :model-value="instrument.volume"
              :max="AHX_NUMBER_FIELDS.volume"
              suffix="/ 64"
              testid="ahx-field-volume"
              :title="AHX_HELP.volume"
              @update:model-value="setNumber('volume', $event)"
            />
            <div class="ahx-field-row ahx-field-row--wrap">
              <AhxSegmented
                label="Wave length"
                :model-value="instrument.waveLength"
                :options="WAVE_LENGTH_OPTIONS"
                testid="ahx-seg-waveLength"
                :title="AHX_HELP.waveLength"
                @update:model-value="setNumber('waveLength', $event)"
              />
              <AhxNumberField
                compact
                :model-value="instrument.waveLength"
                :max="AHX_NUMBER_FIELDS.waveLength"
                :suffix="`(${cycleLength} samples)`"
                testid="ahx-field-waveLength"
                :title="AHX_HELP.waveLength"
                @update:model-value="setNumber('waveLength', $event)"
              />
            </div>
          </div>
        </fieldset>

        <fieldset class="ahx-card">
          <legend>Vibrato</legend>
          <div class="ahx-fields">
            <AhxSliderField
              label="Vibrato delay"
              :model-value="instrument.vibratoDelay"
              :max="AHX_NUMBER_FIELDS.vibratoDelay"
              :throttle-ms="AHX_TABLE_THROTTLE_MS"
              testid="ahx-field-vibratoDelay"
              :title="AHX_HELP.vibratoDelay"
              suffix="frames"
              @update:model-value="setNumber('vibratoDelay', $event)"
            />
            <AhxSliderField
              label="Vibrato speed"
              :model-value="instrument.vibratoSpeed"
              :max="AHX_NUMBER_FIELDS.vibratoSpeed"
              :throttle-ms="AHX_TABLE_THROTTLE_MS"
              testid="ahx-field-vibratoSpeed"
              :title="AHX_HELP.vibratoSpeed"
              @update:model-value="setNumber('vibratoSpeed', $event)"
            />
            <AhxSliderField
              stepper
              label="Vibrato depth"
              :model-value="instrument.vibratoDepth"
              :max="AHX_NUMBER_FIELDS.vibratoDepth"
              testid="ahx-field-vibratoDepth"
              :title="AHX_HELP.vibratoDepth"
              @update:model-value="setNumber('vibratoDepth', $event)"
            />
          </div>
          <AhxVibratoLane
            class="ahx-fieldset-lane"
            :delay="instrument.vibratoDelay"
            :speed="instrument.vibratoSpeed"
            :depth="instrument.vibratoDepth"
          />
        </fieldset>

        <fieldset class="ahx-card">
          <legend>Square</legend>
          <div class="ahx-fields">
            <AhxSliderField
              label="Square lower"
              :model-value="instrument.squareLowerLimit"
              :max="AHX_NUMBER_FIELDS.squareLowerLimit"
              :throttle-ms="AHX_TABLE_THROTTLE_MS"
              testid="ahx-field-squareLowerLimit"
              :title="AHX_HELP.squareLowerLimit"
              @update:model-value="setNumber('squareLowerLimit', $event)"
            />
            <AhxSliderField
              label="Square upper"
              :model-value="instrument.squareUpperLimit"
              :max="AHX_NUMBER_FIELDS.squareUpperLimit"
              :throttle-ms="AHX_TABLE_THROTTLE_MS"
              testid="ahx-field-squareUpperLimit"
              :title="AHX_HELP.squareUpperLimit"
              @update:model-value="setNumber('squareUpperLimit', $event)"
            />
            <AhxSliderField
              label="Square speed"
              :model-value="instrument.squareSpeed"
              :max="AHX_NUMBER_FIELDS.squareSpeed"
              :throttle-ms="AHX_TABLE_THROTTLE_MS"
              testid="ahx-field-squareSpeed"
              :title="AHX_HELP.squareSpeed"
              @update:model-value="setNumber('squareSpeed', $event)"
            />
          </div>
          <AhxSweepLane
            class="ahx-fieldset-lane"
            kind="square"
            :instrument="instrument"
            :format="songFormat"
            :version="sourceVersion"
            @enable="enableSweep('square')"
          />
        </fieldset>

        <fieldset class="ahx-card">
          <legend>Filter</legend>
          <div class="ahx-fields">
            <AhxSliderField
              label="Filter lower"
              :model-value="instrument.filterLowerLimit"
              :max="AHX_NUMBER_FIELDS.filterLowerLimit"
              :throttle-ms="AHX_TABLE_THROTTLE_MS"
              :marker="AHX_FILTER_NEUTRAL"
              marker-title="32 is the neutral position: no filtering"
              :hint="filterLowerHint"
              testid="ahx-field-filterLowerLimit"
              :title="AHX_HELP.filterLowerLimit"
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
              :title="AHX_HELP.filterUpperLimit"
              @update:model-value="setNumber('filterUpperLimit', $event)"
            />
            <AhxSliderField
              label="Filter speed"
              :model-value="instrument.filterSpeed"
              :max="AHX_NUMBER_FIELDS.filterSpeed"
              :throttle-ms="AHX_TABLE_THROTTLE_MS"
              testid="ahx-field-filterSpeed"
              :title="AHX_HELP.filterSpeed"
              @update:model-value="setNumber('filterSpeed', $event)"
            />
            <div class="ahx-field-row">
              <label class="ahx-check" :title="AHX_HELP.hardCutRelease">
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
                suffix="frames"
                testid="ahx-field-hardCutReleaseFrames"
                :title="AHX_HELP.hardCutReleaseFrames"
                @update:model-value="setNumber('hardCutReleaseFrames', $event)"
              />
            </div>
            <p
              v-if="!instrument.hardCutRelease && instrument.hardCutReleaseFrames > 0"
              class="ahx-warn"
              data-testid="ahx-hardcut-abrupt"
            >
              Hard cut release is off, so the note is muted abruptly {{ instrument.hardCutReleaseFrames }}
              {{ instrument.hardCutReleaseFrames === 1 ? 'tick' : 'ticks' }} before the next row that sets an instrument (a number above the tempo cuts from the start of the row).
            </p>
          </div>
          <AhxSweepLane
            class="ahx-fieldset-lane"
            kind="filter"
            :instrument="instrument"
            :format="songFormat"
            :version="sourceVersion"
            @enable="enableSweep('filter')"
          />
        </fieldset>
      </div>

      <div class="ahx-right">
        <div class="ahx-right-top">
          <AhxAuditionBar
            :audible="audible"
            :held-keys="heldKeys"
            v-model:latch="latch"
            v-model:restrike="restrike"
            :octave="octave"
            :strip-start="stripStart"
            :midi-status="play.midiStatus.value"
            @pointer-down="play.pointerDown"
            @pointer-up="play.pointerUp"
            @set-octave="play.setOctave"
            @toggle-midi="play.toggleMidi"
          />
          <div v-if="audible" class="ahx-analyzer" data-testid="ahx-analyzer-row">
            <OscilloscopeComponent :node="ahxPreviewOutputNode" :mono="true" data-testid="ahx-analyzer-oscilloscope" />
            <FrequencyAnalyzerComponent :node="ahxPreviewOutputNode" data-testid="ahx-analyzer-frequency" />
          </div>
          <span v-else class="ahx-dim" data-testid="ahx-analyzer-off"
            >Unavailable: there is no source file to play this instrument from.</span
          >
        </div>

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
                  :title="AHX_HELP[stage.framesHelp]"
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
                  :title="stage.volumeHelp ? AHX_HELP[stage.volumeHelp] : ''"
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
          <AhxSegmented
            label="Starts with"
            :model-value="startWaveform"
            :options="START_WAVE_OPTIONS"
            :title="AHX_HELP.startWaveform"
            testid="ahx-seg-startWaveform"
            @update:model-value="setStartWaveform"
          />
          <label class="ahx-field" :title="AHX_HELP.startWaveform">
            <span class="ahx-field__label">Exact value</span>
            <select
              class="ahx-select"
              data-testid="ahx-start-waveform"
              :title="AHX_HELP.startWaveform"
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
                ? AHX_HELP.filterPosition
                : 'The first PList row has no free command slot for a brightness (filter position) command.'
            "
            testid="ahx-start-filter"
            @update:model-value="setStartFilter"
          />
        </div>
        <AhxWaveShape
          :kind="previewKind"
          :wave-length="instrument.waveLength"
          :square-pos="previewSquarePos"
          :filtered="usesFilter"
        />
        <p class="ahx-dim ahx-note" data-testid="ahx-wave-character">{{ AHX_WAVE_CHARACTER[previewKind] }}</p>
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
      </div>

      <section class="ahx-card ahx-plist-full">
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
            :title="AHX_HELP.plistSpeed"
            @update:model-value="setPListSpeed"
          />
          <button
            type="button"
            class="ahx-btn"
            data-testid="ahx-plist-add"
            :title="AHX_HELP.plistAdd"
            :disabled="instrument.plist.entries.length >= AHX_MAX_PLIST_ENTRIES"
            @click="addRow()"
          >
            Add row
          </button>
          <button
            v-if="canEditPList"
            type="button"
            class="ahx-btn ahx-plist-edit-toggle"
            :class="{ 'ahx-btn--active': plistEdit.mode }"
            :aria-pressed="plistEdit.mode ? 'true' : 'false'"
            :disabled="!plistEdit.mode && instrument.plist.entries.length === 0"
            :title="EDIT_TOGGLE_TITLE"
            data-testid="ahx-plist-edit-toggle"
            @click="setPListEditMode(!plistEdit.mode)"
          >
            {{ plistEdit.mode ? 'Edit steps: on (keyboard piano off)' : 'Edit steps (F2)' }}
          </button>
          <span
            v-else
            class="ahx-dim ahx-plist-edit-unavailable"
            :title="EDIT_UNAVAILABLE_TITLE"
            data-testid="ahx-plist-edit-unavailable"
            >Canvas editing needs an editable AHX song; the table edits any.</span
          >
          <button
            type="button"
            class="ahx-btn ahx-plist-table-toggle"
            :class="{ 'ahx-btn--active': plistTableVisible }"
            :aria-expanded="plistTableVisible ? 'true' : 'false'"
            title="Every row's typed fields, for editing without the canvas."
            data-testid="ahx-plist-table-toggle"
            @click="plistTableVisible = !plistTableVisible"
          >
            {{ plistTableVisible ? 'Hide table' : 'Show table' }}
          </button>
        </div>
        <div v-if="editNotice" class="ahx-notice ahx-notice--edit" role="status" data-testid="ahx-edit-notice">
          {{ editNotice.message }}
        </div>
        <PListCanvas
          ref="plistCanvasRef"
          :instrument="instrument"
          :selected="selectedRow"
          :playhead-row="playheadRow"
          :audible="audible"
          :editable="canEditPList"
          :edit-mode="plistEdit.mode"
          :cursor="plistCursor"
          :step-size="trackerStore.stepSize"
          :octave="octave"
          :menu-reasons="plistMenuReasons"
          @select="onPListSelect"
          @cursor="onPListCursor"
          @edit="onPListEdit"
          @refuse="reportAhxEditNotice"
          @undo="onPListUndo"
          @redo="onPListRedo"
          @focus-field="focusField"
        />
        <div v-if="instrument.plist.entries.length" v-show="plistTableVisible" class="ahx-plist-scroll">
          <table class="ahx-table" data-testid="ahx-plist">
            <thead>
              <tr>
                <th>Row</th><th>Note</th><th>Waveform</th><th>Fixed</th>
                <th>FX 1</th><th>FX 2</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(entry, index) in instrument.plist.entries"
                :key="index"
                :class="{ 'ahx-row--selected': index === selectedRow, 'ahx-row--playing': index === playheadRow }"
                :data-selected="index === selectedRow ? 'true' : 'false'"
                :data-playing="index === playheadRow ? 'true' : 'false'"
                :data-testid="`ahx-plist-row-${index}`"
                @focusin="selectedRow = index"
              >
                <td class="ahx-dim" :title="AHX_HELP.plistRow">{{ hex2(index) }}</td>
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
                    :title="AHX_HELP.plistWaveform"
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
                    :title="AHX_HELP.plistFixed"
                    :data-testid="`ahx-plist-${index}-fixed`"
                    :checked="entry.fixed"
                    @change="editEntry(index, { field: 'fixed', value: ($event.target as HTMLInputElement).checked })"
                  />
                </td>
                <td v-for="slotIndex in FX_SLOTS" :key="slotIndex" class="ahx-plist-fx">
                  <select
                    class="ahx-select"
                    :data-testid="`ahx-plist-${index}-fx${slotIndex}`"
                    :title="ahxFxTooltip(entry.fx[slotIndex] ?? 0, entry.fxParam[slotIndex] ?? 0)"
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
                    :title="AHX_HELP.plistInsert"
                    @click="addRow(index)"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    class="ahx-btn ahx-btn--small"
                    :data-testid="`ahx-plist-remove-${index}`"
                    :title="AHX_HELP.plistRemove"
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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
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
  useAhxPlayInput,
} from 'src/composables/useAhxPlayInput';
import AhxAuditionBar from 'src/components/ahx/AhxAuditionBar.vue';
import { ahxSourceInfo } from 'src/audio/tracker/ahx-source';
import { ahxPListPlayhead } from 'src/audio/tracker/ahx-plist-playhead';
import { ahxPreviewOutputNode } from 'src/audio/tracker/ahx-preview-output';
import OscilloscopeComponent from 'src/components/OscilloscopeComponent.vue';
import FrequencyAnalyzerComponent from 'src/components/FrequencyAnalyzerComponent.vue';
import { ahxNotices, reportAhxNotice } from 'src/audio/tracker/ahx-notices';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import AhxSliderField from 'src/components/ahx/AhxSliderField.vue';
import AhxSegmented from 'src/components/ahx/AhxSegmented.vue';
import AhxEnvelopeEditor from 'src/components/ahx/AhxEnvelopeEditor.vue';
import AhxWaveShape from 'src/components/ahx/AhxWaveShape.vue';
import AhxVibratoLane from 'src/components/ahx/AhxVibratoLane.vue';
import AhxSweepLane from 'src/components/ahx/AhxSweepLane.vue';
import PListCanvas from 'src/components/ahx/PListCanvas.vue';
import { ahxEditNotice, reportAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { isTextEntryTarget } from 'src/composables/keyboard/note-key-map';
import { useAhxPListEditing } from 'src/composables/useAhxPListEditing';
import {
  AHX_FX_NAMES,
  AHX_HELP,
  AHX_WAVE_CHARACTER,
  ahxFxParamTooltip,
  ahxFxTooltip,
  type AhxHelpKey,
} from 'src/audio/tracker/ahx-plain-language';
import {
  ahxSweepSetup,
  ahxUsesFilter,
  type AhxSweepKind,
} from 'src/audio/tracker/ahx-instrument-visuals';
import { AHX_TABLE_THROTTLE_MS } from 'src/composables/useAhxDrag';
import {
  ahxNoteName,
  ahxWaveCycleLength,
  ahxWaveformKind,
  ahxWaveformLabel,
  ahxWaveformList,
  type AhxWaveformKind,
} from 'src/audio/tracker/ahx-instrument-display';
import {
  AHX_EDIT_MAX_VOLUME,
  AHX_MAX_FILTER_POSITION,
  AHX_NUMBER_FIELDS,
  ahxEnvelopeWarnings,
  enableAhxSweep,
  ahxFxParamMax,
  ahxStartFilterPosition,
  ahxStartWaveform,
  canSetAhxStartFilterPosition,
  editAhxPListEntry,
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

const sweepContext = computed(() => ({ format: songFormat.value, version: sourceVersion.value }));

/** The tone the shape preview draws: the first row's, else the first the PList picks, else the default (triangle). */
const previewKind = computed<AhxWaveformKind>(() => {
  const field = startWaveform.value !== 0 ? startWaveform.value : (waveforms.value[0]?.field ?? 1);
  const kind = ahxWaveformKind(field);
  return kind === 'keep' || kind === 'unknown' ? 'triangle' : kind;
});
/**
 * The pulse width the square preview shows: where the PList sets it, else where
 * a fresh voice starts, position 0 (a very thin pulse; a sweep, if on, slides in
 * from there; a channel that has already played keeps the position it left, `voice.rs:129-132`). The same start as the sweep lane's trace (`startPos ?? 0`).
 */
const previewSquarePos = computed(() => {
  const ins = instrument.value;
  if (!ins) return 0;
  return ahxSweepSetup(ins, 'square', sweepContext.value).startPos ?? 0;
});
const usesFilter = computed(() =>
  instrument.value ? ahxUsesFilter(instrument.value, sweepContext.value) : false,
);

/** The PList row the canvas and the table highlight. */
const selectedRow = ref<number | null>(null);
function selectRow(row: number): void {
  selectedRow.value = row;
  void nextTick(() => {
    document
      .querySelector<HTMLElement>(`[data-testid="ahx-plist-row-${row}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  });
}
// A row that no longer exists (removed) is not selected any more.
watch(
  () => instrument.value?.plist.entries.length ?? 0,
  (count) => {
    if (selectedRow.value !== null && selectedRow.value >= count) selectedRow.value = null;
  },
);

/**
 * The PList row the engine's preview note is on, for this slot, or -1. The
 * instrument stamp comes from the engine with each report: a note of another
 * instrument, or a row the list no longer has, is not this list's playhead.
 */
const playheadRow = computed(() => {
  const playhead = ahxPListPlayhead.value;
  const count = instrument.value?.plist.entries.length ?? 0;
  return playhead !== null &&
    slotNumber.value !== null &&
    playhead.instrument === slotNumber.value &&
    playhead.row >= 0 &&
    playhead.row < count
    ? playhead.row
    : -1;
});

const enableSweep = (kind: AhxSweepKind) =>
  commit((ins) => enableAhxSweep(ins, kind, sweepContext.value));

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

/** The wave picker: Keep, then the four tones with their glyph and what they sound like. */
const START_WAVE_OPTIONS = [
  { value: 0, label: 'Keep', title: 'Leaves the tone as it was.' },
  ...(['triangle', 'sawtooth', 'square', 'noise'] as const).map((kind, i) => ({
    value: i + 1,
    label: kind === 'sawtooth' ? 'Saw' : kind[0]!.toUpperCase() + kind.slice(1),
    glyph: WAVE_GLYPH[kind],
    title: AHX_WAVE_CHARACTER[kind],
  })),
];

/** What a PList row's waveform field can be: 0 keeps the voice's, 1..=4 the four waves. */
const WAVEFORM_CHOICES = [0, 1, 2, 3, 4].map((value) => ({
  value,
  label: value === 0 ? 'Keep' : ahxWaveformLabel(value),
}));

const ENVELOPE_STAGES: ReadonlyArray<{
  label: string;
  frames: keyof AhxEnvelope;
  volume?: keyof AhxEnvelope;
  framesHelp: AhxHelpKey;
  volumeHelp?: AhxHelpKey;
}> = [
  { label: 'Attack', frames: 'aFrames', volume: 'aVolume', framesHelp: 'envAttackFrames', volumeHelp: 'envAttackVolume' },
  { label: 'Decay', frames: 'dFrames', volume: 'dVolume', framesHelp: 'envDecayFrames', volumeHelp: 'envDecayVolume' },
  { label: 'Sustain', frames: 'sFrames', framesHelp: 'envSustainFrames' },
  { label: 'Release', frames: 'rFrames', volume: 'rVolume', framesHelp: 'envReleaseFrames', volumeHelp: 'envReleaseVolume' },
];

const FX_SLOTS = [0, 1] as const;
/** The song's format decides which PList commands a row can hold (HVL has more than AHX). */
const songFormat = computed(() => ahxSourceInfo.value?.format ?? 'ahx');
const FX_CHOICES = computed(() =>
  ahxPListCommandsFor(songFormat.value).map((value) => ({
    value,
    label: `${value.toString(16).toUpperCase()} ${AHX_FX_NAMES[value] ?? 'Unused'}`,
  })),
);

/** Whether the song's source is there to play from: without it an edit is kept but never heard. */
const audible = computed(() => ahxSourceInfo.value !== null);
const notices = ahxNotices;

/** The header's version: a version-0 AHX file drops a filter toggle's high nibble at load. */
const sourceVersion = computed(() => ahxSourceInfo.value?.version ?? 1);

const paramTitle = (fx: number): string =>
  ahxFxParamMax(fx, songFormat.value, sourceVersion.value) < 255
    ? `${ahxFxParamTooltip(fx)} This is an AHX version 0 file: it ignores the brightness digit, so only the pulse-width toggle (0-15) plays.`
    : ahxFxParamTooltip(fx);

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
const setStartWaveform = (value: number) => commit((ins) => setAhxStartWaveform(ins, value));
const setStartFilter = (value: number) => commit((ins) => setAhxStartFilterPosition(ins, value));
const setPListSpeed = (value: number) => commit((ins) => setAhxPListSpeed(ins, value));
const editEntry = (row: number, edit: AhxPListEdit) =>
  commit((ins) => editAhxPListEntry(ins, row, edit, songFormat.value));

// ---------------------------------------------------------------------------
// Editing steps: the row buttons, the canvas keys and the row menu are one path
// ---------------------------------------------------------------------------

const editNotice = ahxEditNotice;
/** The full PList table sits behind this toggle (default hidden); a double-click hand-off (`focusField`) opens it too. */
const plistTableVisible = ref(false);

const {
  plistEdit,
  plistCanvasRef,
  canEditPList,
  plistCursor,
  EDIT_TOGGLE_TITLE,
  EDIT_UNAVAILABLE_TITLE,
  setPListEditMode,
  onPListCursor,
  onPListSelect,
  onPListEdit,
  onPListUndo,
  onPListRedo,
  plistMenuReasons,
  addRow,
  removeRow,
} = useAhxPListEditing({
  instrument,
  slotNumber,
  songFormat,
  sourceVersion,
  trackerStore,
  selectedRow,
  selectRow,
  releaseKeyboard: () => play.releaseKeyboard(),
});

/**
 * Double-click on an envelope node, or the canvas's hand-off to the same table
 * field: the typed field for the same value. A PList field opens the table
 * first if it is behind the `v-show` toggle — `display:none` cannot receive
 * focus, so the ref flip must land in the DOM (`nextTick`) before the
 * querySelector/focus.
 */
async function focusField(testid: string): Promise<void> {
  if (/^ahx-plist-\d+-/.test(testid)) plistTableVisible.value = true;
  await nextTick();
  const el = document.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`);
  el?.focus();
  // A select (the tone, a command) has no text to select.
  el?.select?.();
}

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
  // Edit mode types with the keys the piano would take; the on-screen keys and MIDI still play.
  suspended: computed(() => plistEdit.mode),
});
const { heldKeys, latch, octave } = play;

/** The strip's lowest key follows the octave shift, so touch reaches the same range the keyboard does. */
const stripStart = computed(() => 48 + (octave.value - AHX_DEFAULT_OCTAVE) * 12);

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
    // Edit mode first: only a second Escape leaves the page.
    if (plistEdit.mode) {
      setPListEditMode(false);
      return;
    }
    backToTracker();
    return;
  }
  if (event.key === 'F2' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    // A field being typed in keeps its keys; F2 is only the canvas's toggle.
    if (isTextEntryTarget(event.target) || !canEditPList.value) return;
    event.preventDefault();
    setPListEditMode(!plistEdit.mode);
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
  grid-template-columns: minmax(300px, 380px) 1fr;
  gap: 12px;
  padding: 12px;
}

.ahx-left {
  display: grid;
  gap: 12px;
  align-content: start;
}

.ahx-right {
  display: grid;
  gap: 12px;
}

.ahx-plist-full {
  grid-column: 1 / -1;
}

.ahx-card {
  margin: 0;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}

.ahx-card h3,
.ahx-card legend {
  margin: 0 0 8px;
  padding: 0;
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

.ahx-btn--active {
  color: var(--app-background, #0b111a);
  background: var(--tracker-accent-primary, #f0b25e);
  border-color: var(--tracker-accent-primary, #f0b25e);
}

.ahx-notice--edit {
  margin: 0 0 8px;
}

.ahx-plist-edit-unavailable {
  font-size: 0.8rem;
}

/* A soft keyboard cannot type into a canvas: on touch the row menu and the table are the editors. */
@media (hover: none) {
  .ahx-plist-edit-toggle {
    display: none;
  }
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

.ahx-right-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.ahx-analyzer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 280px;
}

/* FrequencyAnalyzerComponent inherits height: 100% with no fallback, so an
   unsized flex slot would collapse its canvas to 0 and it would draw
   nothing; OscilloscopeComponent has its own fixed 120px canvas that this
   caps down to match. */
.ahx-analyzer > * {
  height: 70px;
}

.ahx-analyzer :deep(canvas) {
  height: 70px;
}

.ahx-fieldset-lane {
  margin-top: 10px;
}

.ahx-row--selected td {
  background: var(--tracker-active-bg, #14283d);
}

/* The step the note is on: a marker on the row number, not a background, so it reads beside the selection. The table does not scroll to it. */
.ahx-row--playing td:first-child {
  box-shadow: inset 3px 0 0 var(--tracker-accent-primary, #f0b25e);
  color: var(--tracker-accent-primary, #f0b25e);
  font-weight: 700;
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
