<template>
  <q-page class="tracker-page" :class="{ 'edit-mode-active': isEditMode }">
    <div
      ref="trackerContainer"
      class="tracker-container"
      :class="{ 'edit-mode': isEditMode, 'is-mobile': isMobileLayout }"
      tabindex="0"
      @keydown="onKeyDown"
      @pointerdown="onContainerPointerDown"
    >
      <div
        v-if="isLoadingSong"
        class="song-loading-overlay"
        role="alertdialog"
        aria-busy="true"
        aria-live="assertive"
        @pointerdown.stop.prevent
        @wheel.stop.prevent
        @contextmenu.stop.prevent
      >
        <div class="song-loading-dialog">
          <div class="spinner" aria-hidden="true"></div>
          <div class="song-loading-text">
            {{
              deepLinkPending && deepLinkSongName
                ? `Loading ${deepLinkSongName}…`
                : 'Loading song…'
            }}
          </div>
          <div v-if="!deepLinkPending" class="song-loading-subtext">
            Preparing instruments and assets
          </div>
        </div>
      </div>

      <!--
        Phone layout: one horizontal strip instead of three wrapping
        sections. Everything stays on one line and scrolls sideways, which
        costs one row of the little vertical space a phone has instead of
        the four the wrapped desktop toolbar took. Transport lives here too
        -- on desktop it sits in the song panel, which is collapsed here.
      -->
      <div v-if="isMobileLayout" class="tracker-toolbar toolbar-mobile">
        <div class="toolbar-strip">
          <button
            type="button"
            class="transport-icon-btn"
            :class="{ active: playbackMode === 'song' && isPlaying }"
            title="Play song"
            :disabled="isLoadingSong"
            @click="handlePlaySong"
          >
            <q-icon name="play_arrow" size="20px" />
          </button>
          <button
            type="button"
            class="transport-icon-btn"
            :class="{ active: playbackMode === 'pattern' && isPlaying }"
            title="Play pattern"
            :disabled="isLoadingSong"
            @click="handlePlayPattern"
          >
            <q-icon name="replay" size="18px" />
          </button>
          <button
            type="button"
            class="transport-icon-btn"
            title="Stop"
            :disabled="isLoadingSong"
            @click="handleStop"
          >
            <q-icon name="stop" size="20px" />
          </button>

          <span class="strip-divider" aria-hidden="true"></span>

          <button
            v-for="panel in MOBILE_PANELS"
            :key="panel.id"
            type="button"
            class="panel-chip"
            :class="{ active: mobilePanel === panel.id }"
            :aria-expanded="mobilePanel === panel.id"
            @click="toggleMobilePanel(panel.id)"
          >
            {{ panel.label }}
            <span class="chip-caret" aria-hidden="true">{{
              mobilePanel === panel.id ? '▾' : '▸'
            }}</span>
          </button>

          <span class="strip-divider" aria-hidden="true"></span>

          <button
            type="button"
            class="edit-mode-toggle toolbar-edit-toggle"
            :class="{ active: isEditMode }"
            :disabled="isReadOnly"
            :title="isReadOnly ? readOnlyHint : 'Edit mode'"
            @click="toggleEditMode"
          >
            Edit
          </button>
          <button
            type="button"
            class="toolbar-icon-button"
            :class="{ active: isFullscreen }"
            :title="isFullscreen ? 'Exit full screen' : 'Full screen pattern'"
            @click="toggleFullscreen"
          >
            ⛶
          </button>

          <span class="strip-divider" aria-hidden="true"></span>

          <button
            type="button"
            class="song-button ghost"
            :disabled="isLoadingSong"
            @click="handleNewSong"
          >
            New
          </button>
          <button
            type="button"
            class="song-button ghost"
            :disabled="isLoadingSong"
            @click="handleLoadSongFile"
          >
            Load
          </button>
          <button
            type="button"
            class="song-button"
            :disabled="isLoadingSong"
            @click="handleSaveSongFile"
          >
            Save
          </button>
          <button
            type="button"
            class="song-button ghost"
            data-testid="song-export-open"
            title="Export the song as a file"
            :disabled="isLoadingSong"
            @click="showSongExport = true"
          >
            Export…
          </button>
          <button
            type="button"
            class="song-button ghost"
            :disabled="isLoadingSong"
            @click="openDemoBrowser()"
          >
            Demos
          </button>
          <button
            type="button"
            class="song-button ghost"
            :disabled="isLoadingSong"
            @click="openJukebox"
          >
            Jukebox
          </button>
          <PostFxFilterControl compact />
          <label class="toggle toolbar-toggle">
            <input v-model="autoScroll" type="checkbox" />
            <span>Follow</span>
          </label>
        </div>
      </div>

      <div v-else class="tracker-toolbar">
        <div class="toolbar-section toolbar-left">
          <button
            type="button"
            class="transport-button ghost"
            :disabled="isExporting"
            @click="exportSongToMp3"
          >
            {{ isExporting ? 'Exporting…' : 'Export MP3' }}
          </button>
        </div>
        <div class="toolbar-section toolbar-middle">
          <button
            type="button"
            class="song-button"
            @click="addTrack"
            :disabled="isReadOnly || isAhxSong || trackCount >= 32"
            :title="isReadOnly ? readOnlyHint : isAhxSong ? ahxChannelsHint : 'Add a track'"
          >
            + Track
          </button>
          <button
            type="button"
            class="song-button ghost"
            @click="removeTrack"
            :disabled="isReadOnly || isAhxSong || trackCount <= 1"
            :title="isReadOnly ? readOnlyHint : isAhxSong ? ahxChannelsHint : 'Remove the current track'"
          >
            - Track
          </button>
        </div>
        <div class="toolbar-section toolbar-right">
          <button
            type="button"
            class="song-button ghost"
            title="Start a new song"
            @click="handleNewSong"
            :disabled="isLoadingSong"
          >
            New
          </button>
          <button
            type="button"
            class="song-button ghost"
            title="Load a song file"
            @click="handleLoadSongFile"
            :disabled="isLoadingSong"
          >
            Load
          </button>
          <button
            type="button"
            class="song-button"
            title="Save the song to a file"
            @click="handleSaveSongFile"
            :disabled="isLoadingSong"
          >
            Save
          </button>
          <button
            type="button"
            class="song-button ghost"
            data-testid="song-export-open"
            title="Export the song as a file"
            @click="showSongExport = true"
            :disabled="isLoadingSong"
          >
            Export…
          </button>
          <button
            type="button"
            class="song-button ghost"
            @click="openDemoBrowser()"
            :disabled="isLoadingSong"
          >
            Demos
          </button>
          <button
            type="button"
            class="song-button ghost"
            :disabled="isLoadingSong"
            title="Play the demo collection on its own page"
            @click="openJukebox"
          >
            Jukebox
          </button>
          <PostFxFilterControl />
          <label class="toggle toolbar-toggle">
            <input
              v-model="autoScroll"
              type="checkbox"
              @change="blurAndRefocusTracker"
            />
            <span>Auto-scroll</span>
          </label>
          <label class="toggle toolbar-toggle">
            <input
              v-model="userSettings.showTrackerExtraEffectColumn"
              type="checkbox"
              @change="blurAndRefocusTracker"
            />
            <span>Dual FX cols</span>
          </label>
          <button
            type="button"
            class="edit-mode-toggle toolbar-edit-toggle"
            :class="{ active: isEditMode }"
            :disabled="isReadOnly"
            :title="isReadOnly ? readOnlyHint : 'Edit mode (F2)'"
            @click="toggleEditMode"
          >
            Edit (F2)
          </button>
          <button
            type="button"
            class="toolbar-icon-button"
            :class="{ active: isFullscreen }"
            :title="isFullscreen ? 'Exit full screen' : 'Full screen pattern'"
            @click="toggleFullscreen"
          >
            ⛶
          </button>
        </div>
      </div>

      <!--
        Desktop: three panels side by side, always open. Phone: one sheet
        over the pattern showing whichever chip is expanded, and nothing at
        all while none is -- the pattern is what the screen is for.
      -->
      <div
        v-show="!isFullscreen && (!isMobileLayout || mobilePanel !== null)"
        class="top-grid"
        :class="{ 'top-grid-sheet': isMobileLayout }"
      >
        <div
          v-show="!isMobileLayout || mobilePanel === 'patterns'"
          class="top-panel"
        >
          <SequenceEditor
            ref="sequenceEditorRef"
            :sequence="sequence"
            :patterns="patterns"
            :current-pattern-id="currentPatternId"
            :current-sequence-index="currentSequenceIndex"
            :is-playing="isPlaying"
            :readonly="isReadOnly || isAhxSong"
            @select-pattern="handleSelectPattern"
            @add-pattern-to-sequence="handleAddPatternToSequence"
            @remove-pattern-from-sequence="handleRemovePatternFromSequence"
            @create-pattern="handleCreatePattern"
            @move-sequence-item="handleMoveSequenceItem"
            @rename-pattern="handleRenamePattern"
            @request-refocus="refocusTracker"
          />
        </div>
        <div
          v-show="!isMobileLayout || mobilePanel === 'song'"
          class="summary-card top-panel"
        >
          <div class="summary-header">
            <div class="eyebrow">Tracker</div>
            <div class="engine-rate" :title="engineRateTitle">
              {{ engineRateLabel }}
            </div>
          </div>
          <div class="song-meta">
            <div class="field">
              <label for="song-title">Song title</label>
              <input
                id="song-title"
                v-model="currentSong.title"
                type="text"
                placeholder="Untitled song"
                @blur="refocusTracker"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />
            </div>
            <div class="field">
              <label for="song-author">Author</label>
              <input
                id="song-author"
                v-model="currentSong.author"
                type="text"
                placeholder="Unknown"
                @blur="refocusTracker"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />
            </div>
            <div class="field">
              <label for="song-bpm">BPM</label>
              <input
                id="song-bpm"
                class="bpm-input"
                v-model.number="currentSong.bpm"
                type="number"
                :disabled="isReadOnly || isAhxSong"
                :title="isReadOnly || isAhxSong ? 'AHX/HVL songs set their own tempo' : ''"
                min="32"
                max="255"
                placeholder="120"
                @blur="refocusTracker"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />
            </div>
          </div>
          <div class="stats-inline">
            <span class="stat-inline"
              ><span class="stat-label">Patterns:</span>
              {{ patterns.length }}</span
            >
            <span class="stat-inline"
              ><span class="stat-label">Rows:</span> {{ rowsCount }}</span
            >
          </div>
          <div class="pattern-row-inline">
            <div class="pattern-controls">
              <div class="control-label">Pattern length</div>
              <div class="control-field">
                <input
                  class="length-input"
                  type="number"
                  :min="1"
                  :max="256"
                  :value="rowsCount"
                  :disabled="isReadOnly || isAhxSong"
                  :title="isReadOnly ? readOnlyHint : isAhxSong ? ahxLengthHint : ''"
                  @change="onPatternLengthInput($event)"
                  @blur="refocusTracker"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <div class="control-hint">Rows</div>
              </div>
            </div>
            <div class="pattern-controls">
              <div class="control-label">Step size</div>
              <div class="control-field">
                <input
                  class="length-input"
                  type="number"
                  :min="1"
                  :max="64"
                  :value="stepSize"
                  @change="
                    (event) =>
                      setStepSizeInput(
                        Number((event.target as HTMLInputElement).value),
                      )
                  "
                  @blur="refocusTracker"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <div class="control-hint">Rows per edit</div>
              </div>
            </div>
          </div>
          <div class="pattern-row-inline">
            <div class="pattern-controls">
              <div class="control-label">Base octave</div>
              <div class="control-field">
                <input
                  class="length-input"
                  type="number"
                  :min="0"
                  :max="8"
                  :value="baseOctave"
                  @change="
                    (event) =>
                      setBaseOctaveInput(
                        Number((event.target as HTMLInputElement).value),
                      )
                  "
                  @blur="refocusTracker"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <div class="control-hint">Shift+PgUp/PgDn</div>
              </div>
            </div>
          </div>
          <div class="transport-controls">
            <button
              type="button"
              class="transport-icon-btn"
              :class="{ active: playbackMode === 'pattern' && isPlaying }"
              title="Play Pattern (Space)"
              :disabled="isLoadingSong"
              @mousedown.prevent
              @focus="($event.target as HTMLButtonElement)?.blur()"
              @click="handlePlayPattern"
            >
              <q-icon name="replay" size="20px" />
            </button>
            <button
              type="button"
              class="transport-icon-btn"
              :class="{ active: playbackMode === 'song' && isPlaying }"
              title="Play Song"
              :disabled="isLoadingSong"
              @mousedown.prevent
              @focus="($event.target as HTMLButtonElement)?.blur()"
              @click="handlePlaySong"
            >
              <q-icon name="play_arrow" size="20px" />
            </button>
            <button
              type="button"
              class="transport-icon-btn"
              title="Pause"
              :disabled="isLoadingSong"
              @mousedown.prevent
              @focus="($event.target as HTMLButtonElement)?.blur()"
              @click="handlePause"
            >
              <q-icon name="pause" size="20px" />
            </button>
            <button
              type="button"
              class="transport-icon-btn"
              title="Stop"
              :disabled="isLoadingSong"
              @click="handleStop"
            >
              <q-icon name="stop" size="20px" />
            </button>
            <div class="volume-control">
              <q-icon name="volume_up" size="14px" class="volume-icon" />
              <input
                type="range"
                class="volume-slider"
                :value="userSettings.masterVolume"
                :style="{
                  '--volume-percent': `${userSettings.masterVolume * 100}%`,
                }"
                min="0"
                max="1"
                step="0.01"
                @input="onMasterVolumeChange"
                @change="blurAndRefocusTracker"
                @pointerup="blurAndRefocusTracker"
                @mousedown.stop
                @click.stop
                title="Master Volume"
              />
            </div>
          </div>
        </div>

        <div
          v-show="!isMobileLayout || mobilePanel === 'instruments'"
          class="instrument-panel top-panel"
        >
          <div class="panel-header">
            <div class="panel-title">Instruments</div>
            <div class="page-tabs">
              <button
                type="button"
                class="page-tab page-step"
                :disabled="currentInstrumentPage === 0"
                title="Previous page"
                @click="stepInstrumentPage(-1)"
              >
                &lsaquo;
              </button>
              <button
                v-for="page in visibleInstrumentPages"
                :key="page"
                type="button"
                class="page-tab"
                :class="{ active: currentInstrumentPage === page }"
                @click="trackerStore.setInstrumentPage(page)"
              >
                {{ page + 1 }}
              </button>
              <button
                type="button"
                class="page-tab page-step"
                :disabled="currentInstrumentPage >= TOTAL_PAGES - 1"
                title="Next page"
                @click="stepInstrumentPage(1)"
              >
                &rsaquo;
              </button>
            </div>
          </div>
          <div class="instrument-panel-body">
            <div class="instrument-list">
              <div
                v-for="slot in currentPageSlots"
                :key="slot.slot"
                class="instrument-row"
                :class="{
                  active: activeInstrumentId === formatInstrumentId(slot.slot),
                  empty: !slot.patchId && !isAhxSlot(slot),
                  'mod-instrument': !!instrumentBadgeLabel(slot),
                }"
                :title="slot.patchId || isAhxSlot(slot) ? `Bank: ${slot.bankName}` : ''"
                @click="setActiveInstrument(slot.slot)"
              >
                <div class="slot-number">
                  #{{ formatInstrumentId(slot.slot) }}
                  <span
                    v-if="instrumentBadgeLabel(slot)"
                    class="mod-badge"
                    :data-instrument-type="slot.instrumentType"
                    :data-instrument-format="slot.instrumentFormat"
                    >{{ instrumentBadgeLabel(slot) }}</span
                  >
                </div>
                <div
                  class="patch-name"
                  @dblclick.stop="beginInstrumentRename(slot)"
                >
                  <input
                    v-if="instrumentNameEditSlot === slot.slot"
                    :ref="(el) => setInstrumentNameInputRef(slot.slot, el)"
                    v-model="instrumentNameDraft"
                    type="text"
                    class="instrument-name-input"
                    @keydown.enter.prevent="
                      commitInstrumentRename(slot.slot);
                      refocusTracker();
                    "
                    @keydown.esc.prevent="
                      cancelInstrumentRename();
                      refocusTracker();
                    "
                    @blur="
                      commitInstrumentRename(slot.slot);
                      refocusTracker();
                    "
                  />
                  <span v-else>{{ getInstrumentDisplayName(slot) }}</span>
                </div>
                <PatchPicker
                  :model-value="slot.patchId ?? null"
                  :patches="availablePatches"
                  placeholder="Select patch"
                  @select="
                    (p) => {
                      onPatchSelect(slot.slot, p.id);
                      refocusTracker();
                    }
                  "
                  @close="refocusTracker"
                  @click.stop
                />
                <div
                  class="instrument-volume"
                  @click.stop
                  @mousedown.stop
                  @pointerup="blurAndRefocusTracker"
                >
                  <AudioKnobComponent
                    :model-value="slot.volume ?? 1.0"
                    label=""
                    :min="0"
                    :max="2"
                    :decimals="2"
                    scale="mini"
                    :unitFunc="formatGainAsDb"
                    :disable="isAhxSlot(slot)"
                    @update:model-value="onSlotVolumeChange(slot.slot, $event)"
                  />
                </div>
                <div class="instrument-actions">
                  <button
                    type="button"
                    class="icon-action-button"
                    :title="isReadOnly ? readOnlyHint : isAhxSong ? ahxInstrumentsHint : 'New patch'"
                    :disabled="isReadOnly || isAhxSong"
                    @click.stop="
                      createNewSongPatch(slot.slot);
                      refocusTracker();
                    "
                  >
                    <q-icon name="add" size="16px" />
                  </button>
                  <button
                    type="button"
                    class="icon-action-button"
                    :title="isAhxSlot(slot) ? 'Edit instrument' : 'Edit patch'"
                    :disabled="!canEditSlot(slot)"
                    @click.stop="editSlotPatch(slot.slot)"
                  >
                    <q-icon name="edit" size="16px" />
                  </button>
                  <button
                    type="button"
                    class="icon-action-button danger"
                    title="Clear instrument"
                    :disabled="isReadOnly || isAhxSong || !slot.patchId"
                    @click.stop="
                      clearInstrument(slot.slot);
                      refocusTracker();
                    "
                  >
                    <q-icon name="close" size="16px" />
                  </button>
                </div>
              </div>
            </div>
            <StereoLevelMeter
              :node="masterOutputNode"
              :audio-context="audioContext"
              :is-playing="isPlaying"
            />
          </div>
        </div>
      </div>

      <div
        v-if="waveformVisualizersVisible"
        ref="visualizerRowRef"
        class="visualizer-row"
        :style="{
          paddingLeft: `${visualizerPadding.left}px`,
          paddingRight: `${visualizerPadding.right}px`,
        }"
      >
        <div class="visualizer-spacer"></div>
        <div
          ref="visualizerTracksRef"
          class="visualizer-tracks visualizer-fade"
          :class="{ ready: visualizerReady }"
          :style="{
            '--tracker-track-width': trackerTrackWidth,
            '--tracker-track-gap': trackerTrackGap,
          }"
        >
          <div
            v-for="(track, index) in currentPattern?.tracks"
            :key="`viz-${track.id}`"
            class="visualizer-cell"
          >
            <!-- Per-track mute/solo: the sampler formats' track nodes, or for
                 AHX/HVL the worklet's per-voice mute/solo (same buttons, same
                 store state; see tracker-playback-store syncAhxMuteSolo). -->
            <div class="visualizer-controls">
              <button
                type="button"
                class="track-btn solo-btn"
                :class="{ active: soloedTracks.has(index) }"
                @click="toggleSolo(index)"
                title="Solo"
              >
                S
              </button>
              <button
                type="button"
                class="track-btn mute-btn"
                :class="{ active: mutedTracks.has(index) }"
                @click="toggleMute(index)"
                title="Mute"
              >
                M
              </button>
            </div>
            <TrackWaveform
              :audio-node="trackAudioNodes[index] ?? null"
              :audio-context="audioContext"
              :scope-source="isAhxSong ? playbackStore.getAhxChannelWaveform : null"
              :scope-channel="index"
              :scope-gain="userSettings.ahxScopeGain"
            />
          </div>
        </div>
      </div>

      <div class="pattern-area-wrapper" ref="patternAreaWrapperRef">
        <TrackerSpectrumAnalyzer
          v-if="spectrumAnalyzerVisible"
          :node="masterOutputNode"
          :track-nodes="spectrumTrackNodes"
          :is-playing="isPlaying"
        />
        <div
          ref="patternAreaRef"
          class="pattern-area"
          data-selection-surface
          @scroll.passive="onPatternAreaScroll"
        >
          <!--
            Right-click anywhere in the pattern editor offers a pre-filled
            bug report. Anchored on this element, so Quasar positions it at
            the pointer and keeps the native menu away. The item is disabled
            unless a selection exists AND the edited pattern sits in the
            song's sequence — the report's range is never guessed.
          -->
          <q-menu context-menu>
            <q-list dense style="min-width: 200px">
              <q-item
                clickable
                v-close-popup
                :disable="!selectionMapsToSong"
                :title="
                  selectionMapsToSong
                    ? 'Open a bug report pre-filled with the selection'
                    : selectionRect
                      ? 'This pattern is not placed in the song sequence'
                      : 'Select part of the pattern first'
                "
                @click="openBugReportFromSelection"
              >
                <q-item-section>Bug report…</q-item-section>
              </q-item>
            </q-list>
          </q-menu>

          <!--
            The canvas renderer swaps in behind its own setting; a page-level
            failure flag (rendererError) drops it back to the DOM grid, which
            stays compiled as the escape hatch. The canvas owns its scroll —
            the state it reports back is the same scrollTop/scrollLeft pair
            the DOM grid path feeds from this element.
          -->
          <PatternCanvas
            v-if="canvasRenderer && !canvasRendererFailed"
            ref="patternCanvasRef"
            :tracks="currentPattern?.tracks ?? []"
            :rows="rowsCount"
            :selected-row="activeRow"
            :playback-row="playbackRow"
            :active-track="activeTrack"
            :active-column="activeColumn"
            :active-macro-nibble="activeMacroNibble"
            :selection-rect="selectionRect"
            :auto-scroll="autoScroll"
            :is-playing="isPlaying"
            :playback-mode="playbackMode"
            :scroll-top="patternAreaScrollTop"
            :scroll-left="patternAreaScrollLeft"
            :container-width="patternAreaWidth"
            :container-height="patternAreaHeight"
            :is-mouse-selecting="isMouseSelecting"
            :show-extra-effect-column="userSettings.showTrackerExtraEffectColumn"
            :reserve-side-gutter="spectrumAnalyzerVisible"
            :granular-scroll="userSettings.granularPlaybackScroll"
            :enable-editing="isEditMode"
            :upcoming-pattern="upcomingPattern"
            :transpose-labels="ahxTransposeLabels.length > 0 ? ahxTransposeLabels : undefined"
            :transpose-titles="ahxTransposeTitles.length > 0 ? ahxTransposeTitles : undefined"
            :transpose-editable="isAhxEditable"
            @transpose-chip-step="onTransposeChipStep"
            @rowSelected="setActiveRow"
            @cellSelected="setActiveCell"
            @startSelection="onPatternStartSelection"
            @hoverSelection="onPatternHoverSelection"
            @scroll="onCanvasScroll"
            @renderer-error="onCanvasRendererError"
          />
          <TrackerPattern
            v-else
            ref="trackerPatternRef"
            :tracks="currentPattern?.tracks ?? []"
            :rows="rowsCount"
            :selected-row="activeRow"
            :playback-row="playbackRow"
            :active-track="activeTrack"
            :active-column="activeColumn"
            :active-macro-nibble="activeMacroNibble"
            :selection-rect="selectionRect"
            :auto-scroll="autoScroll"
            :is-playing="isPlaying"
            :playback-mode="playbackMode"
            :scroll-top="patternAreaScrollTop"
            :container-height="patternAreaHeight"
            :is-mouse-selecting="isMouseSelecting"
            :show-extra-effect-column="userSettings.showTrackerExtraEffectColumn"
            :reserve-side-gutter="spectrumAnalyzerVisible"
            :upcoming-pattern="upcomingPattern"
            :transpose-labels="ahxTransposeLabels.length > 0 ? ahxTransposeLabels : undefined"
            :transpose-titles="ahxTransposeTitles.length > 0 ? ahxTransposeTitles : undefined"
            :transpose-editable="isAhxEditable"
            @rowSelected="setActiveRow"
            @cellSelected="setActiveCell"
            @startSelection="onPatternStartSelection"
            @hoverSelection="onPatternHoverSelection"
          />
        </div>

        <!--
          The tracks scroll horizontally inside an element as tall as every row
          in the pattern, so its own scrollbar sits far below the viewport. This
          is a proxy for it: pinned under the pattern area, scrolling nothing of
          its own, kept in sync both ways with the real scroller.
        -->
        <div
          v-show="trackScrollbarWidth > 0"
          ref="trackScrollbarRef"
          class="track-scrollbar"
          data-selection-surface
          :style="{
            marginLeft: `${trackScrollbarInset.left}px`,
            marginRight: `${trackScrollbarInset.right}px`,
          }"
          aria-hidden="true"
        >
          <div
            class="track-scrollbar-extent"
            :style="{ width: `${trackScrollbarWidth}px` }"
          ></div>
        </div>
      </div>
    </div>
    <DemoSongBrowser v-model="showDemoBrowser" @select="handleDemoSelect" />
    <SongExportDialog :open="showSongExport" :get-song="getExportSong" @close="showSongExport = false" />

    <div v-if="showBugReport" class="bug-report-float">
      <BugReportDialog :preset="bugReportPreset" @close="closeBugReport" />
    </div>

    <div v-if="showExportModal" class="export-modal">
      <div class="export-dialog">
        <div class="export-title">Exporting song</div>
        <div class="export-status">{{ exportStatusText }}</div>
        <div class="export-progress">
          <div class="export-progress-bar">
            <div
              class="export-progress-fill"
              :style="{ width: `${exportProgressPercent}%` }"
            ></div>
          </div>
          <div class="export-progress-value">{{ exportProgressPercent }}%</div>
        </div>
        <div v-if="exportError" class="export-error">{{ exportError }}</div>
        <button
          type="button"
          class="export-close"
          :disabled="exportStage === 'recording' || exportStage === 'encoding'"
          @click="showExportModal = false"
        >
          {{
            exportStage === 'done' || exportStage === 'error' ? 'Close' : 'Hide'
          }}
        </button>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import TrackerPattern from 'src/components/tracker/TrackerPattern.vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import { selectUpcomingPattern } from 'src/components/tracker/pattern-buffering';
import {
  trackGapPx,
  trackWidthPx,
} from 'src/components/tracker/track-metrics';
import { visiblePageWindow } from 'src/components/tracker/page-window';
import SequenceEditor from 'src/components/tracker/SequenceEditor.vue';
import { ahxTransposeLabel, ahxTransposeTitle } from 'src/audio/tracker/ahx-position-display';
import TrackWaveform from 'src/components/tracker/TrackWaveform.vue';
import TrackerSpectrumAnalyzer from 'src/components/tracker/TrackerSpectrumAnalyzer.vue';
import DemoSongBrowser from 'src/components/tracker/DemoSongBrowser.vue';
import type { DemoSong } from 'src/composables/useDemoManifest';
import {
  useDemoManifest,
  demoSongUrl,
} from 'src/composables/useDemoManifest';
import {
  DEMO_LINK_QUERY_KEY,
  findDemoSongByFile,
  readDemoLinkParam,
  demoFileDisplayName,
} from 'src/composables/demo-deep-link';
import StereoLevelMeter from 'src/components/tracker/StereoLevelMeter.vue';
import AudioKnobComponent from 'src/components/AudioKnobComponent.vue';
import PatchPicker from 'src/components/PatchPicker.vue';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import { parseEffectCommand, parseTrackerNoteSymbol } from 'src/audio/tracker/note-utils';
import {
  useTrackerStore,
  TOTAL_PAGES,
  clampPatternRows,
} from 'src/stores/tracker-store';
import { usePatchStore } from 'src/stores/patch-store';
import { useKeyboardStore } from 'src/stores/keyboard-store';
import { useTrackerKeyboard } from 'src/composables/keyboard/useTrackerKeyboard';
import { TRACKER_NOTE_KEY_MAP } from 'src/composables/keyboard/note-key-map';
import type { TrackerKeyboardContext } from 'src/composables/keyboard/types';
import { useTrackerExport } from 'src/composables/useTrackerExport';
import type { TrackerExportContext } from 'src/composables/useTrackerExport';
import { useTrackerSelection } from 'src/composables/useTrackerSelection';
import { useTrackerScrollSync } from 'src/composables/useTrackerScrollSync';
import { createClearSelectionOnPress } from 'src/composables/useClearSelectionOnOutsidePress';
import type { TrackerSelectionContext } from 'src/composables/useTrackerSelection';
import { useTrackerEditing } from 'src/composables/useTrackerEditing';
import type { TrackerEditingContext } from 'src/composables/useTrackerEditing';
import { useTrackerNavigation } from 'src/composables/useTrackerNavigation';
import type { TrackerNavigationContext } from 'src/composables/useTrackerNavigation';
import { useTrackerSongHost } from 'src/composables/useTrackerSongHost';
import BugReportDialog from 'src/components/tracker/BugReportDialog.vue';
import SongExportDialog from 'src/components/tracker/SongExportDialog.vue';
import { snapshotEditorSong } from 'src/audio/tracker/ahx-source';
import type { AhxEditGate } from 'src/audio/tracker/ahx-doc/edit-guard';
import { reportAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import {
  channelsFromSelection,
  selectionToReportRange,
  type BugReportPreset,
} from 'src/composables/bug-report-context';
import { getLoadedSongHash } from 'src/composables/song-identity';
import { handleSongDragOver, handleSongDrop } from 'src/composables/song-drop';
import { useTrackerInstruments } from 'src/composables/useTrackerInstruments';
import type { TrackerInstrumentsContext } from 'src/composables/useTrackerInstruments';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import { usePostFxStore } from 'src/stores/post-fx-store';
import PostFxFilterControl from 'src/components/PostFxFilterControl.vue';
import { useMobileLayout } from 'src/composables/useMobileLayout';
import { storeToRefs } from 'pinia';
import {
  canEditSlot,
  instrumentBadgeLabel,
  isAhxSlot,
} from 'src/audio/tracker/instrument-types';

const router = useRouter();
const $q = useQuasar();
const userSettingsStore = useUserSettingsStore();
const { settings: userSettings } = storeToRefs(userSettingsStore);
const trackerStore = useTrackerStore();
trackerStore.initializeIfNeeded();
const showSongExport = ref(false);
const getExportSong = () => snapshotEditorSong(trackerStore);
const keyboardStore = useKeyboardStore();
const {
  currentSong,
  stepSize,
  patterns,
  sequence,
  currentPatternId,
  instrumentSlots,
  activeInstrumentId,
  currentInstrumentPage,
  songPatches,
} = storeToRefs(trackerStore);
const currentPattern = computed(() => trackerStore.currentPattern);
const currentPageSlots = computed(() => trackerStore.currentPageSlots);

/**
 * The pattern the sequencer will play after the current one.
 *
 * The pattern grid double-buffers it: while playing, the upcoming pattern is
 * pre-rendered into a hidden grid so the swap paints no blank frame. See
 * pattern-buffering.ts for the guard rules (empty sequence, deleted pattern,
 * etc.) -- computed live from the store so edits to the upcoming pattern
 * reach the pre-render buffer before the flip.
 */
const upcomingPattern = computed(() =>
  selectUpcomingPattern(
    isPlaying.value,
    currentSequenceIndex.value,
    sequence.value,
    (id) => {
      const next = trackerStore.patterns.find((p) => p.id === id);
      if (!next) return null;
      return { id: next.id, tracks: next.tracks, rows: trackerStore.rowsForPattern(next.id) };
    },
  ),
);

// Signature of instrument slots for audio sync - only watch properties that matter
const slotSignatures = computed(() =>
  instrumentSlots.value
    .map((s) => `${s.slot}:${s.patchId ?? ''}:${s.bankId ?? ''}`)
    .join('|'),
);
const patchStore = usePatchStore();
const playbackStore = useTrackerPlaybackStore();

/**
 * Everything that makes a song play: the song builder, the song bank sync,
 * the per-track visualiser nodes and the file loading. Shared with the
 * jukebox page, which needs all of it and none of the editing below.
 */
const host = useTrackerSongHost({
  onSequenceReset: () => {
    // Scroll the sequence list back to the top and drop its selection, so it
    // agrees with the index the load just reset.
    void nextTick(() => {
      sequenceEditorRef.value?.scrollToTop();
      sequenceEditorRef.value?.resetSelection();
    });
  },
});
const {
  songBank,
  audioContext,
  masterOutputNode,
  trackAudioNodes,
  spectrumTrackNodes,
  setTrackAudioNodeForInstrument,
  updateTrackAudioNodes,
  clearActiveNoteTracks,
  claimTrackAudioNodeSetter,
  releaseTrackAudioNodeSetter,
  buildPlaybackSong,
  syncSongBankFromSlots,
  initializePlayback,
  isLoadingSong,
  handleSaveSongFile,
  handleLoadSongFile,
  loadSongFromFile,
  loadSongFromUrl,
  formatInstrumentId,
  normalizeInstrumentId,
} = host;

/**
 * A demo deep link (`?demo=…`) is only resolved after mount, and resolving
 * it -- manifest fetch, module download, sample decode -- takes seconds. The
 * gate goes up here, synchronously at setup, so the tracker is never
 * editable during the gap before the linked song lands on top of whatever
 * the user just typed. `loadDemoDeepLink` lowers it on every exit path.
 */
const deepLinkFile =
  typeof window !== 'undefined' ? readDemoLinkParam(window.location.search) : null;
const deepLinkPending = ref(deepLinkFile !== null);
/**
 * What the overlay calls the linked song. The manifest -- and with it the
 * real title -- only lands seconds later, so the file name stands in until
 * `resolveDemoDeepLink` knows better.
 */
const deepLinkSongName = ref(deepLinkFile ? demoFileDisplayName(deepLinkFile) : '');
if (deepLinkPending.value) isLoadingSong.value = true;
const activeRow = ref(0);
const activeTrack = ref(0);
const activeColumn = ref(0);
const activeMacroNibble = ref(0);
/**
 * An AHX/HVL song's row model is display only (the worklet plays the file), so
 * the page is read-only for it: edit mode cannot be entered, and the
 * structural controls are disabled rather than left to do nothing.
 */
const isReadOnly = computed(() => trackerStore.isReadOnly);
/**
 * The song is an AHX song, editable or not. Distinct from `isReadOnly` (may I
 * write): the structure of an AHX song is not a pattern list's (four channels,
 * one track length, positions instead of patterns, numbered instruments), and
 * the scopes and the playback cursor follow the file, not the row model.
 */
const isAhxSong = computed(() => trackerStore.isAhxSong);
const readOnlyHint = 'This song is read-only: it plays from its file';

/*
 * Per-position, per-channel transpose (plan-pos-transpose.md): the AHX byte
 * the engine applies to every note the position plays and the tracker never
 * exposed. The panel edits it through `setTranspose` (the model op) via the
 * store action; the grid's track headers show it for the current position —
 * on the header, not the rows, because it also shifts notes that only keep
 * sounding while the position's own slots are empty.
 */
const isAhxEditable = computed(() => trackerStore.isAhxEditable);
/** The position the page shows: the projected pattern id `ahx-pos-<n>`, -1 when it is not one. */
const ahxPositionIndex = computed(() => {
  if (!isAhxEditable.value) return -1;
  const match = /^ahx-pos-(\d+)$/.exec(trackerStore.currentPatternId ?? '');
  return match ? Number(match[1]) : -1;
});
/** The current position's channels in doc order (empty when there is none). */
const ahxPositionChannels = computed(() => {
  const position = trackerStore.ahxDoc?.positions[ahxPositionIndex.value];
  if (!position) return [];
  return position.track.map((track, ch) => ({ track, transpose: position.transpose[ch] ?? 0 }));
});
/*
 * The read-only sibling (plan-hvl-header-ux-0923.md BUG 1): an HVL song, or an
 * AHX saved without its bytes, has no editable doc (an HVL song's `hvlDoc` is
 * display-only until plan-hvl-editing.md P2) — but the format still carries
 * the per-position transpose and the engine still applies it
 * (`formats/ahx.ts`'s position parse, `engine.rs`'s per-step `v.transpose`).
 * The import, and an HVL doc's display projection, keep those bytes on each
 * pattern (`positionTranspose`), so the header shows them read-only: same labels, a
 * title that does not promise a wheel edit, and a chip without the resize
 * cursor. Patterns are one per position in sequence order, so the position
 * index is the current pattern's sequence slot.
 */
const ahxReadOnlyTranspose = computed<number[] | undefined>(() => {
  if (isAhxEditable.value || !isAhxSong.value) return undefined;
  return trackerStore.currentPattern?.positionTranspose ?? undefined;
});
const ahxReadOnlyPositionIndex = computed(() =>
  trackerStore.sequence.indexOf(trackerStore.currentPatternId ?? ''),
);
const ahxReadOnlyLabels = computed(() =>
  (ahxReadOnlyTranspose.value ?? []).map((value) => ahxTransposeLabel(value)),
);
const ahxReadOnlyTitles = computed(() =>
  (ahxReadOnlyTranspose.value ?? []).map(
    (value, index) =>
      `Position ${ahxReadOnlyPositionIndex.value + 1}, channel ${index + 1}: notes shift by ${ahxTransposeLabel(value)} semitones when the song plays (read-only).`,
  ),
);
const ahxTransposeLabels = computed(() =>
  ahxReadOnlyLabels.value.length > 0
    ? ahxReadOnlyLabels.value
    : ahxPositionChannels.value.map((ch) => ahxTransposeLabel(ch.transpose)),
);
const ahxTransposeTitles = computed(() =>
  ahxReadOnlyTitles.value.length > 0
    ? ahxReadOnlyTitles.value
    : ahxPositionChannels.value.map((ch, index) => ahxTransposeTitle(ahxPositionIndex.value, index, ch.transpose)),
);
/**
 * The canvas header chip's wheel step (plan-ahx-transpose-header.md D-C):
 * the chip only emits; the page reads the current byte from the store doc
 * and sends the stepped value through `setAhxPositionTranspose` — the model
 * op's own range check is the clamp, and a refusal reports the transient
 * notice. Out-of-bounds channels/
 * positions cannot reach here (the labels only exist for a real position).
 */
function onTransposeChipStep(channel: number, direction: number): void {
  const index = ahxPositionIndex.value;
  if (index < 0) return;
  const current = trackerStore.ahxDoc?.positions[index]?.transpose[channel] ?? 0;
  trackerStore.setAhxPositionTranspose(index, channel, current + direction);
}
/** An editable HVL doc's width (its file sets it), or `null` for AHX and a song without a doc. */
const hvlDocChannels = computed(() => {
  const doc = trackerStore.ahxDoc;
  return doc?.format === 'hvl' ? doc.channels : null;
});
const ahxChannelsHint = computed(() =>
  hvlDocChannels.value === null ? 'AHX songs have exactly 4 channels' : `This HVL song has ${hvlDocChannels.value} channels, set by its file`
);
const ahxLengthHint = 'All the tracks of an AHX or HVL song have the same length';
// HVL instruments are listed and edited like AHX ones (plan-hvl-instruments-0923).
const ahxInstrumentsHint = computed(() =>
  hvlDocChannels.value === null
    ? 'AHX instruments are numbered in order and edited in their own editor'
    : 'HVL instruments are numbered in order and edited in their own editor'
);
/** What the edit composables ask before an edit an AHX step has no home for (see `AhxEditGate`). */
const ahxEditGate: AhxEditGate = {
  active: () => trackerStore.isAhxEditable,
  refuse: (check) => {
    const reason = trackerStore.ahxRefusal(check);
    if (reason === null) return false;
    reportAhxEditNotice(reason);
    return true;
  },
  flush: () => {
    trackerStore.syncAhxWriteBack();
  },
};
const editModeRequested = ref(false);
const isEditMode = computed<boolean>({
  get: () => editModeRequested.value && !isReadOnly.value,
  set: (value) => {
    if (!isReadOnly.value) editModeRequested.value = value;
  },
});
watch(isReadOnly, (readOnly) => {
  // Do not let edit mode come back on by itself when a MOD is loaded next.
  if (readOnly) editModeRequested.value = false;
});
const isFullscreen = ref(false);
const columnsPerTrack = computed(() =>
  userSettings.value.showTrackerExtraEffectColumn ? 6 : 5,
);
/** How many page numbers the instrument pager shows at once. */
const INSTRUMENT_PAGE_WINDOW = 5;

/*
 * The sample-quality settings are pushed into the audio layer by the user
 * settings store itself, so the jukebox gets them too -- see
 * `applySampleQuality` there. Nothing to do on this page.
 */

/**
 * The rate the audio engine is actually running at.
 *
 * Read from the live context rather than from the setting: a browser may
 * decline a rate the hardware will not run and fall back, so the setting says
 * what was asked for and this says what happened.
 */
const engineRateLabel = computed(() => {
  const rate = audioContext.value?.sampleRate;
  if (!rate) return 'engine idle';
  // Trailing zeroes are noise at a glance: 48 kHz, but 44.1 kHz.
  const khz = rate / 1000;
  const shown = Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1);
  return `${shown} kHz`;
});

const engineRateTitle = computed(() => {
  const rate = audioContext.value?.sampleRate;
  if (!rate) return 'The audio engine has not started yet.';
  const requested = userSettings.value.audioSampleRate;
  return rate === requested
    ? `Audio engine running at ${rate} Hz.`
    : `Audio engine running at ${rate} Hz; ${requested} Hz was requested but the browser declined it.`;
});

/** The run of page numbers to show, sliding with the current page. */
const visibleInstrumentPages = computed(() =>
  visiblePageWindow(
    currentInstrumentPage.value,
    TOTAL_PAGES,
    INSTRUMENT_PAGE_WINDOW,
  ),
);

function stepInstrumentPage(delta: number) {
  trackerStore.setInstrumentPage(currentInstrumentPage.value + delta);
}

/**
 * Column metrics for the waveform row, which must match the pattern grid's
 * exactly or the waveforms drift off the tracks they meter.
 *
 * Both width and gap depend on the channel count: this used to be a fixed
 * 180px with a 10px gap in CSS, while the pattern tightened past eight
 * channels, so every column added 16px of error (24px past sixteen).
 */
const trackerTrackWidth = computed(
  () =>
    `${trackWidthPx(
      trackCount.value,
      userSettings.value.showTrackerExtraEffectColumn,
    )}px`,
);
const trackerTrackGap = computed(() => `${trackGapPx(trackCount.value)}px`);
const trackerContainer = ref<HTMLDivElement | null>(null);
const patternAreaRef = ref<HTMLDivElement | null>(null);
const sequenceEditorRef = ref<InstanceType<typeof SequenceEditor> | null>(null);
const patternAreaScrollTop = ref(0);
const patternAreaScrollLeft = ref(0);
const patternAreaHeight = ref(600);
const patternAreaWidth = ref(0);
const patternCanvasRef = ref<InstanceType<typeof PatternCanvas> | null>(null);
// Grid/navigation/selection all size against the *current* pattern.
const rowsCount = computed(() => trackerStore.currentPatternRows);

// Handle pattern area scroll for virtual scrolling
// Throttle scroll updates using requestAnimationFrame for better performance
let scrollRafId: number | null = null;
function onPatternAreaScroll(event: Event) {
  if (scrollRafId !== null) return;

  scrollRafId = requestAnimationFrame(() => {
    const target = event.target as HTMLElement;
    patternAreaScrollTop.value = target.scrollTop;
    scrollRafId = null;
  });
}

// Update pattern area height on mount and resize
function updatePatternAreaHeight() {
  if (patternAreaRef.value) {
    patternAreaHeight.value = patternAreaRef.value.clientHeight;
    patternAreaWidth.value = patternAreaRef.value.clientWidth;
  }
}

// ---------------------------------------------------------------
// Phone layout
// ---------------------------------------------------------------

/**
 * On a phone the three top panels collapse to chips in the toolbar and open
 * one at a time as a sheet over the pattern, so the pattern -- the only part
 * that cannot be summarised -- gets the screen.
 */
const isMobileLayout = useMobileLayout();

const MOBILE_PANELS = [
  { id: 'song', label: 'Song' },
  { id: 'patterns', label: 'Patterns' },
  { id: 'instruments', label: 'Instr' },
] as const;

type MobilePanelId = (typeof MOBILE_PANELS)[number]['id'];

const mobilePanel = ref<MobilePanelId | null>(null);

function toggleMobilePanel(id: MobilePanelId): void {
  mobilePanel.value = mobilePanel.value === id ? null : id;
}

// Leaving the phone layout (a rotate, a resized window) must not leave a
// sheet pinned over a desktop grid that is showing the same panels anyway.
watch(isMobileLayout, (mobile) => {
  if (!mobile) mobilePanel.value = null;
});

// Full screen means the pattern and nothing else.
watch(
  () => isFullscreen.value,
  (full) => {
    if (full) mobilePanel.value = null;
  },
);

/**
 * The visualizers are off on a phone whatever the settings say: they are the
 * most expensive thing on the page (a canvas per channel, plus the taps
 * feeding them) and the least affordable there. The song host reads the same
 * condition to stop the bank building per-track taps at all.
 */
const spectrumAnalyzerVisible = computed(
  () => userSettings.value.showSpectrumAnalyzer && !isMobileLayout.value,
);
const waveformVisualizersVisible = computed(
  () => userSettings.value.showWaveformVisualizers && !isMobileLayout.value,
);

// An AHX/HVL song's visualizers are fed by the worklet's per-voice capture,
// which records nothing unless asked: on while they are showing, off otherwise.
watch(
  () => waveformVisualizersVisible.value && isAhxSong.value,
  (wanted) => playbackStore.setAhxScopesEnabled(wanted),
  { immediate: true },
);

// ---------------------------------------------------------------
// Canvas renderer wiring (mirrors JukeboxPage)
// ---------------------------------------------------------------

/**
 * Canvas renderer on until this page's own copy proves it cannot run here.
 *
 * The setting has no toggle any more -- the canvas grid is the pattern grid
 * -- but it is still read rather than hardcoded, so the DOM grid remains
 * reachable by editing the stored settings if it is ever needed again.
 */
const canvasRenderer = computed(() => userSettings.value.canvasPatternRenderer);
const canvasRendererFailed = ref(false);

/**
 * Latest scroll position reported by the canvas pattern renderer.
 *
 * The rAF callback reads this, not its closure: scroll events arrive in
 * bursts faster than frames, and a captured payload would keep writing a
 * stale position over newer ones. Same pattern as JukeboxPage.
 */
let pendingCanvasScroll: { top: number; left: number } | null = null;

function onCanvasScroll(payload: { top: number; left: number }): void {
  pendingCanvasScroll = payload;
  if (canvasScrollRafId !== null) return;
  canvasScrollRafId = requestAnimationFrame(() => {
    const pending = pendingCanvasScroll;
    pendingCanvasScroll = null;
    if (pending) {
      patternAreaScrollTop.value = pending.top;
      patternAreaScrollLeft.value = pending.left;
    }
    canvasScrollRafId = null;
  });
}

let canvasScrollRafId: number | null = null;

/**
 * Fall back to the DOM grid, for this pattern.
 *
 * Deliberately not persisted, and deliberately not permanent. What the
 * renderer reports is a property of the pattern in front of it -- one whose
 * bitmap will not fit -- not of the machine, so a failure must not outlive
 * the pattern that caused it. `retryCanvasRenderer` below puts it back.
 */
function onCanvasRendererError(error: Error): void {
  canvasRendererFailed.value = true;
  // Once per page. The retry means the same unhappy pattern can report
  // again on every visit to it, and a notification per visit is noise.
  if (!canvasFailureNotified) {
    canvasFailureNotified = true;
    $q.notify({
      type: 'negative',
      message: `Canvas pattern renderer failed — switched to the DOM grid. (${error.message})`,
    });
  }
}

let canvasFailureNotified = false;

/**
 * Give the canvas renderer another go when what it must draw changes.
 *
 * A failure is about one pattern's size, so the pattern extent changing --
 * a different pattern, a resized one, a loaded song -- is exactly when the
 * answer might differ. Without this a single oversized pattern left the
 * page on the DOM grid until it was reloaded, which on a phone (where the
 * cap is easiest to hit) was most of a session.
 */
function retryCanvasRenderer(): void {
  if (canvasRendererFailed.value) canvasRendererFailed.value = false;
}


// Set up selection composable
const selectionContext: TrackerSelectionContext = {
  activeRow,
  activeTrack,
  isEditMode,
  isReadOnly,
  rowsCount,
  currentPattern,
  pushHistory: () => trackerStore.pushHistory(),
  parseTrackerNoteSymbol,
  midiToTrackerNote,
  ahx: ahxEditGate,
};

const {
  selectionAnchor,
  selectionEnd,
  isMouseSelecting,
  selectionRect,
  clearSelection,
  startSelectionAtCursor,
  onPatternStartSelection,
  onPatternHoverSelection,
  transposeSelection: rawTransposeSelection,
  copySelectionToClipboard,
  pasteFromClipboard,
  // Track operations
  copyTrack,
  cutTrack,
  pasteTrack,
  transposeTrack: rawTransposeTrack,
  // Pattern operations
  copyPattern,
  cutPattern,
  pastePattern,
  transposePattern: rawTransposePattern,
} = useTrackerSelection(selectionContext);

function normalizeVolumeChars(vol?: string): [string, string] {
  const clean = (vol ?? '').toUpperCase();
  const chars: [string, string] = ['.', '.'];
  if (/^[0-9A-F]$/.test(clean[0] ?? '')) chars[0] = clean[0] as string;
  if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1] as string;
  return chars;
}

function normalizeMacroChars(macro?: string): [string, string, string] {
  const clean = (macro ?? '').toUpperCase();
  const chars: [string, string, string] = ['.', '.', '.'];
  // Allow any effect command letter (A-Z) or digit in the first slot; params stay hex
  if (/^[0-9A-Z]$/.test(clean[0] ?? '')) chars[0] = clean[0] as string;
  if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1] as string;
  if (/^[0-9A-F]$/.test(clean[2] ?? '')) chars[2] = clean[2] as string;
  return chars;
}

function getTrackByIndex(trackIndex: number) {
  return currentPattern.value?.tracks[trackIndex];
}

function parseMacroEffect(macro?: string) {
  const parsed = parseEffectCommand(macro);
  if (parsed?.type === 'macro') {
    return { macroIndex: parsed.index, value: parsed.value };
  }
  return undefined;
}

function findInterpolationRangeContaining(trackIndex: number, row: number) {
  const track = getTrackByIndex(trackIndex);
  if (!track?.interpolations) return undefined;
  return track.interpolations.find(
    (range) => row >= range.startRow && row <= range.endRow,
  );
}

function clearInterpolationRangeAt(row: number, trackIndex: number) {
  const track = getTrackByIndex(trackIndex);
  if (!track?.interpolations || track.interpolations.length === 0) return;
  track.interpolations = track.interpolations.filter(
    (range) => !(row >= range.startRow && row <= range.endRow),
  );
}

function findNearestMacroEntry(
  trackIndex: number,
  row: number,
  direction: -1 | 1,
): { row: number; macroIndex: number; value: number } | undefined {
  const track = getTrackByIndex(trackIndex);
  if (!track) return undefined;
  const sorted = [...track.entries].sort((a, b) => a.row - b.row);
  const iterator =
    direction === -1 ? [...sorted].reverse() : sorted;
  for (const entry of iterator) {
    if (direction === -1 && entry.row >= row) continue;
    if (direction === 1 && entry.row <= row) continue;
    const macro = parseMacroEffect(entry.macro);
    if (macro) {
      return { row: entry.row, macroIndex: macro.macroIndex, value: macro.value };
    }
  }
  return undefined;
}

function toggleInterpolationRangeAt(row: number, trackIndex: number) {
  const track = getTrackByIndex(trackIndex);
  if (!track) return;

  const existing = findInterpolationRangeContaining(trackIndex, row);
  if (existing) {
    trackerStore.pushHistory();
    if (existing.interpolation === 'linear') {
      existing.interpolation = 'exponential';
    } else {
      clearInterpolationRangeAt(row, trackIndex);
    }
    return;
  }

  const entryHere = track.entries.find((e) => e.row === row);
  if (entryHere && (entryHere.macro ?? '').trim() !== '') return;

  const above = findNearestMacroEntry(trackIndex, row, -1);
  const below = findNearestMacroEntry(trackIndex, row, 1);
  if (!above || !below) return;
  if (above.macroIndex !== below.macroIndex) return;

  trackerStore.pushHistory();
  const filtered = (track.interpolations ?? []).filter(
    // Keep ranges that end at/before the new start, or start at/after the new end (allow touching endpoints)
    (r) => r.endRow <= above.row || r.startRow >= below.row,
  );
  filtered.push({
    startRow: above.row,
    endRow: below.row,
    macroIndex: above.macroIndex,
    startValue: above.value,
    endValue: below.value,
    interpolation: 'linear',
  });
  track.interpolations = filtered;
}

function midiToTrackerNote(midi: number): string {
  const names = [
    'C-',
    'C#',
    'D-',
    'D#',
    'E-',
    'F-',
    'F#',
    'G-',
    'G#',
    'A-',
    'A#',
    'B-',
  ];
  const octave = Math.floor(midi / 12) - 1;
  const name = names[midi % 12] ?? 'C-';
  return `${name}${octave}`;
}

// Mute/solo state from playback store
const {
  mutedTracks,
  soloedTracks,
  isPlaying,
  isPaused,
  playbackRow,
  playbackMode,
  autoScroll,
  currentSequenceIndex,
} = storeToRefs(playbackStore);

// Selecting an AHX instrument gets its preview voice ready, so that the first
// key sounds at once (an AHX song loading does the same, in the store).
watch(
  [activeInstrumentId, instrumentSlots],
  ([instrumentId]) => {
    if (instrumentId && ahxInstrumentNumberFor(instrumentId) !== undefined) {
      void playbackStore.prepareAhxPreview();
    }
  },
  { immediate: true },
);

watch(
  () => keyboardStore.latestEvent,
  (event) => {
    if (!event) return;
    if (isEditMode.value) return;

    const instrumentId =
      activeInstrumentId.value ?? formatInstrumentId(activeTrack.value + 1);
    if (!instrumentId) return;

    const adjustedMidi = applyBaseOctave(event.note);
    const midi = adjustedMidi;

    if (!Number.isFinite(midi)) return;
    if (!playbackStore.isTrackAudible(activeTrack.value)) return;

    // An AHX instrument has no patch: it is sounded by the AHX preview voice,
    // called at once (no await first) so that a quick key-up cannot overtake it.
    const ahxInstrument = ahxInstrumentNumberFor(instrumentId);
    if (ahxInstrument !== undefined) {
      if (event.velocity <= 0.0001) {
        playbackStore.previewAhxNoteOff(midi);
      } else {
        void playbackStore.previewAhxNoteOn(ahxInstrument, midi, event.velocity);
      }
      return;
    }

    void (async () => {
      if (!hasPatchForInstrument(instrumentId)) return;
      await songBank.ensureAudioContextRunning();
      await songBank.prepareInstrument(instrumentId);
      if (event.velocity <= 0.0001) {
        songBank.previewNoteOff(instrumentId, midi);
      } else {
        songBank.previewNoteOn(instrumentId, midi, event.velocity);
      }
    })();
  },
);

// Playback functionality will be initialized after all dependencies are set up

const DEFAULT_BASE_OCTAVE = trackerStore.baseOctave;
const baseOctave = ref(trackerStore.baseOctave);
const trackCount = computed(() => currentPattern.value?.tracks.length ?? 0);
type TrackerPatternInstance = InstanceType<typeof TrackerPattern> & {
  tracksWrapperRef?: { value: HTMLElement | null };
};
const trackerPatternRef = ref<TrackerPatternInstance | null>(null);
const visualizerRowRef = ref<HTMLDivElement | null>(null);
const visualizerTracksRef = ref<HTMLDivElement | null>(null);
const patternTracksWrapper = ref<HTMLElement | null>(null);
const patternAreaWrapperRef = ref<HTMLElement | null>(null);
const trackScrollbarRef = ref<HTMLElement | null>(null);
/** Scrollable width of the tracks, or 0 when they all fit and no bar is needed. */
const trackScrollbarWidth = ref(0);
/** Aligns the proxy bar under the tracks rather than the whole pattern panel. */
const trackScrollbarInset = ref({ left: 0, right: 0 });
const visualizerPadding = ref({ left: 18, right: 18 });
const TRACK_SCROLL_MARGIN = 16;
let teardownTrackWheelScroll: (() => void) | null = null;

const {
  canvasRendererActive,
  resolvePatternTracksWrapper,
  syncTrackScroll,
  refreshVisualizerAlignment,
} = useTrackerScrollSync({
  trackerPatternRef,
  patternCanvasRef,
  patternTracksWrapper,
  patternAreaWrapperRef,
  visualizerRowRef,
  visualizerTracksRef,
  trackScrollbarRef,
  trackScrollbarWidth,
  trackScrollbarInset,
  visualizerPadding,
  canvasRenderer,
  canvasRendererFailed,
  patternAreaScrollLeft,
  waveformVisualizersVisible,
});

function toggleEditMode() {
  isEditMode.value = !isEditMode.value;
}

function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
}

/**
 * Return focus to the tracker container so keyboard shortcuts work.
 * Called after interacting with form elements like selects.
 */
function refocusTracker() {
  // Use nextTick to ensure this happens after the current event completes
  void nextTick(() => {
    trackerContainer.value?.focus();
  });
}

function blurAndRefocusTracker(event?: Event) {
  const target = event?.target as HTMLElement | null;
  target?.blur();
  refocusTracker();
}

async function scrollActiveTrackIntoView() {
  // Wait for DOM to settle so measurements are correct
  await nextTick();
  const wrapper = resolvePatternTracksWrapper();
  if (!wrapper) return;
  const tracks = wrapper.querySelectorAll<HTMLElement>('.tracker-track');
  const target = tracks[activeTrack.value];
  if (!target) return;

  const { scrollLeft, clientWidth } = wrapper;
  const left = target.offsetLeft;
  const right = target.offsetLeft + target.offsetWidth;
  const margin = TRACK_SCROLL_MARGIN;

  let targetScrollLeft: number | null = null;

  // Check if track is hidden to the left
  if (left < scrollLeft + margin) {
    targetScrollLeft = Math.max(0, left - margin);
  }
  // Check if track is hidden to the right
  else if (right > scrollLeft + clientWidth - margin) {
    targetScrollLeft = right - clientWidth + margin;
  }

  // Perform smooth scroll if needed
  if (targetScrollLeft !== null) {
    wrapper.scrollTo({
      left: targetScrollLeft,
      behavior: 'smooth'
    });
  }
}

function setupTrackWheelScroll() {
  teardownTrackWheelScroll?.();
  const wrapper = resolvePatternTracksWrapper();
  if (!wrapper) return;
  const handleWheel = (event: WheelEvent) => {
    // Convert vertical wheel motion into horizontal scroll for tracks
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      wrapper.scrollLeft += event.deltaY;
    }
  };
  wrapper.addEventListener('wheel', handleWheel, { passive: false });
  teardownTrackWheelScroll = () => {
    wrapper.removeEventListener('wheel', handleWheel);
  };
}

const visualizerReady = ref(false);

const noteKeyMap = TRACKER_NOTE_KEY_MAP;

function applyBaseOctave(midi: number): number {
  const offset = (baseOctave.value - DEFAULT_BASE_OCTAVE) * 12;
  const adjusted = midi + offset;
  return Math.max(0, Math.min(127, Math.round(adjusted)));
}

/** The AHX instrument number (1-based; the slot number) behind `instrumentId`, if it is an AHX slot. */
function ahxInstrumentNumberFor(instrumentId: string): number | undefined {
  const slot = instrumentSlots.value.find(
    (candidate) => formatInstrumentId(candidate.slot) === instrumentId,
  );
  return slot && isAhxSlot(slot) && slot.ahxData ? slot.slot : undefined;
}

function hasPatchForInstrument(instrumentId: string): boolean {
  return instrumentSlots.value.some(
    (slot) => formatInstrumentId(slot.slot) === instrumentId && !!slot.patchId,
  );
}

// Set up navigation composable
const navigationContext: TrackerNavigationContext = {
  activeRow,
  activeTrack,
  activeColumn,
  activeMacroNibble,
  rowsCount,
  currentPattern,
  columnsPerTrack,
  clearSelection,
};

const {
  setActiveRow,
  setActiveCell,
  moveRow,
  moveColumn,
  jumpToNextTrack,
  jumpToPrevTrack,
} = useTrackerNavigation(navigationContext);

// Set up editing composable
const editingContext: TrackerEditingContext = {
  activeRow,
  activeTrack,
  activeColumn,
  activeMacroNibble,
  isEditMode,
  stepSize,
  baseOctave,
  defaultBaseOctave: DEFAULT_BASE_OCTAVE,
  activeInstrumentId,
  rowsCount,
  currentPattern,
  instrumentSlots,
  songBank,
  toggleInterpolationRange: toggleInterpolationRangeAt,
  clearInterpolationRangeAt,
  pushHistory: () => trackerStore.pushHistory(),
  moveRow,
  formatInstrumentId,
  normalizeInstrumentId,
  normalizeVolumeChars,
  normalizeMacroChars,
  midiToTrackerNote,
  ahx: ahxEditGate,
  onNotePreview: (trackIndex: number, instrumentId: string) => {
    setTrackAudioNodeForInstrument(trackIndex, instrumentId);
    host.markTrackNotePlayed(trackIndex);
  },
};

const {
  ensureActiveInstrument,
  setActiveInstrument,
  handleNoteEntry,
  handleVolumeInput,
  handleMacroInput,
  clearInstrumentField,
  clearVolumeNibble,
  clearVolumeField,
  clearMacroNibble,
  clearMacroField,
  insertNoteOff,
  clearStep,
  deleteRowAndShiftUp,
  insertRowAndShiftDown,
  toggleInterpolationRange: toggleInterpolationRangeCommand,
} = useTrackerEditing(editingContext);

// Set up instruments composable (needs to be after playback and editing composables)
// We'll declare it later after playback is set up

function setStepSizeInput(value: number) {
  if (!Number.isFinite(value)) return;
  const clamped = Math.max(1, Math.min(64, Math.round(value)));
  trackerStore.pushHistory();
  stepSize.value = clamped;
}

function setBaseOctaveInput(value: number) {
  if (!Number.isFinite(value)) return;
  const clamped = Math.max(0, Math.min(8, Math.round(value)));
  baseOctave.value = clamped;
  trackerStore.setBaseOctave(clamped);
}

function setPatternRows(count: number) {
  // An AHX song's tracks share one length for the whole song, not per pattern.
  if (isAhxSong.value) return;
  const clamped = clampPatternRows(count);
  trackerStore.pushHistory();
  // Applies to the pattern being edited; patterns may differ in length.
  trackerStore.setPatternRows(clamped);
  setActiveRow(activeRow.value);
  playbackStore.setPatternLength(currentPatternId.value, clamped);
}

function onPatternLengthInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (Number.isFinite(value)) {
    setPatternRows(value);
  }
}

// A primary press on a dead area (no control, not the pattern grid) drops the
// selection. The grid is tagged `data-selection-surface`, so a drag-select
// that starts there is never cleared by this. Sequence rows are clickable
// divs, so they count as controls.
const onContainerPointerDown = createClearSelectionOnPress(
  () => clearSelection(),
  () => selectionAnchor.value !== null,
  { isExempt: (target) => target.closest('.sequence-item') !== null }
);

function handleGlobalMouseUp() {
  if (isMouseSelecting.value) {
    isMouseSelecting.value = false;
  }
}

// Set up song builder composable (must be before playback)
// Reload playback after structural edits (transpose) without forcing a stop/start cycle
async function restartPlaybackIfActive() {
  // Only hot-reload playback while actively playing; keep stopped/paused idle.
  // Never for an AHX/HVL song: its row model is display only, so a "reload"
  // would restart it from the top and sound exactly the same.
  if (!isPlaying.value || isAhxSong.value) return;
  const mode = playbackMode.value;
  const startRow = playbackRow.value;
  const song = buildPlaybackSong(mode);
  await playbackStore.play(song, mode, startRow, currentSequenceIndex.value);
}

function transposeSelection(semitones: number) {
  if (isReadOnly.value) return;
  rawTransposeSelection(semitones);
  void restartPlaybackIfActive();
}

function transposeTrack(semitones: number) {
  if (isReadOnly.value) return;
  rawTransposeTrack(semitones);
  void restartPlaybackIfActive();
}

function transposePattern(semitones: number) {
  if (isReadOnly.value) return;
  rawTransposePattern(semitones);
  void restartPlaybackIfActive();
}

// Playback handlers that delegate to the store
async function handlePlayPattern() {
  await host.play('pattern', activeRow.value);
}

async function handlePlaySong() {
  await host.play('song', activeRow.value);
}

function handlePause() {
  activeRow.value = playbackRow.value;
  playbackStore.pause();
}

// An AHX/HVL song resumes in place when it is played from the row it paused
// on (`playAhx`), and the cursor is what "the row it is played from" means. The
// header's pause button, and the jukebox's, pause without `handlePause`, so the
// cursor is put on the paused row whoever paused. A cursor moved after that is
// a play-from-here, which seeks. The other formats restart from the cursor as
// they always have, so they are left as they are.
watch(isPaused, (paused) => {
  if (paused && isAhxSong.value) activeRow.value = playbackRow.value;
});

function handleStop() {
  playbackStore.stop();
  activeRow.value = 0;
  clearActiveNoteTracks();
  // Don't clear track audio nodes - allow sounds to fade out visually
}

function togglePatternPlayback() {
  if (isPlaying.value && playbackMode.value === 'pattern') {
    handlePause();
    return;
  }
  void handlePlayPattern();
}

function toggleMute(trackIndex: number) {
  playbackStore.toggleMute(trackIndex, trackCount.value);
}

function toggleSolo(trackIndex: number) {
  playbackStore.toggleSolo(trackIndex, trackCount.value);
}

function sanitizeMuteSoloState(trackTotal = trackCount.value) {
  playbackStore.sanitizeMuteSoloState(trackTotal);
}

// Set up instruments composable
const instrumentsContext: TrackerInstrumentsContext = {
  trackerStore,
  patchStore,
  router,
  instrumentSlots,
  songPatches,
  activeTrack,
  currentPattern,
  formatInstrumentId,
  ensureActiveInstrument,
  setActiveInstrument,
  syncSongBankFromSlots,
  sanitizeMuteSoloState,
  updateTrackAudioNodes,
  trackCount,
};

const {
  instrumentNameEditSlot,
  instrumentNameDraft,
  availablePatches,
  getInstrumentDisplayName,
  setInstrumentNameInputRef,
  beginInstrumentRename,
  cancelInstrumentRename,
  commitInstrumentRename,
  onPatchSelect,
  clearInstrument,
  createNewSongPatch,
  editSlotPatch,
  loadSystemBankOptions,
  addTrack,
  removeTrack,
} = useTrackerInstruments(instrumentsContext);

// Instrument volume (mixer) controls
const formatGainAsDb = (value: number): string => {
  if (value <= 0) return '-inf dB';
  const db = 20 * Math.log10(value);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
};

const onSlotVolumeChange = (slotNumber: number, volume: number) => {
  trackerStore.setSlotVolume(slotNumber, volume);
  // Apply to song bank immediately
  const instrumentId = formatInstrumentId(slotNumber);
  songBank.setInstrumentOutputGain(instrumentId, volume);
};

// Master volume control
const onMasterVolumeChange = (event: Event) => {
  const volume = parseFloat((event.target as HTMLInputElement).value);
  userSettingsStore.updateSetting('masterVolume', volume);
  songBank.setUserMasterVolume(volume);
};

const showDemoBrowser = ref(false);

// ---------------------------------------------------------------
// Bug report via pattern selection (right-click)
// ---------------------------------------------------------------

const showBugReport = ref(false);
const bugReportPreset = ref<BugReportPreset | null>(null);

/**
 * The honest pairing between what is edited and what plays: on this page
 * they are the same song — one shared tracker store, which playback even
 * retargets pattern-by-pattern while running. A selection therefore maps
 * into the sequence of the song that is loaded here, preferring the order
 * actually playing when playback is live on the edited pattern, else the
 * pattern's first sequence occurrence.
 */
const selectionMapsToSong = computed(() => {
  const rect = selectionRect.value;
  if (!rect) return false;
  const playing = isPlaying.value || isPaused.value ? currentSequenceIndex.value : null;
  return (
    selectionToReportRange({
      selectionRect: rect,
      patternId: currentPatternId.value,
      sequence: sequence.value,
      playingOrder: playing,
    }) !== null
  );
});

function openBugReportFromSelection(): void {
  const rect = selectionRect.value;
  if (!rect) return;
  // The playing order only counts when playback is live or paused mid-play;
  // a stale index from a finished run is not what the user is hearing.
  const playing = isPlaying.value || isPaused.value ? currentSequenceIndex.value : null;
  const range = selectionToReportRange({
    selectionRect: rect,
    patternId: currentPatternId.value,
    sequence: sequence.value,
    playingOrder: playing,
  });
  // An unplaced pattern has no honest order+row position — no report.
  if (!range) return;
  const sha256 = getLoadedSongHash();
  bugReportPreset.value = {
    songIdentity: {
      // The edited song's own title; the hash (when a module file was
      // loaded) is what anchors it to the exact bytes.
      name: currentSong.value.title,
      ...(sha256 !== null ? { sha256 } : {}),
    },
    startPosition: range.startPosition,
    endPosition: range.endPosition,
    // The selected columns, 1-based like the report's channel numbering.
    channels: channelsFromSelection(rect),
  };
  showBugReport.value = true;
}

function closeBugReport(): void {
  showBugReport.value = false;
  bugReportPreset.value = null;
}

function openDemoBrowser() {
  showDemoBrowser.value = true;
}

async function handleDemoSelect(url: string, _song: DemoSong) {
  showDemoBrowser.value = false;
  await loadSongFromUrl(url);
}

/**
 * A demo deep link (`?demo=<manifest path>`) loads that song once the page
 * is up. It loads but does not auto-start: browsers refuse playback without
 * a user gesture, and a link that silently fails to start is worse than
 * one that waits for the play button.
 */
async function loadDemoDeepLink(): Promise<void> {
  try {
    await resolveDemoDeepLink();
  } finally {
    // Whatever happened -- loaded, failed, nothing to load -- the gate that
    // went up at setup comes down here, and only here.
    deepLinkPending.value = false;
    isLoadingSong.value = false;
  }
}

async function resolveDemoDeepLink(): Promise<void> {
  const file = readDemoLinkParam(window.location.search);
  if (!file) return;
  // Coming back to the tracker with something already playing (returning
  // from the instrument editor, a running jukebox) must not clobber it: the
  // deep link is for a fresh arrival. The param goes with it — the URL must
  // not promise a song this session is not going to load.
  if (isPlaying.value || isPaused.value) {
    stripDemoLinkParam();
    return;
  }
  const { collections, error, load } = useDemoManifest();
  // `load` never rejects: a failed manifest lands in `error` (and is not
  // cached, so a later retry can succeed).
  await load();
  if (error.value) {
    // The manifest is how a link resolves to a song; without it the link
    // says nothing about whether the song still exists.
    console.error('[Demo deep link] could not resolve the linked song', error.value);
    $q.notify({
      type: 'negative',
      message: `Could not load the linked demo song (${error.value}).`,
      timeout: 4000,
    });
    return;
  }
  const song = findDemoSongByFile(collections.value, file);
  if (song) deepLinkSongName.value = song.title;
  if (!song) {
    $q.notify({
      type: 'warning',
      message: 'The linked song is no longer in the demo list.',
      timeout: 4000,
    });
    return;
  }
  try {
    await loadSongFromUrl(demoSongUrl(song));
    $q.notify({
      type: 'positive',
      message: `Loaded “${song.title}” from the link.`,
      timeout: 3000,
    });
  } catch (err) {
    console.error('[Demo deep link] could not load the linked song', err);
    $q.notify({
      type: 'negative',
      message: 'Could not load the linked demo song.',
      timeout: 4000,
    });
  }
}

/** Remove the demo param from the address bar without disturbing the route. */
function stripDemoLinkParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(DEMO_LINK_QUERY_KEY);
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

/**
 * The jukebox is a page of its own: it plays the demo collection without
 * touching the song loaded here, and puts this song back on the way out.
 */
function openJukebox() {
  void router.push('/jukebox');
}

// New Song with confirmation
function handleNewSong() {
  $q.dialog({
    title: 'New Song',
    message:
      'Are you sure you want to start a new song? All unsaved changes will be lost.',
    cancel: {
      label: 'Cancel',
      flat: true,
    },
    ok: {
      label: 'New Song',
      color: 'negative',
    },
    persistent: true,
  }).onOk(() => {
    // Stop any playback first
    handleStop();
    // Reset the store to a fresh state
    trackerStore.resetToNewSong();
    // Resync the song bank with empty instruments
    syncSongBankFromSlots();
    // New Song replaces the song without going through applySongFile, so the
    // AUTO load-reset must be hooked here too (plan review M6).
    usePostFxStore().onSongLoad(trackerStore.moduleFormat);
  });
}

// Set up keyboard command system
const keyboardContext: TrackerKeyboardContext = {
  // Current state
  activeRow,
  activeTrack,
  activeColumn,
  activeMacroNibble,
  isEditMode,
  isFullscreen,
  get rowsCount() {
    return rowsCount.value;
  },
  get trackCount() {
    return trackCount.value;
  },

  // Selection
  selectionAnchor,
  selectionEnd,
  clearSelection,
  startSelectionAtCursor,
  copySelectionToClipboard,
  pasteFromClipboard,
  transposeSelection,

  // Navigation
  setActiveRow,
  moveRow,
  moveColumn,
  jumpToNextTrack,
  jumpToPrevTrack,

  // Editing
  handleNoteEntry,
  handleVolumeInput,
  handleMacroInput,
  clearStep,
  clearInstrumentField,
  clearVolumeNibble,
  clearVolumeField,
  clearMacroNibble,
  clearMacroField,
  insertNoteOff,
  insertRowAndShiftDown,
  deleteRowAndShiftUp,
  toggleInterpolationRange: toggleInterpolationRangeCommand,
  ensureActiveInstrument,

  // Playback
  togglePatternPlayback,

  // UI
  toggleEditMode,
  toggleFullscreen,

  // Octave
  baseOctave,
  setBaseOctaveInput,

  // Step size
  stepSize,
  setStepSizeInput,

  // Store actions
  undo: () => trackerStore.undo(), // no-ops on a read-only song
  redo: () => trackerStore.redo(),

  // Track/Pattern operations
  copyTrack,
  cutTrack,
  pasteTrack,
  copyPattern,
  cutPattern,
  pastePattern,
  transposeTrack,
  transposePattern,

  // Note mapping
  noteKeyMap,
};

const { handleKeyDown } = useTrackerKeyboard(keyboardContext);

/**
 * The loading overlay covers the pointer; keys reach the container anyway,
 * so a song load locks the keyboard too rather than letting edits land on a
 * song that is about to be replaced.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (isLoadingSong.value) {
    event.preventDefault();
    return;
  }
  handleKeyDown(event);
}

// Set up export composable
const exportContext: TrackerExportContext = {
  getPlaybackEngine: () => playbackStore.engine,
  songBank,
  rowsCount,
  currentSong,
  sequence,
  patterns,
  currentPatternId,
  currentPattern,
  playbackMode,
  activeRow,
  playbackRow,
  syncSongBankFromSlots,
  initializePlayback,
};

const {
  isExporting,
  showExportModal,
  exportStage,
  exportError,
  exportStatusText,
  exportProgressPercent,
  exportSongToMp3,
} = useTrackerExport(exportContext);

function handleCreatePattern() {
  if (isAhxSong.value) return;
  trackerStore.pushHistory();
  const newPatternId = trackerStore.createPattern();
  trackerStore.addPatternToSequence(newPatternId);
  trackerStore.setCurrentPatternId(newPatternId);
  playbackStore.setSequenceIndex(trackerStore.sequence.length - 1);
}

function handleSelectPattern(payload: { patternId: string; index: number }) {
  trackerStore.setCurrentPatternId(payload.patternId);
  playbackStore.setSequenceIndex(payload.index);
}

function handleAddPatternToSequence(patternId: string) {
  if (isAhxSong.value) return;
  trackerStore.pushHistory();
  trackerStore.addPatternToSequence(patternId);
}

function handleRemovePatternFromSequence(index: number) {
  if (isAhxSong.value) return;
  trackerStore.pushHistory();
  trackerStore.removePatternFromSequence(index);
}

function handleMoveSequenceItem(fromIndex: number, toIndex: number) {
  if (isAhxSong.value) return;
  trackerStore.pushHistory();
  trackerStore.moveSequenceItem(fromIndex, toIndex);
}

function handleRenamePattern(patternId: string, name: string) {
  if (isAhxSong.value) return;
  trackerStore.pushHistory();
  trackerStore.setPatternName(patternId, name);
}

function handleWindowResize() {
  updatePatternAreaHeight();
  refreshVisualizerAlignment();
}

/**
 * Dropping a song file anywhere on the page opens it, the same as the Open
 * button; other files are refused (see `song-drop.ts`).
 */
function handleFileDrop(event: DragEvent): void {
  handleSongDrop(event, {
    isBusy: () => isLoadingSong.value,
    load: (file) => void loadSongFromFile(file),
    reject: (file) =>
      $q.notify({
        type: 'warning',
        message: `${file.name} is not a song file (.cmod, .json, .mod, .xm, .s3m, .ahx, .hvl)`,
      }),
  });
}

onMounted(async () => {
  window.addEventListener('dragover', handleSongDragOver);
  window.addEventListener('drop', handleFileDrop);
  trackerContainer.value?.focus();
  // Skip song bank sync if playback is active (returning from instrument editor)
  // The song bank already has the correct instruments loaded
  await loadSystemBankOptions({ skipSync: isPlaying.value || isPaused.value });
  ensureActiveInstrument();
  // Apply master volume from user settings
  songBank.setUserMasterVolume(userSettings.value.masterVolume);
  // Skip reloading song if playback is already active (returning to page while playing)
  void initializePlayback(playbackMode.value, true);
  keyboardStore.setupGlobalKeyboardListeners();
  keyboardStore.syncMidiSetting(userSettings.value.enableMidi);
  window.addEventListener('mouseup', handleGlobalMouseUp);
  window.addEventListener('resize', handleWindowResize);
  handleWindowResize();
  visualizerReady.value = false;
  await nextTick();
  refreshVisualizerAlignment();
  await nextTick();
  visualizerReady.value = true;
  visualizerReady.value = false;
  await nextTick();
  refreshVisualizerAlignment();
  visualizerReady.value = true;

  setupTrackWheelScroll();
  // Wait for next tick to ensure all refs are ready before setting up the watch
  await nextTick();
  watch(
    () => activeTrack.value,
    () => {
      scrollActiveTrackIntoView();
    },
    { flush: 'post' },
  );
  watch(
    () => trackCount.value,
    () => {
      setupTrackWheelScroll();
      refreshVisualizerAlignment();
    },
    { immediate: true, flush: 'post' },
  );

  // Re-register the track audio node setter since it was cleared on unmount
  claimTrackAudioNodeSetter();

  // Last, and not awaited: a slow manifest or module must not hold up the
  // page's own keyboard/visualiser setup above.
  void loadDemoDeepLink();
});

watch(
  () => userSettings.value.enableMidi,
  (enabled) => {
    keyboardStore.syncMidiSetting(enabled);
  },
);

// Debounced BPM watcher to avoid excessive updates during slider dragging
let bpmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => currentSong.value.bpm,
  (bpm) => {
    if (bpmDebounceTimer) clearTimeout(bpmDebounceTimer);
    bpmDebounceTimer = setTimeout(() => {
      playbackStore.setBpm(bpm);
    }, 50);
  },
  { immediate: true },
);

watch(
  () => rowsCount.value,
  (rows) => playbackStore.setPatternLength(currentPatternId.value, rows),
  { immediate: true },
);

// Update pattern area height when fullscreen mode changes
watch(isFullscreen, async () => {
  await nextTick();
  updatePatternAreaHeight();
  refreshVisualizerAlignment();
});

watch(
  () => baseOctave.value,
  (oct) => trackerStore.setBaseOctave(oct),
  { immediate: true },
);

watch(
  () => currentPatternId.value,
  () => {
    updateTrackAudioNodes();
    refreshVisualizerAlignment();
  },
);

watch(trackCount, () => refreshVisualizerAlignment());

// A new song starts at its first track. Left where the last song was, a
// narrower song can sit entirely off-screen with nothing left to scroll by.
watch(isLoadingSong, async (loading) => {
  if (loading) return;
  patternAreaScrollLeft.value = 0;
  await nextTick();
  syncTrackScroll(0);
});

// The extent the renderer failed on has changed: let it try again (see
// retryCanvasRenderer). Declared here rather than beside the handler
// because `watch` seeds its getters immediately, and `trackCount` is not
// initialised until further down this setup.
watch(
  [trackCount, rowsCount, currentPatternId, isLoadingSong],
  () => retryCanvasRenderer(),
);

watch(
  waveformVisualizersVisible,
  async (show) => {
    if (show) {
      visualizerReady.value = false;
      await nextTick();
      refreshVisualizerAlignment();
      await nextTick();
      visualizerReady.value = true;
    } else {
      visualizerReady.value = false;
      refreshVisualizerAlignment();
    }
  },
);

watch(
  () => userSettings.value.showTrackerExtraEffectColumn,
  async () => {
    await nextTick();
    refreshVisualizerAlignment();
    scrollActiveTrackIntoView();
  },
);

// Toggling the canvas renderer swaps the pattern element (and its geometry);
// the waveform strip must re-measure and re-sync against whichever shows.
watch(canvasRendererActive, async () => {
  await nextTick();
  refreshVisualizerAlignment();
});

// Watch only the properties that matter for audio sync (slot, patchId, bankId)
// This prevents unnecessary audio rebuilds when editing instrument names
watch(slotSignatures, async () => {
  // Skip sync if explicit file load is in progress - handleLoadSongFile handles everything
  if (isLoadingSong.value) {
    return;
  }

  // Skip sync if playback is active - the song bank already has the correct state
  // This prevents interruption when returning from instrument editor
  if (isPlaying.value || isPaused.value) {
    updateTrackAudioNodes();
    return;
  }

  // Ensure audio context is resumed before creating instruments
  // This provides the required user gesture for browsers' autoplay policy
  await songBank.ensureAudioContextRunning();
  await syncSongBankFromSlots();
  updateTrackAudioNodes();
  // Skip reloading song if playback is active to preserve position
  void initializePlayback(playbackMode.value, true);
});

onBeforeUnmount(() => {
  // Clear the track audio node setter so the store doesn't try to call into unmounted component
  releaseTrackAudioNodeSetter();
  // Don't stop playback - it continues when navigating away
  // The visualizers go with the page, so the worklet stops recording for them.
  playbackStore.setAhxScopesEnabled(false);
  // Don't dispose the songBank - it's a singleton managed by trackerAudioStore
  keyboardStore.cleanup();
  keyboardStore.clearAllNotes();
  keyboardStore.cleanupMidiListeners();
  window.removeEventListener('dragover', handleSongDragOver);
  window.removeEventListener('drop', handleFileDrop);
  window.removeEventListener('mouseup', handleGlobalMouseUp);
  window.removeEventListener('resize', handleWindowResize);
  teardownTrackWheelScroll?.();
  // Cancel pending scroll RAF
  if (scrollRafId !== null) {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
  if (canvasScrollRafId !== null) {
    cancelAnimationFrame(canvasScrollRafId);
    canvasScrollRafId = null;
  }
});
</script>

<style scoped lang="scss">
@import '../css/tracker-page.scss';
</style>
