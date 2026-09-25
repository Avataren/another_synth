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
        <q-btn
          v-if="doc && instrument"
          flat
          dense
          color="white"
          icon="content_copy"
          label="Copy"
          data-testid="sid-clone-instrument"
          title="A copy of this instrument, with copies of its table rows (editing one never changes the other)"
          :disable="doc.instruments.length >= SID_MAX_INSTRUMENTS"
          @click="cloneInstrument"
        />
        <q-btn
          v-if="doc && instrument"
          flat
          dense
          color="white"
          icon="delete"
          label="Delete"
          data-testid="sid-delete-instrument"
          title="Delete this instrument; the ones after it move down a number, and the song's rows follow them"
          @click="deleteInstrument(false)"
        />
        <q-btn flat dense color="white" icon="arrow_back" label="Back to Tracker" title="Press Escape to return" @click="backToTracker" />
      </div>
    </div>

    <div v-if="editNotice" class="sid-notice" role="alert" data-testid="sid-notice">{{ editNotice.message }}</div>

    <div v-if="pendingDelete !== null" class="sid-notice sid-confirm" role="alert" data-testid="sid-delete-confirm">
      Instrument {{ formatInstrumentId(instrumentNumber) }} is named on {{ pendingDelete }} row{{ pendingDelete === 1 ? '' : 's' }}. Delete it, and
      leave those rows without an instrument (their voice keeps the one it had)?
      <q-btn dense flat color="white" label="Delete" data-testid="sid-delete-confirm-yes" @click="deleteInstrument(true)" />
      <q-btn dense flat color="white" label="Cancel" @click="pendingDelete = null" />
    </div>

    <div v-if="!instrument || !doc" class="sid-empty" data-testid="sid-instrument-missing">
      This slot has no SID instrument. Open a SID song in the tracker and edit one of its instruments from the list.
    </div>

    <template v-else>
      <div class="sid-sound-band" data-testid="sid-sound-band">
        <AhxAuditionBar
          :audible="true"
          :held-keys="heldKeys"
          v-model:latch="latch"
          v-model:restrike="restrike"
          :octave="octave"
          :strip-start="stripStart"
          :midi-status="play.midiStatus.value"
          hint="Play with the keyboard (Z-M, Q-P), MIDI or the keys; an edit is heard from the next note."
          restrike-title="Strike the held note again shortly after each edit: the preview voice takes the edited instrument when a note is struck, so this is what makes an edit audible while you drag."
          @pointer-down="play.pointerDown"
          @pointer-up="play.pointerUp"
          @set-octave="play.setOctave"
          @toggle-midi="play.toggleMidi"
        />
        <PreviewScopeBand
          class="sid-scopes"
          testid-prefix="sid"
          :spectrum-node="previewNode"
          :audio-node="previewNode"
          :analyser-full-scale="playbackStore.getSidPreviewFullScale"
          :scope-gain="userSettings.settings.ahxScopeGain"
        />
      </div>

      <div class="sid-body">
        <!-- What the note plays, frame by frame: the ground truth every card below reads from. -->
        <fieldset class="sid-card sid-timeline" data-testid="sid-timeline">
          <legend>What a note plays</legend>
          <div class="sid-timeline__cursor">
            <label for="sid-frame-cursor">Frame</label>
            <input
              id="sid-frame-cursor"
              type="range"
              min="0"
              :max="LANE_FRAMES - 1"
              step="1"
              :value="cursor"
              data-testid="sid-frame-cursor"
              title="Pick a frame of the note: the waveform, the drawings and the table rows below show that frame"
              @input="cursor = Number(($event.target as HTMLInputElement).value)"
            />
            <span class="sid-mono" data-testid="sid-frame-readout">{{ cursor }} · {{ frameMs(cursor) }} ms</span>
          </div>
          <svg
            class="sid-wave-lane"
            :viewBox="`0 0 ${LANE_FRAMES} 20`"
            preserveAspectRatio="none"
            data-testid="sid-wave-lane"
            @click="pickFrame"
          >
            <rect
              v-for="(t, f) in trace"
              :key="f"
              :x="f"
              :y="t.gate ? 0 : 10"
              width="1"
              :height="t.gate ? 20 : 10"
              :class="`sid-wave--${sidWaveClass(t.waveform)}`"
            >
              <title>Frame {{ f }}: {{ sidControlName(t.waveform, false) }}, gate {{ t.gate ? 'on' : 'off' }}</title>
            </rect>
            <rect class="sid-cursor" :x="cursor" y="0" width="1" height="20" />
          </svg>
          <div class="sid-legend sid-dim">
            <span v-for="k in WAVE_LEGEND" :key="k.cls"><i :class="`sid-wave--${k.cls}`" />{{ k.label }}</span>
            <span><i class="sid-legend__half" />gate off (releasing)</span>
          </div>
          <p class="sid-now" data-testid="sid-now">
            <b>Frame {{ cursor }}:</b>
            <span data-testid="sid-now-wave"><b>{{ sidWaveformName(now.waveform) }}</b>, gate {{ now.gate ? 'on' : 'off' }} ({{ sourceText(now.waveSource) }})</span>
            · <span data-testid="sid-now-pitch">{{ pitchText }}</span>
            · <span>width {{ hex3(nowFrame[1]) }} ({{ ((nowFrame[1] / 4096) * 100).toFixed(0) }} %){{ now.pulseRow ? `, pulse row ${hexByte(now.pulseRow)}` : '' }}</span>
            <template v-if="usesFilter">
              · <span>cutoff {{ hex3(nowFrame[3]) }} ({{ Math.round(sidCutoffHz(doc.chipModel, nowFrame[3])) }} Hz){{ now.filterRow ? `, filter row ${hexByte(now.filterRow)}` : '' }}</span>
            </template>
          </p>
          <p class="sid-dim sid-note">
            A C-4 played on the preview voice, 50.12 frames a second, the C64's PAL rate ({{ LANE_FRAMES }} frames). Drag the frame, or click the strip.
          </p>
        </fieldset>

        <div class="sid-col">
          <fieldset class="sid-card" data-testid="sid-card-wave">
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
            <SidRowPointer
              label="Wave table"
              :model-value="instrument.wavePtr"
              :table-length="doc.tables.wave.length"
              none-text="none: the first-frame byte plays all through the note"
              testid="sid-field-wavePtr"
              title="The wave table row the note starts on: it sets the waveform and the arpeggio frame by frame."
              @update:model-value="edit({ wavePtr: $event })"
              @reveal="reveal('wave', $event)"
            />
            <p class="sid-wave-status" data-testid="sid-wave-status">{{ waveStatus }}</p>
            <div class="sid-toggles" data-testid="sid-waveform-bits">
              <label v-for="bit in CONTROL_BITS" :key="bit.bit" :title="bit.title" :class="`sid-bit sid-bit--${bit.name}`">
                <input
                  type="checkbox"
                  :checked="(targetByte & bit.bit) !== 0"
                  :data-testid="`sid-bit-${bit.name}`"
                  @change="commit(toggleSidWaveTargetBit(doc, instrumentNumber, waveTarget, bit.bit))"
                />
                {{ bit.label }}
              </label>
              <label title="The gate bit: set, the note sounds; clear, it releases (41 is pulse with the gate on, 40 pulse released)">
                <input
                  type="checkbox"
                  :checked="(targetByte & 0x01) !== 0"
                  data-testid="sid-bit-gate"
                  @change="commit(toggleSidWaveTargetBit(doc, instrumentNumber, waveTarget, 0x01))"
                />
                Gate
              </label>
              <span class="sid-mono sid-dim" data-testid="sid-wave-byte">${{ hexByte(targetByte) }}</span>
            </div>
            <svg class="sid-lane" viewBox="0 0 256 64" preserveAspectRatio="none" data-testid="sid-wave-shape">
              <path v-if="waveCycle" :d="sidStepPath(waveCycle, 256, 64)" />
            </svg>
            <p class="sid-dim sid-note">{{ waveCaption }}</p>
          </fieldset>

          <fieldset class="sid-card" data-testid="sid-card-pulse">
            <legend>Pulse</legend>
            <AhxSliderField
              label="Start width"
              :model-value="startWidth?.width ?? 0"
              :max="0xfff"
              :disabled="instrument.pulsePtr !== 0 && startWidth === null"
              :suffix="startWidth ? `(${((startWidth.width / 4096) * 100).toFixed(1)} %)` : ''"
              :hint="pulseHint"
              testid="sid-field-pulseWidth"
              title="The width the pulse table's first row sets on the note's second frame. 50 % is a square wave; near 0 or 100 % it gets thin and nasal."
              @update:model-value="commit(setSidInstrumentStartWidth(doc, instrumentNumber, $event))"
            />
            <SidRowPointer
              label="Pulse table"
              :model-value="instrument.pulsePtr"
              :table-length="doc.tables.pulse.length"
              none-text="none: the channel keeps the width it had"
              testid="sid-field-pulsePtr"
              title="The pulse table row the note starts on: it sets and sweeps the width frame by frame."
              @update:model-value="edit({ pulsePtr: $event })"
              @reveal="reveal('pulse', $event)"
            />
            <svg class="sid-lane" viewBox="0 0 256 48" preserveAspectRatio="none" data-testid="sid-pulse-lane">
              <path :d="sidStepPath(frames.map((f) => f[1]), 256, 48)" />
              <line class="sid-cursor-line" :x1="cursorX" :x2="cursorX" y1="0" y2="48" />
            </svg>
            <p class="sid-dim sid-note">Pulse width over the first {{ LANE_FRAMES }} frames (only heard with the pulse waveform on).</p>
          </fieldset>

          <fieldset class="sid-card" data-testid="sid-card-filter">
            <legend>Filter</legend>
            <SidRowPointer
              label="Filter table"
              :model-value="instrument.filterPtr"
              :table-length="doc.tables.filter.length"
              none-text="none: the filter stays as the song left it"
              testid="sid-field-filterPtr"
              title="The filter table row the note starts on. The filter is the chip's one: a table row changes it for every voice."
              @update:model-value="edit({ filterPtr: $event })"
              @reveal="reveal('filter', $event)"
            />
            <AhxSliderField
              label="Cutoff"
              :model-value="filterStart?.cutoff ?? 0"
              :max="0xff"
              :disabled="filterLocked || (filterStart !== null && filterStart.cutoff === null)"
              :suffix="filterStart?.cutoff != null ? `(${Math.round(sidCutoffHz(doc.chipModel, filterStart.cutoff << 3))} Hz on the ${doc.chipModel})` : ''"
              :hint="filterHint"
              testid="sid-field-cutoff"
              title="The cutoff the filter table's cutoff row sets (the register's high 8 bits)."
              @update:model-value="setFilter({ cutoff: $event })"
            />
            <AhxSliderField
              label="Resonance"
              :model-value="filterStart?.resonance ?? 0"
              :max="15"
              :disabled="filterLocked"
              :suffix="filterStart ? `(Q ${sidResonanceQ(doc.chipModel, filterStart.resonance).toFixed(2)})` : ''"
              testid="sid-field-resonance"
              @update:model-value="setFilter({ resonance: $event })"
            />
            <div class="sid-toggles">
              <span class="sid-dim">Mode</span>
              <label v-for="mode in FILTER_MODES" :key="mode.bit" :title="mode.title">
                <input
                  type="checkbox"
                  :checked="((filterStart?.mode ?? 0) & mode.bit) !== 0"
                  :disabled="filterLocked"
                  :data-testid="`sid-filter-${mode.label}`"
                  @change="setFilter({ mode: (filterStart?.mode ?? 0) ^ mode.bit })"
                />
                {{ mode.label }}
              </label>
            </div>
            <div class="sid-toggles" title="The chip has one filter: these pick which voices go through it.">
              <span class="sid-dim">Voices</span>
              <label v-for="v in [1, 2, 3]" :key="v">
                <input
                  type="checkbox"
                  :checked="((filterStart?.voices ?? 0) & (1 << (v - 1))) !== 0"
                  :disabled="filterLocked"
                  :data-testid="`sid-filter-voice-${v}`"
                  @change="setFilter({ voices: (filterStart?.voices ?? 0) ^ (1 << (v - 1)) })"
                />
                {{ v }}
              </label>
            </div>
            <svg class="sid-lane" viewBox="0 0 256 48" preserveAspectRatio="none" data-testid="sid-filter-response">
              <path :d="filterPath" />
            </svg>
            <p class="sid-dim sid-note">{{ filterCaption }}</p>
            <svg class="sid-lane" viewBox="0 0 256 48" preserveAspectRatio="none" data-testid="sid-cutoff-lane">
              <path :d="sidStepPath(frames.map((f) => f[3]), 256, 48, 0x7ff)" />
              <line class="sid-cursor-line" :x1="cursorX" :x2="cursorX" y1="0" y2="48" />
            </svg>
            <p class="sid-dim sid-note">Cutoff over the first {{ LANE_FRAMES }} frames of a note.</p>
          </fieldset>
        </div>

        <div class="sid-col">
          <fieldset class="sid-card" data-testid="sid-card-envelope">
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
            <p class="sid-dim sid-note">Level over 100 PAL frames (2 s), the gate released after 50 (the chip's own rates).</p>
          </fieldset>

          <fieldset class="sid-card" data-testid="sid-card-gate">
            <legend>Note start &amp; gate</legend>
            <div class="sid-field">
              <span class="sid-field__label">First frame</span>
              <input
                class="sid-hex"
                maxlength="2"
                spellcheck="false"
                :value="hexByte(instrument.firstWave)"
                data-testid="sid-field-firstWave"
                title="The control byte written on a note's first frame, in hex"
                @change="setFirstWave"
              />
              <button
                v-for="p in FIRST_WAVE_PRESETS"
                :key="p.value"
                type="button"
                class="sid-preset"
                :class="{ 'sid-preset--on': instrument.firstWave === p.value }"
                :title="p.title"
                :data-testid="`sid-first-wave-${hexByte(p.value)}`"
                @click="edit({ firstWave: p.value })"
              >
                {{ p.label }}
              </button>
            </div>
            <p class="sid-dim sid-note" data-testid="sid-first-wave-meaning">{{ firstWaveMeaning }}</p>
            <AhxSliderField
              label="Gate timer"
              :model-value="instrument.gateTimer"
              :max="SID_INSTRUMENT_NUMBER_FIELDS.gateTimer"
              :suffix="instrument.gateTimer === 0 ? '(off)' : `(frames: ${frameMs(instrument.gateTimer)} ms)`"
              testid="sid-field-gateTimer"
              title="How many frames before the next note of the channel the gate is cleared, so the envelope has time to release (GoatTracker's default is 2). 0: never early."
              @update:model-value="edit({ gateTimer: $event })"
            />
            <label class="sid-check">
              <input type="checkbox" :checked="instrument.hardRestart" data-testid="sid-hard-restart" @change="edit({ hardRestart: !instrument.hardRestart })" />
              Hard restart: the early gate-off also zeroes the envelope (AD 0F, SR 00), so every note starts its attack cleanly
            </label>
            <label class="sid-check">
              <input type="checkbox" :checked="instrument.noGateOff" data-testid="sid-no-gate-off" @change="edit({ noGateOff: !instrument.noGateOff })" />
              No gate-off: a note of this instrument is not preceded by the early gate-off or hard restart (legato)
            </label>
          </fieldset>

          <fieldset class="sid-card" data-testid="sid-card-vibrato">
            <legend>Vibrato</legend>
            <SidRowPointer
              label="Speed table"
              :model-value="instrument.speedPtr"
              :table-length="doc.tables.speed.length"
              none-text="none: no vibrato"
              testid="sid-field-speedPtr"
              title="The speed table row holding this instrument's vibrato (speed, depth). One row: the speed table is not walked."
              @update:model-value="edit({ speedPtr: $event })"
              @reveal="reveal('speed', $event)"
            />
            <AhxSliderField
              label="Delay"
              :model-value="instrument.vibratoDelay"
              :max="SID_INSTRUMENT_NUMBER_FIELDS.vibratoDelay"
              :suffix="instrument.vibratoDelay === 0 ? '(off)' : `(frames: ${frameMs(instrument.vibratoDelay - 1)} ms)`"
              :hint="vibratoHint"
              testid="sid-field-vibratoDelay"
              title="Frames before the vibrato starts. 0 turns the instrument's vibrato off; 1 starts it at once."
              @update:model-value="edit({ vibratoDelay: $event })"
            />
            <template v-if="speedRow">
              <AhxSliderField
                label="Speed"
                :model-value="speedRow.left & 0x7f"
                :max="0x7f"
                suffix="(higher is slower)"
                testid="sid-vib-speed"
                title="The turn value: how far the vibrato runs before it turns back. Higher is a slower, wider swing."
                @update:model-value="setSpeedRow('left', (speedRow.left & 0x80) | $event)"
              />
              <AhxSliderField
                label="Depth"
                :model-value="speedRow.right"
                :max="speedRow.left & 0x80 ? 31 : 0xff"
                :suffix="speedRow.left & 0x80 ? '(note gap >> this)' : '(register step a frame)'"
                testid="sid-vib-depth"
                @update:model-value="setSpeedRow('right', $event)"
              />
              <label class="sid-check">
                <input
                  type="checkbox"
                  :checked="(speedRow.left & 0x80) !== 0"
                  data-testid="sid-vib-fine"
                  @change="setSpeedRow('left', speedRow.left ^ 0x80)"
                />
                Note-relative depth (the same width in semitones on every note)
              </label>
              <p v-if="speedShared" class="sid-warn sid-note" data-testid="sid-vib-shared">{{ speedShared }}</p>
            </template>
            <svg class="sid-lane" viewBox="0 0 256 48" preserveAspectRatio="none" data-testid="sid-pitch-lane">
              <path :d="pitchPath" />
              <line class="sid-cursor-line" :x1="cursorX" :x2="cursorX" y1="0" y2="48" />
            </svg>
            <p class="sid-dim sid-note">Pitch over the first {{ LANE_FRAMES }} frames (arpeggio from the wave table, vibrato).</p>
          </fieldset>
        </div>

        <div class="sid-col sid-col--tables">
          <p class="sid-dim sid-note sid-tables-intro">
            The four tables belong to the song and are shared by every instrument. An instrument only names the row it
            <b>starts</b> at (▶, from its pointer; <code>00</code> = none); from there a table plays row after row until a
            <code>FF</code> row: <code>FF 00</code> stops, <code>FF nn</code> jumps to row nn (a loop). So a table's length is
            simply how many rows it has; each instrument's part of it is marked in green, the row the frame cursor is on is
            lit, and <span class="sid-warn">shared</span> rows are reached by other instruments too. Row numbers are hex.
          </p>
          <div class="sid-tables">
            <SidTableCard
              v-for="table in SID_TABLE_NAMES"
              :key="table"
              :ref="(el) => setTableCard(table, el)"
              :table="table"
              :label="TABLE_LABELS[table]"
              :rows="doc.tables[table]"
              :chip="doc.chipModel"
              :pointer="instrument[SID_TABLE_POINTER[table]]"
              :reached="reached[table]"
              :current="currentRow[table]"
              :used-by="users[table]"
              :instrument="instrumentNumber"
              @set-byte="(index, side, event) => setTableByte(table, index, side, event)"
              @insert="(at) => commit(insertSidTableRow(doc!, table, at))"
              @delete="(at) => commit(deleteSidTableRow(doc!, table, at))"
              @clear="(at) => commit(clearSidTableRow(doc!, table, at))"
              @set-pointer="(row) => edit({ [SID_TABLE_POINTER[table]]: row })"
              @template="(id) => addTemplate(table, id)"
            >
              <template #hint>{{ TABLE_HINTS[table] }}</template>
            </SidTableCard>
          </div>
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
 * (`sid-instrument-edit.ts`, `sid-table-rows.ts`) committed with an undo step
 * (`editSidDoc`), and the slots (names), the grid, the save and both SID
 * worklets follow the doc. The drawings are the Rust's own behaviour
 * (`sid-instrument-visuals.ts`, held to a fixture dumped from the Rust).
 *
 * What plays is shown before what is stored: a frame cursor over the note's
 * simulated frames (`simulateSidInstrument` and its trace) names the waveform
 * sounding at that frame and the byte that set it, and the waveform boxes
 * edit THAT byte (the instrument's own, its first-frame byte, or a wave-table
 * row), so a box ticked is a change heard. A GoatTracker instrument has no
 * waveform of its own at all: its wave table sets it.
 *
 * The AHX PList canvas does not carry over: a PList is one instrument's own
 * rows of note/waveform/two effects, while a SID instrument points into four
 * shared two-byte tables, so the tables are edited as byte rows here, each
 * with what it does in words.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { formatInstrumentId, sidFreqRegToHz, sidTableFreqReg } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import { AHX_DEFAULT_OCTAVE, useAhxPlayInput } from 'src/composables/useAhxPlayInput';
import {
  SID_MAX_INSTRUMENTS,
  SID_TABLE_NAMES,
  setSidChipModel,
  cloneSidInstrument,
  deleteSidInstrument,
  sidInstrumentUses,
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
  setSidInstrumentFilterStart,
  setSidInstrumentStartWidth,
  sidInstrumentFilterStart,
  sidInstrumentStartWidth,
  sidWaveTargetByte,
  toggleSidWaveTargetBit,
  type SidInstrumentFilterPatch,
  type SidInstrumentPatch,
  type SidWaveTarget,
} from 'src/audio/tracker/sid-instrument-edit';
import {
  SID_TABLE_POINTER,
  appendSidTableTemplate,
  clearSidTableRow,
  deleteSidTableRow,
  insertSidTableRow,
  sidControlName,
  sidNoteName,
  sidTableUsers,
  sidWaveClass,
  sidWaveformName,
} from 'src/audio/tracker/sid-table-rows';
import {
  SID_ATTACK_MS,
  sidCutoffHz,
  sidEnvelopeLevels,
  sidFilterResponseDb,
  sidFramesMs,
  sidResonanceQ,
  sidStepPath,
  sidWaveCycle,
  simulateSidInstrument,
  type SidFrameTrace,
  type SidInstrumentFrame,
  type SidWaveSource,
} from 'src/audio/tracker/sid-instrument-visuals';
import { ahxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import AhxSliderField from 'src/components/ahx/AhxSliderField.vue';
import AhxSegmented from 'src/components/ahx/AhxSegmented.vue';
import AhxAuditionBar from 'src/components/ahx/AhxAuditionBar.vue';
import PreviewScopeBand from 'src/components/tracker/PreviewScopeBand.vue';
import SidRowPointer from 'src/components/sid/SidRowPointer.vue';
import SidTableCard from 'src/components/sid/SidTableCard.vue';

const route = useRoute();
const router = useRouter();
const trackerStore = useTrackerStore();
const playbackStore = useTrackerPlaybackStore();
const userSettings = useUserSettingsStore();

const CHIP_OPTIONS = [
  { value: 0, label: '8580' },
  { value: 1, label: '6581' },
];
const CONTROL_BITS = [
  { bit: 0x10, name: 'triangle', label: 'Triangle', title: 'Triangle waveform' },
  { bit: 0x20, name: 'saw', label: 'Saw', title: 'Sawtooth waveform' },
  { bit: 0x40, name: 'pulse', label: 'Pulse', title: 'Pulse waveform (its width on the Pulse card)' },
  { bit: 0x80, name: 'noise', label: 'Noise', title: 'Noise' },
  { bit: 0x04, name: 'ring', label: 'Ring', title: 'Ring modulation by the previous voice (with triangle)' },
  { bit: 0x02, name: 'sync', label: 'Sync', title: 'Hard sync to the previous voice' },
  { bit: 0x08, name: 'test', label: 'Test', title: 'Test bit: holds the oscillator at zero' },
] as const;
const WAVE_LEGEND = [
  { cls: 'tri', label: 'triangle' },
  { cls: 'saw', label: 'saw' },
  { cls: 'pulse', label: 'pulse' },
  { cls: 'noise', label: 'noise' },
  { cls: 'mixed', label: 'combined' },
  { cls: 'none', label: 'no waveform' },
] as const;
const FILTER_MODES = [
  { bit: 1, label: 'LP', title: 'Low-pass: keeps what is below the cutoff' },
  { bit: 2, label: 'BP', title: 'Band-pass: keeps what is around the cutoff' },
  { bit: 4, label: 'HP', title: 'High-pass: keeps what is above the cutoff' },
] as const;
const FIRST_WAVE_PRESETS = [
  { value: 0x00, label: 'None', title: '00: no first-frame byte' },
  { value: 0x09, label: 'Test+gate', title: '09: test bit and gate, which resets the oscillator for a hard, consistent attack (GoatTracker\'s usual)' },
  { value: 0xff, label: 'Gate on', title: 'FF: only sets the gate' },
  { value: 0xfe, label: 'Gate off', title: 'FE: only clears the gate' },
] as const;
const ADSR = ['attack', 'decay', 'sustain', 'release'] as const;
const ADSR_LABELS = { attack: 'Attack', decay: 'Decay', sustain: 'Sustain', release: 'Release' } as const;
const TABLE_LABELS: Record<SidTableName, string> = { wave: 'Wave / arpeggio', pulse: 'Pulse', filter: 'Filter', speed: 'Speed' };
const TABLE_HINTS: Record<SidTableName, string> = {
  wave:
    'Wave column: 10-DF sets the waveform (bit 0 is the gate: 41 pulse sounding, 40 pulse released), 01-0F waits that many frames, 00 keeps the waveform, E0-EF a waveform-less control byte, F0-FE runs a pattern command. Note column: 00-7F semitones up from the played note, 80 the same note, 81-DF a fixed note.',
  pulse: 'Left 80-FF sets the width to its low digit and the right byte (88 00 is 50 %); 01-7F sweeps by the signed right byte for that many frames (F0 is -16).',
  filter: 'Left 80-F0 sets the mode (90 LP, A0 BP, C0 HP) with the right byte as resonance (high digit) and filtered voices (bits 0-2); 00 sets the cutoff; 01-7F sweeps it for that many frames.',
  speed: 'Data rows, not played in order: a vibrato reads one row as speed and depth, a slide (commands 1-3) as a 16-bit speed.',
};
const LANE_FRAMES = 96;
/** The preview's note on the drawings: C-4. */
const PREVIEW_NOTE = 48;

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
/** Rows naming the instrument, when a delete waits for the user to say yes; `null` otherwise. */
const pendingDelete = ref<number | null>(null);
watch(instrumentNumber, () => {
  pendingDelete.value = null;
});
function cloneInstrument(): void {
  if (!doc.value) return;
  if (trackerStore.editSidDoc(cloneSidInstrument(doc.value, instrumentNumber.value))) {
    void router.push({ name: 'sid-instrument-editor', params: { slot: String(trackerStore.sidDoc?.instruments.length ?? 1) } });
  }
}
/** Deletes the instrument; one that rows name asks first (in the page), then clears them. */
function deleteInstrument(confirmed = false): void {
  if (!doc.value) return;
  const n = instrumentNumber.value;
  const uses = sidInstrumentUses(doc.value, n).length;
  if (uses > 0 && !confirmed) {
    pendingDelete.value = uses;
    return;
  }
  pendingDelete.value = null;
  if (trackerStore.editSidDoc(deleteSidInstrument(doc.value, n, { clearUses: true }))) {
    const left = trackerStore.sidDoc?.instruments.length ?? 0;
    if (left > 0) void router.push({ name: 'sid-instrument-editor', params: { slot: String(Math.min(n, left)) } });
  }
}
function addInstrument(): void {
  if (!doc.value) return;
  if (trackerStore.editSidDoc(newSidInstrument(doc.value))) {
    void router.push({ name: 'sid-instrument-editor', params: { slot: String(trackerStore.sidDoc?.instruments.length ?? 1) } });
  }
}
const parseHexByte = (text: string): number => (/^[0-9a-fA-F]{1,2}$/.test(text.trim()) ? parseInt(text.trim(), 16) : NaN);
function setTableByte(table: SidTableName, index: number, side: 'left' | 'right', event: Event): void {
  const input = event.target as HTMLInputElement;
  if (doc.value) commit(editSidTableByte(doc.value, table, index, side, parseHexByte(input.value)));
  // A refused edit leaves the doc as it was: show its byte again.
  const row = doc.value?.tables[table][index];
  if (row) input.value = hexByte(row[side]);
}
function setFirstWave(event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = parseHexByte(input.value);
  if (Number.isInteger(value)) edit({ firstWave: value });
  input.value = hexByte(instrument.value?.firstWave ?? 0);
}
function addTemplate(table: SidTableName, id: string): void {
  const d = doc.value;
  if (!d) return;
  const start = d.tables[table].length + 1;
  if (trackerStore.editSidDoc(appendSidTableTemplate(d, table, id, instrumentNumber.value))) reveal(table, start);
}

/** Frames as milliseconds at the song's frame rate (PAL frames, the player's). */
const frameMs = (frames: number): number => Math.round(sidFramesMs(frames, doc.value?.speedMultiplier ?? 1));
const hex3 = (v: number): string => v.toString(16).toUpperCase().padStart(3, '0');

const adsrSuffix = (key: (typeof ADSR)[number]): string => {
  if (key === 'sustain') return `(${Math.round(((instrument.value?.sustain ?? 0) / 15) * 100)} %)`;
  const ms = SID_ATTACK_MS[instrument.value?.[key] ?? 0] ?? 0;
  return `(${key === 'attack' ? ms : ms * 3} ms)`;
};

// ---------------------------------------------------------------------------
// What plays: the preview voice's frames, and why each sounds as it does
// ---------------------------------------------------------------------------

const sim = computed(() => {
  const trace: SidFrameTrace[] = [];
  const frames = doc.value && instrument.value ? simulateSidInstrument(doc.value, instrumentNumber.value, PREVIEW_NOTE, LANE_FRAMES, trace) : [];
  return { frames, trace };
});
const frames = computed(() => sim.value.frames);
const trace = computed(() => sim.value.trace);
/**
 * The frame cursor. Frame 1 by default: frame 0 is often the first-frame
 * byte (test + gate), and a GoatTracker wave table takes over on frame 1.
 */
const cursor = ref(1);
const EMPTY_TRACE: SidFrameTrace = { waveform: 0, gate: false, waveSource: { kind: 'none' }, waveRow: 0, pulseRow: 0, filterRow: 0 };
const EMPTY_FRAME: SidInstrumentFrame = [0, 0, 0, 0, 0, 0];
const now = computed(() => trace.value[cursor.value] ?? EMPTY_TRACE);
const nowFrame = computed(() => frames.value[cursor.value] ?? EMPTY_FRAME);
const cursorX = computed(() => (((cursor.value + 0.5) * 256) / LANE_FRAMES).toFixed(2));
function pickFrame(event: MouseEvent): void {
  const svg = event.currentTarget as SVGElement;
  const width = svg.getBoundingClientRect().width;
  if (width > 0) cursor.value = Math.max(0, Math.min(LANE_FRAMES - 1, Math.floor((event.offsetX / width) * LANE_FRAMES)));
}

function sourceText(source: SidWaveSource): string {
  switch (source.kind) {
    case 'first-frame':
      return 'the first-frame byte';
    case 'wave-row':
      return `set by wave table row ${hexByte(source.row)}`;
    case 'wave-command':
      return `set by the command 7 in wave table row ${hexByte(source.row)}`;
    case 'none':
      return 'nothing has set a waveform yet';
  }
}

const pitchText = computed(() => {
  const reg = nowFrame.value[0];
  if (reg === 0) return 'no pitch yet';
  const hz = sidFreqRegToHz(reg);
  let best = 0;
  let bestCents = Infinity;
  for (let i = 0; i < 96; i++) {
    const cents = 1200 * Math.log2(reg / sidTableFreqReg(i));
    if (Math.abs(cents) < Math.abs(bestCents)) {
      best = i;
      bestCents = cents;
    }
  }
  const off = Math.round(bestCents);
  return `${sidNoteName(best)}${off ? ` ${off > 0 ? '+' : ''}${off} ct` : ''} (${hz.toFixed(1)} Hz)`;
});

// ---------------------------------------------------------------------------
// The waveform: the boxes edit the byte that sets what is heard
// ---------------------------------------------------------------------------

/**
 * The byte that set the waveform at the cursor's frame: what the boxes edit.
 * Before anything has set one, the first-frame byte (what a note plays first).
 */
const waveTarget = computed<SidWaveTarget>(() => {
  const source = now.value.waveSource;
  return source.kind === 'none' ? { kind: 'first-frame' } : source;
});
const targetByte = computed(() => (doc.value ? sidWaveTargetByte(doc.value, instrumentNumber.value, waveTarget.value) : 0));
const waveStatus = computed(() => {
  const ins = instrument.value;
  if (!ins) return '';
  const target = waveTarget.value;
  const shared = target.kind === 'wave-row' || target.kind === 'wave-command' ? sharedText('wave', target.row) : '';
  if (target.kind === 'first-frame') return `Editing the first-frame byte ${hexByte(ins.firstWave)}: it plays until a wave table row sets a waveform.`;
  return `Editing wave table row ${hexByte(target.row)}, what sounds at frame ${cursor.value}.${shared}`;
});
function sharedText(table: SidTableName, row: number): string {
  const others = (users.value[table].get(row) ?? []).filter((n) => n !== instrumentNumber.value);
  return others.length ? ` Shared with instrument ${others.map(hexByte).join(', ')}: they change too.` : '';
}

const waveCycle = computed(() => (doc.value ? sidWaveCycle(doc.value.chipModel, now.value.waveform, nowFrame.value[1], 256) : null));
const waveCaption = computed(() => {
  const w = now.value.waveform;
  if (w & 0x08 && (w & 0xf0) === 0) return `Frame ${cursor.value}: the test bit holds the oscillator at zero (silent), resetting it for the next frame.`;
  if ((w & 0xf0) === 0) return `Frame ${cursor.value}: no waveform, the voice holds its last level (silent).`;
  if (w & 0x80) return `Frame ${cursor.value}: noise, which has no cycle to draw.`;
  return `One cycle of the waveform at frame ${cursor.value} on the ${doc.value?.chipModel ?? ''}, before the filter${now.value.gate ? '' : ' (gate off: releasing)'}.`;
});

// ---------------------------------------------------------------------------
// Pulse, filter, envelope, vibrato
// ---------------------------------------------------------------------------

const startWidth = computed(() => (doc.value ? sidInstrumentStartWidth(doc.value, instrumentNumber.value) : null));
const pulseHint = computed(() => {
  const ins = instrument.value;
  if (!ins) return '';
  if (ins.pulsePtr === 0) return 'No pulse table: the channel keeps the width it had. Moving this adds a width row for this instrument.';
  if (startWidth.value === null) return `Pulse table row ${hexByte(ins.pulsePtr)} is a sweep or a jump: set the width in the table.`;
  return `Pulse table row ${hexByte(startWidth.value.row)}, from the note's second frame.${sharedText('pulse', startWidth.value.row)}`;
});
const filterStart = computed(() => (doc.value ? sidInstrumentFilterStart(doc.value, instrumentNumber.value) : null));
/** The filter table starts with something the controls cannot edit (a cutoff, sweep or jump row). */
const filterLocked = computed(() => !!instrument.value?.filterPtr && filterStart.value === null);
function setFilter(patch: SidInstrumentFilterPatch): void {
  if (doc.value) commit(setSidInstrumentFilterStart(doc.value, instrumentNumber.value, patch));
}
const usesFilter = computed(() => !!instrument.value && instrument.value.filterPtr !== 0);
const filterHint = computed(() => {
  const ins = instrument.value;
  if (!ins) return '';
  if (ins.filterPtr === 0) return 'No filter table: the filter stays as the song left it. Changing a control here adds a filter row for this instrument.';
  if (filterStart.value === null) return `Filter table row ${hexByte(ins.filterPtr)} does not set a mode: edit the filter in the table.`;
  if (filterStart.value.cutoff === null) return `Row ${hexByte(filterStart.value.row + 1)} is not a cutoff row: set the cutoff in the table.`;
  return `Filter table rows ${hexByte(filterStart.value.row)}-${hexByte(filterStart.value.row + 1)}.${sharedText('filter', filterStart.value.row)}`;
});
const filterCaption = computed(() =>
  instrument.value?.filterPtr
    ? `The response at frame ${cursor.value}, from the filter table, 30 Hz to 18 kHz (the ideal curve; the 6581's saturation is not drawn).`
    : 'No filter table: nothing to draw.',
);
const filterPath = computed(() => {
  const ins = instrument.value;
  const d = doc.value;
  if (!ins || !d || !ins.filterPtr) return '';
  const [, , , cutoff, res, mode] = nowFrame.value;
  const points = Array.from({ length: 128 }, (_, i) => {
    const hz = 30 * (18_000 / 30) ** (i / 127);
    const db = sidFilterResponseDb(d.chipModel, cutoff, res, mode, hz);
    return Math.max(0, Math.min(0xfff, ((db + 48) / 72) * 0xfff));
  });
  return sidStepPath(points, 256, 48);
});
const envelope = computed(() => {
  const ins = instrument.value;
  if (!ins) return [];
  return sidEnvelopeLevels((ins.attack << 4) | ins.decay, (ins.sustain << 4) | ins.release, 50, 100);
});
const pitchPath = computed(() => {
  const regs = frames.value.map((f) => f[0]);
  if (regs.length === 0) return '';
  const lo = Math.min(...regs);
  const hi = Math.max(...regs);
  const span = Math.max(1, hi - lo);
  return sidStepPath(regs.map((r) => ((r - lo) / span) * 0xfff * (hi === lo ? 0.5 : 1) + (hi === lo ? 0x800 : 0)), 256, 48);
});
const speedRow = computed(() => {
  const ins = instrument.value;
  return ins && ins.speedPtr ? (doc.value?.tables.speed[ins.speedPtr - 1] ?? null) : null;
});
const vibratoHint = computed(() =>
  instrument.value?.speedPtr && instrument.value.vibratoDelay === 0 ? 'The delay is 0, which turns the vibrato off: set 1 to start it at once.' : '',
);
const speedShared = computed(() => {
  const ptr = instrument.value?.speedPtr ?? 0;
  const text = ptr ? sharedText('speed', ptr) : '';
  return text ? `Speed row ${hexByte(ptr)} is the song's.${text}` : '';
});
function setSpeedRow(side: 'left' | 'right', value: number): void {
  const ptr = instrument.value?.speedPtr ?? 0;
  if (doc.value && ptr) commit(editSidTableByte(doc.value, 'speed', ptr - 1, side, value));
}

const firstWaveMeaning = computed(() => {
  const ins = instrument.value;
  if (!ins) return '';
  const fw = ins.firstWave;
  if (fw === 0) return '00: the note keeps the channel\'s waveform and gate until the wave table sets them.';
  if (fw === 0xff) return 'FF: the first frame only sets the gate.';
  if (fw === 0xfe) return 'FE: the first frame only clears the gate.';
  return `${hexByte(fw)} (${sidControlName(fw)}) is written on the note's first frame, and plays on until the wave table sets a waveform.`;
});

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

const reached = computed(() => {
  const ins = instrument.value;
  const d = doc.value;
  const from = (table: SidTableName) => (d && ins && ins[SID_TABLE_POINTER[table]] ? sidTableRowsFrom(d, table, ins[SID_TABLE_POINTER[table]]) : []);
  return { wave: from('wave'), pulse: from('pulse'), filter: from('filter'), speed: from('speed') };
});
const users = computed(() => {
  const d = doc.value;
  const of = (table: SidTableName) => (d ? sidTableUsers(d, table) : new Map<number, number[]>());
  return { wave: of('wave'), pulse: of('pulse'), filter: of('filter'), speed: of('speed') };
});
/** The row each table's step read at the cursor's frame (the speed table: the vibrato's row while it swings). */
const currentRow = computed(() => ({
  wave: now.value.waveRow,
  pulse: now.value.pulseRow,
  filter: now.value.filterRow,
  speed: instrument.value?.speedPtr ?? 0,
}));

const tableCards: Partial<Record<SidTableName, InstanceType<typeof SidTableCard>>> = {};
function setTableCard(table: SidTableName, el: Element | ComponentPublicInstance | null): void {
  if (el) tableCards[table] = el as InstanceType<typeof SidTableCard>;
  else delete tableCards[table];
}
function reveal(table: SidTableName, row: number): void {
  // After a template the new rows render on the next tick.
  setTimeout(() => tableCards[table]?.reveal(row), 0);
}

// Audition: the preview voice (its own SID worklet), and its output for the analyzer.
const previewNode = shallowRef<AudioNode | null>(playbackStore.sidPreviewOutput());
const stopPreviewWatch = playbackStore.onSidPreviewOutput((node) => {
  previewNode.value = node;
});
/**
 * The on-screen keys, the computer keyboard and MIDI play through the AHX
 * editor's input model (`useAhxPlayInput`): one voice, last key wins. The
 * note-off names its key, so letting go of a key another has taken over from
 * leaves the newer note sounding.
 */
const play = useAhxPlayInput({
  slot: slotNumber,
  audible: computed(() => instrument.value !== null),
  sink: {
    noteOn: (slotNo, midi) => void playbackStore.previewSidNoteOn(slotNo, midi),
    noteOff: (midi) => playbackStore.previewSidNoteOff(midi),
  },
  autoMidi: computed(() => userSettings.settings.enableMidi),
});
const { heldKeys, latch, octave } = play;
/** The strip's lowest key follows the octave, so touch reaches what the keyboard does (Z is C-3 at octave 4). */
const stripStart = computed(() => 48 + (octave.value - AHX_DEFAULT_OCTAVE) * 12);
/**
 * Re-strike on edit, as the AHX page: the preview voice takes the edited doc
 * when a note is struck, so striking the held note again after a short pause
 * is what makes an edit heard while it is being made. The tables are the
 * song's, so a table edit re-strikes too.
 */
const restrike = ref(false);
const RESTRIKE_DELAY_MS = 150;
let restrikeTimer: ReturnType<typeof setTimeout> | null = null;
watch([instrument, () => doc.value?.tables], () => {
  if (!restrike.value || heldKeys.size === 0) return;
  if (restrikeTimer !== null) clearTimeout(restrikeTimer);
  restrikeTimer = setTimeout(() => {
    restrikeTimer = null;
    play.restrikeHeld();
  }, RESTRIKE_DELAY_MS);
});
// Ready the preview voice, so the first key sounds at once.
onMounted(() => {
  if (instrument.value) void playbackStore.prepareSidPreview().catch(() => undefined);
});

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
  if (restrikeTimer !== null) clearTimeout(restrikeTimer);
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
.sid-toggles {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
/* A checkbox with a sentence: the box stays beside the text as it wraps. */
.sid-check {
  display: flex;
  align-items: baseline;
  gap: 8px;
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
.sid-mono {
  font-family: monospace;
}
.sid-warn {
  color: #f0b25e;
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
  align-items: stretch;
  gap: 12px;
  padding: 8px 12px;
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--app-background, #0b111a);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
/* The AHX editor's bar: its card frame comes from that page's `.ahx-card`, so it is given here. */
.sid-sound-band > .ahx-audition-bar {
  flex: 1 1 420px;
  position: static;
  margin: 0;
  border: 1px solid var(--tracker-accent-secondary, #3b82a0);
  border-radius: 6px;
}
.sid-sound-band > .sid-scopes {
  flex: 1 1 420px;
  align-self: center;
}
.sid-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 12px;
  padding: 12px;
}
.sid-timeline {
  grid-column: 1 / -1;
}
/*
 * Wide screens: the sound's two columns, then the tables taking what is left.
 * The four tables sit two by two there (each scrolls on its own), rather
 * than stacked into one column several screens tall.
 */
@media (min-width: 1400px) {
  .sid-body {
    grid-template-columns: minmax(340px, 1fr) minmax(340px, 1fr) minmax(460px, 1.5fr);
  }
}
.sid-tables {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  align-items: start;
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
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.sid-field__label {
  min-width: 100px;
  opacity: 0.65;
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
.sid-preset {
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  font-size: 0.85em;
  cursor: pointer;
}
.sid-preset--on {
  border-color: var(--tracker-accent-primary, #4df2c5);
  color: var(--tracker-accent-primary, #4df2c5);
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
.sid-cursor-line {
  stroke: rgba(255, 255, 255, 0.5);
  stroke-dasharray: 2 2;
  vector-effect: non-scaling-stroke;
}
.sid-note {
  margin: 0;
  font-size: 0.85em;
}
.sid-timeline__cursor {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sid-timeline__cursor input {
  flex: 1;
  accent-color: var(--tracker-accent-secondary, #5ec2e8);
}
.sid-wave-lane {
  width: 100%;
  height: 28px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
  cursor: crosshair;
}
.sid-cursor {
  fill: rgba(255, 255, 255, 0.35);
  stroke: #fff;
  stroke-width: 0.15;
}
.sid-wave--tri {
  fill: #5ec2e8;
  background: #5ec2e8;
}
.sid-wave--saw {
  fill: #f0b25e;
  background: #f0b25e;
}
.sid-wave--pulse {
  fill: #4df2c5;
  background: #4df2c5;
}
.sid-wave--noise {
  fill: #c9a0ff;
  background: #c9a0ff;
}
.sid-wave--mixed {
  fill: #ff7a8a;
  background: #ff7a8a;
}
.sid-wave--none {
  fill: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.12);
}
.sid-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 0.8em;
}
.sid-legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  border-radius: 2px;
  vertical-align: middle;
}
.sid-legend__half {
  background: linear-gradient(to top, rgba(255, 255, 255, 0.5) 50%, transparent 50%);
}
.sid-now {
  margin: 0;
}
.sid-wave-status {
  margin: 0;
  font-size: 0.9em;
}
.sid-tables-intro {
  line-height: 1.45;
}
</style>
